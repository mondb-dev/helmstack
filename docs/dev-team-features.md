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

### 5. Storage Inspector ✅

Read and write `localStorage`, `sessionStorage`, cookies, and `IndexedDB` via CDP `Storage`/`Network` domains. Useful for seeding test data, inspecting auth state, or resetting app state between test runs.

**API**
```
GET    /api/tabs/:id/storage                        → StorageReport (all areas)
GET    /api/tabs/:id/storage/local                  → StorageEntry[]  (?key=X for single)
GET    /api/tabs/:id/storage/session                → StorageEntry[]  (?key=X for single)
POST   /api/tabs/:id/storage/local                  { entries: Record<string,string> }
POST   /api/tabs/:id/storage/session                { entries: Record<string,string> }
DELETE /api/tabs/:id/storage/local                  body? { keys: string[] } — omit to clear all
DELETE /api/tabs/:id/storage/session                body? { keys: string[] } — omit to clear all
GET    /api/tabs/:id/cookies                        → CookieEntry[]
POST   /api/tabs/:id/cookies                        { name, value, domain?, path?, httpOnly?, secure?, sameSite?, expires? }
DELETE /api/tabs/:id/cookies                        clear all cookies for the tab's origin
DELETE /api/tabs/:id/cookies/:name                  ?url= optional
```

**SDK**
```typescript
// Full snapshot of all storage areas
const snap = await browser.captureStorage(tabId);
console.log(`${snap.localStorage.length} localStorage keys`);
console.log(`${snap.cookies.length} cookies`);
console.log(`${snap.indexedDb.length} IndexedDB databases`);
console.log(`Total: ${(snap.totalBytes / 1024).toFixed(1)} KB`);

// Seed localStorage for a test
await browser.setStorage(tabId, "local", {
  "auth-token": "test-jwt-xxx",
  "user-id": "42",
  "theme": "dark"
});

// Read a single key
const entries = await browser.getStorage(tabId, "local", "auth-token");
// entries[0].value === "test-jwt-xxx"

// Remove specific keys / clear area
await browser.clearStorage(tabId, "local", ["cart", "draft"]);
await browser.clearStorage(tabId, "session");   // clear entire session storage

// Cookies
const cookies = await browser.getCookies(tabId);
const session  = cookies.find(c => c.name === "session_id");

await browser.setCookie(tabId, {
  name: "session_id",
  value: "test-sess-abc",
  httpOnly: true,
  secure: true,
  path: "/"
});

await browser.deleteCookie(tabId, "session_id");
await browser.clearCookies(tabId);   // nuke all cookies for this origin
```

**`StorageReport` shape**
```typescript
{
  tabId:          string;
  url:            string;
  capturedAt:     number;
  localStorage:   StorageEntry[];   // { key, value, bytes }
  sessionStorage: StorageEntry[];
  cookies:        CookieEntry[];    // see below
  indexedDb:      IndexedDbDatabase[];
  totalBytes:     number;
}

// CookieEntry
{
  name: string; value: string; domain: string; path: string;
  expires: number | null;   // epoch ms; null = session cookie
  httpOnly: boolean; secure: boolean;
  sameSite: "Strict" | "Lax" | "None" | "";
  size: number;
}

// IndexedDbDatabase
{ name: string; version: number; objectStores: IndexedDbObjectStore[] }

// IndexedDbObjectStore
{ name: string; keyPath: …; autoIncrement: boolean; count: number;
  rows: Array<{ key: string; value: string }>  // first 100 rows, JSON-serialised }
```

### 6. Interaction Recorder → Test Script ✅
Record a sequence of agent actions on a tab and export them as a replayable HelmStack script. Dramatically speeds up writing regression tests.

```typescript
browser.startRecording(tabId);
// ... do things in the browser ...
const script = await browser.stopRecording(tabId);
// exports: navigate, click, fill_form, submit steps with real selectors
```

### 7. WebSocket + SSE Monitoring ✅
Buffered WebSocket frames and EventSource messages are now exposed alongside console logs and network requests.

### 8. File Upload + Download Hooks ✅
Agents can now set files on live file inputs by selector and inspect tracked downloads per tab.

### 9. Per-Tab Resource Budgets ✅
Tabs now support CPU throttling, network shaping, offline mode, and a soft JS heap ceiling that blocks commands when exceeded.

### 10. Geolocation + Timezone Spoofing ✅
Set or clear per-tab geolocation and timezone overrides through the substrate API.

### 11. Persistent Site Pattern Memory ✅
Persist origin-scoped patterns and surface them in each perception packet.

