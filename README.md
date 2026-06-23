# HelmStack

[![CI](https://github.com/mondb-dev/helmstack/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/mondb-dev/helmstack/actions/workflows/ci.yml)
[![Release](https://github.com/mondb-dev/helmstack/actions/workflows/release.yml/badge.svg)](https://github.com/mondb-dev/helmstack/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

HelmStack is an AI-native browser substrate — a perception and execution layer for autonomous agents.

The browser is the eyes and hands:
- perception of live web state (DOM, accessibility tree, screenshots)
- grounded execution on the page
- approvals and safety boundaries
- site capability discovery
- account vault with TOTP support
- anti-detection hardening

The cognition layer is external and pluggable:
- OpenAI
- Anthropic
- LangGraph
- MCP clients
- custom agents

The goal is not to bolt an assistant onto a normal browser. The goal is to expose a browser runtime that any agent can use as a perception/execution system. Agents connect via HTTP+SSE at `127.0.0.1:7070`.

## Current Architecture

### Browser Substrate

The browser owns:
- tabs and session state
- DOM and accessibility perception
- same-origin iframe and open shadow-root traversal
- DOM-grounded execution
- per-tab capability manifests
- WebMCP readiness as a site capability provider slot
- anti-detection layer (CDP-based hardening)
- account vault with encrypted storage and TOTP generation
- Chrome extension loading (DevTools, ad-blockers, etc.)
- HTTP+SSE agent server on `127.0.0.1:7070`

### Agent Server

The browser exposes an HTTP+SSE API at `127.0.0.1:7070` (localhost only, never network-exposed).

**REST endpoints:**
- Tab management (list, open, navigate, set viewport)
- Perception (page state, manifests, screenshots)
- Execution (invoke site tools, DOM commands)
- Approvals (list, approve, reject sensitive actions)
- Human handoffs (request user intervention, wait for resolution)
- Accounts (CRUD, TOTP generation, origin lookup)
- Extensions (load/unload Chrome extensions)
- Intent (task panel text input for agent triggers)
- Logging (agent messages appear in terminal panel)

**SSE stream:**
- `tabs_changed` — tab created/closed/activated
- `page_observed` — page content updated
- `approval_queued` — sensitive action waiting for approval
- `human_handoff_requested` — agent needs user help
- `human_handoff_resolved` — user completed handoff
- `intent_changed` — new task entered in UI
- `agent_log` — agent logging events

See `apps/desktop/src/main/agent-server.ts` for the full API surface.

### Cognitive Runtime

The agent runtime is not hard-coded into the browser.

It should consume:
- `BrowserPerceptionPacket`

And return:
- `BrowserOutputCommand[]`

The browser then executes those commands and returns refreshed state.

### Site Capability Providers

Each tab can expose multiple capability providers:
- `dom`: generated from browser-owned perception
- `webmcp`: reserved for site-defined structured capabilities when available

Today:
- `dom` is implemented
- `webmcp` detection, tool enumeration, validation, and invocation are implemented for `navigator.webMcp`, `window.WebMCP` / `window.__WEB_MCP__`, and `script[type="application/webmcp+json"]` endpoint manifests

## Repository Layout

- `apps/desktop`: Electron shell, HTTP+SSE agent server, tab manager, preload bridge, capability registry, DOM actuator, vault, approvals, anti-detection
- `apps/agent-example`: Intent-driven example agent showing how to connect to the browser substrate
- `packages/agent-sdk`: Zero-dependency TypeScript client for the agent server HTTP+SSE API
- `packages/perception`: DOM observation, shadow-root/iframe traversal, semantic graph normalization
- `packages/shared`: shared browser, perception, substrate, and WebMCP contracts
- `docs/webmcp-ready.md`: architecture notes for pluggable cognition and WebMCP alignment
- `docs/agent-sdk.md`: complete Agent SDK reference with examples
- `docs/social-perception.md`: social feed/post/composer/navigation semantics exposed through `PageGraph.social`

## Implemented

**Core browser substrate**
- custom Electron browser shell
- `WebContentsView` tab surface
- HTTP+SSE agent server on `127.0.0.1:7070`
- TypeScript agent SDK (`@helmstack/agent-sdk`)
- live page observation stream
- DOM snapshot + accessibility-tree capture
- semantic `PageGraph` normalization
- same-origin iframe perception
- open shadow-root perception
- DOM capability manifests generated per tab
- unified `BrowserPerceptionPacket`
- encrypted account vault with secret refs for automation
- TOTP generation for 2FA codes
- approval gate for sensitive submit actions
- human handoff system for agent → user escalation
- intent system for task panel → agent triggers
- in-app contact-form fixture runner
- DOM-grounded execution for:
  - observed action activation
  - observed form fill with literal or vault-backed values
  - observed form submit with approval pause
  - low-level `click`, `type` with literal or vault-backed values, `select`, `submit`
- post-action perception refresh
- perception regression tests with fixture and golden coverage
- anti-detection hardening (navigator.webdriver, window.chrome, WebGL, canvas fingerprinting)
- Chrome extension loading (DevTools, ad-blockers, etc.)
- media perception — video/audio state capture (`ObservedMedia` in `PageGraph`)
- social-platform perception — optional `social` graph for feeds, posts, composers, navigation, and reaction/share/follow/message affordances
- action retry/recovery — `withDomRetry()` with exponential backoff (3 attempts)

**Dev tooling (exposed via REST, SDK, and MCP)**
- responsive multi-viewport capture suite — screenshot at mobile/tablet/desktop/4K simultaneously, with optional diffs
- performance metrics — Core Web Vitals + extended CDP metrics (LCP, CLS, FID/INP, TBT, TTI, JS heap, layout counts)
- accessibility audit — WCAG 2.2-aligned rule set against the live AX tree (img alt, button/link labels, input labels)
- element style inspector — computed CSS, box model, contrast ratio, viewport bounds, and issue detection
- component tree capture — React 16–18, Vue 2/3, Svelte detection with depth-limited prop extraction
- visual snapshot diff — pixel-level diff with blended overlay, bounding-box change regions, named snapshots
- "What Broke?" perception diff — structured before/after `PageGraph` comparison (headings, forms, actions, alerts, title)
- Three.js scene inspector — scene graph walk, draw-call stats, FPS estimate, AI feedback workflow
- natural language assertions — `browser.assert(tabId, "the cart shows 3 items")` with heuristic evaluator + evidence bundle
- storage inspector — read/write/clear `localStorage`, `sessionStorage`, cookies, IndexedDB

## MCP Server — AI Platform Setup

HelmStack ships a zero-config MCP server (`@helmstack/mcp-server`) that exposes the browser substrate as tools any MCP-compatible client can call. No custom agent code required — just point your AI tool at the server and it can drive a live browser session.

### How it works

1. **Launch HelmStack** — the Electron app starts the HTTP+SSE agent server on `127.0.0.1:7070`
2. **Start the MCP server** — connects to HelmStack and serves browser tools over stdio to your AI client
3. **Use your AI as normal** — it can now call `browser_navigate`, `browser_get_perception`, `browser_execute`, etc.

### Prerequisites

```bash
# 1. Clone and install
git clone https://github.com/mondb-dev/helmstack.git
cd helmstack
npm install && npm run build:packages

# 2. Start the HelmStack desktop app
npm run dev
```

The browser is now running and waiting on `127.0.0.1:7070`.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `browser_health` | Check if HelmStack is running |
| `browser_list_tabs` | List open tabs with ID, title, URL |
| `browser_open_tab` | Open a new tab (optionally navigate to a URL) |
| `browser_navigate` | Navigate a tab to a URL |
| `browser_set_viewport` | Resize a tab's viewport |
| `browser_get_perception` | Structured DOM graph: forms, fields, actions, a11y metadata |
| `browser_list_manifests` | Site capability manifests for a tab |
| `browser_screenshot` | Screenshot a tab (returns base64 PNG) |
| `browser_execute` | Execute DOM commands (fill form, click, invoke site tools) |
| `browser_list_approvals` | List pending actions awaiting human approval |
| `browser_approve` / `browser_reject` | Approve or reject a sensitive pending action |
| `browser_list_handoffs` | List tasks that require human takeover |
| `browser_resolve_handoff` | Return control to the agent after a handoff |
| `browser_list_accounts` | List credential vault entries |
| `browser_lookup_accounts` | Find credentials by origin (e.g. `https://github.com`) |
| `browser_generate_totp` | Generate a TOTP 2FA code for an account |
| `browser_get_intent` / `browser_set_intent` | Read/write the task panel intent |
| `browser_log` | Write a message to the HelmStack terminal panel |
| `browser_get_tab_logs` / `browser_clear_tab_logs` | Inspect or clear console, network, WebSocket, EventSource, and JS error logs |
| `browser_network_audit` | Summarise response headers, TLS details, cache status, and failed requests |
| `browser_get_network_mock` / `browser_enable_network_mock` / `browser_disable_network_mock` | Inspect or control request mocking |
| `browser_capture_named_screenshot` / `browser_diff_screenshots` | Capture named screenshots and compare visual changes |
| `browser_list_screenshots` / `browser_delete_screenshot` | Manage cached screenshot snapshots |
| `browser_viewport_suite` | Capture responsive screenshots across viewport presets |
| `browser_performance` / `browser_a11y_audit` | Capture performance metrics and accessibility findings |
| `browser_inspect_element_styles` | Inspect computed styles, box model, contrast, bounds, and style issues for matched elements |
| `browser_assert_element_styles` | Assert CSS values or numeric thresholds for matched elements |
| `browser_component_tree` / `browser_threejs_scene` | Inspect framework component trees and Three.js scenes |
| `browser_assert` | Evaluate a natural-language assertion against page evidence |
| `browser_get_recording` / `browser_start_recording` / `browser_stop_recording` | Record browser commands and export a replay script |
| `browser_get_site_patterns` / `browser_add_site_patterns` / `browser_set_site_patterns` / `browser_clear_site_patterns` | Manage remembered site patterns |
| `browser_set_file_input_files` | Attach local files to a page file input |
| `browser_list_downloads` / `browser_clear_downloads` | Inspect and clear tracked downloads |
| `browser_get_resource_budget` / `browser_set_resource_budget` / `browser_clear_resource_budget` | Control CPU, network, and heap budgets |
| `browser_get_location_override` / `browser_set_location_override` / `browser_clear_location_override` | Control geolocation, timezone, and locale overrides |
| `browser_capture_storage` / `browser_get_storage` / `browser_set_storage` / `browser_clear_storage` | Inspect and mutate local/session storage |
| `browser_get_cookies` / `browser_set_cookie` / `browser_delete_cookie` / `browser_clear_cookies` | Inspect and mutate cookies |
| `browser_save_perception_snapshot` / `browser_diff_perception` | Save and compare semantic page snapshots |
| `browser_list_perception_snapshots` / `browser_delete_perception_snapshot` | Manage cached perception snapshots |

---

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "helmstack": {
      "command": "node",
      "args": [
        "/absolute/path/to/helmstack/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "HELMSTACK_PORT": "7070"
      }
    }
  }
}
```

Restart Claude Desktop. A browser icon will appear in the tool panel — Claude can now browse the web on your behalf.

> **From npm:** If you've installed the package globally (`npm i -g @helmstack/mcp-server`), replace the `args` path with the output of `which helmstack-mcp`.

---

### GitHub Copilot (VS Code)

Add to your VS Code `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "helmstack": {
        "type": "stdio",
        "command": "node",
        "args": [
          "/absolute/path/to/helmstack/packages/mcp-server/dist/index.js"
        ],
        "env": {
          "HELMSTACK_PORT": "7070"
        }
      }
    }
  }
}
```

Or place an `.mcp.json` file at the root of your workspace:

```json
{
  "servers": {
    "helmstack": {
      "type": "stdio",
      "command": "node",
      "args": ["./packages/mcp-server/dist/index.js"],
      "env": { "HELMSTACK_PORT": "7070" }
    }
  }
}
```

In VS Code Agent Mode (`@agent`), Copilot will now have access to all `browser_*` tools.

---

### Cursor

In Cursor go to **Settings → MCP** and add:

```json
{
  "mcpServers": {
    "helmstack": {
      "command": "node",
      "args": [
        "/absolute/path/to/helmstack/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "HELMSTACK_PORT": "7070"
      }
    }
  }
}
```

---

### Windsurf (Codeium)

In `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "helmstack": {
      "command": "node",
      "args": [
        "/absolute/path/to/helmstack/packages/mcp-server/dist/index.js"
      ],
      "env": {
        "HELMSTACK_PORT": "7070"
      }
    }
  }
}
```

---

### Zed

In `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "helmstack": {
      "command": {
        "path": "node",
        "args": [
          "/absolute/path/to/helmstack/packages/mcp-server/dist/index.js"
        ],
        "env": {
          "HELMSTACK_PORT": "7070"
        }
      }
    }
  }
}
```

---

### Any MCP-compatible client (generic)

The server communicates over **stdio** using the standard MCP protocol. Pass the command and it will work with any client that respects the spec:

```bash
# Run directly (useful for testing)
node /path/to/helmstack/packages/mcp-server/dist/index.js

