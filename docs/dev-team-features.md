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

### 10. Natural Language Assertions ✅

Point the agent at the live page and assert something in plain English. The server captures a fresh `PageGraph` and runs a heuristic evaluator — no LLM required for the common cases.

**API**
```
POST /api/tabs/:id/assert   { assertion: string }   → AssertionResult
```

**SDK**
```typescript
// Throws AssertionError on failure (default behaviour):
await browser.assert(tabId, "the checkout button is visible");
await browser.assert(tabId, "there are no error messages");
await browser.assert(tabId, "the cart shows 3 items");
await browser.assert(tabId, "the submit button is disabled");
await browser.assert(tabId, "the page title is 'Dashboard'");
await browser.assert(tabId, "at least 2 forms");
await browser.assert(tabId, "no warnings");

// Get raw result without throwing — useful when you want to forward
// low-confidence results to your own LLM:
const result = await browser.assert(tabId, "the invoice total is correct", { throw: false });
if (!result.pass && result.confidence === "low") {
  const llmVerdict = await ai.chat([
    { role: "user", content: `Evidence: ${JSON.stringify(result.evidence)}\nIs this true: "${result.assertion}"?` }
  ]);
}
```

**`AssertionResult` shape**
```typescript
{
  tabId:       string;
  assertion:   string;
  pass:        boolean;
  confidence:  "high" | "medium" | "low";
  explanation: string;   // plain English — suitable for test reports
  evidence: {
    url:          string;
    title:        string;
    headings:     string[];
    actionLabels: string[];
    alertTexts:   string[];
    formSummaries: string[];   // "<purpose>: field1, field2, …"
    counts: { headings, actions, forms, alerts, fields, mediaItems };
  };
}
```

**Heuristic coverage**

| Pattern | Example |
|---|---|
| Quantitative | `"3 items"`, `"2 buttons"`, `"0 errors"` |
| Absence | `"no error messages"`, `"not visible"` |
| Presence | `"checkout button is visible"`, `"login form"` |
| Disabled state | `"submit button is disabled"` |
| Title | `"page title is 'Dashboard'"` |
| Comparative | `"at least 2 forms"`, `"fewer than 5 headings"` |
| Fallback | Low-confidence result with evidence for LLM forwarding |

### 11. "What Broke?" Post-Deploy Diff ✅
Save a named perception snapshot before a deploy, then diff before/after to get a structured list of every structural change — headings added/removed, forms changed, actions gone, alerts added, title changed. No visual screenshots needed.

**API**
```
POST   /api/tabs/:id/perception/named   { snapshotId: string }     → PerceptionSnapshotEntry
POST   /api/perception/diff             { beforeId, afterId }       → PerceptionDiff
GET    /api/perception                                               → PerceptionSnapshotEntry[]
DELETE /api/perception/:id                                           → { ok: true }
```
**SDK**
```typescript
// 1. Snapshot before the deploy
await browser.savePerceptionSnapshot(tabId, "pre-deploy-v1.4");

// 2. Deploy your changes, navigate to the same URL
await browser.navigate(tabId, "https://app.example.com");

// 3. Snapshot after the deploy
await browser.savePerceptionSnapshot(tabId, "post-deploy-v1.4");

// 4. Diff
const diff = await browser.diffPerception("pre-deploy-v1.4", "post-deploy-v1.4");

console.log(diff.summary);
// e.g. "2 headings changed, 1 form changed, 3 actions changed."

for (const change of diff.changes) {
  console.log(`[${change.kind}] ${change.description}`);
  if (change.before) console.log(`  before: ${change.before}`);
  if (change.after)  console.log(`  after:  ${change.after}`);
}

if (diff.identical) console.log("Zero structural changes — clean deploy!");

// List and clean up
const snaps = await browser.listPerceptionSnapshots();
await browser.deletePerceptionSnapshot("pre-deploy-v1.4");
await browser.deletePerceptionSnapshot("post-deploy-v1.4");
```

**Response shape** (`PerceptionDiff`):
```typescript
interface PerceptionDiff {
  beforeId: string;
  afterId: string;
  beforeUrl: string;
  afterUrl: string;
  capturedAt: number;
  changes: PerceptionChange[];
  summary: string;    // "2 headings changed, 1 form changed."
  identical: boolean; // true when changes.length === 0
}

interface PerceptionChange {
  kind: PerceptionChangeKind;
  description: string;  // human-readable one-liner
  before?: string;      // set for title_changed / page_kind_changed
  after?: string;
}

type PerceptionChangeKind =
  | "heading_added"    | "heading_removed"
  | "form_added"       | "form_removed"    | "form_changed"
  | "action_added"     | "action_removed"
  | "alert_added"      | "alert_removed"
  | "title_changed"    | "page_kind_changed"
  | "media_added"      | "media_removed";
```

