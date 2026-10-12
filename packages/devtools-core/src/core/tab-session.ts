/**
 * `TabSession` — one tab's tools on top of its `CdpTarget` (ADR 0001 §4.3).
 *
 * Holds the per-tab tool bodies that used to live in the desktop `TabManager`
 * (snapshot, screenshot, coverage, trace, collectors, input, storage,
 * overrides, mock, logs/HAR, recording, perception, resource budget). Every
 * CDP call goes through `tab.cdp`, so the same code runs on the Electron
 * desktop and the headless daemon. Cross-tab concerns (stores, watches,
 * approvals, listeners) live in `HelmstackCore`.
 */
import { normalizePerception } from "../../../perception/src/normalize.js";
import type {
  A11yAuditReport,
  BrowserCommandResult,
  CdpTarget,
  ChangedElement,
  ComponentSourceReport,
  ComponentTreeReport,
  CookieEntry,
  CssCoverageReport,
  DesignTokensReport,
  DiffRegion,
  DownloadEntry,
  ElementBound,
  ElementStyleAssertionReport,
  ElementStyleInspectionReport,
  FileUploadTarget,
  FocusOrderReport,
  FrameworkReport,
  HarArchive,
  JsCoverageReport,
  LayoutIssuesReport,
  LocationOverride,
  MediaEmulation,
  MediaStateReport,
  MutationTimelineReport,
  NetworkInterceptRule,
  PageObservation,
  PageScreenshot,
  PageSnapshot,
  PerceptionResult,
  PerformanceReport,
  RecordedCommand,
  RecordingSession,
  RecordingStopResult,
  ResourceBudget,
  ScreenshotOptions,
  StorageArea,
  StorageEntry,
  StorageReport,
  StyleAssertion,
  TabId,
  TabLogSnapshot,
  ThreeSceneReport,
  TraceReport
} from "../../../shared/src/index.js";
import type { BackendTab } from "../backend.js";
import { requestObservation } from "../perception/injector.js";
import { runA11yAudit } from "./cdp/a11y-audit.js";
import { handleCdpMessage } from "./cdp/cdp-events.js";
import { runComponentTree } from "./cdp/component-tree.js";
import { applyLocationOverride, applyMediaEmulation, applyResourceBudget } from "./cdp/overrides.js";
import { capturePerformance } from "./cdp/performance-probe.js";
import * as storage from "./cdp/storage-inspector.js";
import { assertStyles, inspectStyles } from "./cdp/style-inspector.js";
import { captureThreeScene } from "./cdp/threejs-inspector.js";
import type { PageHandle } from "./commands/types.js";
import { buildComponentSourceReport, componentSourceCollectorScript, type RawComponentSources } from "./reports/component-source.js";
import { buildCssCoverageReport, type RawRuleRange, type RawStylesheetCoverage } from "./reports/css-coverage.js";
import { buildDesignTokensReport, designTokenCollectorScript, type RawDesignTokens } from "./reports/design-tokens.js";
import { correlateRegionsToElements, elementBoundsScript } from "./reports/element-bounds.js";
import { analyzeFocusOrder, focusableElementsScript, type RawFocusOrder } from "./reports/focus-order.js";
import { detectFramework as classifyFramework, frameworkSignalsScript, type RawFrameworkSignals } from "./reports/framework-detect.js";
import { buildHar } from "./reports/har.js";
import { buildJsCoverageReport, type RawScriptCoverage } from "./reports/js-coverage.js";
import { buildLayoutIssuesReport, layoutIssueDetectorScript, type LayoutIssuesRaw } from "./reports/layout-issues.js";
import { buildMediaStateReport, mediaStateCollectorScript, type MediaStateRaw } from "./reports/media-state.js";
import { buildMutationReport, mutationTimelineScript, type RawMutationTimeline } from "./reports/mutation-timeline.js";
import { exportRecordingAll, renderRecordingScript } from "./reports/recording-export.js";
import { buildTraceSummary, type RawTraceEvent } from "./reports/trace-summary.js";
import { clearLogBuffers, type TabState } from "./tab-state.js";
import { clampInt } from "./util.js";

