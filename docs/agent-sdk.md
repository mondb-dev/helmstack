# HelmStack Agent SDK

The `@helmstack/agent-sdk` package provides a TypeScript client for building agents that connect to the HelmStack browser substrate.

## Installation

```bash
npm install @helmstack/agent-sdk
```

**Note:** The SDK is currently part of the HelmStack monorepo and not yet published to npm. To use it in your project:

1. Clone the HelmStack repo
2. Use npm workspaces or link it locally:
   ```bash
   cd /path/to/helmstack
   npm link packages/agent-sdk

   cd /path/to/your-agent
   npm link @helmstack/agent-sdk
   ```

Or reference it directly in your `package.json`:
```json
{
  "dependencies": {
    "@helmstack/agent-sdk": "file:../helmstack/packages/agent-sdk"
  }
}
```

## Quick Start

```typescript
import { createBrowserClient } from "@helmstack/agent-sdk";

// Connect to the browser (default: 127.0.0.1:7070)
const browser = createBrowserClient();

// Health check
const health = await browser.health();
console.log(`Connected. ${health.tabs} tabs open.`);

// Get active tab
const tabs = await browser.listTabs();
const tab = tabs.find(t => t.isActive);

// Navigate
await browser.navigate(tab.id, "https://example.com");

// Get page perception
const perception = await browser.getPerception(tab.id);
console.log(`Page: ${perception.result.snapshot.title}`);
console.log(`Forms: ${perception.result.graph.forms.length}`);

// Execute a command
await browser.execute(tab.id, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.fill.form-1",
  args: {
    "field-1": "test@example.com",
    "field-2": "password123"
  }
});
```

## Configuration

```typescript
import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient({
  host: "127.0.0.1",    // default
  port: 7070,            // default
  timeout: 30000,        // default: 30s
  authToken: process.env.HELMSTACK_AUTH_TOKEN // optional
});
```

## Core APIs

### Tab Management

```typescript
// List all tabs
const tabs = await browser.listTabs();

// Open a new tab
await browser.openTab("https://example.com");

// Navigate existing tab
await browser.navigate(tabId, "https://github.com");

// Set viewport size
await browser.setViewport(tabId, 1280, 720, false);
```

### Perception

```typescript
// Get full page perception packet
const perception = await browser.getPerception(tabId);

// Access the semantic page graph
const graph = perception.result.graph;
console.log(`Page kind: ${graph.pageKind}`);
console.log(`Forms: ${graph.forms.length}`);
console.log(`Actions: ${graph.actions.length}`);
console.log(`Headings: ${graph.headings.map(h => h.text)}`);

// Get capability manifests
const manifests = await browser.listManifests(tabId);

// Get screenshot (base64 PNG)
const screenshot = await browser.getScreenshot(tabId);
const base64 = screenshot.data;

// Or get raw Buffer for vision APIs
const buffer = await browser.getScreenshotBuffer(tabId);
```

### Execution

```typescript
// Fill a form
await browser.execute(tabId, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.fill.form-1",
  args: {
    "field-1": "value1",
    "field-2": { kind: "vault", id: "vault.identity.work_email" }
  }
});

// Submit a form (pauses for approval)
await browser.execute(tabId, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.submit.form-1",
  args: {}
});

// Click an action
await browser.execute(tabId, {
  type: "invoke_site_tool",
  provider: "dom",
  toolName: "dom.activate.action-123",
  args: {}
});

// Low-level commands
await browser.execute(tabId, {
  type: "browser_action",
  action: "click",
  selector: "#login-button"
});
```

### Approvals

Sensitive actions (form submits) require user approval. Handle them with:

```typescript
// List pending approvals
const approvals = await browser.listApprovals();

// Approve
await browser.approveCommand(approvalId);

// Reject
await browser.rejectCommand(approvalId);
```

### Human Handoffs

Request user intervention when the agent is blocked:

