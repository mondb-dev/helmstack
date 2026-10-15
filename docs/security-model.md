# HelmStack Security Model

HelmStack exposes a browser runtime to external agents. This document describes
the trust boundaries, what each mechanism protects, and the known caveats.

## Threat model in one line

The control plane is **localhost-only and token-authenticated**; the primary
threat it defends against is a **malicious web page** (in any browser on the
machine) trying to reach the agent API at `127.0.0.1:7070`, plus other local
processes that don't hold the token.

## The agent server (`127.0.0.1:7070`)

- **Loopback bind.** The HTTP/SSE server listens on `127.0.0.1` only and is
  never bound to a routable interface.
- **Token auth, on by default.** On first launch the app generates a random
  token, persists it to `<userData>/helmstack-agent-token` (mode `0600`), and
  prints it to the console. Every request must present it via
  `X-HelmStack-Token: <token>` or `Authorization: Bearer <token>`. Override the
  generated token by setting `HELMSTACK_AUTH_TOKEN` before launch.
  - Local agents authenticate with zero config by setting `HELMSTACK_AUTH_TOKEN`
    or pointing `HELMSTACK_TOKEN_FILE` at the token file; the SDK reads both.
- **DNS-rebinding guard.** Requests whose `Host` header is not a loopback name
  (`127.0.0.1` / `localhost` / `::1`) are rejected with `403`, so a domain that
  rebinds to `127.0.0.1` cannot drive the API.
- **Cross-origin guard.** Browsers attach an `Origin` header on cross-origin
  requests; any `Origin` that is not itself loopback is rejected with `403`.
  Non-browser clients (Node, curl, the SDK) send no `Origin` and are allowed
  (subject to the token).
- **No wildcard CORS.** `Access-Control-Allow-Origin` is echoed only for
  loopback origins, never `*`, so a web page cannot read responses even if a
  request slipped through.

### Known caveat — agent isolation is advisory

Per-agent tab ownership (`tabOwners`, gated by `isTabAccessible`) keys off the
client-supplied `X-Agent-ID` header. It prevents *accidental* cross-agent
interference but is **not** a security boundary:

- There is a **single shared auth token**. Identity is not bound to the caller,
  so any holder of the token can present **any** `X-Agent-ID` and reach another
  agent's tabs, approvals, and handoffs. The header is trusted, not authenticated.
- Therefore: **treat all token-holders as mutually trusting.** The ownership
  check is a cooperative partition, not a defense against a malicious agent.

**Remediation / safe usage:**

- To run **mutually-distrusting** agents, give each its **own HelmStack instance**
  (separate process + port + token + `userData`) rather than relying on
  `X-Agent-ID` within one instance.
- True in-process isolation would require **per-agent tokens** (a token→agentId
  binding so the server derives identity from the authenticated token instead of
  a header). That is tracked in the agent-substrate backlog and is the only way
  to make this a real boundary.

This caveat is asserted in code (`AgentServer.agentIdOf` / `isTabAccessible`
carry `SECURITY:` comments) and codified by a test in
`packages/devtools-core/test/agent-server.integration.test.ts` so it can't silently be
mistaken for a security boundary.

## Credential storage

- **Identity vault** (`helmstack-vault.enc`) and **account store**
  (`helmstack-accounts.enc`): AES-256-GCM, with the master key in
  `helmstack-vault.key`.
- **Key protection.** The master key is wrapped with the OS keychain via
  Electron `safeStorage` when available (`keyProtection: "safe_storage"`).
  - **Caveat — plaintext fallback.** When `safeStorage` is unavailable (e.g.
    Linux without a keyring/libsecret), the key is stored base64-plaintext next
    to the ciphertext (`keyProtection: "plaintext_fallback"`), which means the
    vault is effectively unencrypted at rest. The vault status surfaces this;
    adding a user passphrase is tracked in the agent-substrate backlog.
- **Exposure.** Summaries returned to agents/renderers mask passwords and omit
  TOTP seeds. Full records never leave the main process unmasked.

## Action approvals

Sensitive effects are gated by per-effect policies
(`helmstack-approval-policies.json`): `share_personal_data`, `create_account`,
`accept_legal_terms`, `submit_payment`. Each policy is `auto` / `ask` / `block`;
`ask` queues a `PendingApproval`. Who may then decide depends on the runtime:

