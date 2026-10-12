# ADR 0001 — Headless Chrome backend and a shared devtools core

- **Status:** Proposed
- **Date:** 2026-10-13
- **Deciders:** PM, architect, desktop + daemon engineers
- **Related:** `packages/shared/src/cdp.ts` (`CdpTarget`), `apps/desktop/src/main/electron-cdp-target.ts`, `apps/daemon/` (new)

## 1. Context

`apps/desktop/src/main/agent-server.ts` (1194 lines) serves the HTTP+SSE agent API on `127.0.0.1:7070`.
It calls into a 2228-line `TabManager` (`tab-manager.ts`) and `ExtensionManager`. `packages/mcp-server`
only speaks HTTP (via `HELMSTACK_HOST`/`HELMSTACK_PORT`/`HELMSTACK_AUTH_TOKEN`). We are adding a headless
daemon (`apps/daemon`, puppeteer-core + plain Chrome) that must serve **the same HTTP API** so mcp-server works
unchanged, and the Electron app must keep working.

The CDP-only modules (a11y-audit, style-inspector, component-tree, performance-probe, threejs-inspector,
storage-inspector, overrides, dom-actuator) are being moved from `WebContents` to `CdpTarget` right now (uncommitted
in this worktree; `electronCdpTarget()` caches one adapter per `WebContents`). This ADR assumes that work lands first
("Phase 0").

## 2. Decision (summary)

1. Create **`packages/devtools-core`** (`@helmstack/devtools-core`, tsup-built like `shared`, **no `electron` import —
   enforced by an ESLint `no-restricted-imports` rule scoped to that package**). It owns: the HTTP server, all pure
   report builders/stores, per-tab state, and a `HelmstackCore` that implements every tool once on top of `CdpTarget`.
2. Split TabManager into a **thin `BrowserBackend`** (tab lifecycle, a `CdpTarget` per tab, an observation feed) and
   the shared core. Desktop = `ElectronBackend` (what is left of TabManager); daemon = `ChromeBackend`.
3. `agent-server.ts` becomes `createAgentServer({ api, extensions?, port, authToken })` in
   `packages/devtools-core/src/http/`, typed against an `AgentApi` interface, never against `TabManager`.
4. Desktop-only features are **optional API slices**. When a slice is absent the server returns
   **`501 {"error":"…","code":"unsupported_on_backend","backend":"daemon"}`**. `GET /api/health` gains additive
   fields `backend` and `capabilities[]` (mcp-server ignores unknown fields, so it stays unchanged).
5. The perception packet pipeline is injected over CDP (`Page.addScriptToEvaluateOnNewDocument` into an isolated
   world + `Runtime.addBinding`) instead of the Electron preload.

## 3. Route → method map and classification

Legend: **P** portable (CdpTarget + Node only, once Phase 0 lands) · **R** portable-with-replacement · **D** desktop-only (daemon → 501).
Line numbers are `agent-server.ts`; method names are `TabManager` unless prefixed.