```typescript
// Request handoff — reason must be one of: "captcha" | "2fa" | "payment" | "legal"
await browser.execute(tabId, {
  type: "await_human",
  reason: "captcha"
});

// Wait for user to resolve it (polls SSE stream)
await browser.waitForHandoffResolved(requestId, 120000);

// Or manually check
const handoffs = await browser.listHandoffs();

// Resolve
await browser.resolveHandoff(requestId);

// Cancel
await browser.cancelHandoff(requestId);
```

### Accounts & TOTP

```typescript
// List all accounts
const accounts = await browser.listAccounts();

// Find accounts for a specific origin
const matched = await browser.lookupAccounts("https://github.com");

// Create account
await browser.saveAccount({
  label: "GitHub",
  origins: ["https://github.com"],
  username: "user@example.com",
  password: "secret",
  totpSeed: "JBSWY3DPEHPK3PXP"   // base32 TOTP seed (optional)
});

// Update account
await browser.updateAccount(accountId, {
  password: "new-password"
});

// Delete account
await browser.deleteAccount(accountId);

// Generate TOTP code
const totp = await browser.generateTotp(accountId);
console.log(totp.code);      // "123456"
console.log(totp.expiresIn); // seconds until code expires (max 30)
```

### Intent System

```typescript
// Get current intent from task panel
const { intent } = await browser.getIntent();

// Set intent (triggers agents listening to the stream)
await browser.setIntent("go to github.com and check notifications");
```

### Logging

```typescript
// Log to HelmStack terminal panel
await browser.log("Processing login form", "agent");
await browser.log("Navigation complete", "nav");
await browser.log("Error occurred", "error");
```

## Real-Time Events (SSE)

Subscribe to browser events via Server-Sent Events:

```typescript
const stream = browser.stream({
  // Tab state changes
  onTabsChanged: (tabs) => {
    console.log(`${tabs.length} tabs open`);
  },

  // Page content updated
  onPageObserved: (observation) => {
    console.log("Page changed:", observation.tabId);
  },

  // Approval needed
  onApprovalQueued: (approval) => {
    console.log("Action needs approval:", approval);
  },

  // Human handoff requested
  onHandoffRequested: (handoff) => {
    console.log("Agent needs help:", handoff.reason);
  },

  // Handoff resolved
  onHandoffResolved: (data) => {
    console.log("Handoff resolved:", data.requestId);
  },

  // Intent changed
  onIntentChanged: (data) => {
    console.log("New intent:", data.intent);
  },

  // Agent logs
  onAgentLog: (data) => {
    console.log(`[${data.level}] ${data.message}`);
  },

  // Stream errors
  onError: (err) => {
    console.error("SSE error:", err);
  }
});

// Later: disconnect
stream.close();
```

The SSE stream automatically reconnects on disconnection.

## Example Agents

### Intent-Driven Agent

```typescript
import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient();

async function handleIntent(intent: string, tabId: string) {
  // Parse intent
  const urlMatch = intent.match(/https?:\/\/[^\s]+/);

  if (urlMatch) {
    // Navigate to explicit URL
    await browser.navigate(tabId, urlMatch[0]);
  } else {
    // Search Google
    const query = encodeURIComponent(intent);
    await browser.navigate(tabId, `https://www.google.com/search?q=${query}`);
  }

  // Wait for page load
  await new Promise(r => setTimeout(r, 2000));

  // Get perception
  const perception = await browser.getPerception(tabId);
  const graph = perception.result.graph;

  console.log(`Page: ${perception.result.snapshot.title}`);
  console.log(`Forms: ${graph.forms.length}`);
  console.log(`Actions: ${graph.actions.length}`);
}

// Listen for intents
browser.stream({
  onIntentChanged: async (data) => {
    const tabs = await browser.listTabs();
    const tab = tabs.find(t => t.isActive);
    if (tab) {
      await handleIntent(data.intent, tab.id);
    }
  }
});
```

### Form-Filling Agent

```typescript
import { createBrowserClient } from "@helmstack/agent-sdk";

const browser = createBrowserClient();