# Or via npx after publishing
npx @helmstack/mcp-server
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HELMSTACK_PORT` | `7070` | Port the HelmStack desktop app is listening on |
| `HELMSTACK_HOST` | `127.0.0.1` | Host (never change unless you know what you're doing) |
| `HELMSTACK_AUTH_TOKEN` | unset | Optional shared token. If the desktop app is launched with this set, MCP/SDK clients must send the same value. |
| `HELMSTACK_PROFILE` | `fe-dev` | Preset for the three opt-in surfaces below. `fe-dev` (or unset) = all off (lean front-end instrument); `agent-substrate` / `full` = all on. An explicit per-flag var below always overrides. Set on the relevant process. |
| `HELMSTACK_AGENT_SUBSTRATE` | unset (off) | Opt-in. Registers the autonomous-agent MCP tools (accounts/TOTP, approvals, handoffs, intent). Off by default so the tool surface stays lean for front-end-dev use. Set on the **MCP server** process. |
| `HELMSTACK_SOCIAL` | unset (off) | Opt-in. Enables social-feed/profile/thread perception. Off by default so a plain web app is never mislabelled `social-feed`. Set on the **desktop app** process. |
| `HELMSTACK_STEALTH` | unset (off) | Opt-in. Enables anti-detection hardening + human-like input timing. Off by default for deterministic, fast actuation. Set on the **desktop app** process. |

> **Positioning:** by default HelmStack is a lean front-end-dev instrument. The
> autonomous-web-agent surfaces (substrate tools, social perception, stealth) are
> opt-in via the flags above. See [docs/positioning.md](docs/positioning.md).

---

### Example — Claude browsing the web

Once configured, you can ask Claude (or any connected AI):

> *"Go to github.com/mondb-dev/helmstack, find the latest open issue, and summarise it."*

Claude will call:
1. `browser_list_tabs` → find an active tab
2. `browser_navigate` → go to GitHub
3. `browser_get_perception` → read the page DOM
4. `browser_screenshot` → optionally look at the rendered page
5. Reply with the summary

## Agent Example

HelmStack includes an intent-driven example agent (`apps/agent-example`) that demonstrates the agent SDK.

**What it does:**
1. Connects to the browser at `127.0.0.1:7070`
2. Subscribes to the SSE stream for intent changes
3. When you type a task in the UI task panel and press "Run", the agent:
   - Extracts URLs or search terms from your intent
   - Navigates the active tab
   - Captures perception (page graph, forms, actions, alerts)
   - Logs the results to the terminal panel

**Run it:**

```bash
# Terminal 1: Start the browser
npm run dev

