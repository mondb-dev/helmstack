# HelmStack

HelmStack is an AI-native browser substrate.

The browser is the eyes and hands:
- perception of live web state
- grounded execution on the page
- approvals and safety boundaries
- site capability discovery

The cognition layer is external and pluggable:
- OpenAI
- Anthropic
- LangGraph
- MCP clients
- custom agents

The goal is not to bolt an assistant onto a normal browser. The goal is to expose a browser runtime that any agent can use as a perception/output system.

## Current Architecture

### Browser Substrate

The browser owns:
- tabs and session state
- DOM and accessibility perception
- same-origin iframe and open shadow-root traversal
- DOM-grounded execution
- per-tab capability manifests
- WebMCP readiness as a site capability provider slot

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

- `apps/desktop`: Electron shell, tab manager, preload bridge, capability registry, DOM actuator
- `packages/perception`: DOM observation, shadow-root/iframe traversal, semantic graph normalization
- `packages/shared`: shared browser, perception, substrate, and WebMCP contracts
- `docs/webmcp-ready.md`: architecture notes for pluggable cognition and WebMCP alignment

## Implemented

- custom Electron browser shell
- `WebContentsView` tab surface
- live page observation stream
- DOM snapshot + accessibility-tree capture
- semantic `PageGraph` normalization
- same-origin iframe perception
- open shadow-root perception
- DOM capability manifests generated per tab
- unified `BrowserPerceptionPacket`
- local test vault with secret refs for fixture automation
- approval gate for sensitive submit actions
- in-app contact-form fixture runner
- DOM-grounded execution for:
  - observed action activation
  - observed form fill with literal or vault-backed values
  - observed form submit with approval pause
  - low-level `click`, `type` with literal or vault-backed values, `select`, `submit`
- post-action perception refresh
- perception regression tests with fixture and golden coverage

## LLM Agent Example

Run the Vertex AI (Gemini) agentic loop:

```bash
VERTEX_PROJECT=your-gcp-project \
GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
npm run llm -w @helmstack/agent-example
```

Optionally set a custom task:

```bash
TASK="Go to Wikipedia and find today's featured article" \
VERTEX_PROJECT=your-gcp-project \
GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json \
npm run llm -w @helmstack/agent-example
```

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

1. Implement real WebMCP detection and invocation.
2. Add media perception for video/audio.
3. Robust browser action recovery and retry strategies.
4. Packaged installers for macOS, Windows, and Linux.