| Route(s) | agent-server line | Method(s) | Class | Notes |
|---|---|---|---|---|
| `GET /api/stream`, `GET/PUT /api/intent`, `POST /api/log` | 385–445 | server-local + `onTabsChanged/onPageObserved/onAssertionTransition/onApprovalQueued/onHandoffRequested` (ctor, l.186–203) | P | SSE fan-out, intent, ownership map live in the server |
| `GET /api/health` | 416 | `listTabs` | P | add `backend`, `capabilities` |
| `GET/POST /api/tabs`, `DELETE /api/tabs/:id`, `POST …/navigate` | 447–487 | `listTabs`, `createTab`, `closeTab`, `navigate` | R | `WebContentsView` → CDP `Target.createTarget`/`page.close()`; summary from `Page.frameNavigated`/lifecycle events; `setWindowOpenHandler` → `Target.targetCreated.openerId` |
| `GET …/perception`, `GET …/manifests` | 489–498 | `getPerceptionPacket`, `listCapabilityManifests` → `capturePerception` + `SiteCapabilityRegistry` | R | needs `lastObservation` (preload IPC → binding, §6.1); registry still takes `WebContents` (`loadURL`, 3× `executeJavaScript`) → `PageHandle` |
| `POST …/command`, `GET /api/approvals`, `POST /api/approvals/:id/{approve,reject}` | 500, 533–556 | `executeCommand`, `approveCommand`, `rejectCommand`, `listPendingApprovals` | R | registry + `vault.resolveValue` → `SecretResolver` (daemon: passthrough/env) |
| `GET /api/handoffs`, `POST …/{resolve,cancel}` | 558–593 | `listHandoffs`, `resolveHandoff`, `cancelHandoff` | P | pure `HandoffStore`; on daemon only resolvable via API (no UI) |
| `GET …/screenshot`, `POST …/viewport` | 507–531 | `captureScreenshot`, `setEmulatedViewport` | P | `this.viewport` (shell rect) → `backend.defaultViewport` |
| `POST …/screenshot/named`, `GET /api/screenshots`, `DELETE /api/screenshots/:id`, `POST /api/screenshots/diff` | 681–722 | `captureNamedScreenshot`, `listScreenshots`, `deleteScreenshot`, `diffScreenshots` | R | `visual-diff-store.ts` uses `nativeImage` (l.1, 61–62, 117) → `pngjs`. **pngjs is RGBA, `pixel-compare.ts` assumes BGRA** |
| `POST …/changed-elements`, `POST …/viewport-suite` | 703, 724 | `mapRegionsToElements`, `captureViewportSuite` | P | |
| `GET …/performance`, `…/health`, `…/a11y`, `…/focus-order` | 734–757 | `capturePerformanceMetrics`, `captureHealthReport`, `auditAccessibility`, `auditFocusOrder` | P | |
| `POST …/styles/{inspect,assert}`, `GET …/component-tree`, `…/design-tokens` | 759–802 | `inspectElementStyles`, `assertElementStyles`, `captureComponentTree`, `extractDesignTokens` | P | |
| `GET …/css-coverage`, `…/js-coverage`, `…/trace` | 804–821 | `captureCssCoverage`, `captureJsCoverage`, `captureTrace` | P | use `dbg.on("message")` ad hoc → `cdp.onEvent` + unsubscribe |
| `GET …/framework`, `…/component-sources`, `…/layout-issues`, `…/media-state`, `…/mutations`, `…/threejs-scene` | 823–905 | `detectFramework`, `captureComponentSources`, `detectLayoutIssues`, `getMediaState`, `captureMutationTimeline`, `captureThreeJsScene` | P | all `Runtime.evaluate` of a collector script + pure builder |
| `POST …/evaluate`, `…/insert-text`, `…/key`, `…/click`, `…/file-input` | 829–868, 976 | `evaluateExpression`, `insertText`, `pressKey`, `clickAt`, `setFileInputFiles` | P | file paths are daemon-host paths |
| `GET …/pick` | 870 | `pickElement` (`element-picker.ts`, `executeJavaScript` + human click) | **D** | needs a visible window + human. 501 (revisit for `--headful`) |
| `POST …/assert`, `GET/POST …/watches`, `DELETE …/watches/:wid` | 907–938 | `evaluateAssertion`, `add/list/removeAssertionWatch` | P | depends on perception quality (§6.1) |
| `GET …/recording`, `POST …/recording/{start,stop}` | 940–953 | `getRecording`, `startRecording`, `stopRecording` | P | |
| `GET/POST/DELETE …/site-patterns` | 955–974 | `get/set/add/clearSitePatterns` | P | `SitePatternStore` is fs-only |
| `GET/DELETE …/logs`, `GET …/har` | 645–661 | `getTabLogs`, `clearTabLogs`, `exportHar` | P | buffers filled by `cdp-events.ts` (§6.2) |
| `GET/POST/DELETE …/mock` | 663–679 | `get/enable/disableNetworkMock` | P | `Fetch.*` replies in `cdp-events.ts` must use `CdpTarget` |
| `GET/DELETE …/downloads` | 988–998 | `listDownloads`, `clearDownloads` | R | Electron `session.on("will-download")` (tab-manager l.1821) → `Browser.setDownloadBehavior{eventsEnabled}` + `Browser.downloadWillBegin/downloadProgress` on the browser session |
| `…/budget`, `…/location`, `…/media` (GET/POST/DELETE each) | 1000–1056 | `get/set/clearResourceBudget`, `…LocationOverride`, `…MediaEmulation` | P | `overrides.ts` already on `CdpTarget`; `checkResourceBudget` uses `Performance.getMetrics` |
| `…/storage`, `…/storage/:area`, `…/cookies`, `…/cookies/:name` | 1058–1118 | `captureStorage`, `get/set/clearStorage`, `setCookie`, `deleteCookie`, `clearCookies` | P | |
| `POST …/perception/named`, `POST /api/perception/diff`, `GET /api/perception`, `DELETE /api/perception/:id` | 1120–1145 | `saveNamedPerception`, `diffPerception`, `listPerceptionSnapshots`, `deletePerceptionSnapshot` | P | `webContents.getTitle()` → `tab.title()` |
| `GET/POST /api/accounts`, `GET …/lookup/:origin`, `PATCH/DELETE /api/accounts/:id`, `GET …/:id/totp` | 595–626 | `listAccounts`, `saveAccount`, `lookupAccounts`, `updateAccount`, `deleteAccount`, `generateTotp` | **D** | `AccountStore` uses `safeStorage`; credential product feature. 501 |
| `GET/POST /api/extensions`, `DELETE /api/extensions/:id` | 628–643 | `ExtensionManager.list/load/removeExtension` | **D** | Electron `session` extension API. 501 |