export type TabSessionOptions = {
  /** Fallback screenshot viewport when no emulated viewport is set (desktop: shell rect). */
  defaultViewport?: () => { width: number; height: number };
  /** Social-surface perception for pulled observations. Default false. */
  includeSocial?: boolean;
  /**
   * Pull a fresh observation from the page on every `capturePerception`
   * (default true). Backends whose push feed is already fresh enough (the
   * desktop preload) pass false to skip the one-off extraction.
   */
  pullObservations?: boolean;
};

type Bounds = { x: number; y: number; width: number; height: number };

const RELOAD_TIMEOUT_MS = 4000;
const RELOAD_SETTLE_MS = 250;
const TRACE_COMPLETE_TIMEOUT_MS = 5000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves on the first `method` event (or after `timeoutMs`). `off` must be
 * called in a `finally` so the listener never outlives the capture.
 */
function waitForCdpEvent(cdp: CdpTarget, method: string): { fired: Promise<void>; off: () => void } {
  let off: () => void = () => {};
  const fired = new Promise<void>((resolve) => {
    off = cdp.onEvent((m) => {
      if (m === method) {
        off();
        resolve();
      }
    });
  });
  return { fired, off: () => off() };
}

export class TabSession {
  readonly id: TabId;
  readonly cdp: CdpTarget;
  /** What the command registry acts on. */
  readonly page: PageHandle;
  private readonly offCdpEvents: () => void;
  private disposed = false;