# Terminal 2: Start the intent agent
npm run start -w @helmstack/agent-example
```

Then type an intent in the HelmStack task panel:
- `go to example.com`
- `https://github.com/mondb-dev/helmstack`
- `search for AI browser automation`

The agent logs appear in both your terminal *and* the HelmStack terminal panel.

**Build your own:**

```typescript
import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient();

// Get active tab and perception
const tabs = await browser.listTabs();
const tab = tabs.find(t => t.isActive)!;
const perception = await browser.getPerception(tab.id);

// Execute a command
await browser.execute(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.fill.form-1",
  args: { "field-1": "test@example.com" }
});

// Subscribe to real-time events
browser.stream({
  onPageObserved: (obs) => console.log("Page changed:", obs),
  onIntentChanged: (data) => console.log("New intent:", data.intent)
});
```

See `packages/agent-sdk/src/index.ts` for the full API, or read the complete [Agent SDK documentation](docs/agent-sdk.md).

## Account Vault & TOTP

The browser includes an encrypted account store for credentials and TOTP secrets.

**Features:**
- AES-256-GCM encryption with per-installation key
- Account lookup by origin (automatic matching for login forms)
- TOTP generation for 2FA codes (RFC 6238)
- Vault-backed form filling: `{ kind: "vault", id: "vault.identity.work_email" }`

