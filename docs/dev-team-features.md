# Dev Team Feature Backlog

Features particularly valuable for teams actively developing web sites and apps with HelmStack.

---

## ✅ Implemented

### 1. Console + Network Log Capture
Stream JS errors, console output, and network request outcomes from the live page into the agent layer without any instrumentation code.

**API**
```
GET    /api/tabs/:id/logs      → { consoleLogs, networkRequests, jsErrors }
DELETE /api/tabs/:id/logs      → clears buffers for that tab
```
**SDK**
```typescript
const logs = await browser.getLogs(tabId);
logs.consoleLogs;       // ConsoleLogEntry[] — level, text, url, lineNumber
logs.networkRequests;   // NetworkRequestEntry[] — url, method, statusCode, failed, errorText
logs.jsErrors;          // string[] — uncaught exception descriptions
await browser.clearLogs(tabId);
```
**How it works**: Enables CDP `Runtime`, `Log`, and `Network` domains on first snapshot. Events are buffered per-tab and cleared on navigation.

---

### 2. Network Mock / Intercept
Intercept HTTP requests and return custom responses — without touching backend code. Ideal for testing error states, offline behavior, or slow APIs.

**API**
```
POST   /api/tabs/:id/mock      { rules: NetworkInterceptRule[] }
GET    /api/tabs/:id/mock      → { rules }
DELETE /api/tabs/:id/mock      → disables interception
```
**SDK**
```typescript
await browser.enableNetworkMock(tabId, [
  {
    urlPattern: "*/api/products*",
    method: "GET",
    responseStatus: 200,
    responseBody: { items: [], total: 0 }
  },
  {
    urlPattern: "*/api/checkout",
    responseStatus: 503,
    responseBody: { error: "Service unavailable" }
  }
]);

// After testing:
await browser.disableNetworkMock(tabId);
```
**Rule matching**: `urlPattern` supports `*` wildcards or `/regex/flags` syntax. `method` is optional (matches any method if omitted). `responseBody` objects are auto-JSON-serialized with `Content-Type: application/json`.

**How it works**: Uses CDP `Fetch.enable` with `requestStage: "Request"` to intercept before the request hits the network. Non-matching requests are passed through transparently.

---

### 3. Visual Snapshot Diff ✅
Capture named screenshots and compare them pixel-by-pixel. Returns a diff percentage, a list of changed **regions** (bounding boxes), and a highlighted overlay image showing exactly what changed — context preserved.

**API**
```
POST   /api/tabs/:id/screenshot/named  { snapshotId: string } → PageScreenshot
POST   /api/screenshots/diff           { beforeId, afterId }  → ScreenshotDiff
GET    /api/screenshots                                        → SnapshotEntry[]
DELETE /api/screenshots/:id                                    → { ok: true }
```
**SDK**
```typescript
// Capture baselines
await browser.captureNamedScreenshot(tabId, "before-deploy");
// ... deploy changes ...
await browser.captureNamedScreenshot(tabId, "after-deploy");

// Compare
const diff = await browser.diffScreenshots("before-deploy", "after-deploy");
console.log(`${diff.diffPercentage}% of pixels changed (${diff.diffPixelCount} px)`);

// Inspect changed regions — useful for AI agents and CI reporters
for (const region of diff.diffRegions) {
  console.log(`Change at (${region.x}, ${region.y}), ${region.width}×${region.height}px`);
}

// diff.diffImageData — base64 PNG with changed pixels tinted red over the original

// List and clean up cached snapshots
const list = await browser.listScreenshots();
// [{ id, tabId, url, width, height, capturedAt }, ...]

await browser.deleteScreenshot("before-deploy");
await browser.deleteScreenshot("after-deploy");
```

**Response shape** (`ScreenshotDiff`):
```typescript
interface ScreenshotDiff {
  beforeId: string;
  afterId: string;
  diffPixelCount: number;
  diffPercentage: number;         // 0–100, two decimal places
  totalPixels: number;
  width: number;
  height: number;
  diffRegions: DiffRegion[];      // bounding boxes of changed clusters
  diffImageData?: string;         // base64 PNG — red tint over original
  capturedAt: number;
}

interface DiffRegion {
  x: number; y: number;           // top-left pixel offset
  width: number; height: number;
}
```

**How it works**: Electron `nativeImage.createFromDataURL()` decodes each PNG into a raw BGRA bitmap. Per-pixel comparison uses a ±10 per-channel tolerance to ignore sub-pixel rendering noise. Changed pixels are highlighted by blending 40% original + 60% red (instead of solid red), so surrounding context remains legible. Diff regions are computed by scanning changed pixels and merging any clusters within 8px of each other into a single bounding box.

---

## 🟡 High Value — Not Yet Implemented

### 4. Performance Metrics ✅
Surface Core Web Vitals (LCP, FCP, CLS, INP, TTFB) from CDP `Performance` domain + `window.performance` APIs alongside each perception packet.