- **Desktop (default): only the human.** Every queued approval — whether the
  agent API or the shell itself triggered it — is pushed to the HelmStack
  window (`browser-shell:approvals-changed`), where the human approves or
  rejects it. The agent server runs with `approvals: "human"`, so
  `POST /api/approvals/:id/approve` answers
  `403 { code: "requires_human" }`: holding the token is not enough to approve
  your own sensitive action. An agent may still `POST …/reject` to withdraw
  its request, and it still receives `approval_queued` over SSE so it knows to
  wait.
- **Escape hatch: `HELMSTACK_AGENT_APPROVALS=1`** (desktop only) restores
  agent approval, e.g. to run the contract suite against a desktop
  (`HELMSTACK_CONTRACT_URL`) or for unattended automation. With it set, any
  token holder can approve — treat it like running the daemon.
- **Daemon: the agent decides.** The headless daemon has no human window, so it
  runs with `approvals: "agent"` and any token holder can approve. The gate
  there is a pause-and-confirm step for the calling agent, not a human
  checkpoint; use `block` policies for effects that must never happen
  unattended.

### What is gated

Effects are classified **before** a command runs, so `ask` / `block` stop it
before anything reaches the page:

- **Submits** (`submit`, `dom.submit.<form>`): `share_personal_data` (the
  form's personal fields), plus `create_account` for signup forms.
- **Fills** (`dom.fill.<form>`) and **`type`** actions: `share_personal_data`
  when a value goes into a personal field — `email` / `tel` / `password` /
  address inputs, or a personal `autocomplete` hint (`name`, `email`, `tel`,
  `street-address`, `postal-code`, `bday`, `cc-*`, …) — or when the value is a
  vault / account ref. A `type` is matched to an observed field by accessible
  name, else classified from the live element's `type` / `autocomplete`.
  Typing is gated because input listeners, autosave and analytics can read a
  value long before any submit. Filling only non-personal fields is not gated.

Policies apply the same everywhere, including `localhost` test fixtures: there
is no host special-casing — set `share_personal_data` to `auto` in a test
profile if you want unattended fills.

### Approvals are bound to the page they were asked on

A `PendingApproval` records the tab's main-frame `url` and `origin` when it is
queued, and the approval dialog shows that page, not whatever the tab is on
now. It is cancelled — never executed — when:

- **the tab navigates the main frame** (cross-origin or same-origin). A
  fragment-only change (`#section`, same document) keeps it. A query-string
  change counts as a different page and cancels, because it usually selects
  different content;
- **the tab closes**;
- **it expires**: unanswered approvals lapse after 10 minutes
  (`HELMSTACK_APPROVAL_TTL_MS` or the `approvalTtlMs` core option; `0`
  disables);
- **the approve-time check fails**: defense in depth in case a navigation
  event was missed, `approve` compares the tab's live main-frame URL (fragment
  ignored) with the approval's `url` and refuses and cancels on a mismatch.

A cancelled or expired approval is removed from the pending list
(`approvals-changed` fires), fill grants for the tab are reset, the waiting
agent receives an `approval_resolved` SSE event
(`outcome: cancelled | expired`, with a reason), and a later approve/reject of
that id answers `blocked` with "Page changed before approval — ask again".
The agent must re-issue the command against the new page.

### No double prompt: fill → submit grants

Approving a fill / `type` into form F on tab T records a single-use grant. The
next submit of F on T runs without a second approval when **all** hold:

- the tab is still on the same document URL — any main-frame navigation (or
  closing the tab) voids the grant;
- the submit's effect kinds are a subset of the approved ones (a signup submit
  adds `create_account`, so it still asks);
- it happens within 5 minutes of the approval.