**Storage:**
- Accounts: `~/Library/Application Support/HelmStack/helmstack-accounts.enc`
- Vault: `~/Library/Application Support/HelmStack/helmstack-vault.enc`
- Keys: `~/Library/Application Support/HelmStack/helmstack-vault.key`

**Agent API:**
```typescript
// List all accounts
const accounts = await browser.listAccounts();

// Find accounts for a specific site
const matched = await browser.lookupAccounts("https://github.com");

// Generate a TOTP code
const totp = await browser.generateTotp(accountId);
console.log(totp.code); // "123456"
```

Accounts are excluded from git (`.gitignore` covers `*.enc`, `*.key`).

## Chrome Extensions

HelmStack supports loading unpacked Chrome/Chromium extensions (DevTools, ad-blockers, etc.).

**Load an extension at runtime:**
```typescript
const extensions = await browser.listExtensions();

// Load from an unpacked extension directory
await browser.loadExtension("/path/to/unpacked-extension");
```

**Or via HTTP:**
```bash
curl -X POST http://127.0.0.1:7070/api/extensions \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/extension"}'
```

Extensions are indexed in `userData/extensions/extensions-index.json` and auto-loaded on startup. CRX files are not supported — unpack them first.

## Anti-Detection

> **Opt-in.** Anti-detection is **off by default** — the default is a clean,
> deterministic browser suited to front-end development and CI. Set
> `HELMSTACK_STEALTH=1` to enable fingerprint hardening **and** human-like input
> timing for autonomous automation. See [docs/security-model.md](docs/security-model.md).

