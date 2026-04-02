# HelmStack

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
- `webmcp` is scaffolded for detection and future invocation

## Repository Layout

- `apps/desktop`: Electron shell, HTTP+SSE agent server, tab manager, preload bridge, capability registry, DOM actuator, vault, approvals, anti-detection
- `apps/agent-example`: Intent-driven example agent showing how to connect to the browser substrate
- `packages/agent-sdk`: Zero-dependency TypeScript client for the agent server HTTP+SSE API
- `packages/perception`: DOM observation, shadow-root/iframe traversal, semantic graph normalization
- `packages/shared`: shared browser, perception, substrate, and WebMCP contracts
- `docs/webmcp-ready.md`: architecture notes for pluggable cognition and WebMCP alignment
- `docs/agent-sdk.md`: complete Agent SDK reference with examples

## Implemented

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

The browser hardens each tab against bot-detection fingerprinting using CDP `Page.addScriptToEvaluateOnNewDocument`.

**Patches applied before any site code runs:**
- `navigator.webdriver` → `undefined`
- `window.chrome` → realistic chrome object
- `navigator.plugins` → PDF Viewer + Chrome PDF Plugin
- WebGL `UNMASKED_VENDOR` / `UNMASKED_RENDERER` → realistic GPU strings
- `HTMLCanvasElement.toDataURL` → per-session pixel noise
- `Permissions.prototype.query` → consistent responses
- `navigator.platform` → matched to user-agent OS

These patches run in the page's main JavaScript world and persist across navigations. See `apps/desktop/src/main/anti-detection.ts` for implementation details.

## Not Implemented Yet

- real WebMCP invocation
- media perception for video/audio
- packaged OS installers (macOS, Windows, Linux)

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

## Immediate Next Steps

1. **WebMCP invocation** — real site-provided structured capabilities (detection is scaffolded, invocation is not)
2. **Media perception** — video/audio state capture for YouTube, streaming sites, etc.
3. **Action recovery** — robust retry strategies for flaky DOM targets and navigation timing
4. **LLM agent examples** — OpenAI, Anthropic, LangGraph integration demos beyond the basic intent agent
5. **Packaged installers** — macOS .dmg, Windows .exe, Linux .AppImage/.deb
6. **Multi-account session isolation** — separate cookie jars per account/profile
