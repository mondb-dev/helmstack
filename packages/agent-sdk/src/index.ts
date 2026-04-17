/**
 * @helmstack/agent-sdk
 *
 * Typed client for the HelmStack agent server (127.0.0.1:7070).
 * Zero external dependencies — built on Node.js built-in http module.
 *
 * Quick start:
 *
 *   import { createBrowserClient } from "@helmstack/agent-sdk";
 *
 *   const browser = createBrowserClient();
 *   const tabs    = await browser.listTabs();
 *   const tab     = tabs.find(t => t.isActive)!;
 *   const page    = await browser.getPerception(tab.id);
 *   const shot    = await browser.getScreenshot(tab.id);  // base64 PNG
 *
 *   const result = await browser.execute(tab.id, {
 *     type: "invoke_site_tool",
 *     provider: "dom",
 *     toolName: "dom.read_page_state",
 *     args: {}
 *   });
 *
 *   const stream = browser.stream({
 *     onPageObserved: obs => console.log("page changed:", obs.tabId)
 *   });
 *   // later: stream.close();
 */

import * as http from "node:http";

// ── Re-export shared types agents need ────────────────────────────────────────
export type {
  A11yAuditReport,
  A11yImpact,
  A11yViolation,
  AccountInput,
  AccountSummary,
  AccountUpdate,
  AssertionConfidence,
  AssertionEvidence,
  AssertionResult,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  ComponentFramework,
  ComponentNode,
  ComponentTreeReport,
  ConsoleLogEntry,
  CookieEntry,
  DownloadEntry,
  DiffRegion,
  EventSourceMessageEntry,
  FileUploadTarget,
  HumanHandoffRecord,
  IndexedDbDatabase,
  IndexedDbObjectStore,
  LocationOverride,
  NetworkInterceptRule,
  NetworkRequestEntry,
  PageGraph,
  PageObservation,
  PageScreenshot,
  PerceptionChange,
  PerceptionChangeKind,
  PerceptionDiff,
  PerceptionSnapshotEntry,
  PerformanceReport,
  ScreenshotDiff,
  SiteCapabilityManifest,
  StorageArea,
  StorageEntry,
  StorageReport,
  RecordedCommand,
  RecordingSession,
  RecordingStopResult,
  ResourceBudget,
  TabId,
  TabLogSnapshot,
  TabSummary,
  ThreeEuler,
  ThreeFpsEstimate,
  ThreeGeometryInfo,
  ThreeMaterialInfo,
  ThreeObject,
  ThreeObjectType,
  ThreeRendererInfo,
  ThreeSceneReport,
  ThreeVec3,
  TotpResult,
  ViewportPresetName,
  ViewportSuiteReport,
  WebSocketFrameEntry,
  VIEWPORT_PRESETS
} from "../../shared/src/index.js";

import type {
  A11yAuditReport,
  AccountInput,
  AccountSummary,
  AccountUpdate,
  AssertionResult,
  BrowserCommandResult,
  BrowserOutputCommand,
  BrowserPerceptionPacket,
  ComponentTreeReport,
  CookieEntry,
  DownloadEntry,
  HumanHandoffRecord,
  LocationOverride,
  NetworkInterceptRule,
  PerceptionDiff,
  PerceptionSnapshotEntry,
  PerformanceReport,
  PageScreenshot,
  RecordingSession,
  RecordingStopResult,
  ResourceBudget,
  ScreenshotDiff,
  SiteCapabilityManifest,
  StorageArea,
  FileUploadTarget,
  StorageEntry,
  StorageReport,
  TabId,
  TabLogSnapshot,
  TabSummary,
  ThreeSceneReport,
  TotpResult,
  ViewportPresetName,
  ViewportSuiteReport
} from "../../shared/src/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BrowserClientOptions = {
  /** Default: 7070 */
  port?: number;
  /** Default: "127.0.0.1" */
  host?: string;
  /** Request timeout in ms. Default: 30_000 */
  timeout?: number;
};