Not routed but in TabManager and desktop-only: `focusTab`, `setViewport`, `layoutActiveTab` (shell layout),
`installAntiDetection` (stealth), the `login` basic-auth handler (vault accounts), vault/policy IPC
(`listVaultSecrets`, `updateApprovalPolicy`, …), `getFixtureUrl`. The page preload's `navigator.webdriver` patch is anti-detection → desktop only.

**Recommendation:** daemon returns 501 for accounts (6), extensions (3), and pick (1). Everything else must work.
The default mcp-server profile only exposes verification tools; accounts/commands live behind `HELMSTACK_AGENT_SUBSTRATE`.

## 4. Interfaces

### 4.1 `BrowserBackend` (thin; implemented twice) — `packages/devtools-core/src/backend.ts`

```ts
export interface BackendTab {
  readonly id: TabId;
  readonly parentTabId?: TabId;
  readonly cdp: CdpTarget;              // one long-lived session per tab
  summary(): TabSummary;                 // backend maintains url/title/status
  title(): string;
  navigate(url: string): Promise<void>;  // loadURL / Page.navigate
}
export type TabLifecycleEvent =
  | { type: "created"; tab: BackendTab }
  | { type: "closed"; tabId: TabId }
  | { type: "main-frame-navigation"; tabId: TabId; url: string } // clear log buffers
  | { type: "load-finished"; tabId: TabId }                      // re-apply overrides
  | { type: "summary-changed" };                                 // → tabs_changed SSE
export interface BrowserBackend {
  readonly kind: "desktop" | "daemon";
  defaultViewport(): { width: number; height: number };  // desktop: shell rect; daemon: launch size
  listTabs(): BackendTab[];
  getTab(id: TabId): BackendTab | undefined;
  createTab(url: string, opts?: { parentTabId?: TabId }): Promise<BackendTab>;
  closeTab(id: TabId): Promise<void>;
  onLifecycle(l: (e: TabLifecycleEvent) => void): () => void;
  onObservation(l: (o: PageObservation) => void): () => void;   // preload IPC | Runtime.bindingCalled
  onDownload?(l: (tabId: TabId, d: DownloadEntry) => void): () => void;
  pickElement?(id: TabId): Promise<ElementPickResult>;
}
```

### 4.2 `AgentApi` (what the HTTP server calls) — `packages/devtools-core/src/api.ts`

A flat interface containing exactly the ~85 TabManager methods listed in §3 (same names, same signatures), plus
optional slices:

```ts
export interface AgentApi extends TabsApi, PerceptionApi, CommandApi, ScreenshotApi, InspectApi,
  InputApi, LogsApi, OverridesApi, StorageApi, RecordingApi, WatchApi, EventsApi {
  readonly backend: "desktop" | "daemon";
  accounts?: AccountsApi;        // listAccounts…generateTotp
  pickElement?(id: TabId): Promise<ElementPickResult>;
}
export interface ExtensionsApi { listExtensions(); loadExtension(path); removeExtension(id) }
```

Key property: **today's `TabManager` satisfies `AgentApi` structurally** (step WP-A), so the server can be
decoupled before any TabManager surgery. Later `HelmstackCore implements AgentApi` replaces it.

### 4.3 Shared core — `packages/devtools-core/src/core/`

- `tab-state.ts` — `TabState`, the portable half of `TabRecord` (tab-manager l.~124–150):
  `lastObservation, emulatedViewport, cdpLoggingEnabled, consoleLogs, networkRequests, webSocketUrls,
  webSocketFrames, eventSourceEvents, jsErrors, downloads, recording, resourceBudget, locationOverride,
  mediaEmulation, networkMockRules`. Stays in backends: `view`, `pendingUrl`, `summary`, `parentTabId`.
  **The daemon needs exactly this state per tab; it must not re-declare it.**
- `tab-session.ts` — `TabSession(tab: BackendTab, state: TabState)`: subscribes `tab.cdp.onEvent → handleCdpMessage`
  once (replaces `bindLifecycle` l.1706–1712), `enableCdpLogging` (l.1808), and hosts the per-tab tool bodies now at
  tab-manager l.363–1466 (`captureSnapshot`, `captureScreenshot`, coverage, trace, collectors, input, storage,
  overrides, mock, logs/HAR, recording, `capturePerception`, `checkResourceBudget`).
- `helmstack-core.ts` — `HelmstackCore implements AgentApi`: owns `Map<TabId, TabSession>`, cross-tab stores
  (`VisualDiffStore`, `PerceptionBaselineStore` + cache, `AssertionWatchStore`, `SitePatternStore`,
  `ApprovalStore`, `HandoffStore`, `ApprovalPolicyStore`, `SiteCapabilityRegistry`), listener sets, and the
  cross-tab methods (`listScreenshots`, `diffScreenshots`, `captureViewportSuite`, perception snapshots,
  `captureHealthReport`, watches, approvals/handoffs, `getHandoffContext`). Ctor:
  `new HelmstackCore(backend, { dataDir, secrets?: SecretResolver, accounts?: AccountsApi, includeSocial })`.
- `perception/diff.ts`, `perception/assertions.ts` — `computePerceptionDiff` (l.1933) and
  `evaluateAssertionAgainstGraph` (l.2060) moved verbatim.
- `perception/injector.ts` — §6.1.
- `commands/site-capability-registry.ts` — takes `PageHandle = { cdp: CdpTarget; navigate(url): Promise<void> }`
  and `SecretResolver { resolveValue(v): string; resolveRef?(v) }` instead of `WebContents`/`VaultStore`/`AccountStore`.
- `reports/*` (pure builders), `stores/*`, `cdp/cdp-events.ts`, `cdp/*` (the eight Phase-0 modules), `util.ts`.
- `http/agent-server.ts`, `http/request-validation.ts`, `http/token.ts` (`readOrCreateAgentToken`, main.ts l.216).

Desktop afterwards: `tab-manager.ts` → `ElectronBackend implements BrowserBackend` (~500 lines: `WebContentsView`,
focus/layout, preload path, `bindLifecycle` emitting `TabLifecycleEvent`s, downloads, anti-detection, basic-auth
login, window-open) plus `VaultStore`/`AccountStore` (`safeStorage`) and `ExtensionManager`. `main.ts` wires
`createAgentServer({ api: new HelmstackCore(electronBackend, …), extensions, port: 7070 })` and keeps shell IPC
pointing at the core.

### 4.4 Agent server

`createAgentServer(opts: { api: AgentApi; extensions?: ExtensionsApi; port?: number; authToken: string | null; host?: "127.0.0.1" })`
lives in `devtools-core/src/http/` (it has zero Electron deps today; only its `import type { TabManager }` couples it).
The loopback/Origin/token guards (l.24–64, 323–368) move with it unchanged, so the daemon gets them for free.
Add a `unsupported(res, feature)` helper used where a slice is missing. Keep the regex router as-is (no rewrite in
this ADR; a table-driven router is a later, separate change).

