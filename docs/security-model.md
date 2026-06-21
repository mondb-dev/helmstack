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

Per-agent tab ownership keys off the client-supplied `X-Agent-ID` header. It
prevents *accidental* cross-agent interference but is **not** a security
boundary: a client that holds the token can present any `X-Agent-ID`. Treat all
token-holders as mutually trusting. (Binding agent identity to the token is
tracked in the agent-substrate backlog.)

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
`ask` queues a `PendingApproval` surfaced over SSE for a human decision.

> Note: effect classification currently fires for form submits; broadening it to
> cover low-level click/type and payment/consent detection is tracked in the
> agent-substrate backlog.

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
