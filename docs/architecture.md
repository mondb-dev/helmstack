# Architecture

HelmStack is one shared core with two browser backends, plus clients that speak its HTTP API.

**Prerequisites:** none. The decision record is [ADR 0001](adr/0001-headless-chrome-backend.md).

## Layers

```text
 agents / MCP clients / scripts
        │  MCP (stdio)                      │  HTTP + SSE
 packages/mcp-server ──► packages/agent-sdk ─┤
                                             ▼
                     packages/devtools-core  (no Electron imports)
                       createAgentServer  ─►  HelmstackCore  ─►  BrowserBackend
                       stores, approvals       every tool         tabs + one CdpTarget per tab
                       agent runner (chat)
                                             ▲                 ▲
                              apps/desktop (ElectronBackend)   apps/daemon (ChromeBackend)
                              Electron shell UI                headless Chrome via puppeteer-core
```

| Piece | Responsibility |
| --- | --- |
| `packages/shared` | Types shared by everyone, the `CdpTarget` contract, the keyboard shortcut table |
| `packages/perception` | In-page extractor that builds the perception graph |
| `packages/devtools-core` | `HelmstackCore` implements every tool once over a `CdpTarget`; the HTTP+SSE server; approval, baseline, policy and site-pattern stores; the chat runner for CLIs and local models |
| `apps/desktop` | `ElectronBackend` (tabs as `WebContentsView`s, element picking, preload observations) and the shell UI |
| `apps/daemon` | `ChromeBackend` (tabs as puppeteer pages, perception injected over CDP, downloads) and the `helmstack-daemon` CLI |
| `packages/agent-sdk` | `BrowserClient` HTTP client and the lite toolset |
| `packages/mcp-server` | `helmstack-mcp`: maps MCP tools onto the SDK |

An ESLint rule forbids importing `electron` from `packages/devtools-core`, so the core stays portable.

## How a request flows

1. A client calls the HTTP API (or an MCP tool, which calls the SDK, which calls HTTP).
2. The server checks `Host`, `Origin` and the token, records the request in the activity feed, and routes it.
3. `HelmstackCore` resolves the tab, runs the tool through that tab's `CdpTarget`, and returns the result.
4. Commands that could share personal data are classified first and may be queued for approval. See [Approvals](approvals.md).

## What differs per backend

Optional slices (accounts and TOTP, extensions, element picking) exist only where the backend provides them; otherwise routes answer `501 unsupported_on_backend`. The desktop decides approvals with a human; the daemon lets the token holder decide. See [Headless and CI](headless-ci.md) for the table.

## Chat runner

The agent runner (CLI and local models) is owned by the desktop main process and reachable only through the shell's IPC. No HTTP route starts or controls a conversation, so an agent talking to the API cannot launch another agent. The loops talk back to the same agent API with the instance token, as `chat:<provider>:<model>` or `chat:<cli>`.

## Data and ports

See [Configuration](configuration.md#data-files) for files, and the same page for ports.

## Verify it worked

`GET /api/health` returns `backend`: `desktop` or `daemon`, the same JSON shape in both.