## 5. Package/consumption mechanics

- Desktop keeps importing via relative `../../../../packages/devtools-core/src/…` (esbuild bundles; same as `shared`).
- Daemon depends on `"@helmstack/devtools-core": "*"` (tsup, like `@helmstack/shared`); add it to root
  `build:packages`. Runtime deps of the package: `pngjs` (+ `@types/pngjs`).
- `vitest.config.ts` `include` must add `packages/devtools-core/test/**` and `apps/daemon/test/**`.

## 6. Risks

### 6.1 Perception packet pipeline (highest risk)
Today `page-preload.ts` runs `installPageObservationStream` + `extractPageObservation` (packages/perception
`dom-extractor.ts`) in an isolated world and pushes via `ipcRenderer.send(PageObserved)` → `TabManager.recordObservation`
(l.1647). `normalizePerception` (normalize.ts l.15–29) takes **forms, alerts, media, primary actions, page kind only
from the observation**; without it `forms: []` and assertions/commands silently degrade — no error.
Daemon plan:
1. New `packages/perception/src/page-inject.ts` (entry) bundled by tsup/esbuild as an **IIFE string** exported from
   `packages/perception/src/generated/page-inject-source.ts` (generated, checked by a test). It runs the same stream
   but calls `globalThis.__helmstackObserved(JSON.stringify(obs))`; config (`includeSocial`) is prepended as a literal.
2. `injector.ts`: `Page.enable`; `Runtime.addBinding({ name: "__helmstackObserved", executionContextName: "helmstack" })`;
   `Page.addScriptToEvaluateOnNewDocument({ source, worldName: "helmstack" })`; for the already-loaded document,
   `Page.createIsolatedWorld({ frameId: mainFrame, worldName: "helmstack" })` + `Runtime.evaluate` of the source.
   `Runtime.bindingCalled` → parse → stamp `tabId` server-side → `onObservation`.
3. Freshness: preload is debounced 150 ms, so `capturePerception` may read a stale observation. Core should
   **pull** a fresh one (`Runtime.evaluate` `__helmstack.extract()` in the tracked isolated-world context from
   `Runtime.executionContextCreated`) with push as fallback. Apply to both backends once proven.
Isolated world keeps the extractor invisible to page scripts (parity with `contextIsolation: true`). Desktop keeps its preload.

### 6.2 CDP event wiring
`bindLifecycle` (l.1710) attaches `debugger.on("message") → handleCdpMessage(tab, …)` once per tab, and
`cdp-events.ts` (l.194, 217, 226) replies to `Fetch.requestPaused` via `tab.view.webContents.debugger`. Port to
`handleCdpMessage(state, cdp, method, params)`. Daemon must use **one dedicated `page.createCDPSession()` per tab**
for all our traffic (events arrive only for domains enabled on that session; `Fetch.continue/fulfill` must go to the
session that paused). Do **not** use puppeteer's `page.setRequestInterception`, `page.setViewport` or emulation
helpers (they fight our `Fetch`/`Emulation` state); launch with `defaultViewport: null`, `pipe: true` (no open
remote-debugging port), `--window-size=1280,800` (headless default is 800×600). Ad-hoc listeners in coverage/trace
(tab-manager l.~769, 790, 900) must call the unsubscribe returned by `onEvent` in `finally`.
Log clearing on navigation: Electron uses `did-start-navigation` (fires before the document request). Daemon
equivalent: in the session handler, clear buffers on `Network.requestWillBeSent` where `type === "Document"`,
`frameId === mainFrameId` and `requestId === loaderId` **before** recording that request.

### 6.3 Behavioural differences
- `captureScreenshot`'s `finally` calls `Emulation.clearDeviceMetricsOverride` (l.~452), dropping an active
  `setEmulatedViewport`. Masked in Electron by the view bounds; in headless it snaps to window size. Fix in
  `TabSession`: re-apply `state.emulatedViewport` instead of clearing.