async function fillLoginForm(tabId: string, origin: string) {
  // Get perception
  const perception = await browser.getPerception(tabId);
  const forms = perception.result.graph.forms;

  // Find login form
  const loginForm = forms.find(f =>
    f.purpose?.includes("login") ||
    f.purpose?.includes("sign-in")
  );

  if (!loginForm) {
    console.log("No login form found");
    return;
  }

  // Lookup accounts for this origin
  const accounts = await browser.lookupAccounts(origin);
  if (accounts.length === 0) {
    console.log("No saved accounts for", origin);
    return;
  }

  const account = accounts[0];

  // Fill form
  const usernameField = loginForm.fields.find(f =>
    f.fieldType === "email" || f.label?.includes("username")
  );
  const passwordField = loginForm.fields.find(f =>
    f.fieldType === "password"
  );

  if (usernameField && passwordField) {
    await browser.execute(tabId, {
      type: "invoke_site_tool",
      provider: "dom",
      toolName: `dom.fill.${loginForm.id}`,
      args: {
        [usernameField.id]: account.username,
        [passwordField.id]: account.password
      }
    });

    console.log("Form filled, ready to submit");
  }
}
```

### TOTP 2FA Agent

```typescript
async function handle2FA(tabId: string) {
  const perception = await browser.getPerception(tabId);
  const forms = perception.result.graph.forms;

  // Find TOTP input
  const totpForm = forms.find(f =>
    f.fields.some(field =>
      field.label?.toLowerCase().includes("code") ||
      field.label?.toLowerCase().includes("2fa") ||
      field.label?.toLowerCase().includes("verify")
    )
  );

  if (!totpForm) return;

  // Get current origin
  const origin = perception.result.snapshot.url;
  const accounts = await browser.lookupAccounts(origin);

  if (accounts.length === 0) return;

  // Generate TOTP
  const totp = await browser.generateTotp(accounts[0].id);

  // Fill code
  const codeField = totpForm.fields[0];
  await browser.execute(tabId, {
    type: "invoke_site_tool",
    provider: "dom",
    toolName: `dom.fill.${totpForm.id}`,
    args: {
      [codeField.id]: totp.code
    }
  });

  console.log("TOTP code filled:", totp.code);
}
```

## Dev Tooling for Web Teams

All dev-team tools are available on `BrowserClient` with no extra configuration.

### Viewport Suite

```typescript
const suite = await browser.captureViewportSuite(tabId);
// Screenshots at mobile / tablet / desktop / 4K simultaneously
// Optionally includes pixel diffs between adjacent breakpoints
for (const entry of suite.captures) {
  console.log(`${entry.preset}: ${entry.screenshot.width}×${entry.screenshot.height}`);
}
```

### Performance Metrics

```typescript
const perf = await browser.getPerformanceMetrics(tabId);
console.log(`LCP: ${perf.lcp}ms  CLS: ${perf.cls}  TBT: ${perf.tbt}ms`);
console.log(`JS heap: ${(perf.jsHeapUsed / 1e6).toFixed(1)} MB`);
```

### Accessibility Audit

```typescript
const report = await browser.auditAccessibility(tabId);
for (const v of report.violations) {
  console.log(`[${v.impact}] ${v.rule}: ${v.description}`);
  console.log(`  selector: ${v.selector}`);
}
```

### Element Style Inspector

```typescript
const styles = await browser.inspectElementStyles(tabId, ".primary-button");
const button = styles.elements[0];

console.log(button.bounds);
console.log(button.box.padding);
console.log(button.computed["background-color"]);
console.log(button.contrast?.ratio);
console.log(button.issues);