When enabled, the browser hardens each tab against bot-detection fingerprinting using CDP `Page.addScriptToEvaluateOnNewDocument`.

**Patches applied before any site code runs:**
- `navigator.webdriver` → `undefined`
- `window.chrome` → realistic chrome object
- `navigator.plugins` → PDF Viewer + Chrome PDF Plugin
- WebGL `UNMASKED_VENDOR` / `UNMASKED_RENDERER` → realistic GPU strings
- `HTMLCanvasElement.toDataURL` → per-session pixel noise
- `Permissions.prototype.query` → consistent responses
- `navigator.platform` → matched to user-agent OS

These patches run in the page's main JavaScript world and persist across navigations. See `apps/desktop/src/main/anti-detection.ts` for implementation details.

## Front-End Development Quickstart

HelmStack isn't only an autonomous-agent substrate — it's a perception +
execution layer you can point at your own app while you build it. Start the
desktop app, then drive it from a script or your agent via the SDK (set
`HELMSTACK_AUTH_TOKEN` to the token printed on launch, or point
`HELMSTACK_TOKEN_FILE` at `<userData>/helmstack-agent-token`).

```typescript
import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient();           // reads HELMSTACK_AUTH_TOKEN from env
const tabs = await browser.openTab("http://localhost:3000");
const tab = tabs.find((t) => t.isActive)!;

// 1. Capture baselines before a change
await browser.captureNamedScreenshot(tab.id, "before", { fullPage: true });
await browser.savePerceptionSnapshot(tab.id, "before");

// 2. …edit your code, let the dev server hot-reload, then re-capture…
await browser.captureNamedScreenshot(tab.id, "after", { fullPage: true });
await browser.savePerceptionSnapshot(tab.id, "after");

// 3. Diff visually AND structurally
const pixels = await browser.diffScreenshots("before", "after");
const structure = await browser.diffPerception("before", "after");
console.log(`${pixels.diffPercentage}% pixels changed; ${structure.summary}`);

// 4. Audit the result — a11y, design tokens, layout, dark mode
const a11y   = await browser.auditAccessibility(tab.id);
const tokens = await browser.extractDesignTokens(tab.id);          // colors/type/spacing in use
await browser.setMediaEmulation(tab.id, { colorScheme: "dark" });  // test dark mode
await browser.setViewport(tab.id, 390, 844, true);
const layout = await browser.detectLayoutIssues(tab.id);           // why did mobile break?

if (a11y.score < 90 || layout.hasHorizontalOverflow) process.exit(1); // gate CI
```

Baselines (screenshots + perception snapshots) persist to disk under
`<userData>`, so "compare against yesterday" works across restarts and CI runs.
Every capability below is also available as an MCP tool (e.g. `browser_design_tokens`,
`browser_layout_issues`, `browser_media_state`, `browser_export_har`) for use
directly from an AI client.