The grant is consumed by that submit; `block` always wins; a rejected fill
grants nothing, and fills never consume grants (each personal fill asks — use
one `dom.fill` rather than several `type`s for a single prompt). A raw `type` /
`submit` is tied to a form only when it can be resolved (field / submit-button
label, or the page's only form); unresolved ones never share a grant.

> Note: payment and consent detection (`submit_payment`, `accept_legal_terms`)
> and `click` / `select` classification are tracked in the agent-substrate
> backlog.

## In-window agent chat (agent CLI runner)

The Chat tab lets the human talk to an installed agent CLI (Claude Code, Gemini
CLI) inside the HelmStack window. The desktop main process launches the CLI as
a child process and gives it HelmStack's own MCP server so it can use the
browser tools.

**What starts it.** Only the human, through the shell IPC bridge
(`browserShell.startAgentConversation` etc.). IPC handlers accept calls only
from the shell window's own `webContents` and validate every argument (types,
lengths, known conversation id). **There is no HTTP route** to start, control
or read a conversation, so an agent talking to `127.0.0.1:7070` cannot launch
another agent (a unit test asserts the agent server and daemon reference
nothing from the runner).

**What it runs.** Only allowlisted CLIs (`claude`, `gemini`) found by name on
`PATH` and a few well-known install dirs (relative `PATH` entries ignored). The
only other thing ever executed is `<found> --version` with a 5 s timeout. argv
is a fixed template, `shell:false`; the user's text goes to the CLI on stdin.
The model id must match `^[A-Za-z0-9._:/-]{1,80}$`; the working directory must
be an existing directory (realpath) and defaults to an empty private directory
under `<userData>`.

**Confinement.** Claude Code runs with `--tools=` (no built-in tools),
`--allowedTools=mcp__helmstack`, an explicit deny list for the built-ins,
`--permission-mode dontAsk` (anything not pre-allowed is denied, never
prompted) and `--strict-mcp-config`; `--dangerously-skip-permissions` /
`bypassPermissions` / `--yolo` are never passed. Verified live: asked to run
`ls` and write a file, the model reported it had neither tool, while HelmStack
MCP calls worked. Gemini CLI is started with a policy file that denies every
tool except the `helmstack` MCP server, `--approval-mode default` and
`--allowed-mcp-server-names`, but this could not be verified end to end, so it
is reported `confined:false, experimental:true` and a conversation needs an
explicit per-conversation `allowUnconfined` acknowledgement.

**Secrets.** The CLI's environment has every `HELMSTACK_*` / `ELECTRON_*`
variable (notably `HELMSTACK_AUTH_TOKEN`) removed. The MCP server receives the
agent-server port and a token **file path** (`HELMSTACK_TOKEN_FILE`), never the
token. If the token came from the environment it is written to a 0600 file in
a 0700 per-conversation temp dir that is deleted when the conversation closes.
The MCP server runs with `HELMSTACK_AGENT_ID=chat:<cli>` (activity feed
attribution) and without the opt-in accounts/TOTP/approval tool surface.

**What the UI sees.** Text, tool name + a fixed short summary, and a sanitised
outcome. Tool arguments, tool results and raw stderr are never forwarded.

**Limits.** One running turn per conversation, 10 minute hard timeout, 16 MiB
output cap, 400k characters of assistant text, 4 concurrent conversations, 500
replayed events. Stop sends SIGTERM to the whole process group then SIGKILL
after 3 s; closing the tab or conversation and quitting the app kill any
remaining process group and delete the temp files.

**Not guaranteed.** The CLI authenticates with the user's own login and sends
page content the agent reads to that provider. HelmStack's approval gating
still applies to risky actions the agent requests through MCP.

## Anti-detection / stealth

Fingerprint hardening and human-like input timing are **opt-in** and **off by
default** (`HELMSTACK_STEALTH=1` enables them). The default is a clean,
deterministic browser suited to front-end development and CI. Operators enabling
stealth for autonomous automation are responsible for complying with the target
sites' terms of service and applicable law.

## Data at rest (under `<userData>`)

| File | Contents | Protection |
|---|---|---|
| `helmstack-agent-token` | REST auth token | `0600` |
| `helmstack-vault.key` | AES master key | `safeStorage`-wrapped or plaintext fallback |
| `helmstack-vault.enc` | Identity vault | AES-256-GCM |
| `helmstack-accounts.enc` | Site accounts (+ TOTP seeds) | AES-256-GCM |
| `helmstack-approval-policies.json` | Approval decisions | `0600` |
| `helmstack-screenshots/`, `helmstack-perception/` | Visual + perception baselines | plain files (no secrets) |
