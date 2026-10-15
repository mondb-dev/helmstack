# Security model

HelmStack gives external programs control of a browser. This page states the trust boundaries, what each mechanism protects, and the known caveats.

**Prerequisites:** none. For day-to-day approval behavior see [Approvals](approvals.md).

## Threat model in one line

The control plane is loopback-only and token-authenticated. The main threats it defends against are a malicious web page in any browser on the machine trying to reach the agent API, and other local processes that do not hold the token. It also limits what an in-window chat agent can do and keeps the person at the window in charge of sensitive actions.

It is not a defense against a hostile process that already runs as you and can read the token file.

## The agent server

- **Loopback bind.** The server listens on `127.0.0.1` only (default port 7070).
- **Token auth, always on in the shipped apps.** Every request must present the token as `X-HelmStack-Token: <token>` or `Authorization: Bearer <token>`. The desktop app and the daemon generate a random 32-byte token on first run and store it in `helmstack-agent-token` (mode `0600`). `HELMSTACK_AUTH_TOKEN` replaces the generated token. The desktop app logs only the token file path at start, never the token itself.
- **DNS-rebinding guard.** A `Host` header that is not `127.0.0.1`, `localhost` or `::1` is rejected with `403`.
- **Cross-origin guard.** A browser `Origin` that is not loopback is rejected with `403`; `Origin: null` is rejected too. Non-browser clients send no `Origin` and are allowed (subject to the token).
- **No wildcard CORS.** `Access-Control-Allow-Origin` is echoed only for loopback origins.

### Known caveat: agent isolation is advisory

Per-agent tab ownership keys off the client-supplied `X-Agent-ID` header. There is one shared token, so any token holder can present any agent id and reach another agent's tabs, approvals and handoffs. Ownership prevents accidental interference between cooperating agents; it is not a security boundary.

To run mutually distrusting agents, give each its own HelmStack instance (separate process, port, token and user-data directory). A test in `packages/devtools-core/test/agent-server.integration.test.ts` pins this behavior so it cannot silently be read as a guarantee.

## Approvals

Sensitive effects (sharing personal data, creating accounts, accepting terms, payments) are classified before a command runs and can be `auto`, `ask` or `block`.

- On the desktop app only the person in the window can approve. An agent that calls approve gets `403` with `code: "requires_human"`; it may still reject its own request.
- `HELMSTACK_AGENT_APPROVALS=1` removes that protection on the desktop.
- The daemon has no window, so any token holder can approve.
- An approval is bound to the page it was requested on, expires after 10 minutes by default (`HELMSTACK_APPROVAL_TTL_MS`) and is cancelled when the tab navigates or closes.

Full behavior and policy keys: [Approvals](approvals.md).

## Credential storage

Desktop only.

- **Identity vault** (`helmstack-vault.enc`) and **account store** (`helmstack-accounts.enc`) are AES-256-GCM encrypted, with the master key in `helmstack-vault.key`.
- **Key protection.** The master key is wrapped with the OS keychain through Electron `safeStorage` when available.
- **Plaintext fallback.** When `safeStorage` is unavailable (for example Linux without a keyring), the key is stored base64-encoded next to the ciphertext, so the vault is effectively unencrypted at rest. The vault status reports which mode is active.
- **Exposure.** Summaries returned to agents and the renderer mask passwords and omit TOTP seeds.

## In-window agent chat

The Chat tab lets you talk to an installed agent CLI (Claude Code, Gemini CLI) inside the HelmStack window. The desktop main process launches the CLI as a child process and gives it HelmStack's MCP server.