  constructor(
    readonly tab: BackendTab,
    readonly state: TabState,
    private readonly options: TabSessionOptions = {}
  ) {
    this.id = tab.id;
    this.cdp = tab.cdp;
    this.page = { cdp: tab.cdp, navigate: (url) => tab.navigate(url) };
    // Route CDP events to the log/mock buffers — bound once per tab.
    this.offCdpEvents = this.cdp.onEvent((method, params) => {
      handleCdpMessage(this.state, this.cdp, method, params);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offCdpEvents();
  }

  // ── CDP domain management ─────────────────────────────────────────────────

  /** Enables the domains `handleCdpMessage` buffers from (idempotent). */
  async enableCdpLogging(): Promise<void> {
    if (this.state.cdpLoggingEnabled) return;
    this.state.cdpLoggingEnabled = true;
    try {
      await Promise.all([
        this.cdp.send("Runtime.enable"),
        this.cdp.send("Log.enable"),
        this.cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
        this.cdp.send("Performance.enable", { timeDomain: "timeTicks" }).catch(() => {})
      ]);
    } catch (error) {
      // Let the next caller retry (e.g. the target was not attachable yet).
      this.state.cdpLoggingEnabled = false;
      throw error;
    }
  }

  // ── Lifecycle hooks (driven by HelmstackCore) ─────────────────────────────

  /** Main-frame navigation started: drop the previous document's logs. */
  clearLogBuffers(): void {
    clearLogBuffers(this.state);
  }

  /** Load finished: re-apply emulation overrides that a new document drops. */
  async reapplyOverrides(): Promise<void> {
    await Promise.allSettled([
      applyLocationOverride(this.cdp, this.state.locationOverride),
      applyResourceBudget(this.cdp, this.state.resourceBudget),
      applyMediaEmulation(this.cdp, this.state.mediaEmulation)
    ]);
  }

  recordObservation(observation: PageObservation): void {
    this.state.lastObservation = observation;
  }

  /** Inserts or updates (by id) a download reported by the backend. */
  recordDownload(download: DownloadEntry): void {
    const existing = this.state.downloads.find((entry) => entry.id === download.id);
    if (existing) {
      if (existing !== download) Object.assign(existing, download);
    } else {
      this.state.downloads.push(download);
    }
  }

  recordCommand(source: RecordedCommand["source"], command: unknown, outcome: RecordedCommand["outcome"]): void {
    if (!this.state.recording) return;
    this.state.recording.commands.push({ at: Date.now(), source, command, outcome });
  }

  // ── Snapshot / perception ─────────────────────────────────────────────────

  async captureSnapshot(): Promise<PageSnapshot> {
    // Enable log/network CDP domains once per tab lifetime (idempotent after first call).
    await this.enableCdpLogging();

    await this.cdp.send("Accessibility.enable");

    const [dom, ax] = await Promise.all([
      this.cdp.send("DOMSnapshot.captureSnapshot", {
        computedStyles: ["display", "visibility", "pointer-events"],
        includeDOMRects: true,
        includePaintOrder: true
      }),
      this.cdp.send("Accessibility.getFullAXTree", {})
    ]);

    return {
      tabId: this.id,
      url: this.cdp.url(),
      title: this.tab.title(),
      capturedAt: Date.now(),
      dom,
      accessibilityTree: ax
    };
  }

  /**
   * Pulls a fresh observation from the page (ADR §6.1 step 3: the pushed one
   * is debounced and may be stale). Falls back to the last pushed observation
   * when the pull fails or there is no document yet.
   */
  async refreshObservation(): Promise<PageObservation | null> {
    try {
      const pulled = await requestObservation(this.cdp, {
        tabId: this.id,
        includeSocial: this.options.includeSocial ?? false
      });
      if (pulled) {
        this.state.lastObservation = pulled;
      }
    } catch {
      // keep the pushed observation
    }
    return this.state.lastObservation;
  }

  /** Snapshot + observation → normalized `PageGraph`. Watches are evaluated by the core. */
  async capturePerception(): Promise<PerceptionResult> {
    const snapshot = await this.captureSnapshot();
    const observation = this.options.pullObservations === false
      ? this.state.lastObservation
      : await this.refreshObservation();
    return normalizePerception(snapshot, observation);
  }

  // ── Screenshots / viewport ────────────────────────────────────────────────

  async captureScreenshot(options: ScreenshotOptions = {}): Promise<PageScreenshot> {
    const fallback = this.options.defaultViewport?.() ?? { width: 0, height: 0 };
    const emu = this.state.emulatedViewport;
    const w = (emu?.width  ?? fallback.width)  || 1280;
    const h = (emu?.height ?? fallback.height) || 800;
    const mobile = emu?.mobile ?? false;

    // Ensure a rendering viewport exists even if the tab is not currently visible.
    // Without this, inactive tabs have 0×0 bounds and the capture fails.
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile
    });

    // Resolve an optional capture region: a selector's bounding box, or the
    // full scrollable content. Both need captureBeyondViewport so content
    // below the fold renders.
    let clip: (Bounds & { scale: number }) | undefined;
    let captureBeyondViewport = false;

    try {
      if (options.selector) {
        const bounds = await this.resolveElementBounds(options.selector);
        if (!bounds) {
          throw new Error(`No visible element matches selector: ${options.selector}`);
        }
        clip = { ...bounds, scale: 1 };
        captureBeyondViewport = true;
      } else if (options.fullPage) {
        const layout = await this.cdp.send<{
          cssContentSize?: { width: number; height: number };
          contentSize?: { width: number; height: number };
        }>("Page.getLayoutMetrics");
        const content = layout.cssContentSize ?? layout.contentSize;
        if (content && content.width > 0 && content.height > 0) {
          clip = { x: 0, y: 0, width: content.width, height: content.height, scale: 1 };
          captureBeyondViewport = true;
        }
      }

      const result = await this.cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport,
        ...(clip ? { clip } : {})
      });

      const metrics = await this.cdp.send<{
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      }>("Page.getLayoutMetrics");