**What is diffed:**
| Field | How matched |
|---|---|
| `headings` | Set equality — any added or removed string |
| `forms` | Matched by form `id`; field changes by field `id` within the form |
| `actions` | Matched by `kind + label` key |
| `alerts` | Set equality |
| `title` | Direct string comparison |
| `kind` (page kind) | Direct comparison — e.g. `"login"` → `"dashboard"` |
| `media` | Matched by `src` URL or `alt` text |

**How it works**: Pure in-process computation — no CDP calls. `savePerceptionSnapshot` captures the live `PageGraph` via the normal perception pipeline and stores it in a server-side `Map<id, {graph, url, title, capturedAt}>`. `diffPerception` compares two stored graphs field by field and produces a flat `PerceptionChange[]` list with a generated plain-English summary.

---

## Architecture Notes

All implemented features follow the same pattern:
1. **Compute** in `TabManager` (main process — CDP calls or in-process logic)
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
| Perception diff | None — pure in-process PageGraph comparison |
| Three.js inspector | `Runtime.evaluate` (in-page scene graph walk + rAF FPS sample) |
| NL assertions | None — pure in-process PageGraph heuristics |

---

## 12. Three.js Scene Inspector 

**Endpoint:** `GET /api/tabs/:id/threejs-scene`

**SDK:** `browser.captureThreeJsScene(tabId)`

**Returns:** `ThreeSceneReport`

Probes a live Three.js scene without any custom instrumentation on the app side.
Detects common renderer/scene exposure patterns (`window.renderer`, `window.scene`,
`window.__threeRenderer__`, `window.experience.renderer`, React Three Fiber canvas hooks)
then walks the scene graph ( 8), reads renderer draw-call stats, and estimates FPSdepth 
via a 300 ms `requestAnimationFrame` sample.

### What the AI gets

| Field | Description |
|---|---|
| `detected` | Whether a Three.js renderer was found on the page |
| `scene` | Full object tree (meshes, lights, cameras, ) |groups 
| `renderer` | `drawCalls`, `triangles`, `geometries`, `textures`, `programs` |
| `fps` | Estimated FPS + frames sampled |
| `materials` | All unique `ThreeMaterialInfo` objects in the scene (deduplicated) |
| `summary` | Counts: objects, meshes, lights, cameras, vertices, triangles |

### Per-node information

Each `ThreeObject` in the scene tree includes:
- ` e.g. `Mesh`, `PointLight`, `PerspectiveCamera`, `InstancedMesh`type` 
- `position / rotation / scale`
- `castShadow / receiveShadow`
- ` vertex count, index count, attribute namesgeometry` 
- ` type, color (hex), opacity, wireframe, side, depthWritematerials` 
- ` intensity, color, castShadow, distance, anglelightProps` 
- ` fov, near, far, zoomcameraProps` 
- ` for `InstancedMesh`instanceCount` 

### AI feedback workflow

```ts
import { BrowserClient } from "@openvisual/agent-sdk";

const browser = new BrowserClient();
const report = await browser.captureThreeJsScene(tabId);

if (!report.detected) {
  console.log("No Three.js renderer found on this page.");
  return;
}

// Feed the report directly to your AI
const feedback = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    {
      role: "system",
      content: `You are a Three.js performance and correctness expert.
Analyze the provided ThreeSceneReport and give specific, actionable code
feedback. Reference exact object names, material UUIDs, and field values.`
    },
    { role: "user", content: JSON.stringify(report, null, 2) }
  ]
});

console.log(feedback.choices[0].message.content);
 "Your scene has 847 draw calls. The 14 Mesh objects named 'wall_*'
//    share identical  merge them into a singleMeshStandardMaterial 
//    InstancedMesh to reduce draw calls to ~12..."
```

### Common AI-generated insights

| Observation | Example feedback |
|---|---|
| High draw calls | "Merge the 23 static Mesh  they all use the same material" |objects 
| Unused shadow casting | "6 meshes have `castShadow: true` but no `DirectionalLight` has shadows enabled" |
| Low-intensity light | "`PointLight 'lamp' intensity: 0. likely a unit mistake; try 1.5.0" |0001` 
| Duplicate materials | "14 unique MeshStandardMaterial instances are  share one reference" |identical 
| Infinite light range | "`PointLight distance: 0` means infinite  set an explicit range" |falloff 
| Camera clipping | "`PerspectiveCamera far: 100` may clip geometry at world-scale scenes" |