**API**
```
GET /api/tabs/:id/performance  → PerformanceReport
```
**SDK**
```typescript
const perf = await browser.getPerformanceMetrics(tabId);

// Core Web Vitals
console.log(`LCP:  ${perf.vitals.lcp}ms`);
console.log(`FCP:  ${perf.vitals.fcp}ms`);
console.log(`CLS:  ${perf.vitals.cls}`);   // raw score (×1000 for display)
console.log(`INP:  ${perf.vitals.inp}ms`);
console.log(`TTFB: ${perf.vitals.ttfb}ms`);

// Navigation Timing breakdown
if (perf.navigation) {
  console.log(`DNS: ${perf.navigation.dns}ms`);
  console.log(`Connect: ${perf.navigation.connect}ms`);
  console.log(`DOM Load: ${perf.navigation.domComplete}ms`);
  console.log(`Page Load: ${perf.navigation.loadEvent}ms`);
}

// Slowest resources (top 20)
for (const res of perf.slowResources) {
  console.log(`${res.name}: ${res.duration}ms (${res.type})`);
}

// Raw CDP counters
console.log("JS heap:", perf.rawMetrics?.find(m => m.name === "JSHeapUsedSize")?.value);
```

**Response shape** (`PerformanceReport`):
```typescript
interface PerformanceReport {
  capturedAt: string;          // ISO timestamp
  url: string;
  vitals: CoreWebVitals;       // lcp, fcp, cls, inp, ttfb — all nullable
  navigation: NavigationTiming | null; // full NavTiming L1 breakdown
  slowResources: ResourceTimingEntry[];// top-20 longest resource loads
  rawMetrics: { name: string; value: number }[] | null; // raw CDP counters
}
```

**How it works**: CDP `Performance.enable`/`getMetrics` supplies V8/Blink counters; `Runtime.evaluate` queries `window.performance.timing` (Navigation Timing L1) and `performance.getEntriesByType()` for LCP, FCP, CLS (sum of non-input-gated shifts), and INP (longest event entry). Top-20 slowest resources sorted by duration are returned from `getEntriesByType("resource")`.

### 5. Storage Inspector
Read and write `localStorage`, `sessionStorage`, cookies, and `IndexedDB` via CDP `Storage`/`IndexedDB` domains. Useful for seeding test data or inspecting auth state.

```typescript
await browser.setLocalStorage(tabId, { "auth-token": "test-jwt-xxx" });
const token = await browser.getLocalStorage(tabId, "auth-token");
await browser.clearCookies(tabId, "https://app.example.com");
```

### 6. Interaction Recorder → Test Script
Record a sequence of agent actions on a tab and export them as a replayable HelmStack script. Dramatically speeds up writing regression tests.

```typescript
browser.startRecording(tabId);
// ... do things in the browser ...
const script = await browser.stopRecording(tabId);
// exports: navigate, click, fill_form, submit steps with real selectors
```

### 7. Accessibility Audit ✅
Run a WCAG 2.2-aligned rule set directly against the live AX tree. No external tooling needed — the AX tree is already captured during every perception call.

**API**
```
GET /api/tabs/:id/a11y  → A11yAuditReport
```
**SDK**
```typescript
const report = await browser.auditAccessibility(tabId);

// Print all violations
for (const v of report.violations) {
  console.log(`[${v.impact}] ${v.rule}: ${v.description}`);
  console.log(`  selector: ${v.selector}`);
}

console.log(`${report.passes} nodes passed, ${report.violations.length} violations`);
console.log(`Checked ${report.nodeCount} AX nodes`);
```

**Response shape** (`A11yAuditReport`):
```typescript
interface A11yAuditReport {
  tabId: string;
  url: string;
  capturedAt: number;          // Unix ms
  violations: A11yViolation[];
  passes: number;              // nodes that passed all rules
  nodeCount: number;           // total AX nodes inspected
}

interface A11yViolation {
  rule: string;       // e.g. "1.1.1-image-alt"
  impact: "critical" | "serious" | "moderate" | "minor";
  selector: string;   // CSS-style selector hint for the offending node
  description: string;
  role: string;       // AX role, e.g. "img", "button"
  name?: string;      // accessible name, if any
}
```

**Rules implemented:**
| Rule ID | WCAG SC | Description |
|---|---|---|
| `1.1.1-image-alt` | 1.1.1 | Images must have a non-empty accessible name |
| `2.4.6-label` | 2.4.6 | Buttons and links must have a discernible name |
| `1.3.1-input-label` | 1.3.1 | Text inputs must have an associated label |
| `4.1.3-disabled-label` | 4.1.3 | Disabled controls still need accessible names |

**How it works**: CDP `Accessibility.getFullAXTree` returns all AX nodes. Each node is checked against the rule set. Nodes with `backendDOMNodeId` get a stable selector hint; others fall back to a role-based selector.

---

### 8. Component Tree Awareness ✅
Probe React, Vue 3, Vue 2, or Svelte devtools hooks and return a lightweight component tree. Runs entirely in-page via `Runtime.evaluate` — no browser extension required.