await browser.assertElementStyles(tabId, ".primary-button", [
  { property: "background-color", equals: "#2563eb" },
  { property: "border-radius", min: 6 },
  { property: "font-weight", min: 600 }
]);
```

### Component Tree

```typescript
const ct = await browser.captureComponentTree(tabId);
// Detects React 16-18, Vue 2/3, Svelte
console.log(`Framework: ${ct.framework}, ${ct.nodeCount} components`);
```

### Visual Snapshot Diff

```typescript
await browser.captureNamedScreenshot(tabId, "before");
// … make changes …
await browser.captureNamedScreenshot(tabId, "after");
const diff = await browser.diffScreenshots("before", "after");
console.log(`${diff.diffPixelCount} changed pixels`);
console.log(`${diff.diffRegions.length} change regions`);
// diff.diffImageData — blended overlay (40% original + 60% red tint)
```

### Perception Diff ("What Broke?")

```typescript
await browser.savePerceptionSnapshot(tabId, "pre-deploy");
// … deploy your changes …
await browser.savePerceptionSnapshot(tabId, "post-deploy");
const diff = await browser.diffPerception("pre-deploy", "post-deploy");
console.log(diff.summary);
for (const change of diff.changes) {
  console.log(`[${change.kind}] ${change.description}`);
}
```

### Three.js Scene Inspector

```typescript
const report = await browser.captureThreeJsScene(tabId);
if (report.detected) {
  console.log(`Draw calls: ${report.renderer?.drawCalls}`);
  console.log(`FPS: ${report.fps?.fps}`);
  // Feed report to an LLM for AI code feedback
}
```

### Natural Language Assertions

```typescript
// Throws AssertionError on failure (default):
await browser.assert(tabId, "the checkout button is visible");
await browser.assert(tabId, "there are no error messages");
await browser.assert(tabId, "the cart shows 3 items");
await browser.assert(tabId, "the submit button is disabled");

// Get raw result without throwing:
const r = await browser.assert(tabId, "the total is correct", { throw: false });
if (!r.pass) {
  console.log(`FAIL (${r.confidence}): ${r.explanation}`);
  // r.evidence — compact page-graph bundle for LLM forwarding
}
```

### Storage Inspector

```typescript
// Full snapshot
const snap = await browser.captureStorage(tabId);
console.log(`${snap.localStorage.length} localStorage keys`);
console.log(`${snap.cookies.length} cookies`);
console.log(`${snap.indexedDb.length} IndexedDB databases`);

// Seed test state
await browser.setStorage(tabId, "local", { "auth-token": "test-jwt", "user-id": "42" });
await browser.setCookie(tabId, { name: "session_id", value: "test-sess", httpOnly: true });

// Read & clean up
const entries = await browser.getStorage(tabId, "local", "auth-token");
await browser.clearStorage(tabId, "session");
await browser.clearCookies(tabId);
```

See [`docs/dev-team-features.md`](dev-team-features.md) for the complete reference, request/response shapes, and more examples.

## TypeScript Types

The SDK re-exports all shared types for convenience:

```typescript
import type {
  AssertionConfidence,
  AssertionEvidence,
  AssertionResult,
  BrowserPerceptionPacket,
  BrowserOutputCommand,
  BrowserCommandResult,
  CookieEntry,
  IndexedDbDatabase,
  PageGraph,
  SiteCapabilityManifest,
  StorageArea,
  StorageEntry,
  StorageReport,
  TabSummary,
  AccountSummary,
  ThreeSceneReport,
  TotpResult
} from "@helmstack/agent-sdk";
```

## Error Handling

```typescript
try {
  const result = await browser.execute(tabId, command);
  if (!result.success) {
    console.error("Command failed:", result.error);
  }
} catch (err) {
  if (err.message.includes("HTTP 404")) {
    console.error("Tab not found");
  } else if (err.message.includes("timeout")) {
    console.error("Request timed out");
  } else {
    console.error("Unexpected error:", err);
  }
}
```

## Prerequisites

The HelmStack browser must be running before connecting:

```bash
# Terminal 1: Start the browser
cd /path/to/helmstack
npm run dev

# Terminal 2: Start your agent
cd /path/to/your-agent
npm start
```

The agent server listens on `127.0.0.1:7070` by default.

## Full Example

See `apps/agent-example/src/index.ts` in the HelmStack repo for a complete working example.