## Dev Tooling for Web Teams

HelmStack exposes a full suite of dev-team-focused tools via REST and the SDK. All are zero-dependency — no headless mode, no separate service, no config.

### Responsive Multi-Viewport Capture

```typescript
const suite = await browser.captureViewportSuite(tabId);
// Screenshots at mobile (390×844), tablet (768×1024), desktop (1440×900), 4K (2560×1440)
// Optional pixel diffs between viewports
```

### Performance Metrics

```typescript
const perf = await browser.getPerformanceMetrics(tabId);
// LCP, CLS, FID/INP, TBT, TTI, JS heap, layout shifts, DOM nodes
```

### Accessibility Audit

```typescript
const report = await browser.auditAccessibility(tabId);
for (const v of report.violations) {
  console.log(`[${v.impact}] ${v.rule}: ${v.description} — ${v.selector}`);
}
```

### Element Style Inspector

```typescript
const styles = await browser.inspectElementStyles(tabId, ".primary-button");
console.log(styles.elements[0].computed["background-color"]);
console.log(styles.elements[0].contrast?.ratio);

await browser.assertElementStyles(tabId, ".primary-button", [
  { property: "background-color", equals: "#2563eb" },
  { property: "border-radius", min: 6 },
  { property: "font-weight", min: 600 }
]);
```

### Component Tree (React / Vue / Svelte)

```typescript
const ct = await browser.captureComponentTree(tabId);
console.log(`Framework: ${ct.framework}, ${ct.nodeCount} components`);
```

### Visual Snapshot Diff

```typescript
await browser.captureNamedScreenshot(tabId, "before-deploy");
// … make changes …
await browser.captureNamedScreenshot(tabId, "after-deploy");
const diff = await browser.diffScreenshots("before-deploy", "after-deploy");
console.log(`${diff.diffPixelCount} changed pixels across ${diff.diffRegions.length} regions`);
```

### "What Broke?" Post-Deploy Perception Diff

```typescript
await browser.savePerceptionSnapshot(tabId, "pre-deploy");
// … deploy …
await browser.savePerceptionSnapshot(tabId, "post-deploy");
const diff = await browser.diffPerception("pre-deploy", "post-deploy");
console.log(diff.summary); // "2 headings changed, 1 form changed, 3 actions removed."
```

### Three.js Scene Inspector

```typescript
const scene = await browser.captureThreeJsScene(tabId);
// scene.renderer.drawCalls, scene.fps, scene.summary, full object tree
// Feed to an LLM → "847 draw calls — merge these 14 identical meshes"
```

### Natural Language Assertions

```typescript
await browser.assert(tabId, "the cart shows 3 items");
await browser.assert(tabId, "no error messages");
await browser.assert(tabId, "the submit button is disabled");
// Throws AssertionError on failure with plain-English explanation
```

### Storage Inspector

```typescript
// Seed test state
await browser.setStorage(tabId, "local", { "auth-token": "test-jwt" });
await browser.setCookie(tabId, { name: "session_id", value: "test-sess", httpOnly: true });

// Full snapshot
const snap = await browser.captureStorage(tabId);
// snap.localStorage, snap.sessionStorage, snap.cookies, snap.indexedDb
```

See [`docs/dev-team-features.md`](docs/dev-team-features.md) for the complete API reference with request/response shapes and full examples.

## Not Implemented Yet

- packaged OS installers (macOS .dmg, Windows .exe, Linux .AppImage)

## Platforms

HelmStack runs on **macOS, Windows, and Linux** — anywhere Electron runs. Packaged installers are not yet available; run from source for now.

## Run

Install dependencies:

```bash
npm install
```

If npm cache permissions are noisy in your environment:

```bash
npm install --cache .npm-cache
```

Start the desktop app:

```bash
npm run dev
```

The dev runner now restarts Electron on source changes.

## Try It

### With the UI

1. Launch the app with `npm run dev`.
2. Use the address bar with:
   - `example.com`
   - `https://example.com`
   - `linear app signup`
3. Click `Open Fixture` to load the built-in contact-form test page.
4. Click `Run Fixture` to:
   - fill name and work email from the local test vault
   - fill the rest of the contact form
   - pause on approval before submit