**API**
```
GET /api/tabs/:id/component-tree  → ComponentTreeReport
```
**SDK**
```typescript
const ct = await browser.captureComponentTree(tabId);

console.log(`Framework: ${ct.framework}`);  // "react" | "vue" | "svelte" | "unknown"
console.log(`${ct.nodeCount} component nodes`);

function printTree(node, depth = 0) {
  const indent = "  ".repeat(depth);
  const props = Object.entries(node.props).map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`${indent}<${node.name}${props ? " " + props : ""}>`);
  for (const child of node.children) printTree(child, depth + 1);
}

if (ct.tree) printTree(ct.tree);
```

**Response shape** (`ComponentTreeReport`):
```typescript
interface ComponentTreeReport {
  tabId: string;
  url: string;
  capturedAt: number;
  framework: "react" | "vue" | "svelte" | "angular" | "unknown";
  tree: ComponentNode | null;  // null if no devtools hook detected
  nodeCount: number;
}

interface ComponentNode {
  name: string;
  props: Record<string, string>;  // shallow, values truncated to 80 chars
  children: ComponentNode[];
}
```

**Detection strategy:**
| Framework | Hook | Notes |
|---|---|---|
| React 16–18 | `__reactFiber` / `__reactInternalInstance` on DOM nodes | Works in dev builds; production needs `enableDebugTools` |
| Vue 3 | `__vue_app__` on root element | Set by Vue's mount() |
| Vue 2 | `__vue__` on root element | Set by Vue's $mount() |
| Svelte | `window.__svelte__` | Available in dev mode |

Props are shallow-stringified (functions shown as `[function]`, objects as `[object]`) to keep payloads small. Tree depth is capped at 30 levels.

### 9. Responsive Multi-Viewport Comparison ✅
Capture screenshots at multiple named breakpoints in one call, with optional pairwise pixel diffs. Saves and restores the original viewport.

**API**
```
POST /api/tabs/:id/viewport-suite   { presets?, includeDiffs? } → ViewportSuiteReport
```
**SDK**
```typescript
// Quick: capture default set (mobile, tablet, laptop, desktop)
const report = await browser.captureViewportSuite(tabId);

// Custom presets + diffs
const report = await browser.captureViewportSuite(
  tabId,
  ["mobile", "tablet", "desktop", "wide"],
  true   // includeDiffs
);

for (const { preset, screenshot } of report.captures) {
  console.log(`${preset.label}: ${screenshot.width}×${screenshot.height}`);
}

for (const { from, to, diff } of report.diffs) {
  console.log(`${from} → ${to}: ${diff.diffPercentage}% changed`);
}
```
**Available presets**
| Name | Resolution | Device |
|---|---|---|
| `mobile-sm` | 375×667 | Mobile S |
| `mobile` | 390×844 | Mobile |
| `mobile-lg` | 430×932 | Mobile L |
| `tablet` | 768×1024 | Tablet |
| `tablet-lg` | 1024×1366 | Tablet L |
| `laptop` | 1280×800 | Laptop |
| `desktop` | 1440×900 | Desktop |
| `wide` | 1920×1080 | Wide |

**How it works**: Iterates presets, calling `Emulation.setDeviceMetricsOverride` + 200ms reflow settle + `Page.captureScreenshot` for each. All captures are stored in the named screenshot cache as `<tabId>__<preset>__<runId>` so they can be re-diffed later. Original viewport is restored at the end.

---

### 10. Natural Language Assertions
Point the agent at the live page and ask it to verify something — the agent reads the page graph and uses an LLM to judge truth.

```typescript
await browser.assert(tabId, "the cart shows 3 items");
// throws AssertionError with explanation if false
```

### 11. "What Broke?" Post-Deploy Diff
After a deploy, diff the before/after perception graphs and summarise structural changes — new elements, removed headings, changed form fields.

```typescript
const delta = await browser.diffPerception(beforePacket, afterPacket);
// { added: [...], removed: [...], changed: [...], summary: "3 form fields removed..." }
```

---

## Architecture Notes

All three implemented features follow the same pattern:
1. **Accumulate** in `TabRecord` (main process, per-tab state)
2. **Expose** via `AgentServer` REST endpoints
3. **Consume** via `BrowserClient` SDK methods

CDP domains used:
| Feature | CDP Domains |
|---|---|
| Console logs | `Runtime.enable`, `Log.enable` |
| Network logs | `Network.enable` |
| Network mock | `Fetch.enable` (requestStage: Request) |
| Visual diff | `Page.captureScreenshot` (already used) |
| Viewport suite | `Emulation.setDeviceMetricsOverride`, `Page.captureScreenshot` |
| Performance metrics | `Performance.enable`/`getMetrics`, `Runtime.evaluate` |
| Accessibility audit | `Accessibility.enable`, `Accessibility.getFullAXTree` |
| Component tree | `Runtime.evaluate` (in-page devtools hook probe) |