### 12. Multi-Tab Handoff Context ✅
Human handoffs now include related tab IDs plus grouping metadata so popup and OAuth flows preserve context.

### 13. Accessibility Inspector ✅
Comprehensive WCAG 2.2 audit against the live AX tree and DOM. Returns a 0–100 score, per-violation remediation guidance, principle breakdown, deduplicated rule summaries, and an ordered recommendations list. No external tooling required.

**API**
```
GET /api/tabs/:id/a11y  → A11yAuditReport
```
**SDK**
```typescript
const report = await browser.auditAccessibility(tabId);

// At-a-glance summary
console.log(`Score: ${report.score}/100`);
console.log(`${report.violationCounts.critical} critical, ${report.violationCounts.serious} serious, ` +
            `${report.violationCounts.moderate} moderate, ${report.violationCounts.minor} minor`);

// By WCAG principle
console.log("Perceivable violations:",    report.byPrinciple.perceivable);
console.log("Operable violations:",       report.byPrinciple.operable);
console.log("Understandable violations:", report.byPrinciple.understandable);
console.log("Robust violations:",         report.byPrinciple.robust);

// Deduplicated rule summaries (ordered by severity)
for (const rule of report.violatedRules) {
  console.log(`[WCAG ${rule.wcagCriteria} ${rule.wcagLevel}] ${rule.description} — ${rule.count} instance(s)`);
}

// Individual violations with remediation instructions
for (const v of report.violations) {
  console.log(`[${v.impact}] ${v.rule} @ ${v.selector}`);
  console.log(`  ${v.description}`);
  console.log(`  Fix: ${v.remediation}`);
}

// Plain-English action items, ordered by priority
for (const rec of report.recommendations) {
  console.log("→", rec);
}
```

**Response shape** (`A11yAuditReport`):
```typescript
interface A11yAuditReport {
  tabId: string;
  url: string;
  capturedAt: number;           // Unix ms
  score: number;                // 0–100; 100 = zero violations
  violations: A11yViolation[];
  violationCounts: {
    critical: number; serious: number; moderate: number; minor: number;
  };
  byPrinciple: {
    perceivable: number; operable: number; understandable: number; robust: number;
  };
  violatedRules: A11yRuleSummary[];   // deduplicated, sorted by severity
  recommendations: string[];          // ordered plain-English action items
  passes: number;               // nodes that passed all applicable rules
  nodeCount: number;            // total AX nodes inspected
}

interface A11yViolation {
  rule: string;           // e.g. "1.1.1-image-alt"
  impact: "critical" | "serious" | "moderate" | "minor";
  wcagCriteria: string;   // e.g. "1.1.1"
  wcagLevel: "A" | "AA" | "AAA";
  principle: "perceivable" | "operable" | "understandable" | "robust";
  selector: string;       // CSS-style selector hint for the offending node
  description: string;    // what is wrong
  remediation: string;    // how to fix it
  role: string;           // AX role, e.g. "img", "button"
  name?: string;          // accessible name, if any
}

interface A11yRuleSummary {
  ruleId: string;
  wcagCriteria: string;
  wcagLevel: "A" | "AA" | "AAA";
  principle: "perceivable" | "operable" | "understandable" | "robust";
  impact: "critical" | "serious" | "moderate" | "minor";
  description: string;    // plain English rule title
  count: number;          // total violations for this rule
}
```

