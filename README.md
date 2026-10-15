# HelmStack

[![CI](https://github.com/mondb-dev/helmstack/actions/workflows/ci.yml/badge.svg)](https://github.com/mondb-dev/helmstack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

HelmStack lets an AI agent look at, test and debug a front-end while you work on it. It exposes a live browser page as structured data (what is on the page, what changed, what is broken) and as tools an agent can call: screenshots and diffs, accessibility and SEO audits, layout and style checks, network mocks, coverage, traces and assertions. One shared core runs on two backends: an Electron desktop browser you can watch, and a headless Chrome daemon for CI.

## Who it is for

- Front-end developers who want a coding agent (Claude Code, Gemini CLI, Codex, Cursor) to verify its own UI changes in a real browser.
- Teams that want the same checks in CI, scripted over HTTP or run by an MCP client.

## Status

Pre-release. The `@helmstack/*` npm packages have not been published yet (the release workflow is blocked on the `NPM_TOKEN` repository secret), so everything below runs from a clone. See [Known limitations](#known-limitations).

## Quickstart

Requirements: Node 20 or newer, npm 10 or newer. The daemon also needs a Chrome or Chromium.

```bash
git clone https://github.com/mondb-dev/helmstack.git
cd helmstack
npm install
```

### 1. Desktop app

```bash
npm run dev
```

The window opens with a browser and an agent panel. The status chip at the top right shows the agent API port (7070 by default). Click it, then **Connect agents…** to install HelmStack's MCP server into Claude Code, Claude Desktop, Gemini CLI, Codex CLI, Antigravity or Cursor. See [Getting started](docs/getting-started.md).

### 2. Headless daemon (CI)

```bash
npm run build:packages
npm run build -w @helmstack/daemon
HELMSTACK_AUTH_TOKEN=local-dev-token node apps/daemon/dist/main.js --port 7195
curl -H "X-HelmStack-Token: local-dev-token" http://127.0.0.1:7195/api/health
```

Expected response: `{"status":"ok","connectedAgents":0,"tabs":1,"backend":"daemon","capabilities":[]}`. See [Headless and CI](docs/headless-ci.md).

### 3. MCP client

Add the server to any client that takes an `mcpServers` config, pointing at the port and token file of a running desktop app or daemon:

```json
{
  "mcpServers": {
    "helmstack": {
      "command": "node",
      "args": ["/path/to/helmstack/packages/mcp-server/dist/index.js"],
      "env": { "HELMSTACK_PORT": "7070", "HELMSTACK_TOKEN_FILE": "/path/to/helmstack-agent-token" }
    }
  }
}
```

Run `npm run build:packages` first so `dist/index.js` exists. The desktop app's **Connect agents** dialog writes this for you. See [Connect an agent](docs/connect-an-agent.md).

## What it can do

| Area | Examples |
| --- | --- |
| See the page | Perception graph, accessibility tree, per-element bounds, framework and component detection, element picks from a human |
| Compare | Named screenshots and pixel diffs, perception diffs, multi-viewport suites, "what changed" element mapping |
| Audit | Accessibility (WCAG), SEO, focus order, layout issues, performance, unused CSS and JS, design tokens |
| Assert | Computed-style assertions, natural-language assertions, standing watches |
| Control the environment | Viewport, media emulation, geolocation, network mocks, resource budgets, cookies, storage |
| Record | Console and network logs, HAR export, traces, command recordings |

The complete list is generated from source: [MCP tools](docs/mcp-tools.md) and [HTTP API](docs/http-api.md).

![Chat tab in the agent panel, with each tool call shown as a chip. Captured against a scripted test server, so the reply text is canned.](docs/images/chat-local-model.png)

## Safety model in brief

- The API listens on `127.0.0.1` only and needs a token.
- On the desktop app, only the person at the window can approve a queued sensitive action. An agent that tries gets `403` with `code: "requires_human"`.
- Approvals are tied to the page they were requested on and expire after 10 minutes.
- In-window chat is confined to HelmStack's own tools.

Details: [Security model](docs/security-model.md), [Approvals](docs/approvals.md).

## Known limitations

- In-window chat with agent CLIs is not supported on Windows. Local-model chat is not blocked by the code on Windows but has not been tried there.
- The Gemini CLI path is unverified end to end and is marked experimental.
- The local-model loop has only been verified against fake servers, not a live Ollama or LM Studio.
- Install paths for Codex, Cursor, Claude Desktop and Antigravity are based on their documentation, not tested against the real apps. Claude Code and Gemini CLI were exercised against real binaries.
- ChatGPT cannot use a local stdio MCP server.
- npm packages are not published yet.

## Documentation

Start at the [documentation index](docs/README.md). Contributors: [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/devtools-core` | `HelmstackCore` (every tool, implemented once over a CDP target), the HTTP+SSE agent server, stores, approvals, the chat runner |
| `apps/desktop` | Electron shell: tabs, side panel, approvals UI, Connect an agent dialog |
| `apps/daemon` | `helmstack-daemon`: the same API on a headless Chrome |
| `packages/mcp-server` | `helmstack-mcp`: MCP tools over the agent API |
| `packages/agent-sdk` | TypeScript HTTP client and the lite toolset |
| `packages/perception` | In-page extractor that builds the perception graph |
| `packages/shared` | Types, shortcut table, CDP target contract |
| `apps/agent-example` | Example agents: an intent-driven one and LLM-backed variants (not published) |

## License

MIT. See [LICENSE](LICENSE).