5. Click `Approve` in the modal to complete the submission.
6. Click `Capture Graph` to inspect the refreshed page graph in the side panel.

### With an Agent

1. Start the browser: `npm run dev`
2. Start the example agent: `npm run start -w @helmstack/agent-example`
3. Type an intent in the task panel (e.g., "go to github.com")
4. Press "Run"
5. Watch the agent logs in the terminal panel

### With DevTools

For deeper testing, open DevTools in the app window and use the preload API:

```js
const tabs = await window.browserShell.listTabs();
const tab = tabs.find((t) => t.isActive);

await window.browserShell.getPerceptionPacket(tab.id);
await window.browserShell.listCapabilityManifests(tab.id);
```

Execute a DOM-backed tool:

```js
await window.browserShell.executeCommand(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.read_page_state",
  args: {}
});
```

If the page exposes a detected form:

```js
await window.browserShell.executeCommand(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.fill.form-1",
  args: {
    "field-1": "test@example.com",
    "field-2": "Password123!"
  }
});
```

Then:

```js
await window.browserShell.executeCommand(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.submit.form-1",
  args: {}
});
```

## Test Contact Form

Use the built-in fixture path first. It does not require a local HTTP server.

Open the app:

```bash
npm run dev
```

Then either:
- click `Open Fixture`
- or navigate directly to:

```text
file:///Users/your-user/path/to/HelmStack/apps/desktop/test-pages/contact-form.html
```

The app also includes a one-click `Run Fixture` flow that uses the local test vault and pauses for approval before submit.

If you still want to serve the fixture over `http://127.0.0.1`, use:

```bash
npm run serve:test-pages
```

What this page tests:
- labeled required fields
- email validation
- select input
- consent checkbox
- inline error alert
- client-side success state after submit

Manual perception check:

1. Click `Capture Graph`.
2. Confirm the page is classified as a contact-style form page.
3. Confirm the form fields appear in the side panel output.

Manual execution check in DevTools:

```js
const tabs = await window.browserShell.listTabs();
const tab = tabs.find((t) => t.isActive);

await window.browserShell.getPerceptionPacket(tab.id);
await window.browserShell.executeCommand(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.fill.form-1",
  args: {
    "field-1": { kind: "vault", id: "vault.identity.full_name" },
    "field-2": { kind: "vault", id: "vault.identity.work_email" },
    "field-3": "sales",
    "field-4": "25",
    "field-5": "I want to test the browser substrate on a controlled contact form.",
    "field-6": true
  }
});

await window.browserShell.executeCommand(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.submit.form-1",
  args: {}
});
```

Expected result:
- the page remains in place
- the browser pauses for approval before submit
- a success message appears
- a fresh perception capture shows the success status/alert
- if consent is omitted or the email is invalid, an inline error appears instead

## Test

Run perception tests:

```bash
npm run test:perception
```

Run TypeScript verification:

```bash
npx tsc --noEmit -p apps/desktop/tsconfig.json
```

Build the app:

```bash
npm run build
```

Create a release-ready macOS app bundle:

```bash
npm run package:mac
```

Output:
- `apps/desktop/release/HelmStack.app`
- `apps/desktop/release/HelmStack-<version>-mac-<arch>.zip`

## Immediate Next Steps

1. **Origin allowlisting UI** — optional browser-managed allowlist for REST clients outside the stdio MCP bridge
2. **MCP resources/prompts** — expose large cached artifacts as MCP resources and add reusable prompts for audits/regressions
3. **LLM agent examples** — OpenAI, Anthropic, LangGraph integration demos beyond the basic intent agent
4. **Installers and notarization** — macOS .dmg/notarization, Windows .exe, Linux .AppImage/.deb
5. **Multi-account session isolation** — separate cookie jars per account/profile

## Contributing

We welcome contributions! Please read the [Contributing Guide](./CONTRIBUTING.md) before submitting a PR.

**Quick start:**

```bash
git clone https://github.com/<your-username>/helmstack.git
cd helmstack
npm install
git checkout develop
git checkout -b feature/my-feature
```

All PRs should target the `develop` branch. We use [Conventional Commits](https://conventionalcommits.org) — commit messages are validated automatically.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide on branch strategy, commit conventions, and the PR process.

## License

[MIT](./LICENSE) — Copyright (c) 2025-present HelmStack Contributors