**Scoring**
Score starts at 100 and deductions are applied per severity tier (capped so a single category can't monopolise the total):
| Severity | Deduction per violation | Tier cap |
|---|---|---|
| critical | 8 pts | 48 pts |
| serious | 4 pts | 32 pts |
| moderate | 2 pts | 12 pts |
| minor | 1 pt | 5 pts |

**Rules implemented:**
| Rule ID | WCAG SC | Level | Principle | Impact | Description |
|---|---|---|---|---|---|
| `1.1.1-image-alt` | 1.1.1 | A | Perceivable | Critical | Images must have a non-empty accessible name |
| `1.3.1-input-label` | 1.3.1 | A | Perceivable | Serious | Form inputs must have an accessible label |
| `1.3.1-table-header` | 1.3.1 | A | Perceivable | Moderate | Table header cells must have a name |
| `2.4.2-page-title` | 2.4.2 | A | Operable | Serious | Page must have a descriptive `<title>` |
| `2.4.3-heading-order` | 2.4.3 | A | Operable | Moderate | Heading levels must not skip ranks |
| `2.4.4-link-purpose` | 2.4.4 | A | Operable | Moderate | Link text must be meaningful out of context |
| `2.4.6-button-label` | 2.4.6 | AA | Operable | Serious | Buttons must have an accessible name |
| `2.4.6-link-label` | 2.4.6 | AA | Operable | Serious | Links must have an accessible name |
| `3.1.1-page-lang` | 3.1.1 | A | Understandable | Serious | HTML element must have a `lang` attribute |
| `4.1.2-aria-required-attr` | 4.1.2 | A | Robust | Critical | ARIA widget roles must include required states (`aria-checked`, `aria-expanded`, `aria-valuenow`) |
| `4.1.3-disabled-label` | 4.1.3 | AA | Robust | Minor | Disabled controls must still have an accessible name |

**How it works**: CDP `Accessibility.getFullAXTree` returns all AX nodes; `Runtime.evaluate` checks DOM-level conditions (page lang, page title) that aren't in the AX tree. Ignored nodes are skipped. The heading-order check is stateful — it tracks the last observed heading level as nodes are traversed in tree order and flags any level jump > 1. Score, principle counts, and recommendations are computed in-process with no external dependencies.

> **Related checks** — Text contrast is covered by the element style inspector below. Focus-visible styling (WCAG 2.4.7) and motion sensitivity (2.3.3) still require interactive or visual inspection and are flagged in recommendations when no other violations exist.

---

### 14. Element Style Inspector ✅
Inspect computed CSS, layout geometry, box model, and contrast for elements matching a selector. This gives agents direct evidence for design regressions like wrong colors, missing spacing, clipped content, invisible controls, small tap targets, or accidental overlay/z-index problems.

**API**
```
POST /api/tabs/:id/styles/inspect  { selector, limit? }             → ElementStyleInspectionReport
POST /api/tabs/:id/styles/assert   { selector, assertions, limit? } → ElementStyleAssertionReport
```

**SDK**
```typescript
const styles = await browser.inspectElementStyles(tabId, ".primary-button");
const button = styles.elements[0];

console.log(button.computed["background-color"]);
console.log(button.box.padding);
console.log(button.bounds);
console.log(button.contrast?.ratio);
console.log(button.issues);

await browser.assertElementStyles(tabId, ".primary-button", [
  { property: "background-color", equals: "#2563eb" },
  { property: "border-radius", min: 6 },
  { property: "font-weight", min: 600 },
  { property: "text-transform", not: "uppercase" }
]);
```

**MCP**
| Tool | Purpose |
|---|---|
| `browser_inspect_element_styles` | Return computed style, bounds, box model, contrast, and issue flags for matched elements |
| `browser_assert_element_styles` | Check CSS assertions across matched elements without needing a separate test runner |

**Issue flags**
| Issue | What it detects |
|---|---|
| `not_visible` | `display:none`, `visibility:hidden`, or zero opacity |
| `zero_size` | Element has no rendered width or height |
| `offscreen` | Element bounds are outside the viewport |
| `low_contrast` | Text contrast fails WCAG AA for normal-sized text |
| `small_tap_target` | Interactive element is smaller than the 44×44px recommended target |
| `clipped_content` | Scroll dimensions exceed the visible box under clipping overflow |
| `pointer_events_none` | Element ignores pointer input |
| `high_z_index` | High stacking value that can indicate overlay conflicts |
| `fixed_or_sticky` | Fixed/sticky positioning that can cover content during scrolling |

**Assertions**
Each assertion targets one computed CSS property and supports `equals`, `contains`, `matches`, `not`, `min`, `max`, and optional numeric `tolerance`. Color comparisons normalize common RGB/hex forms, and numeric comparisons parse CSS lengths such as `16px`.

---

### 15. Component Tree Awareness ✅
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

### 16. Responsive Multi-Viewport Comparison ✅
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

### 17. Natural Language Assertions ✅

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

### 18. "What Broke?" Post-Deploy Diff ✅
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
| Storage inspector | `Runtime.evaluate` (localStorage/sessionStorage/IndexedDB), `Network.getCookies`, `Network.setCookie`, `Network.deleteCookies` |

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
- `type`, e.g. `Mesh`, `PointLight`, `PerspectiveCamera`, `InstancedMesh`
- `position / rotation / scale`
- `castShadow / receiveShadow`
- `geometry`: vertex count, index count, attribute names
- `materials`: type, color (hex), opacity, wireframe, side, depthWrite
- `lightProps`: intensity, color, castShadow, distance, angle
- `cameraProps`: fov, near, far, zoom
- `instanceCount` for `InstancedMesh`

### AI feedback workflow

```ts
import { BrowserClient } from "@helmstack/agent-sdk";

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