- Fonts/GPU differ (headless uses SwiftShader; three.js inspector may need `--enable-unsafe-swiftshader`). Visual
  baselines are not comparable across backends → stamp `backend` in `ScreenshotBaselineStore` index entries and use a
  separate data dir (`~/.helmstack/daemon` default, `--data-dir` flag).
- Port: both default to 7070. Daemon honours `HELMSTACK_PORT`; fail fast with a clear message on `EADDRINUSE`.
- Token: daemon uses the same `readOrCreateAgentToken` (moved to core) and `HELMSTACK_AUTH_TOKEN`.
- `listScreenshots` reads live tab URL — fine; `title()` must not need an extra CDP round-trip (cache from `Page.frameNavigated` / `Target.targetInfoChanged`).

### 6.4 Tests that will break / move
- `agent-server.integration.test.ts` constructs `new AgentServer(stub as unknown as TabManager, …)` → `createAgentServer({ api: stub as AgentApi })`. `agent-server-guards.test.ts`, `request-validation.test.ts` → import paths.
- `tab-manager-logic.test.ts` imports `computePerceptionDiff`/`evaluateAssertionAgainstGraph` from `tab-manager.js` and `vi.mock("electron")` → import from core; the mock becomes unnecessary.
- `visual-diff-store.test.ts` mocks `nativeImage: {}`; after pngjs it can (and must) test `diff()` for real. `pixel-compare.test.ts`/`ignore-mask.test.ts` encode BGRA buffers — keep BGRA in `pixel-compare` and swizzle in the store, or update both together.
- Every test of a moved module (har, design-tokens, css/js-coverage, trace-summary, framework-detect, layout-issues, media-state, recording-export, health-report, mutation-timeline, component-source, element-bounds, focus-order, assertion-watch, baseline-store, a11y-audit, component-tree, approval-gating) moves to `packages/devtools-core/test/`. `approval-gating` keeps its `electron` mock only for `VaultStore`/`AccountStore`.
- UI tests (`menu`, `toast`, `theme`, …) and `e2e-smoke` are untouched.

### 6.5 Coordination risk
Phase 0 is editing `tab-manager.ts` and `site-capability-registry.ts` in this worktree now. **No WP below may edit
those two files until Phase 0 is merged.**

## 7. Work packages

Each WP owns the files listed; nobody else edits them during the WP. "→" = must merge first.

**Phase 1 (start now, parallel)**

- **WP-A Server extraction & AgentApi** — *owns:* new `packages/devtools-core/{package.json,tsup.config.ts,tsconfig.json,src/api.ts,src/http/*}`, `git mv` of `agent-server.ts` + `request-validation.ts`, `readOrCreateAgentToken` out of `main.ts`, `main.ts` wiring lines, `vitest.config.ts`, root `package.json` scripts, `eslint.config.*` rule, the three server tests.
  *Accept:* `createAgentServer` typed on `AgentApi`; `TabManager` assigned to `AgentApi` compiles with no TabManager edits; missing slice → 501 JSON (unit-tested for accounts/extensions/pick); `/api/health` has `backend` + `capabilities`; desktop runs unchanged; `npm run typecheck && npm test` green.
- **WP-D Perception injection** — *owns:* `packages/perception/src/page-inject.ts`, `src/generated/page-inject-source.ts`, perception tsup config, `packages/devtools-core/src/perception/injector.ts` (+ tests).
  *Accept:* fake-`CdpTarget` test asserts `addBinding`/`addScriptToEvaluateOnNewDocument(worldName)`/`createIsolatedWorld` sequence and that `bindingCalled` yields a `PageObservation` with `tabId` stamped; jsdom test runs the bundled source against `test-pages/contact-form.html` and gets ≥1 form; generated source is reproducible (test diffs it against a fresh build).

**Phase 2 (after Phase 0 merges)**