      return {
        tabId: this.id,
        capturedAt: Date.now(),
        data: result.data,
        mimeType: "image/png",
        width: clip ? Math.round(clip.width) : metrics.cssLayoutViewport.clientWidth,
        height: clip ? Math.round(clip.height) : metrics.cssLayoutViewport.clientHeight
      };
    } finally {
      // ADR §6.3: keep an active `setEmulatedViewport` instead of clearing it
      // (headless would otherwise snap back to the window size).
      await this.restoreViewport().catch(() => {});
    }
  }

  /** Re-applies the emulated viewport, or clears the override when none is set. */
  private async restoreViewport(): Promise<void> {
    const emu = this.state.emulatedViewport;
    if (emu) {
      await this.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: emu.width, height: emu.height, deviceScaleFactor: emu.mobile ? 2 : 1, mobile: emu.mobile
      });
    } else {
      await this.cdp.send("Emulation.clearDeviceMetricsOverride");
    }
  }

  /** Resolve a selector's page-coordinate bounding box, or null if not found/visible. */
  private async resolveElementBounds(selector: string): Promise<Bounds | null> {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    })()`;
    const res = await this.cdp.send<{ result: { value: Bounds | null } }>("Runtime.evaluate", {
      expression,
      returnByValue: true
    });
    return res.result?.value ?? null;
  }

  async setEmulatedViewport(width: number, height: number, mobile: boolean): Promise<void> {
    this.state.emulatedViewport = { width, height, mobile };
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile
    });
  }

  /** Drops the emulated viewport (used by the viewport suite to restore "none"). */
  async clearEmulatedViewport(): Promise<void> {
    await this.cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    this.state.emulatedViewport = undefined;
  }

  /**
   * Map changed pixel regions (e.g. from `diffScreenshots`) to the DOM elements
   * that occupy them. Captures live element bounds, so call it while the page
   * is in the after-state.
   */
  async mapRegionsToElements(regions: DiffRegion[]): Promise<ChangedElement[]> {
    const value = await this.evaluateCollector<{ elements: ElementBound[] }>(elementBoundsScript());
    return correlateRegionsToElements(regions, value?.elements ?? []);
  }

  // ── Inspection modules ────────────────────────────────────────────────────

  async capturePerformanceMetrics(): Promise<PerformanceReport> {
    return capturePerformance(this.cdp, this.id);
  }

  async auditAccessibility(selector?: string): Promise<A11yAuditReport> {
    return runA11yAudit(this.cdp, this.id, selector);
  }

  async inspectElementStyles(selector: string, options: { limit?: number } = {}): Promise<ElementStyleInspectionReport> {
    return inspectStyles(this.cdp, this.id, selector, options);
  }

  async assertElementStyles(
    selector: string,
    assertions: StyleAssertion[],
    options: { limit?: number } = {}
  ): Promise<ElementStyleAssertionReport> {
    return assertStyles(this.cdp, this.id, selector, assertions, options);
  }

  async captureComponentTree(): Promise<ComponentTreeReport> {
    return runComponentTree(this.cdp, this.id);
  }

  async captureThreeJsScene(): Promise<ThreeSceneReport> {
    return captureThreeScene(this.cdp, this.id);
  }

  // ── Collector scripts (Runtime.evaluate + pure builder) ───────────────────

  /** Runs a collector script in the page and returns its by-value result. */
  private async evaluateCollector<T>(expression: string, awaitPromise = false): Promise<T | undefined> {
    const result = await this.cdp.send<{ result: { value?: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    return result.result.value;
  }

  /** Map rendered DOM nodes back to their authoring component + source file:line. */
  async captureComponentSources(): Promise<ComponentSourceReport> {
    const raw = await this.evaluateCollector<RawComponentSources>(componentSourceCollectorScript())
      ?? { url: this.cdp.url(), sampledElements: 0, elements: [] };
    return buildComponentSourceReport(raw, this.id, Date.now());
  }

  /** Harvest the de-facto design tokens (colors, type scale, spacing, etc.) in use on the page. */
  async extractDesignTokens(): Promise<DesignTokensReport> {
    const raw = await this.evaluateCollector<RawDesignTokens>(designTokenCollectorScript()) ?? {
      url: this.cdp.url(),
      cssVariables: {},
      counts: { colors: {}, fontFamilies: {}, fontSizes: {}, fontWeights: {}, spacing: {}, radii: {}, shadows: {}, zIndices: {} },
      sampledElements: 0
    };
    return buildDesignTokensReport(raw, this.id, Date.now());
  }

  /** Fingerprint the page's framework + dev server and whether it's a dev build with HMR. */
  async detectFramework(): Promise<FrameworkReport> {
    const raw = await this.evaluateCollector<RawFrameworkSignals>(frameworkSignalsScript()) ?? {
      url: this.cdp.url(), globals: [], scriptSrcs: [], astroIslands: 0, generator: null
    };
    return classifyFramework(raw, this.id, Date.now());
  }

  /** Sample DOM mutations for `durationMs` and rank the busiest subtrees. */
  async captureMutationTimeline(durationMs = 1000): Promise<MutationTimelineReport> {
    const clamped = clampInt(durationMs, 100, 10000);
    const raw = await this.evaluateCollector<RawMutationTimeline>(mutationTimelineScript(clamped), true) ?? {
      url: this.cdp.url(),
      durationMs: clamped,
      byKind: { childList: 0, attributes: 0, characterData: 0 },
      addedNodes: 0,
      removedNodes: 0,
      targets: {}
    };
    return buildMutationReport(raw, this.id, Date.now());
  }

  /** Read the page's current responsive state: resolved media features + matching @media queries. */
  async getMediaState(): Promise<MediaStateReport> {
    const raw = await this.evaluateCollector<MediaStateRaw>(mediaStateCollectorScript()) ?? {
      url: this.cdp.url(),
      features: {},
      viewport: { width: 0, height: 0 },
      mediaQueries: []
    };
    return buildMediaStateReport(raw, this.id, Date.now());
  }

  /** Audit keyboard tab order vs. visual reading order. */
  async auditFocusOrder(): Promise<FocusOrderReport> {
    const raw = await this.evaluateCollector<RawFocusOrder>(focusableElementsScript())
      ?? { url: this.cdp.url(), elements: [] };
    return analyzeFocusOrder(raw, this.id, Date.now());
  }

  /** Detect horizontal overflow, container escapes, and clipped content at the current viewport. */
  async detectLayoutIssues(): Promise<LayoutIssuesReport> {
    const raw = await this.evaluateCollector<LayoutIssuesRaw>(layoutIssueDetectorScript()) ?? {
      url: this.cdp.url(),
      viewport: { width: 0, height: 0 },
      hasHorizontalOverflow: false,
      documentScrollWidth: 0,
      issues: []
    };
    return buildLayoutIssuesReport(raw, this.id, Date.now());
  }

  // ── Coverage / trace ──────────────────────────────────────────────────────

  /**
   * Measure unused CSS via CDP rule-usage tracking. Reloads the page (as the
   * DevTools Coverage panel does), guarded by a hard timeout.
   */
  async captureCssCoverage(): Promise<CssCoverageReport> {
    const cdp = this.cdp;

    // Capture stylesheet headers (id → sourceURL) emitted after CSS.enable.
    const headers = new Map<string, string>();
    const offHeaders = cdp.onEvent((method, params) => {
      const header = (params as { header?: { styleSheetId: string; sourceURL?: string } }).header;
      if (method === "CSS.styleSheetAdded" && header) {
        headers.set(header.styleSheetId, header.sourceURL ?? "");
      }
    });
    const load = waitForCdpEvent(cdp, "Page.loadEventFired");

    try {
      await cdp.send("DOM.enable").catch(() => {});
      await cdp.send("CSS.enable").catch(() => {});
      await cdp.send("Page.enable").catch(() => {});
      await cdp.send("CSS.startRuleUsageTracking");

      // Reload so rules used during initial render are counted; race against a
      // timeout so a stalled load never hangs the capture.
      await cdp.send("Page.reload", { ignoreCache: false }).catch(() => {});
      await Promise.race([load.fired, delay(RELOAD_TIMEOUT_MS)]);
      await delay(RELOAD_SETTLE_MS); // settle late-applied styles

      const stop = await cdp.send<{
        ruleUsage?: Array<{ styleSheetId: string; startOffset: number; endOffset: number; used: boolean }>;
      }>("CSS.stopRuleUsageTracking");
      const ruleUsage = stop.ruleUsage ?? [];

      const bySheet = new Map<string, RawRuleRange[]>();
      for (const r of ruleUsage) {
        const arr = bySheet.get(r.styleSheetId) ?? [];
        arr.push({ startOffset: r.startOffset, endOffset: r.endOffset, used: r.used });
        bySheet.set(r.styleSheetId, arr);
      }

      const stylesheets: RawStylesheetCoverage[] = [];
      for (const [styleSheetId, ranges] of bySheet) {
        let text = "";
        try {
          const t = await cdp.send<{ text?: string }>("CSS.getStyleSheetText", { styleSheetId });
          text = t.text ?? "";
        } catch { /* stylesheet may have been replaced by the reload */ }
        stylesheets.push({ styleSheetId, sourceURL: headers.get(styleSheetId) ?? "", text, ranges });
      }

      return buildCssCoverageReport({ url: cdp.url(), stylesheets }, this.id, Date.now());
    } finally {
      offHeaders();
      load.off();
      await cdp.send("CSS.disable").catch(() => {});
    }
  }

  /**
   * Measure dead JavaScript via CDP precise coverage. Reloads the page,
   * guarded by a hard timeout.
   */
  async captureJsCoverage(): Promise<JsCoverageReport> {
    const cdp = this.cdp;
    const load = waitForCdpEvent(cdp, "Page.loadEventFired");

    try {
      await cdp.send("Profiler.enable").catch(() => {});
      await cdp.send("Debugger.enable").catch(() => {});
      await cdp.send("Page.enable").catch(() => {});
      await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

      // Reload so code run during initial load is counted; race a timeout.
      await cdp.send("Page.reload", { ignoreCache: false }).catch(() => {});
      await Promise.race([load.fired, delay(RELOAD_TIMEOUT_MS)]);
      await delay(RELOAD_SETTLE_MS); // settle late-loaded scripts

      const cov = await cdp.send<{
        result?: Array<{
          scriptId: string;
          url: string;
          functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
        }>;
      }>("Profiler.takePreciseCoverage");
      const entries = cov.result ?? [];

      const scripts: RawScriptCoverage[] = [];
      for (const entry of entries) {
        const ranges = entry.functions.flatMap((f) => f.ranges);
        if (!ranges.length) continue;
        let length = 0;
        try {
          const src = await cdp.send<{ scriptSource?: string }>("Debugger.getScriptSource", { scriptId: entry.scriptId });
          length = src.scriptSource?.length ?? 0;
        } catch { /* source may be unavailable */ }
        if (!length) length = ranges.reduce((max, r) => Math.max(max, r.endOffset), 0);
        scripts.push({ scriptId: entry.scriptId, url: entry.url, length, ranges });
      }

      return buildJsCoverageReport({ url: cdp.url(), scripts }, this.id, Date.now());
    } finally {
      load.off();
      await cdp.send("Profiler.stopPreciseCoverage").catch(() => {});
      await cdp.send("Profiler.disable").catch(() => {});
    }
  }

  /**
   * Record a CDP performance trace for `durationMs` and summarise it into long
   * main-thread tasks + a per-category time breakdown.
   */
  async captureTrace(durationMs = 3000): Promise<TraceReport> {
    const cdp = this.cdp;
    const clamped = clampInt(durationMs, 200, 15000);

    const events: RawTraceEvent[] = [];
    const offData = cdp.onEvent((method, params) => {
      const value = (params as { value?: RawTraceEvent[] }).value;
      if (method === "Tracing.dataCollected" && value) {
        events.push(...value);
      }
    });
    const complete = waitForCdpEvent(cdp, "Tracing.tracingComplete");

    try {
      await cdp.send("Tracing.start", {
        transferMode: "ReportEvents",
        traceConfig: {
          includedCategories: [
            "toplevel",
            "devtools.timeline",
            "disabled-by-default-devtools.timeline",
            "blink.user_timing",
            "v8.execute"
          ]
        }
      });
      await delay(clamped);
      await cdp.send("Tracing.end").catch(() => {});
      // dataCollected events stream after end; wait for tracingComplete, bounded.
      await Promise.race([complete.fired, delay(TRACE_COMPLETE_TIMEOUT_MS)]);

      return buildTraceSummary(events, this.id, cdp.url(), clamped, Date.now());
    } finally {
      offData();
      complete.off();
    }
  }

  // ── Script evaluation and synthetic input ─────────────────────────────────

  /** Insert text into the focused element via CDP Input.insertText. */
  async insertText(text: string): Promise<void> {
    await this.cdp.send("Input.insertText", { text });
  }

  /** Dispatch a single key press (keyDown + keyUp) with an optional modifier bitmask. */
  async pressKey(opts: { key: string; code?: string; keyCode?: number; modifiers?: number; text?: string }): Promise<void> {
    const base = {
      key: opts.key,
      code: opts.code ?? opts.key,
      windowsVirtualKeyCode: opts.keyCode ?? 0,
      nativeVirtualKeyCode: opts.keyCode ?? 0,
      modifiers: opts.modifiers ?? 0,
      ...(opts.text ? { text: opts.text } : {})
    };
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Dispatch a real left mouse click at viewport CSS coordinates. */
  async clickAt(x: number, y: number): Promise<void> {
    const base = { x, y, button: "left" as const, clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  /** Evaluate a JavaScript expression in the page and return its (JSON-able) value. Awaits promises. */
  async evaluateExpression(expression: string): Promise<{ value: unknown }> {
    const result = await this.cdp.send<{
      result: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed");
    }
    return { value: result.result.value ?? null };
  }

  async setFileInputFiles(target: FileUploadTarget): Promise<{ ok: true }> {
    const { root } = await this.cdp.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 1 });
    const { nodeId } = await this.cdp.send<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: target.selector
    });

    if (!nodeId) {
      throw new Error(`No file input matched selector: ${target.selector}`);
    }

    const described = await this.cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId });
    await this.cdp.send("DOM.setFileInputFiles", {
      backendNodeId: described.node.backendNodeId,
      files: target.files
    });

    return { ok: true };
  }

  // ── Storage (delegates to storage-inspector.ts) ───────────────────────────

  async captureStorage(): Promise<StorageReport> {
    return storage.capture(this.cdp, this.id);
  }

  async getStorage(area: StorageArea, key?: string): Promise<StorageEntry[]> {
    return storage.read(this.cdp, area, key);
  }

  async setStorage(area: StorageArea, entries: Record<string, string>): Promise<void> {
    return storage.write(this.cdp, area, entries);
  }

  async clearStorage(area: StorageArea, keys?: string[]): Promise<void> {
    return storage.clear(this.cdp, area, keys);
  }

  async setCookie(cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void> {
    return storage.setCookie(this.cdp, cookie);
  }

  async deleteCookie(name: string, url?: string): Promise<void> {
    return storage.deleteCookie(this.cdp, name, url);
  }

  async clearCookies(url?: string): Promise<void> {
    return storage.clearCookies(this.cdp, url);
  }

  // ── Console / Network logs ────────────────────────────────────────────────

  getTabLogs(): TabLogSnapshot {
    const { state } = this;
    return {
      tabId: this.id,
      consoleLogs: [...state.consoleLogs],
      networkRequests: [...state.networkRequests.values()],
      webSocketFrames: [...state.webSocketFrames],
      eventSourceEvents: [...state.eventSourceEvents],
      jsErrors: [...state.jsErrors],
      capturedAt: Date.now()
    };
  }

  /** Export the tab's buffered network requests as a HAR 1.2 archive. */
  exportHar(): HarArchive {
    return buildHar(this.cdp.url(), [...this.state.networkRequests.values()]);
  }

  clearTabLogs(): void {
    clearLogBuffers(this.state);
  }

  listDownloads(): DownloadEntry[] {
    return [...this.state.downloads];
  }

  clearDownloads(): void {
    this.state.downloads = [];
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  startRecording(): RecordingSession {
    this.state.recording = { tabId: this.id, startedAt: Date.now(), commands: [] };
    return this.state.recording;
  }

  getRecording(): RecordingSession | null {
    return this.state.recording;
  }

  stopRecording(): RecordingStopResult {
    const recording = this.state.recording;
    if (!recording) {
      throw new Error(`No recording in progress for tab ${this.id}`);
    }
    this.state.recording = null;
    return {
      ...recording,
      script: renderRecordingScript(recording),
      exports: exportRecordingAll(recording)
    };
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  async setResourceBudget(budget: ResourceBudget): Promise<ResourceBudget> {
    this.state.resourceBudget = { ...budget };
    await applyResourceBudget(this.cdp, this.state.resourceBudget);
    return this.state.resourceBudget;
  }

  getResourceBudget(): ResourceBudget | null {
    return this.state.resourceBudget;
  }

  async clearResourceBudget(): Promise<void> {
    this.state.resourceBudget = null;
    await this.cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await this.cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    }).catch(() => {});
  }

  async setLocationOverride(location: LocationOverride): Promise<LocationOverride> {
    this.state.locationOverride = { ...location };
    await applyLocationOverride(this.cdp, this.state.locationOverride);
    return this.state.locationOverride;
  }

  getLocationOverride(): LocationOverride | null {
    return this.state.locationOverride;
  }

  async clearLocationOverride(): Promise<void> {
    this.state.locationOverride = null;
    await this.cdp.send("Emulation.clearGeolocationOverride").catch(() => {});
    await this.cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" }).catch(() => {});
  }

  async setMediaEmulation(emulation: MediaEmulation): Promise<MediaEmulation> {
    this.state.mediaEmulation = { ...emulation };
    await applyMediaEmulation(this.cdp, this.state.mediaEmulation);
    return this.state.mediaEmulation;
  }

  getMediaEmulation(): MediaEmulation | null {
    return this.state.mediaEmulation;
  }

  async clearMediaEmulation(): Promise<void> {
    this.state.mediaEmulation = null;
    await this.cdp.send("Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => {});
  }

  // ── Network mock / intercept ──────────────────────────────────────────────

  async enableNetworkMock(rules: NetworkInterceptRule[]): Promise<void> {
    // Reset Fetch domain if rules were already active.
    if (this.state.networkMockRules) {
      await this.cdp.send("Fetch.disable").catch(() => {});
    }

    this.state.networkMockRules = rules;

    await this.cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }]
    });
  }

  async disableNetworkMock(): Promise<void> {
    this.state.networkMockRules = null;
    await this.cdp.send("Fetch.disable").catch(() => {});
  }

  getNetworkMockRules(): NetworkInterceptRule[] | null {
    return this.state.networkMockRules;
  }

  // ── Resource budget gate ──────────────────────────────────────────────────

  /** A `blocked` result when the JS heap exceeds the budget, else null. */
  async checkResourceBudget(): Promise<BrowserCommandResult | null> {
    const budget = this.state.resourceBudget;
    if (!budget?.maxJsHeapMb) return null;
    const usedHeapMb = await this.getCurrentJsHeapMb();
    if (usedHeapMb === null || usedHeapMb <= budget.maxJsHeapMb) return null;
    return {
      status: "blocked",
      command: { type: "request_perception_refresh", tabId: this.id },
      reason: `Blocked by resource budget: JS heap ${usedHeapMb.toFixed(1)} MB exceeds ${budget.maxJsHeapMb} MB.`
    };
  }

  private async getCurrentJsHeapMb(): Promise<number | null> {
    const metrics = await this.cdp.send<{ metrics?: Array<{ name: string; value: number }> }>("Performance.getMetrics");
    const heap = metrics.metrics?.find((metric) => metric.name === "JSHeapUsedSize")?.value;
    return typeof heap === "number" ? heap / (1024 * 1024) : null;
  }
}