export type StreamHandlers = {
  onTabsChanged?: (tabs: TabSummary[]) => void;
  onPageObserved?: (observation: unknown) => void;
  onApprovalQueued?: (approval: unknown) => void;
  onHandoffRequested?: (handoff: HumanHandoffRecord) => void;
  onHandoffResolved?: (data: { requestId: string; cancelled?: boolean }) => void;
  onIntentChanged?: (data: { intent: string }) => void;
  onAgentLog?: (data: { level: string; message: string; timestamp: number }) => void;
  onError?: (err: Error) => void;
};

export type StreamHandle = {
  close(): void;
};

// ── Client ────────────────────────────────────────────────────────────────────

export class BrowserClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeout: number;

  constructor(opts: BrowserClientOptions = {}) {
    this.host    = opts.host    ?? "127.0.0.1";
    this.port    = opts.port    ?? 7070;
    this.timeout = opts.timeout ?? 30_000;
  }

  // ── Health ──────────────────────────────────────────────────────────────

  async health(): Promise<{ status: string; tabs: number }> {
    return this.get("/api/health");
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  async listTabs(): Promise<TabSummary[]> {
    return this.get("/api/tabs");
  }

  async openTab(url?: string): Promise<TabSummary[]> {
    return this.post("/api/tabs", url ? { url } : {});
  }

  async navigate(tabId: TabId, url: string): Promise<TabSummary[]> {
    return this.post(`/api/tabs/${tabId}/navigate`, { url });
  }

  async setViewport(tabId: TabId, width: number, height: number, mobile = false): Promise<{ ok: boolean; width: number; height: number; mobile: boolean }> {
    return this.post(`/api/tabs/${tabId}/viewport`, { width, height, mobile });
  }

  // ── Perception ──────────────────────────────────────────────────────────

  async getPerception(tabId: TabId): Promise<BrowserPerceptionPacket> {
    return this.get(`/api/tabs/${tabId}/perception`);
  }

  async listManifests(tabId: TabId): Promise<SiteCapabilityManifest[]> {
    return this.get(`/api/tabs/${tabId}/manifests`);
  }

  /** Returns a PageScreenshot with a base64 PNG in `.data`. */
  async getScreenshot(tabId: TabId): Promise<PageScreenshot> {
    return this.get(`/api/tabs/${tabId}/screenshot`);
  }

  /** Returns the raw PNG as a Buffer — ready for fs.writeFile or vision API. */
  async getScreenshotBuffer(tabId: TabId): Promise<Buffer> {
    const shot = await this.getScreenshot(tabId);
    return Buffer.from(shot.data, "base64");
  }

  // ── Execution ───────────────────────────────────────────────────────────

  async execute(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult> {
    return this.post(`/api/tabs/${tabId}/command`, { command });
  }

  // ── Approvals ───────────────────────────────────────────────────────────

  async listApprovals(): Promise<unknown[]> {
    return this.get("/api/approvals");
  }

  async approveCommand(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/approvals/${requestId}/approve`, {});
  }

  async rejectCommand(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/approvals/${requestId}/reject`, {});
  }

  // ── Human handoffs ──────────────────────────────────────────────────────

  async listHandoffs(): Promise<HumanHandoffRecord[]> {
    return this.get("/api/handoffs");
  }

  async resolveHandoff(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/handoffs/${requestId}/resolve`, {});
  }

  async cancelHandoff(requestId: string): Promise<BrowserCommandResult> {
    return this.post(`/api/handoffs/${requestId}/cancel`, {});
  }

  /**
   * Wait until the given handoff is resolved (by the user in the UI) and
   * return. Polls the SSE stream internally. Rejects if `timeoutMs` elapses.
   */
  waitForHandoffResolved(requestId: string, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handle.close();
        reject(new Error(`Handoff ${requestId} was not resolved within ${timeoutMs}ms`));
      }, timeoutMs);

      const handle = this.stream({
        onHandoffResolved: (data) => {
          if (data.requestId === requestId) {
            clearTimeout(timer);
            handle.close();
            resolve();
          }
        },
        onError: (err) => {
          clearTimeout(timer);
          handle.close();
          reject(err);
        }
      });
    });
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  async listAccounts(): Promise<AccountSummary[]> {
    return this.get("/api/accounts");
  }

  async saveAccount(input: AccountInput): Promise<AccountSummary> {
    return this.post("/api/accounts", input);
  }

  async updateAccount(id: string, update: AccountUpdate): Promise<AccountSummary> {
    return this.request("PATCH", `/api/accounts/${id}`, update);
  }

  async deleteAccount(id: string): Promise<{ deleted: string }> {
    return this.request("DELETE", `/api/accounts/${id}`);
  }

  async lookupAccounts(origin: string): Promise<AccountSummary[]> {
    return this.get(`/api/accounts/lookup/${encodeURIComponent(origin)}`);
  }

  async generateTotp(accountId: string): Promise<TotpResult> {
    return this.get(`/api/accounts/${accountId}/totp`);
  }

  // ── Intent ─────────────────────────────────────────────────────────────

  async getIntent(): Promise<{ intent: string }> {
    return this.get("/api/intent");
  }

  async setIntent(intent: string): Promise<{ intent: string }> {
    return this.request("PUT", "/api/intent", { intent });
  }

  // ── Logging ────────────────────────────────────────────────────────────

  async log(message: string, level: "system" | "agent" | "ai" | "error" | "nav" = "agent"): Promise<void> {
    await this.post("/api/log", { level, message });
  }

  // ── Dev tools ──────────────────────────────────────────────────────────

  /** Return all buffered console logs, network requests, and JS errors for the tab. */
  async getLogs(tabId: TabId): Promise<TabLogSnapshot> {
    return this.get(`/api/tabs/${tabId}/logs`);
  }

  /** Clear all buffered logs for the tab. */
  async clearLogs(tabId: TabId): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/tabs/${tabId}/logs`);
  }

  async getRecording(tabId: TabId): Promise<RecordingSession | null> {
    return this.get(`/api/tabs/${tabId}/recording`);
  }

  async startRecording(tabId: TabId): Promise<RecordingSession> {
    return this.post(`/api/tabs/${tabId}/recording/start`, {});
  }

  async stopRecording(tabId: TabId): Promise<RecordingStopResult> {
    return this.post(`/api/tabs/${tabId}/recording/stop`, {});
  }

  async getSitePatterns(tabId: TabId): Promise<{ patterns: string[] }> {
    return this.get(`/api/tabs/${tabId}/site-patterns`);
  }

  async addSitePatterns(tabId: TabId, patterns: string[]): Promise<{ patterns: string[] }> {
    return this.post(`/api/tabs/${tabId}/site-patterns`, { patterns, mode: "add" });
  }

  async setSitePatterns(tabId: TabId, patterns: string[]): Promise<{ patterns: string[] }> {
    return this.post(`/api/tabs/${tabId}/site-patterns`, { patterns, mode: "set" });
  }

  async clearSitePatterns(tabId: TabId): Promise<void> {
    await this.delete(`/api/tabs/${tabId}/site-patterns`);
  }

  async setFileInputFiles(tabId: TabId, target: FileUploadTarget): Promise<{ ok: true }> {
    return this.post(`/api/tabs/${tabId}/file-input`, target);
  }

  async listDownloads(tabId: TabId): Promise<DownloadEntry[]> {
    return this.get(`/api/tabs/${tabId}/downloads`);
  }

  async clearDownloads(tabId: TabId): Promise<void> {
    await this.delete(`/api/tabs/${tabId}/downloads`);
  }

  async getResourceBudget(tabId: TabId): Promise<ResourceBudget | null> {
    return this.get(`/api/tabs/${tabId}/budget`);
  }

  async setResourceBudget(tabId: TabId, budget: ResourceBudget): Promise<ResourceBudget> {
    return this.post(`/api/tabs/${tabId}/budget`, budget);
  }

  async clearResourceBudget(tabId: TabId): Promise<void> {
    await this.delete(`/api/tabs/${tabId}/budget`);
  }

  async getLocationOverride(tabId: TabId): Promise<LocationOverride | null> {
    return this.get(`/api/tabs/${tabId}/location`);
  }

  async setLocationOverride(tabId: TabId, location: LocationOverride): Promise<LocationOverride> {
    return this.post(`/api/tabs/${tabId}/location`, location);
  }

  async clearLocationOverride(tabId: TabId): Promise<void> {
    await this.delete(`/api/tabs/${tabId}/location`);
  }

  /**
   * Enable network request interception for the tab.
   * Requests matching a rule are fulfilled with the mocked response.
   * Non-matching requests pass through transparently.
   */
  async enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<{ ok: boolean; rulesCount: number }> {
    return this.post(`/api/tabs/${tabId}/mock`, { rules });
  }

  /** Disable network interception and restore normal request handling. */
  async disableNetworkMock(tabId: TabId): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/tabs/${tabId}/mock`);
  }

  /** Return the currently active mock rules for the tab (null if disabled). */
  async getNetworkMockRules(tabId: TabId): Promise<{ rules: NetworkInterceptRule[] | null }> {
    return this.get(`/api/tabs/${tabId}/mock`);
  }

  /**
   * Capture a screenshot and store it in the server-side cache under `snapshotId`.
   * Use `diffScreenshots` to compare two named captures.
   */
  async captureNamedScreenshot(tabId: TabId, snapshotId: string): Promise<PageScreenshot> {
    return this.post(`/api/tabs/${tabId}/screenshot/named`, { snapshotId });
  }

  /**
   * Compare two previously captured named screenshots pixel-by-pixel.
   * Returns a diff percentage and a base64 PNG with changed pixels highlighted in red.
   */
  async diffScreenshots(beforeId: string, afterId: string): Promise<ScreenshotDiff> {
    return this.post("/api/screenshots/diff", { beforeId, afterId });
  }

  /**
   * List all named screenshots currently held in the server-side in-memory cache.
   * Returns lightweight metadata only — no image data.
   *
   * @example
   * const list = await browser.listScreenshots();
   * for (const s of list) {
   *   console.log(`${s.id}: ${s.url} — ${s.width}×${s.height}`);
   * }
   */
  async listScreenshots(): Promise<Array<{ id: string; tabId: string; url: string; width: number; height: number; capturedAt: number }>> {
    return this.get("/api/screenshots");
  }

  /**
   * Remove a named screenshot from the server-side cache.
   * Call this to free memory after you no longer need a captured baseline.
   *
   * @example
   * await browser.deleteScreenshot("before-deploy");
   */
  async deleteScreenshot(id: string): Promise<void> {
    await this.delete(`/api/screenshots/${encodeURIComponent(id)}`);
  }

  /**
   * Capture screenshots at multiple viewport breakpoints in one call.
   *
   * @param presets     Subset of preset names to capture. Defaults to ["mobile","tablet","laptop","desktop"].
   *                    Available: "mobile-sm" | "mobile" | "mobile-lg" | "tablet" | "tablet-lg" | "laptop" | "desktop" | "wide"
   * @param includeDiffs When true, pairwise pixel diffs between consecutive breakpoints are included.
   *
   * @example
   * const report = await browser.captureViewportSuite(tabId, ["mobile","tablet","desktop"], true);
   * for (const { preset, screenshot } of report.captures) {
   *   console.log(preset.label, screenshot.width, screenshot.height);
   * }
   * for (const { from, to, diff } of report.diffs) {
   *   console.log(`${from} → ${to}: ${diff.diffPercentage}% changed`);
   * }
   */
  async captureViewportSuite(
    tabId: TabId,
    presets?: ViewportPresetName[],
    includeDiffs = false
  ): Promise<ViewportSuiteReport> {
    return this.post(`/api/tabs/${tabId}/viewport-suite`, { presets, includeDiffs });
  }

  /**
   * Capture performance metrics for the tab: Navigation Timing, Core Web Vitals
   * (LCP, FCP, CLS, INP, TTFB), top-20 slowest resources, and raw CDP counters.
   *
   * @example
   * const perf = await browser.getPerformanceMetrics(tabId);
   * console.log(`LCP: ${perf.vitals.lcp}ms, CLS: ${perf.vitals.cls}`);
   * console.log(`TTFB: ${perf.navigation?.ttfb}ms`);
   * console.log("Slowest resource:", perf.slowResources[0]?.name);
   */
  async getPerformanceMetrics(tabId: TabId): Promise<PerformanceReport> {
    return this.get(`/api/tabs/${tabId}/performance`);
  }

  /**
   * Run a WCAG 2.2-aligned accessibility audit against the live AX tree.
   * No external tooling required — checks are derived from the AX tree
   * already captured during perception.
   *
   * @example
   * const report = await browser.auditAccessibility(tabId);
   * for (const v of report.violations) {
   *   console.log(`[${v.impact}] ${v.rule}: ${v.description} (${v.selector})`);
   * }
   * console.log(`${report.passes} nodes passed, ${report.violations.length} violations`);
   */
  async auditAccessibility(tabId: TabId): Promise<A11yAuditReport> {
    return this.get(`/api/tabs/${tabId}/a11y`);
  }

  /**
   * Probe the page for React / Vue / Svelte devtools hooks and return a
   * lightweight component tree. Returns `tree: null` when no hook is found
   * (e.g. minified production build without devtools).
   *
   * @example
   * const ct = await browser.captureComponentTree(tabId);
   * console.log(`Framework: ${ct.framework}, ${ct.nodeCount} components`);
   * if (ct.tree) console.log(JSON.stringify(ct.tree, null, 2));
   */
  async captureComponentTree(tabId: TabId): Promise<ComponentTreeReport> {
    return this.get(`/api/tabs/${tabId}/component-tree`);
  }

  // ── Three.js Scene Inspector ──────────────────────────────────────────────

  /**
   * Probe the live page for a Three.js renderer and scene graph.
   *
   * Detects `window.__threeRenderer__`, `window.renderer`, `window.scene` and
   * similar patterns set by Vite/R3F dev builds. Returns a `ThreeSceneReport`
   * with the full object tree (depth ≤ 8), renderer draw-call stats, FPS
   * estimate, and a summary counter block — enough context for an AI agent to
   * give actionable code feedback.
   *
   * @example
   * const report = await browser.captureThreeJsScene(tabId);
   * if (!report.detected) { console.log("No Three.js renderer found"); return; }
   *
   * // Let the AI reason over the report:
   * const feedback = await ai.chat([
   *   { role: "system", content: "You are a Three.js performance expert." },
   *   { role: "user",   content: JSON.stringify(report) }
   * ]);
   */
  async captureThreeJsScene(tabId: TabId): Promise<ThreeSceneReport> {
    return this.get(`/api/tabs/${tabId}/threejs-scene`);
  }

  // ── Natural Language Assertions ───────────────────────────────────────────

  /**
   * Evaluate a natural-language assertion against the live page.
   *
   * The server captures a fresh `PageGraph` and runs a heuristic evaluator
   * covering quantitative checks, presence/absence, disabled state, title
   * matching, and comparative counts.
   *
   * By default this method **throws an `AssertionError`** when the assertion
   * fails — making it drop-in compatible with Node's `assert` module style.
   * Pass `{ throw: false }` to get the raw `AssertionResult` instead.
   *
   * When `result.confidence === "low"` the evidence bundle is returned so
   * you can forward it to your own LLM for a second opinion.
   *
   * @example
   * // In an AI agent test script:
   * await browser.assert(tabId, "the checkout button is visible");
   * await browser.assert(tabId, "there are no error messages");
   * await browser.assert(tabId, "the cart shows 3 items");
   *
   * // Get raw result without throwing:
   * const r = await browser.assert(tabId, "the form has 2 fields", { throw: false });
   * if (!r.pass) {
   *   const feedback = await ai.chat([
   *     { role: "user", content: `Page evidence: ${JSON.stringify(r.evidence)}\nIs this true: "${r.assertion}"?` }
   *   ]);
   * }
   */
  async assert(
    tabId: TabId,
    assertion: string,
    opts: { throw?: boolean } = {}
  ): Promise<AssertionResult> {
    const result: AssertionResult = await this.post(`/api/tabs/${tabId}/assert`, { assertion });
    if (!result.pass && opts.throw !== false) {
      const err = new Error(
        `Assertion failed (confidence: ${result.confidence}): ${assertion}\n  → ${result.explanation}`
      );
      err.name = "AssertionError";
      throw err;
    }
    return result;
  }

  // ── Storage Inspector ─────────────────────────────────────────────────────

  /**
   * Capture a full storage snapshot for the tab: localStorage, sessionStorage,
   * all cookies, and every IndexedDB database at the current origin.
   *
   * @example
   * const s = await browser.captureStorage(tabId);
   * console.log(`${s.localStorage.length} localStorage keys, ${s.cookies.length} cookies`);
   * console.log(`Total storage: ${(s.totalBytes / 1024).toFixed(1)} KB`);
   */
  async captureStorage(tabId: TabId): Promise<StorageReport> {
    return this.get(`/api/tabs/${tabId}/storage`);
  }

  /**
   * Read all entries from localStorage or sessionStorage.
   * Pass `key` to read a single entry.
   *
   * @example
   * const entries = await browser.getStorage(tabId, "local");
   * const token   = await browser.getStorage(tabId, "local", "auth-token");
   */
  async getStorage(tabId: TabId, area: StorageArea, key?: string): Promise<StorageEntry[]> {
    const qs = key ? `?key=${encodeURIComponent(key)}` : "";
    return this.get(`/api/tabs/${tabId}/storage/${area}${qs}`);
  }

  /**
   * Write one or more key/value pairs to localStorage or sessionStorage.
   *
   * @example
   * await browser.setStorage(tabId, "local", { "auth-token": "test-jwt", "theme": "dark" });
   */
  async setStorage(tabId: TabId, area: StorageArea, entries: Record<string, string>): Promise<void> {
    await this.post(`/api/tabs/${tabId}/storage/${area}`, { entries });
  }

  /**
   * Remove specific keys from localStorage or sessionStorage.
   * Omit `keys` to clear the entire area.
   *
   * @example
   * await browser.clearStorage(tabId, "session");          // clear all
   * await browser.clearStorage(tabId, "local", ["cart"]);  // remove one key
   */
  async clearStorage(tabId: TabId, area: StorageArea, keys?: string[]): Promise<void> {
    await this.delete(`/api/tabs/${tabId}/storage/${area}`, keys ? { keys } : undefined);
  }

  /**
   * List all cookies for the tab's current origin.
   *
   * @example
   * const cookies = await browser.getCookies(tabId);
   * const session = cookies.find(c => c.name === "session_id");
   */
  async getCookies(tabId: TabId): Promise<CookieEntry[]> {
    return this.get(`/api/tabs/${tabId}/cookies`);
  }

  /**
   * Set (upsert) a cookie for the tab's current origin.
   *
   * @example
   * await browser.setCookie(tabId, { name: "session_id", value: "test-sess-123", httpOnly: true });
   */
  async setCookie(tabId: TabId, cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void> {
    await this.post(`/api/tabs/${tabId}/cookies`, cookie);
  }

  /**
   * Delete a single cookie by name. Pass `url` if the cookie is scoped to a
   * different URL than the current page.
   *
   * @example
   * await browser.deleteCookie(tabId, "session_id");
   */
  async deleteCookie(tabId: TabId, name: string, url?: string): Promise<void> {
    const qs = url ? `?url=${encodeURIComponent(url)}` : "";
    await this.delete(`/api/tabs/${tabId}/cookies/${encodeURIComponent(name)}${qs}`);
  }

  /**
   * Clear all cookies for the tab's current origin.
   *
   * @example
   * await browser.clearCookies(tabId);
   */
  async clearCookies(tabId: TabId): Promise<void> {
    await this.delete(`/api/tabs/${tabId}/cookies`);
  }

  // ── "What Broke?" Perception Snapshot + Diff ────────────────────────────

  /**
   * Capture the current PageGraph for a tab and store it under `snapshotId`.
   * Call this **before** a deploy to create a structural baseline.
   *
   * @example
   * await browser.savePerceptionSnapshot(tabId, "pre-deploy-v1.2");
   */
  async savePerceptionSnapshot(tabId: TabId, snapshotId: string): Promise<PerceptionSnapshotEntry> {
    return this.post(`/api/tabs/${tabId}/perception/named`, { snapshotId });
  }

  /**
   * Compare two previously saved perception snapshots.
   * Returns every structural change: headings, forms, actions, alerts, title, media.
   *
   * @example
   * const diff = await browser.diffPerception("pre-deploy", "post-deploy");
   * console.log(diff.summary);
   * for (const c of diff.changes) {
   *   console.log(`[${c.kind}] ${c.description}`);
   * }
   * if (diff.identical) console.log("Nothing changed!");
   */
  async diffPerception(beforeId: string, afterId: string): Promise<PerceptionDiff> {
    return this.post("/api/perception/diff", { beforeId, afterId });
  }

  /**
   * List all named perception snapshots currently in the server-side cache.
   *
   * @example
   * const snaps = await browser.listPerceptionSnapshots();
   * // [{ id, tabId, url, title, capturedAt }, ...]
   */
  async listPerceptionSnapshots(): Promise<PerceptionSnapshotEntry[]> {
    return this.get("/api/perception");
  }

  /**
   * Remove a named perception snapshot from the cache to free memory.
   *
   * @example
   * await browser.deletePerceptionSnapshot("pre-deploy-v1.2");
   */
  async deletePerceptionSnapshot(id: string): Promise<void> {
    await this.delete(`/api/perception/${encodeURIComponent(id)}`);
  }

  // ── SSE stream ──────────────────────────────────────────────────────────

  /**
   * Subscribe to the real-time event stream.
   * Returns a handle with a `close()` method to disconnect.
   * Automatically reconnects on drop.
   */
  stream(handlers: StreamHandlers): StreamHandle {
    let alive = true;
    let currentReq: http.ClientRequest | null = null;

    const connect = () => {
      if (!alive) return;

      const req = http.get(
        { host: this.host, port: this.port, path: "/api/stream" },
        (res) => {
          let buf = "";
          let eventType = "message";

          res.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("event: ")) {
                eventType = line.slice(7).trim();
              } else if (line.startsWith("data: ")) {
                try {
                  const data = JSON.parse(line.slice(6)) as unknown;
                  dispatch(eventType, data, handlers);
                } catch {
                  // malformed JSON — skip
                }
                eventType = "message";
              }
            }
          });

          res.on("end", () => {
            if (alive) setTimeout(connect, 2000);
          });
          res.on("error", () => {
            if (alive) setTimeout(connect, 2000);
          });
        }
      );

      req.on("error", () => {
        if (alive) setTimeout(connect, 2000);
      });

      currentReq = req;
    };

    connect();

    return {
      close() {
        alive = false;
        currentReq?.destroy();
        currentReq = null;
      }
    };
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────

  private get<T>(path: string): Promise<T> {
    return this.request("GET", path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request("POST", path, body);
  }

  private delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request("DELETE", path, body);
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string | number> = {
        "Accept": "application/json",
        "Content-Type": "application/json"
      };
      if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          headers,
          timeout: this.timeout
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new Error(`HTTP ${res.statusCode} ${method} ${path}: ${text}`));
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(new Error(`Non-JSON response from ${method} ${path}: ${text}`));
            }
          });
          res.on("error", reject);
        }
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request timed out: ${method} ${path}`));
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

// ── SSE dispatcher ────────────────────────────────────────────────────────────

function dispatch(eventType: string, data: unknown, handlers: StreamHandlers) {
  switch (eventType) {
    case "tabs_changed":
      handlers.onTabsChanged?.(data as TabSummary[]);
      break;
    case "page_observed":
      handlers.onPageObserved?.(data);
      break;
    case "approval_queued":
      handlers.onApprovalQueued?.(data);
      break;
    case "human_handoff_requested":
      handlers.onHandoffRequested?.(data as HumanHandoffRecord);
      break;
    case "human_handoff_resolved":
      handlers.onHandoffResolved?.(data as { requestId: string; cancelled?: boolean });
      break;
    case "intent_changed":
      handlers.onIntentChanged?.(data as { intent: string });
      break;
    case "agent_log":
      handlers.onAgentLog?.(data as { level: string; message: string; timestamp: number });
      break;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createBrowserClient(opts?: BrowserClientOptions): BrowserClient {
  return new BrowserClient(opts);
}