- **What starts it.** Only the person, through the shell's IPC bridge. IPC handlers accept calls only from the shell window and validate every argument. There is no HTTP route to start, control or read a conversation, so an agent using the API cannot launch another agent. A unit test asserts the agent server and daemon reference nothing from the runner.
- **What it runs.** Only the allowlisted names `claude` and `gemini`, found on `PATH` and a few well-known directories. The only other process is `<found> --version` with a 5 second timeout. argv is a fixed template with no shell; your text goes to the CLI on stdin. Model ids must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$`.
- **Confinement.** Claude Code runs with `--tools=` (no built-in tools), `--allowedTools=mcp__helmstack`, an explicit deny list, `--permission-mode dontAsk` and `--strict-mcp-config`; bypass modes are never passed. Gemini CLI gets a policy file that denies every tool except the `helmstack` MCP server, but that was not verified end to end, so it is reported as unconfined and experimental and needs an explicit acknowledgement per conversation.
- **Secrets.** The CLI's environment has every `HELMSTACK_*` and `ELECTRON_*` variable removed. The MCP server it starts receives the port and a token file path. When the token came from the environment it is written to a `0600` file in a `0700` per-conversation temp directory that is deleted when the conversation closes. The MCP server runs as `HELMSTACK_AGENT_ID=chat:<cli>`.
- **What the UI sees.** Text, a tool name with a fixed short summary, and a sanitized outcome. Tool arguments, results and raw stderr are never forwarded.
- **Limits.** One running turn per conversation, 10 minute turn timeout, 16 MiB output cap, 400,000 characters of assistant text, 4 concurrent conversations, 500 replayed events. Stop sends `SIGTERM` to the process group then `SIGKILL` after 3 seconds.
- **Not guaranteed.** The CLI uses your own login and sends what it reads to its provider.

### Local models (Ollama, LM Studio, llama.cpp)

A local runtime is only an HTTP model API, so HelmStack runs the agent loop itself inside the same runner. Detection and usage: [Agent chat and local models](agent-chat.md).

- **Loopback only.** Probes and chat requests go only to `127.0.0.1`, `[::1]` or `localhost` (defaults: Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`; override with `HELMSTACK_LOCAL_ENDPOINTS`). Any non-loopback host, credentials in the URL or a non-http(s) scheme is dropped. Redirects are never followed and bodies are size-capped. Probes time out at 800 ms.
- **Only 14 verbs are executable.** The model gets the lite tools (`look`, `click`, `type`, `select`, `go`, `back`, `forward`, `reload`, `scroll`, `tabs`, `audit`, `details`, `viewport`, `screenshot`) as structured tools. Only structured `tool_calls` run, after the name and arguments are validated against the lite schemas. Unknown tools and extra or invalid arguments are returned to the model as an error and never executed. JSON that merely appears in the model's text or in a page is data. At most 4 calls per step and 12 steps per turn. `click`, `type` and `select` are refused until the model has been shown the page in an earlier step of the same turn (a `look` and a `click` in the same step still counts as blind), so a model that guesses an element number cannot act on it.
- **Model output and page content are untrusted.** Tool results are fed back as `tool` messages only, capped at 3,000 characters.
- **Same pipeline as every other agent.** The loop talks to this instance's agent API over loopback with its token, as `chat:<provider>:<model>`, pinned to the conversation's tab. Approval gating, activity recording and redaction are unchanged: risky actions come back as `NEEDS APPROVAL` and there is no verb that approves. The loop has no shell, file, account or TOTP capability.
- **Ollama's own API is never exposed** to pages or to agents. HelmStack never pulls or downloads models.
- **Failure modes.** The server dying mid-stream, no bytes for 120 seconds, a 5 minute turn timeout, Stop or closing the tab all abort the in-flight request and end the turn cleanly.
- **Context window.** Ollama silently truncates prompts at its small default context. HelmStack always sends `options.num_ctx` (default 8192, override with `HELMSTACK_LOCAL_NUM_CTX`, 2048 to 131072) and bounds history to the last 12 messages.
- **Capability gating.** For Ollama, `/api/show` capabilities decide: models without `tools` are disabled; servers that report none are "unknown" and selectable with a warning. LM Studio and llama.cpp are always "unknown".

## Connect an agent dialog

The dialog only ever receives a client name, an action and a few allowlisted options from the renderer; the main process builds every command and path itself. It writes the token file path, never the token; env keys in written configs are limited to `HELMSTACK_PORT`, `HELMSTACK_TOKEN_FILE`, `HELMSTACK_TOOLSET`, `HELMSTACK_PROFILE` and `ELECTRON_RUN_AS_NODE`. Installs are previewed, confirmed against the preview id, written atomically with a `.bak`, and never overwrite a config that is not valid JSON. To decide whether `npx @helmstack/mcp-server` is offered, the app makes one request to the public npm registry (cached for 10 minutes).

## Anti-detection (stealth)

Fingerprint hardening and human-like input timing are opt-in and off by default (`HELMSTACK_STEALTH=1`, or the `agent-substrate` and `full` profiles). The default is a clean, deterministic browser suited to front-end work and CI. Anyone enabling stealth for autonomous automation is responsible for following the target sites' terms and applicable law.

## Data at rest

See the file table in [Configuration](configuration.md#data-files). Baselines under `helmstack-screenshots/` and `helmstack-perception/` are plain files and can contain whatever was on screen when they were captured.

## Verify it worked

- Without a token: `curl http://127.0.0.1:7070/api/health` returns `{"error":"Unauthorized"}`.
- With a foreign host header: `curl -H "Host: example.com" ...` returns `Forbidden: non-loopback Host header`.