- **WP-B Move pure + CDP modules into core** (→ Phase 0) — *owns:* `git mv` of every electron-free module listed in §6.4 plus the eight Phase-0 modules, `cdp-events.ts` (port to `(state, cdp, …)`), `visual-diff-store.ts` (pngjs), `pixel-compare.ts`, `baseline-store.ts` (backend stamp), `site-pattern-store.ts`, `approval-store.ts`, `handoff-store.ts`, `approval-policy-store.ts`, `util.ts`, `computePerceptionDiff`/`evaluateAssertionAgainstGraph` extraction; **import-line-only** edits in `tab-manager.ts`/`site-capability-registry.ts`; moved tests.
  *Accept:* `packages/devtools-core` has no `electron` import (lint rule passes); `visual-diff-store.test` exercises a real PNG diff; pixel results identical to pre-move on the existing fixtures; desktop builds and behaves the same.
- **WP-E Portable command registry** (→ WP-B) — *owns:* `site-capability-registry.ts` (moves to `core/commands/`), `SecretResolver`/`PageHandle` types, the 4 registry call sites in `tab-manager.ts` (~l.1468–1530), `approval-gating.test.ts`.
  *Accept:* registry has no `WebContents`; desktop passes `{ cdp: electronCdpTarget(wc), navigate: (u) => wc.loadURL(u) }` and a vault-backed resolver; approval-gating tests green.
- **WP-C TabSession + HelmstackCore; TabManager → ElectronBackend** (→ WP-B, WP-E) — *owns:* `core/tab-state.ts`, `core/tab-session.ts`, `core/helmstack-core.ts`, `core/backend.ts`, `tab-manager.ts`, `main.ts` (core wiring), `tab-manager-logic.test.ts`. Can start writing new files after WP-B; touches `tab-manager.ts` only after WP-E merges.
  *Accept:* `tab-manager.ts` < 600 lines with no tool logic; `HelmstackCore` implements `AgentApi` and is what the desktop serves; screenshot re-applies emulated viewport (§6.3); manual desktop smoke of 15 representative routes (screenshot, viewport-suite, a11y, styles/assert, perception/named + diff, logs, har, mock, coverage, trace, storage, cookies, watches, command, approvals) matches pre-refactor output; unit tests for `TabSession` with a fake `CdpTarget`.

**Phase 3**

- **WP-F Daemon backend** (daemon engineer; → WP-A, WP-D; full feature set → WP-C) — *owns:* `apps/daemon/**`: `puppeteer-cdp-target.ts` (`CDPSession` → `CdpTarget`), `chrome-backend.ts` (`BrowserBackend` via `Target` events; downloads via browser session), `main.ts` CLI (`--port`, `--data-dir`, `--chrome-path`, `--headful`). Until WP-C lands, the daemon may serve `createAgentServer` with a temporary `AgentApi` built from core modules — **no copying of TabManager code**.
  *Accept:* `mcp-server` pointed at the daemon passes the contract suite (WP-G); `accounts/extensions/pick` return 501; no Chrome debugging port opened (pipe); clean shutdown kills Chrome.
- **WP-G Contract tests & CI** (→ WP-A; grows with C/F) — *owns:* `packages/devtools-core/test/contract/**`, CI workflow job.
  *Accept:* one route suite runs against (a) `HelmstackCore` + `FakeBackend`/fake `CdpTarget` in plain vitest and (b) the real daemon + headless Chrome serving `apps/desktop/test-pages` (gated on `HELMSTACK_CHROME_PATH`); asserts response shapes for every non-501 route in §3, contact-form perception has forms, mock fulfils a fetch, HAR contains the document request, screenshot diff of identical captures = 0 changed pixels.

Critical path: Phase 0 → WP-B → WP-E → WP-C → WP-F (full). WP-A, WP-D, WP-G start immediately.

## 8. Consequences

- One implementation of every verification tool; Electron and headless differ only in a ~500-line backend each.
- `packages/devtools-core` becomes the reusable heart (could later back a CI runner or Playwright adapter).
- Cost: a large but mechanical move (mostly `git mv` + import fixes), and a new perception injection path that must
  reach parity with the preload — guarded by the contact-form acceptance tests.
- Rejected alternatives: (a) daemon re-implements `AgentApi` by copying TabManager — doubles every tool and drifts;
  (b) run Electron headless (`xvfb`/offscreen) — still ships Electron, no plain-Chrome/CI story;
  (c) move the HTTP API into mcp-server and drop the server — breaks the "mcp-server unchanged" constraint and the SDK.
