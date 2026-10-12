import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, WebContentsView } from "electron";

import { normalizePerception } from "../../../../packages/perception/src/normalize.js";
import { AccountStore } from "./account-store.js";
import { installAntiDetection } from "./anti-detection.js";
import { isStealthEnabled } from "../../../../packages/devtools-core/src/core/runtime-config.js";
import { PerceptionBaselineStore, type PerceptionBaselineEntry } from "../../../../packages/devtools-core/src/core/stores/baseline-store.js";
import { buildHar } from "../../../../packages/devtools-core/src/core/reports/har.js";
import { buildDesignTokensReport, designTokenCollectorScript, type RawDesignTokens } from "../../../../packages/devtools-core/src/core/reports/design-tokens.js";
import { buildCssCoverageReport, type RawRuleRange, type RawStylesheetCoverage } from "../../../../packages/devtools-core/src/core/reports/css-coverage.js";
import { buildJsCoverageReport, type RawScriptCoverage } from "../../../../packages/devtools-core/src/core/reports/js-coverage.js";
import { buildTraceSummary, type RawTraceEvent } from "../../../../packages/devtools-core/src/core/reports/trace-summary.js";
import { detectFramework as classifyFramework, frameworkSignalsScript, type RawFrameworkSignals } from "../../../../packages/devtools-core/src/core/reports/framework-detect.js";
import { pickElement } from "./element-picker.js";
import { buildLayoutIssuesReport, layoutIssueDetectorScript, type LayoutIssuesRaw } from "../../../../packages/devtools-core/src/core/reports/layout-issues.js";
import { buildMediaStateReport, mediaStateCollectorScript, type MediaStateRaw } from "../../../../packages/devtools-core/src/core/reports/media-state.js";
import { exportRecordingAll, renderRecordingScript } from "../../../../packages/devtools-core/src/core/reports/recording-export.js";
import { buildHealthReport } from "../../../../packages/devtools-core/src/core/reports/health-report.js";
import { AssertionWatchStore } from "../../../../packages/devtools-core/src/core/stores/assertion-watch.js";
import { buildMutationReport, mutationTimelineScript, type RawMutationTimeline } from "../../../../packages/devtools-core/src/core/reports/mutation-timeline.js";
import { buildComponentSourceReport, componentSourceCollectorScript, type RawComponentSources } from "../../../../packages/devtools-core/src/core/reports/component-source.js";
import { VisualDiffStore } from "../../../../packages/devtools-core/src/core/stores/visual-diff-store.js";
import { correlateRegionsToElements, elementBoundsScript } from "../../../../packages/devtools-core/src/core/reports/element-bounds.js";
import { analyzeFocusOrder, focusableElementsScript, type RawFocusOrder } from "../../../../packages/devtools-core/src/core/reports/focus-order.js";
import * as storage from "../../../../packages/devtools-core/src/core/cdp/storage-inspector.js";
import { capturePerformance } from "../../../../packages/devtools-core/src/core/cdp/performance-probe.js";
import { captureThreeScene } from "../../../../packages/devtools-core/src/core/cdp/threejs-inspector.js";
import { inspectStyles, assertStyles } from "../../../../packages/devtools-core/src/core/cdp/style-inspector.js";
import { runA11yAudit } from "../../../../packages/devtools-core/src/core/cdp/a11y-audit.js";
import { runComponentTree } from "../../../../packages/devtools-core/src/core/cdp/component-tree.js";
import { handleCdpMessage } from "../../../../packages/devtools-core/src/core/cdp/cdp-events.js";
import { computePerceptionDiff } from "../../../../packages/devtools-core/src/core/perception/diff.js";
import { evaluateAssertionAgainstGraph } from "../../../../packages/devtools-core/src/core/perception/assertions.js";
import { applyMediaEmulation, applyResourceBudget, applyLocationOverride } from "../../../../packages/devtools-core/src/core/cdp/overrides.js";
import { clampInt } from "../../../../packages/devtools-core/src/core/util.js";
import { waitForPageSettled } from "../../../../packages/devtools-core/src/core/cdp/dom-actuator.js";
import { electronCdpTarget } from "./electron-cdp-target.js";
import { ApprovalPolicyStore } from "../../../../packages/devtools-core/src/core/stores/approval-policy-store.js";
import { ApprovalStore } from "../../../../packages/devtools-core/src/core/stores/approval-store.js";
import { HandoffStore } from "../../../../packages/devtools-core/src/core/stores/handoff-store.js";
import {
  type AccountInput,
  type AccountSummary,
  type AccountUpdate,
  type ApprovalDecision,
  type ApprovalPolicyKey,
  type ApprovalPolicyRecord,
  type AssertionResult,
  type BrowserCommandResult,
  type BrowserOutputCommand,
  type BrowserPerceptionPacket,
  type ConsoleLogEntry,
  type CookieEntry,
  type DownloadEntry,
  type ElementStyleAssertionReport,
  type ElementStyleInspectionReport,
  type DiffRegion,
  type EventSourceMessageEntry,
  type FileUploadTarget,
  type FixturePageName,
  type HumanHandoffRecord,
  type CdpTarget,
  type LocationOverride,
  type MediaEmulation,
  type NetworkInterceptRule,
  type NetworkRequestEntry,
  type PageGraph,
  type PageScreenshot,
  type ScreenshotOptions,
  type PageSnapshot,
  type PageObservation,
  type PerceptionDiff,
  type PerceptionSnapshotEntry,
  type PerformanceReport,
  type PerceptionResult,
  type RecordedCommand,
  type RecordingSession,
  type RecordingStopResult,
  type ResourceBudget,
  type ScreenshotDiff,
  type SiteCapabilityManifest,
  type StyleAssertion,
  type StorageArea,
  type StorageEntry,
  type StorageReport,
  type TabId,
  type TabLogSnapshot,
  type HarArchive,
  type CssCoverageReport,
  type JsCoverageReport,
  type TraceReport,
  type FrameworkReport,
  type ElementPickResult,
  type DesignTokensReport,
  type LayoutIssuesReport,
  type MediaStateReport,
  type HealthReport,
  type AssertionWatch,
  type AssertionTransition,
  type MutationTimelineReport,
  type ComponentSourceReport,
  type ChangedElement,
  type ElementBound,
  type FocusOrderReport,
  type TabSummary,
  type ThreeSceneReport,
  type TotpResult,
  type VaultSecretInput,
  type VaultSecretSummary,
  type VaultStatus,
  type ViewportPresetName,
  type ViewportSuiteReport,
  type ViewportRect,
  type WebSocketFrameEntry,
  VIEWPORT_PRESETS
} from "../../../../packages/shared/src/index.js";
import { SiteCapabilityRegistry } from "../../../../packages/devtools-core/src/core/commands/site-capability-registry.js";
import { createDesktopSecrets } from "./desktop-secrets.js";
import { SitePatternStore } from "../../../../packages/devtools-core/src/core/stores/site-pattern-store.js";
import { VaultStore } from "./vault-store.js";

type EmulatedViewport = { width: number; height: number; mobile: boolean };

export type TabRecord = {
  id: TabId;
  view: WebContentsView;
  parentTabId?: TabId;
  lastObservation: PageObservation | null;
  pendingUrl: string | null;
  summary: TabSummary;
  emulatedViewport?: EmulatedViewport;
  // CDP logging state (buffered per-tab, cleared on navigation)
  cdpLoggingEnabled: boolean;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: Map<string, NetworkRequestEntry>;
  webSocketUrls: Map<string, string>;
  webSocketFrames: WebSocketFrameEntry[];
  eventSourceEvents: EventSourceMessageEntry[];
  jsErrors: string[];
  downloads: DownloadEntry[];
  recording: RecordingSession | null;
  resourceBudget: ResourceBudget | null;
  locationOverride: LocationOverride | null;
  mediaEmulation: MediaEmulation | null;
  // Network mock intercept rules (null = disabled)
  networkMockRules: NetworkInterceptRule[] | null;
};

type TabsChangedListener = (tabs: TabSummary[]) => void;
type PageObservedListener = (observation: PageObservation) => void;
type ApprovalQueuedListener = (approval: import("../../../../packages/shared/src/index.js").PendingApproval) => void;

const DEFAULT_VIEWPORT: ViewportRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0
};

export class TabManager {
  private readonly window: BrowserWindow;
  private readonly pagePreloadPath: string;
  private readonly appDir: string;
  private readonly vault: VaultStore;
  private readonly accounts: AccountStore;
  private readonly approvals = new ApprovalStore();
  private readonly handoffs = new HandoffStore();
  private readonly policies: ApprovalPolicyStore;
  private readonly sitePatterns: SitePatternStore;
  private readonly capabilityRegistry: SiteCapabilityRegistry;
  private readonly tabs = new Map<TabId, TabRecord>();
  private readonly listeners = new Set<TabsChangedListener>();
  private readonly observationListeners = new Set<PageObservedListener>();
  private readonly approvalQueuedListeners = new Set<ApprovalQueuedListener>();
  private activeTabId: TabId | null = null;
  private attachedTabId: TabId | null = null;
  private viewport: ViewportRect = DEFAULT_VIEWPORT;
  private readonly visualDiff: VisualDiffStore;
  private readonly perceptionCache = new Map<string, PerceptionBaselineEntry>();
  private readonly perceptionStore: PerceptionBaselineStore;
  private readonly assertionWatches = new AssertionWatchStore();
  private readonly assertionTransitionListeners = new Set<(transition: AssertionTransition) => void>();
  private readonly downloadTrackingSessions = new WeakSet<Electron.Session>();

  constructor(window: BrowserWindow, appDir: string, userDataPath: string, pagePreloadPath: string) {
    this.window = window;
    this.appDir = appDir;
    this.pagePreloadPath = pagePreloadPath;
    this.vault = new VaultStore(userDataPath);
    this.accounts = new AccountStore(userDataPath);
    this.policies = new ApprovalPolicyStore(userDataPath);
    this.sitePatterns = new SitePatternStore(userDataPath);

    // Disk-backed baselines: rehydrate so visual/perception regression
    // references survive an app restart.
    this.visualDiff = new VisualDiffStore(userDataPath);
    this.perceptionStore = new PerceptionBaselineStore(userDataPath);
    for (const { id, entry } of this.perceptionStore.all()) {
      this.perceptionCache.set(id, entry);
    }
    this.capabilityRegistry = new SiteCapabilityRegistry(
      createDesktopSecrets(this.vault, this.accounts),
      this.approvals,
      this.handoffs,
      this.policies,
      (tabId) => this.getHandoffContext(tabId)
    );
    this.window.on("resize", () => this.layoutActiveTab());

    // Forward approval-queued events to any agent-server subscriber
    this.approvals.onCreated((approval) => {
      for (const listener of this.approvalQueuedListeners) {
        listener(approval);
      }
    });
  }

  async createTab(url = "https://example.com", parentTabId?: TabId): Promise<TabSummary[]> {
    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        partition: "persist:default",
        preload: this.pagePreloadPath,
        additionalArguments: [`--ov-tab-id=${id}`]
      }
    });

    const summary: TabSummary = {
      id,
      title: "New Tab",
      url,
      isActive: false,
      status: "loading",
      statusMessage: `Loading ${url}`
    };

    const record: TabRecord = {
      id, view, parentTabId, summary, lastObservation: null, pendingUrl: url,
      cdpLoggingEnabled: false,
      consoleLogs: [],
      networkRequests: new Map(),
      webSocketUrls: new Map(),
      webSocketFrames: [],
      eventSourceEvents: [],
      jsErrors: [],
      downloads: [],
      recording: null,
      resourceBudget: null,
      locationOverride: null,
      mediaEmulation: null,
      networkMockRules: null
    };

    this.tabs.set(id, record);
    this.bindLifecycle(record);
    this.ensureDownloadTracking(record);

    // Install anti-detection after the first document loads so the WebContents
    // target is fully initialised and the CDP debugger can attach cleanly.
    // Stealth is opt-in (HELMSTACK_STEALTH=1); the default is a clean,
    // unhardened browser suited to front-end development and CI.
    if (isStealthEnabled()) {
      view.webContents.once("did-finish-load", () => {
        installAntiDetection(view.webContents).catch((err: unknown) => {
          console.warn("[AntiDetection] Failed to install on tab:", err);
        });
      });
    }

    try {
      await this.focusTab(id);
    } catch (err) {
      console.warn("[TabManager] focusTab failed during createTab:", err);
    }

    void view.webContents.loadURL(url).catch(() => {
      record.pendingUrl = null;
      record.summary = {
        ...record.summary,
        status: "error",
        statusMessage: `Failed to load ${url}`
      };
      this.emitTabsChanged();
    });

    return this.listTabs();
  }

  async navigate(tabId: TabId, url: string): Promise<TabSummary[]> {
    const tab = this.requireTab(tabId);
    tab.pendingUrl = url;
    tab.summary = { ...tab.summary, url, status: "loading", statusMessage: `Loading ${url}` };
    this.recordCommand(tab, "navigate", { type: "navigate", url }, "completed");
    this.emitTabsChanged();
    void tab.view.webContents.loadURL(url).catch(() => {
      tab.pendingUrl = null;
      tab.summary = {
        ...tab.summary,
        status: "error",
        statusMessage: `Failed to load ${url}`
      };
      this.emitTabsChanged();
    });
    return this.listTabs();
  }

  async focusTab(tabId: TabId): Promise<TabSummary[]> {
    const tab = this.requireTab(tabId);

    if (this.attachedTabId && this.attachedTabId !== tabId) {
      const attached = this.tabs.get(this.attachedTabId);
      if (attached) {
        this.window.contentView.removeChildView(attached.view);
      }
    }

    for (const entry of this.tabs.values()) {
      entry.summary = { ...entry.summary, isActive: entry.id === tabId };
      entry.view.setVisible(entry.id === tabId);
    }

    this.activeTabId = tabId;
    if (this.attachedTabId !== tabId) {
      this.window.contentView.addChildView(tab.view);
      this.attachedTabId = tabId;
    }
    this.layoutActiveTab();
    this.emitTabsChanged();

    return this.listTabs();
  }

  async closeTab(tabId: TabId): Promise<TabSummary[]> {
    const tab = this.requireTab(tabId);

    if (this.attachedTabId === tabId) {
      this.window.contentView.removeChildView(tab.view);
      this.attachedTabId = null;
    }
    tab.view.webContents.close();
    this.tabs.delete(tabId);
    this.assertionWatches.clearTab(tabId);

    if (this.activeTabId === tabId) {
      const next = this.tabs.values().next().value as TabRecord | undefined;
      this.activeTabId = next?.id ?? null;
      if (next) {
        await this.focusTab(next.id);
      }
    }

    this.emitTabsChanged();
    return this.listTabs();
  }

  async setViewport(rect: ViewportRect): Promise<void> {
    this.viewport = rect;
    this.layoutActiveTab();
  }

  async captureSnapshot(tabId: TabId): Promise<PageSnapshot> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    // Enable log/network CDP domains once per tab lifetime (idempotent after first call).
    await this.enableCdpLogging(tab);

    await webContents.debugger.sendCommand("Accessibility.enable");

    const [dom, ax] = await Promise.all([
      webContents.debugger.sendCommand("DOMSnapshot.captureSnapshot", {
        computedStyles: ["display", "visibility", "pointer-events"],
        includeDOMRects: true,
        includePaintOrder: true
      }),
      webContents.debugger.sendCommand("Accessibility.getFullAXTree", {})
    ]);

    return {
      tabId,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      capturedAt: Date.now(),
      dom,
      accessibilityTree: ax
    };
  }

  async captureScreenshot(tabId: TabId, options: ScreenshotOptions = {}): Promise<PageScreenshot> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    const emu = tab.emulatedViewport;
    const w = (emu?.width  ?? this.viewport.width)  || 1280;
    const h = (emu?.height ?? this.viewport.height) || 800;
    const mobile = emu?.mobile ?? false;

    // Ensure a rendering viewport exists even if the tab is not currently visible.
    // Without this, inactive tabs have 0×0 bounds and the capture fails.
    await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile
    });

    // Resolve an optional capture region: a selector's bounding box, or the
    // full scrollable content. Both need captureBeyondViewport so content
    // below the fold renders.
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let captureBeyondViewport = false;

    try {
      if (options.selector) {
        const bounds = await this.resolveElementBounds(webContents, options.selector);
        if (!bounds) {
          throw new Error(`No visible element matches selector: ${options.selector}`);
        }
        clip = { ...bounds, scale: 1 };
        captureBeyondViewport = true;
      } else if (options.fullPage) {
        const layout = await webContents.debugger.sendCommand("Page.getLayoutMetrics") as {
          cssContentSize?: { width: number; height: number };
          contentSize?: { width: number; height: number };
        };
        const content = layout.cssContentSize ?? layout.contentSize;
        if (content && content.width > 0 && content.height > 0) {
          clip = { x: 0, y: 0, width: content.width, height: content.height, scale: 1 };
          captureBeyondViewport = true;
        }
      }

      const result = await webContents.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport,
        ...(clip ? { clip } : {})
      }) as { data: string };

      const metrics = await webContents.debugger.sendCommand("Page.getLayoutMetrics") as {
        cssLayoutViewport: { clientWidth: number; clientHeight: number };
      };

      return {
        tabId,
        capturedAt: Date.now(),
        data: result.data,
        mimeType: "image/png",
        width: clip ? Math.round(clip.width) : metrics.cssLayoutViewport.clientWidth,
        height: clip ? Math.round(clip.height) : metrics.cssLayoutViewport.clientHeight
      };
    } finally {
      await webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }

  /** Resolve a selector's page-coordinate bounding box, or null if not found/visible. */
  private async resolveElementBounds(
    webContents: Electron.WebContents,
    selector: string
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    })()`;
    const res = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true
    }) as { result: { value: { x: number; y: number; width: number; height: number } | null } };
    return res.result?.value ?? null;
  }

  /**
   * Capture a screenshot and store it under `snapshotId`. Persisted to disk by
   * default so it survives a restart; pass `persist: false` for transient
   * captures (e.g. viewport-suite frames) that should stay in memory only.
   */
  async captureNamedScreenshot(
    tabId: TabId,
    snapshotId: string,
    options: ScreenshotOptions = {},
    persist = true
  ): Promise<PageScreenshot> {
    const shot = await this.captureScreenshot(tabId, options);
    this.visualDiff.put(snapshotId, shot, persist);
    return shot;
  }

  /** Compare two previously captured named screenshots pixel-by-pixel. */
  diffScreenshots(
    beforeId: string,
    afterId: string,
    options: { ignoreRegions?: DiffRegion[]; perceptual?: boolean; threshold?: number } = {}
  ): ScreenshotDiff {
    return this.visualDiff.diff(beforeId, afterId, options);
  }

  /**
   * Map changed pixel regions (e.g. from `diffScreenshots`) to the DOM elements
   * that occupy them — turns a pixel diff into "which elements changed". Captures
   * live element bounds, so call it while the page is in the after-state.
   */
  async mapRegionsToElements(tabId: TabId, regions: DiffRegion[]): Promise<ChangedElement[]> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: elementBoundsScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: { elements: ElementBound[] } } };

    return correlateRegionsToElements(regions, result.result.value?.elements ?? []);
  }

  /** List all named screenshots currently held in the server-side cache. */
  listScreenshots(): Array<{ id: string; tabId: string; url: string; width: number; height: number; capturedAt: number }> {
    const out: Array<{ id: string; tabId: string; url: string; width: number; height: number; capturedAt: number }> = [];
    for (const [id, shot] of this.visualDiff.entries()) {
      const tab = this.tabs.get(shot.tabId);
      const url = tab ? tab.view.webContents.getURL() : "";
      out.push({ id, tabId: shot.tabId, url, width: shot.width, height: shot.height, capturedAt: shot.capturedAt });
    }
    return out;
  }

  /** Remove a named screenshot from the cache and disk. Returns false if it didn't exist. */
  deleteScreenshot(id: string): boolean {
    return this.visualDiff.remove(id);
  }

  /**
   * Capture screenshots at multiple viewport breakpoints in a single call.
   * Saves the original emulated viewport and restores it afterwards.
   *
   * @param presets  Named presets to capture (defaults to ["mobile","tablet","laptop","desktop"]).
   * @param includeDiffs  When true, also diffs each consecutive pair of breakpoints.
   * @param includeLayoutIssues  When true, also runs layout-overflow detection at each breakpoint.
   */
  async captureViewportSuite(
    tabId: TabId,
    presets: ViewportPresetName[] = ["mobile", "tablet", "laptop", "desktop"],
    includeDiffs = false,
    includeLayoutIssues = false
  ): Promise<ViewportSuiteReport> {
    const tab = this.requireTab(tabId);
    const runId = Date.now().toString(36);
    const savedViewport = tab.emulatedViewport ?? null;

    const captures: ViewportSuiteReport["captures"] = [];

    for (const presetName of presets) {
      const def = VIEWPORT_PRESETS[presetName];
      const preset = { name: presetName, ...def };

      await this.setEmulatedViewport(tabId, def.width, def.height, def.mobile);

      // Allow the page a short reflow settle before capturing.
      await new Promise<void>((r) => setTimeout(r, 200));

      const snapshotId = `${tabId}__${presetName}__${runId}`;
      const screenshot = await this.captureNamedScreenshot(tabId, snapshotId, {}, false);
      const layoutIssues = includeLayoutIssues ? await this.detectLayoutIssues(tabId) : undefined;

      captures.push({ preset, snapshotId, screenshot, ...(layoutIssues ? { layoutIssues } : {}) });
    }

    // Restore original emulated viewport (or clear it if none was set).
    if (savedViewport) {
      await this.setEmulatedViewport(tabId, savedViewport.width, savedViewport.height, savedViewport.mobile);
    } else if (tab.view.webContents.debugger.isAttached()) {
      await tab.view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
      tab.emulatedViewport = undefined;
    }

    const diffs: ViewportSuiteReport["diffs"] = [];
    if (includeDiffs && captures.length >= 2) {
      for (let i = 0; i < captures.length - 1; i++) {
        const from = captures[i];
        const to   = captures[i + 1];
        const diff = this.diffScreenshots(from.snapshotId, to.snapshotId);
        diffs.push({ from: from.preset.name, to: to.preset.name, diff });
      }
    }

    return { tabId, runId, captures, diffs, capturedAt: Date.now() };
  }

  // ── "What Broke?" Perception Snapshot + Diff ─────────────────────────────

  /**
   * Capture the current PageGraph for the tab and store it under `snapshotId`.
   * Call this before a deploy (or any change) to create a baseline.
   */
  async saveNamedPerception(tabId: TabId, snapshotId: string): Promise<PerceptionSnapshotEntry> {
    const result = await this.capturePerception(tabId);
    const { webContents } = this.requireTab(tabId).view;
    const entry = {
      graph: result.graph,
      tabId,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      capturedAt: Date.now()
    };
    this.perceptionCache.set(snapshotId, entry);
    this.perceptionStore.put(snapshotId, entry);
    return { id: snapshotId, tabId, url: entry.url, title: entry.title, capturedAt: entry.capturedAt };
  }

  /** List all named perception snapshots in the cache (metadata only). */
  listPerceptionSnapshots(): PerceptionSnapshotEntry[] {
    return [...this.perceptionCache.entries()].map(([id, e]) => ({
      id, tabId: e.tabId, url: e.url, title: e.title, capturedAt: e.capturedAt
    }));
  }

  /** Remove a named perception snapshot from the cache and disk. Returns false if not found. */
  deletePerceptionSnapshot(id: string): boolean {
    const existed = this.perceptionCache.delete(id);
    this.perceptionStore.remove(id);
    return existed;
  }

  /**
   * Compare two previously saved perception snapshots and return a structured
   * diff of all structural changes — headings, forms, actions, alerts, title, etc.
   */
  diffPerception(beforeId: string, afterId: string): PerceptionDiff {
    const before = this.perceptionCache.get(beforeId);
    const after  = this.perceptionCache.get(afterId);
    if (!before) throw new Error(`Perception snapshot "${beforeId}" not found`);
    if (!after)  throw new Error(`Perception snapshot "${afterId}" not found`);

    return computePerceptionDiff(beforeId, afterId, before, after);
  }

  // ── Performance metrics ───────────────────────────────────────────────────

  /**
   * Capture an aggregated page-health scorecard: Core Web Vitals + WCAG audit +
   * console errors + failed network requests + layout overflow, fused into one
   * report with a pass/fail gate. Gathers each signal then scores in-process.
   */
  async captureHealthReport(tabId: TabId): Promise<HealthReport> {
    const [performance, accessibility, layout] = await Promise.all([
      this.capturePerformanceMetrics(tabId),
      this.auditAccessibility(tabId),
      this.detectLayoutIssues(tabId)
    ]);
    const logs = this.getTabLogs(tabId);
    const url = this.requireTab(tabId).view.webContents.getURL();
    return buildHealthReport({ performance, accessibility, logs, layout }, tabId, url, Date.now());
  }

  /**
   * Capture performance metrics for the tab from three sources:
   *  1. CDP `Performance.getMetrics` — V8/Blink internal counters
   *  2. `window.performance.timing` — classic Navigation Timing (level 1)
   *  3. `PerformanceObserver` entries already buffered in the timeline — CWV
   */
  async capturePerformanceMetrics(tabId: TabId): Promise<PerformanceReport> {
    return capturePerformance(this.debuggerFor(tabId), tabId);
  }

  // ── Accessibility Audit ───────────────────────────────────────────────────

  /**
   * Run a comprehensive WCAG 2.2-aligned accessibility audit against the live
   * AX tree plus select DOM checks. Covers 12 rules across all four WCAG
   * principles, returns per-violation remediation guidance, a 0–100 score,
   * principle breakdown, deduplicated rule summaries, and top recommendations.
   */
  async auditAccessibility(tabId: TabId, selector?: string): Promise<import("../../../../packages/shared/src/index.js").A11yAuditReport> {
    return runA11yAudit(this.debuggerFor(tabId), tabId, selector);
  }

  // ── Element Style Inspector ───────────────────────────────────────────────

  /**
   * Inspect computed styles, layout box, contrast, and common style issues for
   * elements matching a selector. Traverses same-origin iframes and open shadow
   * roots in the page context.
   */
  async inspectElementStyles(tabId: TabId, selector: string, options: { limit?: number } = {}): Promise<ElementStyleInspectionReport> {
    return inspectStyles(this.debuggerFor(tabId), tabId, selector, options);
  }

  /**
   * Assert computed style expectations for all elements matching a selector.
   * Supports exact/contains/regex checks plus numeric min/max thresholds.
   */
  async assertElementStyles(
    tabId: TabId,
    selector: string,
    assertions: StyleAssertion[],
    options: { limit?: number } = {}
  ): Promise<ElementStyleAssertionReport> {
    return assertStyles(this.debuggerFor(tabId), tabId, selector, assertions, options);
  }

  // ── Component Tree ────────────────────────────────────────────────────────

  /**
   * Probe the page for React, Vue 3, Vue 2, or Svelte devtools hooks and
   * return a lightweight component tree. Returns `tree: null` when no hook
   * is found (e.g. production build without devtools enabled).
   */
  /** Map rendered DOM nodes back to their authoring component + source file:line (click-to-component). */
  async captureComponentSources(tabId: TabId): Promise<ComponentSourceReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: componentSourceCollectorScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: RawComponentSources } };

    const raw = result.result.value ?? { url: webContents.getURL(), sampledElements: 0, elements: [] };
    return buildComponentSourceReport(raw, tabId, Date.now());
  }

  /** Harvest the de-facto design tokens (colors, type scale, spacing, etc.) in use on the page. */
  async extractDesignTokens(tabId: TabId): Promise<DesignTokensReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: designTokenCollectorScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: RawDesignTokens } };

    const raw = result.result.value ?? {
      url: webContents.getURL(),
      cssVariables: {},
      counts: { colors: {}, fontFamilies: {}, fontSizes: {}, fontWeights: {}, spacing: {}, radii: {}, shadows: {}, zIndices: {} },
      sampledElements: 0
    };
    return buildDesignTokensReport(raw, tabId, Date.now());
  }

  /**
   * Measure unused CSS via CDP rule-usage tracking. Reloads the page (as the
   * DevTools Coverage panel does) so usage is measured from the initial render,
   * guarded by a hard timeout so it can never hang. Returns per-stylesheet
   * used/unused byte tallies and an aggregate summary.
   */
  async captureCssCoverage(tabId: TabId): Promise<CssCoverageReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);
    const dbg = webContents.debugger;

    // Capture stylesheet headers (id → sourceURL) emitted after CSS.enable.
    const headers = new Map<string, string>();
    const onMessage = (_event: unknown, cdpMethod: string, params: { header?: { styleSheetId: string; sourceURL?: string } }) => {
      if (cdpMethod === "CSS.styleSheetAdded" && params.header) {
        headers.set(params.header.styleSheetId, params.header.sourceURL ?? "");
      }
    };
    dbg.on("message", onMessage);

    try {
      await dbg.sendCommand("DOM.enable").catch(() => {});
      await dbg.sendCommand("CSS.enable").catch(() => {});
      await dbg.sendCommand("Page.enable").catch(() => {});
      await dbg.sendCommand("CSS.startRuleUsageTracking");

      // Reload so rules used during initial render are counted; race against a
      // timeout so a stalled load never hangs the capture.
      const loaded = new Promise<void>((resolve) => {
        const onLoad = (_e: unknown, m: string) => {
          if (m === "Page.loadEventFired") { dbg.removeListener("message", onLoad); resolve(); }
        };
        dbg.on("message", onLoad);
      });
      await dbg.sendCommand("Page.reload", { ignoreCache: false }).catch(() => {});
      await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 4000))]);
      await new Promise<void>((r) => setTimeout(r, 250)); // settle late-applied styles

      const stop = await dbg.sendCommand("CSS.stopRuleUsageTracking") as {
        ruleUsage?: Array<{ styleSheetId: string; startOffset: number; endOffset: number; used: boolean }>;
      };
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
          const t = await dbg.sendCommand("CSS.getStyleSheetText", { styleSheetId }) as { text?: string };
          text = t.text ?? "";
        } catch { /* stylesheet may have been replaced by the reload */ }
        stylesheets.push({ styleSheetId, sourceURL: headers.get(styleSheetId) ?? "", text, ranges });
      }

      return buildCssCoverageReport({ url: webContents.getURL(), stylesheets }, tabId, Date.now());
    } finally {
      dbg.removeListener("message", onMessage);
      await dbg.sendCommand("CSS.disable").catch(() => {});
    }
  }

  /**
   * Measure dead JavaScript via CDP precise coverage. Reloads the page (as the
   * DevTools Coverage panel does) so usage is measured from initial load,
   * guarded by a hard timeout so it can never hang. Returns per-script
   * used/unused byte tallies and an aggregate summary.
   */
  async captureJsCoverage(tabId: TabId): Promise<JsCoverageReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);
    const dbg = webContents.debugger;

    try {
      await dbg.sendCommand("Profiler.enable").catch(() => {});
      await dbg.sendCommand("Debugger.enable").catch(() => {});
      await dbg.sendCommand("Page.enable").catch(() => {});
      await dbg.sendCommand("Profiler.startPreciseCoverage", { callCount: true, detailed: true });

      // Reload so code run during initial load is counted; race a timeout.
      const loaded = new Promise<void>((resolve) => {
        const onLoad = (_e: unknown, m: string) => {
          if (m === "Page.loadEventFired") { dbg.removeListener("message", onLoad); resolve(); }
        };
        dbg.on("message", onLoad);
      });
      await dbg.sendCommand("Page.reload", { ignoreCache: false }).catch(() => {});
      await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 4000))]);
      await new Promise<void>((r) => setTimeout(r, 250)); // settle late-loaded scripts

      const cov = await dbg.sendCommand("Profiler.takePreciseCoverage") as {
        result?: Array<{
          scriptId: string;
          url: string;
          functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
        }>;
      };
      const entries = cov.result ?? [];

      const scripts: RawScriptCoverage[] = [];
      for (const entry of entries) {
        const ranges = entry.functions.flatMap((f) => f.ranges);
        if (!ranges.length) continue;
        let length = 0;
        try {
          const src = await dbg.sendCommand("Debugger.getScriptSource", { scriptId: entry.scriptId }) as { scriptSource?: string };
          length = src.scriptSource?.length ?? 0;
        } catch { /* source may be unavailable */ }
        if (!length) length = ranges.reduce((max, r) => Math.max(max, r.endOffset), 0);
        scripts.push({ scriptId: entry.scriptId, url: entry.url, length, ranges });
      }

      return buildJsCoverageReport({ url: webContents.getURL(), scripts }, tabId, Date.now());
    } finally {
      await dbg.sendCommand("Profiler.stopPreciseCoverage").catch(() => {});
      await dbg.sendCommand("Profiler.disable").catch(() => {});
    }
  }

  /**
   * Record a CDP performance trace for `durationMs` and summarise it into long
   * main-thread tasks + a per-category time breakdown (a digest of the raw
   * multi-megabyte trace stream an agent can reason about for jank).
   */
  async captureTrace(tabId: TabId, durationMs = 3000): Promise<TraceReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);
    const dbg = webContents.debugger;
    const clamped = clampInt(durationMs, 200, 15000);

    const events: RawTraceEvent[] = [];
    const onMessage = (_e: unknown, cdpMethod: string, params: { value?: RawTraceEvent[] }) => {
      if (cdpMethod === "Tracing.dataCollected" && params.value) {
        events.push(...params.value);
      }
    };
    dbg.on("message", onMessage);

    try {
      const complete = new Promise<void>((resolve) => {
        const onComplete = (_e: unknown, m: string) => {
          if (m === "Tracing.tracingComplete") { dbg.removeListener("message", onComplete); resolve(); }
        };
        dbg.on("message", onComplete);
      });

      await dbg.sendCommand("Tracing.start", {
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
      await new Promise<void>((r) => setTimeout(r, clamped));
      await dbg.sendCommand("Tracing.end").catch(() => {});
      // dataCollected events stream after end; wait for tracingComplete, bounded.
      await Promise.race([complete, new Promise<void>((r) => setTimeout(r, 5000))]);

      return buildTraceSummary(events, tabId, webContents.getURL(), clamped, Date.now());
    } finally {
      dbg.removeListener("message", onMessage);
    }
  }

  /**
   * Fingerprint the page's framework + dev server (Vite/webpack/Turbopack) and
   * whether it's a dev build with HMR — lets an agent give framework-specific
   * guidance and treat HMR reloads differently from full navigations.
   */
  async detectFramework(tabId: TabId): Promise<FrameworkReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: frameworkSignalsScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: RawFrameworkSignals } };

    const raw = result.result.value ?? {
      url: webContents.getURL(), globals: [], scriptSrcs: [], astroIslands: 0, generator: null
    };
    return classifyFramework(raw, tabId, Date.now());
  }

  /**
   * Insert text into the currently focused element via CDP Input.insertText.
   * Fires browser-level input events, so framework-controlled editors (React
   * contenteditables, Draft.js/Lexical composers) update their internal state —
   * unlike DOM-level value assignment or execCommand, which newer Chromium
   * versions no longer route through the framework event path. The caller is
   * responsible for focusing the target element first (e.g. via evaluate).
   */
  async insertText(tabId: TabId, text: string): Promise<void> {
    const { webContents } = this.requireTab(tabId).view;
    this.ensureDebugger(webContents);
    await webContents.debugger.sendCommand("Input.insertText", { text });
  }

  /**
   * Dispatch a single key press (keyDown + keyUp) to the focused element via CDP
   * Input.dispatchKeyEvent. Supports modifier chords (bitmask: Alt=1, Ctrl=2,
   * Meta=4, Shift=8) so callers can send e.g. Meta+Enter to submit a composer
   * whose submit button lives in a cross-origin frame the DOM can't reach.
   */
  async pressKey(
    tabId: TabId,
    opts: { key: string; code?: string; keyCode?: number; modifiers?: number; text?: string }
  ): Promise<void> {
    const { webContents } = this.requireTab(tabId).view;
    this.ensureDebugger(webContents);
    const base = {
      key: opts.key,
      code: opts.code ?? opts.key,
      windowsVirtualKeyCode: opts.keyCode ?? 0,
      nativeVirtualKeyCode: opts.keyCode ?? 0,
      modifiers: opts.modifiers ?? 0,
      ...(opts.text ? { text: opts.text } : {})
    };
    await webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /**
   * Dispatch a real left mouse click at viewport CSS coordinates via CDP
   * Input.dispatchMouseEvent. Browser-level, so it reaches targets in
   * cross-origin iframes the DOM can't touch (e.g. an anti-automation-isolated
   * post composer's submit button).
   */
  async clickAt(tabId: TabId, x: number, y: number): Promise<void> {
    const { webContents } = this.requireTab(tabId).view;
    this.ensureDebugger(webContents);
    const base = { x, y, button: "left" as const, clickCount: 1 };
    await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
    await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  /**
   * Evaluate a JavaScript expression in the page and return its (JSON-able)
   * value. A raw execution primitive for agents that need to drive widgets the
   * structured DOM tools can't (e.g. a CodeMirror/Monaco instance). Awaits
   * promises. Carries the full power of the page context — same trust boundary
   * as the rest of the authenticated agent API.
   */
  async evaluateExpression(tabId: TabId, expression: string): Promise<{ value: unknown }> {
    const { webContents } = this.requireTab(tabId).view;
    this.ensureDebugger(webContents);
    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }) as { result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed");
    }
    return { value: result.result.value ?? null };
  }

  /**
   * Activate the devtools-style inspect overlay in the page and resolve when the
   * human clicks an element (or cancels with Escape), handing the selector +
   * identity back so an agent can act on it. Long-lived — resolves on the human
   * interaction.
   */
  async pickElement(tabId: TabId): Promise<ElementPickResult> {
    const tab = this.requireTab(tabId);
    return pickElement(tab.view.webContents, tabId);
  }

  /** Sample DOM mutations for `durationMs` and rank the busiest subtrees (re-render/thrash detector). */
  async captureMutationTimeline(tabId: TabId, durationMs = 1000): Promise<MutationTimelineReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const clamped = clampInt(durationMs, 100, 10000);
    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: mutationTimelineScript(clamped),
      returnByValue: true,
      awaitPromise: true
    }) as { result: { value?: RawMutationTimeline } };

    const raw = result.result.value ?? {
      url: webContents.getURL(),
      durationMs: clamped,
      byKind: { childList: 0, attributes: 0, characterData: 0 },
      addedNodes: 0,
      removedNodes: 0,
      targets: {}
    };
    return buildMutationReport(raw, tabId, Date.now());
  }

  /** Read the page's current responsive state: resolved media features + matching @media queries. */
  async getMediaState(tabId: TabId): Promise<MediaStateReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: mediaStateCollectorScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: MediaStateRaw } };

    const raw = result.result.value ?? {
      url: webContents.getURL(),
      features: {},
      viewport: { width: 0, height: 0 },
      mediaQueries: []
    };
    return buildMediaStateReport(raw, tabId, Date.now());
  }

  /** Audit keyboard tab order vs. visual reading order (positive tabindex + focus jumps). */
  async auditFocusOrder(tabId: TabId): Promise<FocusOrderReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: focusableElementsScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: RawFocusOrder } };

    const raw = result.result.value ?? { url: webContents.getURL(), elements: [] };
    return analyzeFocusOrder(raw, tabId, Date.now());
  }

  /** Detect horizontal overflow, container escapes, and clipped content at the current viewport. */
  async detectLayoutIssues(tabId: TabId): Promise<LayoutIssuesReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: layoutIssueDetectorScript(),
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value?: LayoutIssuesRaw } };

    const raw = result.result.value ?? {
      url: webContents.getURL(),
      viewport: { width: 0, height: 0 },
      hasHorizontalOverflow: false,
      documentScrollWidth: 0,
      issues: []
    };
    return buildLayoutIssuesReport(raw, tabId, Date.now());
  }

  async captureComponentTree(tabId: TabId): Promise<import("../../../../packages/shared/src/index.js").ComponentTreeReport> {
    return runComponentTree(this.debuggerFor(tabId), tabId);
  }

  // ── Three.js Scene Inspector ──────────────────────────────────────────────

  /**
   * Probe the page for a Three.js renderer and scene, extract the full scene
   * graph (depth-limited to 8 levels), renderer stats, FPS estimate, and a
   * summary suitable for AI code feedback.
   *
   * Detection strategy: checks window.__threeRenderer__, window.__three,
   * window.renderer, and searches the global scope for THREE.WebGLRenderer
   * instances attached to any canvas element.
   */
  async captureThreeJsScene(tabId: TabId): Promise<ThreeSceneReport> {
    return captureThreeScene(this.debuggerFor(tabId), tabId);
  }

  // ── Natural Language Assertions ───────────────────────────────────────────

  /**
   * Evaluate a natural-language assertion against the current state of the
   * page by capturing a fresh perception snapshot and running a heuristic
   * pattern matcher over the `PageGraph`.
   *
   * Covers:
   *  - Exact / fuzzy text matching against title, headings, action labels,
   *    alert text, form field names
   *  - Quantitative checks  ("3 items", "at least 2 buttons", "no errors")
   *  - Presence / absence of elements by role or label
   *  - Disabled-state assertions ("the submit button is disabled")
   *
   * Returns an `AssertionResult` with a `pass` flag, `confidence` level,
   * plain-English `explanation`, and a compact `evidence` bundle that can
   * be forwarded to an LLM when `confidence` is "low".
   */
  async evaluateAssertion(tabId: TabId, assertion: string): Promise<AssertionResult> {
    const result = await this.capturePerception(tabId);
    return evaluateAssertionAgainstGraph(tabId, assertion, result.graph);
  }

  // ── Storage Inspector ─────────────────────────────────────────────────────

  /**
   * Capture a full storage snapshot: localStorage, sessionStorage, cookies,
   * and all IndexedDB databases for the tab's current origin.
   */
  // ── Storage inspector (delegates to storage-inspector.ts) ─────────────────

  async captureStorage(tabId: TabId): Promise<StorageReport> {
    return storage.capture(this.debuggerFor(tabId), tabId);
  }

  /** Read all entries (or a single key) from localStorage or sessionStorage. */
  async getStorage(tabId: TabId, area: StorageArea, key?: string): Promise<StorageEntry[]> {
    return storage.read(this.debuggerFor(tabId), area, key);
  }

  /** Set one or more key/value pairs in localStorage or sessionStorage. */
  async setStorage(tabId: TabId, area: StorageArea, entries: Record<string, string>): Promise<void> {
    return storage.write(this.debuggerFor(tabId), area, entries);
  }

  /** Remove specific keys or clear the entire area. */
  async clearStorage(tabId: TabId, area: StorageArea, keys?: string[]): Promise<void> {
    return storage.clear(this.debuggerFor(tabId), area, keys);
  }

  /** Set (upsert) a cookie. Defaults to the tab's current origin. */
  async setCookie(tabId: TabId, cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void> {
    return storage.setCookie(this.debuggerFor(tabId), cookie);
  }

  /** Delete a cookie by name (and optionally a target URL). */
  async deleteCookie(tabId: TabId, name: string, url?: string): Promise<void> {
    return storage.deleteCookie(this.debuggerFor(tabId), name, url);
  }

  /** Clear all cookies for the tab's current origin (or a given URL). */
  async clearCookies(tabId: TabId, url?: string): Promise<void> {
    return storage.clearCookies(this.debuggerFor(tabId), url);
  }

  // ── Console / Network logs ────────────────────────────────────────────────

  /** Return a snapshot of all buffered logs for the tab. */
  getTabLogs(tabId: TabId): TabLogSnapshot {
    const tab = this.requireTab(tabId);
    return {
      tabId,
      consoleLogs: [...tab.consoleLogs],
      networkRequests: [...tab.networkRequests.values()],
      webSocketFrames: [...tab.webSocketFrames],
      eventSourceEvents: [...tab.eventSourceEvents],
      jsErrors: [...tab.jsErrors],
      capturedAt: Date.now()
    };
  }

  /** Export the tab's buffered network requests as a HAR 1.2 archive. */
  exportHar(tabId: TabId): HarArchive {
    const tab = this.requireTab(tabId);
    return buildHar(tab.view.webContents.getURL(), [...tab.networkRequests.values()]);
  }

  /** Clear all buffered logs for the tab. */
  clearTabLogs(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    tab.consoleLogs = [];
    tab.networkRequests = new Map();
    tab.webSocketUrls = new Map();
    tab.webSocketFrames = [];
    tab.eventSourceEvents = [];
    tab.jsErrors = [];
  }

  startRecording(tabId: TabId): RecordingSession {
    const tab = this.requireTab(tabId);
    tab.recording = { tabId, startedAt: Date.now(), commands: [] };
    return tab.recording;
  }

  getRecording(tabId: TabId): RecordingSession | null {
    return this.requireTab(tabId).recording;
  }

  stopRecording(tabId: TabId): RecordingStopResult {
    const tab = this.requireTab(tabId);
    if (!tab.recording) {
      throw new Error(`No recording in progress for tab ${tabId}`);
    }

    const recording = tab.recording;
    tab.recording = null;
    return {
      ...recording,
      script: renderRecordingScript(recording),
      exports: exportRecordingAll(recording)
    };
  }

  getSitePatterns(tabId: TabId): string[] {
    return this.sitePatterns.get(this.getTabOrigin(tabId));
  }

  setSitePatterns(tabId: TabId, patterns: string[]): string[] {
    return this.sitePatterns.set(this.getTabOrigin(tabId), patterns);
  }

  addSitePatterns(tabId: TabId, patterns: string[]): string[] {
    return this.sitePatterns.add(this.getTabOrigin(tabId), patterns);
  }

  clearSitePatterns(tabId: TabId): void {
    this.sitePatterns.clear(this.getTabOrigin(tabId));
  }

  async setFileInputFiles(tabId: TabId, target: FileUploadTarget): Promise<{ ok: true }> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    const { root } = await webContents.debugger.sendCommand("DOM.getDocument", { depth: 1 }) as { root: { nodeId: number } };
    const { nodeId } = await webContents.debugger.sendCommand("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: target.selector
    }) as { nodeId: number };

    if (!nodeId) {
      throw new Error(`No file input matched selector: ${target.selector}`);
    }

    const described = await webContents.debugger.sendCommand("DOM.describeNode", { nodeId }) as { node: { backendNodeId: number } };
    await webContents.debugger.sendCommand("DOM.setFileInputFiles", {
      backendNodeId: described.node.backendNodeId,
      files: target.files
    });

    return { ok: true };
  }

  listDownloads(tabId: TabId): DownloadEntry[] {
    return [...this.requireTab(tabId).downloads];
  }

  clearDownloads(tabId: TabId): void {
    this.requireTab(tabId).downloads = [];
  }

  async setResourceBudget(tabId: TabId, budget: ResourceBudget): Promise<ResourceBudget> {
    const tab = this.requireTab(tabId);
    tab.resourceBudget = { ...budget };
    await applyResourceBudget(electronCdpTarget(tab.view.webContents), tab.resourceBudget);
    return tab.resourceBudget;
  }

  getResourceBudget(tabId: TabId): ResourceBudget | null {
    return this.requireTab(tabId).resourceBudget;
  }

  async clearResourceBudget(tabId: TabId): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.resourceBudget = null;
    this.ensureDebugger(tab.view.webContents);
    await tab.view.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    await tab.view.webContents.debugger.sendCommand("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    }).catch(() => {});
  }

  async setLocationOverride(tabId: TabId, location: LocationOverride): Promise<LocationOverride> {
    const tab = this.requireTab(tabId);
    tab.locationOverride = { ...location };
    await applyLocationOverride(electronCdpTarget(tab.view.webContents), tab.locationOverride);
    return tab.locationOverride;
  }

  getLocationOverride(tabId: TabId): LocationOverride | null {
    return this.requireTab(tabId).locationOverride;
  }

  async clearLocationOverride(tabId: TabId): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.locationOverride = null;
    this.ensureDebugger(tab.view.webContents);
    await tab.view.webContents.debugger.sendCommand("Emulation.clearGeolocationOverride").catch(() => {});
    await tab.view.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "UTC" }).catch(() => {});
  }

  // ── Media / appearance emulation ──────────────────────────────────────────

  async setMediaEmulation(tabId: TabId, emulation: MediaEmulation): Promise<MediaEmulation> {
    const tab = this.requireTab(tabId);
    tab.mediaEmulation = { ...emulation };
    await applyMediaEmulation(electronCdpTarget(tab.view.webContents), tab.mediaEmulation);
    return tab.mediaEmulation;
  }

  getMediaEmulation(tabId: TabId): MediaEmulation | null {
    return this.requireTab(tabId).mediaEmulation;
  }

  async clearMediaEmulation(tabId: TabId): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.mediaEmulation = null;
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);
    await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "", features: [] }).catch(() => {});
  }


  // ── Network mock / intercept ──────────────────────────────────────────────

  async enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    // Reset Fetch domain if rules were already active.
    if (tab.networkMockRules) {
      await webContents.debugger.sendCommand("Fetch.disable").catch(() => {});
    }

    tab.networkMockRules = rules;

    await webContents.debugger.sendCommand("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }]
    });
  }

  async disableNetworkMock(tabId: TabId): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.networkMockRules = null;
    if (tab.view.webContents.debugger.isAttached()) {
      await tab.view.webContents.debugger.sendCommand("Fetch.disable").catch(() => {});
    }
  }

  getNetworkMockRules(tabId: TabId): NetworkInterceptRule[] | null {
    return this.requireTab(tabId).networkMockRules;
  }

  async setEmulatedViewport(tabId: TabId, width: number, height: number, mobile: boolean): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    tab.emulatedViewport = { width, height, mobile };

    await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile
    });
  }

  async getLatestObservation(tabId: TabId): Promise<PageObservation | null> {
    return this.requireTab(tabId).lastObservation;
  }

  async capturePerception(tabId: TabId): Promise<PerceptionResult> {
    const tab = this.requireTab(tabId);
    const snapshot = await this.captureSnapshot(tabId);
    const result = normalizePerception(snapshot, tab.lastObservation);
    this.evaluateAssertionWatches(tabId, result.graph);
    return result;
  }

  // ── Standing assertion watches ────────────────────────────────────────────

  addAssertionWatch(tabId: TabId, assertion: string): AssertionWatch {
    return this.assertionWatches.add(tabId, assertion, Date.now());
  }

  removeAssertionWatch(id: string): boolean {
    return this.assertionWatches.remove(id);
  }

  listAssertionWatches(tabId?: TabId): AssertionWatch[] {
    return this.assertionWatches.list(tabId);
  }

  onAssertionTransition(listener: (transition: AssertionTransition) => void): void {
    this.assertionTransitionListeners.add(listener);
  }

  /** Re-evaluate this tab's watches against a fresh graph and emit transitions. */
  private evaluateAssertionWatches(tabId: TabId, graph: PageGraph): void {
    const transitions = this.assertionWatches.evaluateTab(
      tabId,
      (assertion) => {
        const result = evaluateAssertionAgainstGraph(tabId, assertion, graph);
        return { pass: result.pass, explanation: result.explanation };
      },
      Date.now()
    );
    for (const transition of transitions) {
      for (const listener of this.assertionTransitionListeners) {
        listener(transition);
      }
    }
  }

  async getPerceptionPacket(tabId: TabId): Promise<BrowserPerceptionPacket> {
    const tab = this.requireTab(tabId);
    const result = await this.capturePerception(tabId);
    const packet = await this.capabilityRegistry.buildPerceptionPacket(tabId, tab.lastObservation, result, { cdp: electronCdpTarget(tab.view.webContents), navigate: (u) => tab.view.webContents.loadURL(u) });
    return {
      ...packet,
      sitePatterns: this.sitePatterns.get(originFromUrl(result.graph.url))
    };
  }

  async listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]> {
    const tab = this.requireTab(tabId);
    const result = await this.capturePerception(tabId);
    return this.capabilityRegistry.listCapabilityManifests(tabId, result, { cdp: electronCdpTarget(tab.view.webContents), navigate: (u) => tab.view.webContents.loadURL(u) });
  }

  async executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult> {
    const tab = this.requireTab(tabId);
    const budgetBlock = await this.checkResourceBudget(tab);
    if (budgetBlock) {
      this.recordCommand(tab, "command", command, "blocked");
      return budgetBlock;
    }
    const result = await this.capturePerception(tabId);
    const execution = await this.capabilityRegistry.executeCommand(tabId, command, tab.lastObservation, result, { cdp: electronCdpTarget(tab.view.webContents), navigate: (u) => tab.view.webContents.loadURL(u) });
    this.recordCommand(tab, "command", command, execution.status);

    if (execution.status !== "completed") {
      return execution;
    }

    await waitForPageSettled(electronCdpTarget(tab.view.webContents));

    const refreshed = await this.capturePerception(tabId);
    return {
      ...execution,
      observation: this.requireTab(tabId).lastObservation,
      graph: refreshed.graph
    };
  }

  async approveCommand(requestId: string): Promise<BrowserCommandResult> {
    // Resolve the owning tab directly from the pending approval instead of
    // probing every tab (which captured perception per tab).
    const pending = this.listPendingApprovals().find((approval) => approval.requestId === requestId);
    if (pending) {
      const tab = this.tabs.get(pending.tabId);
      if (!tab) {
        return {
          status: "failed",
          command: { type: "request_perception_refresh", tabId: pending.tabId },
          reason: `Tab ${pending.tabId} for approval ${requestId} no longer exists.`,
          retryable: false
        };
      }

      const result = await this.capturePerception(tab.id);
      const execution = await this.capabilityRegistry.approveCommand(requestId, tab.lastObservation, result, { cdp: electronCdpTarget(tab.view.webContents), navigate: (u) => tab.view.webContents.loadURL(u) });

      if (execution.status === "completed") {
        await waitForPageSettled(electronCdpTarget(tab.view.webContents));
        const refreshed = await this.capturePerception(tab.id);
        return {
          ...execution,
          observation: this.requireTab(tab.id).lastObservation,
          graph: refreshed.graph
        };
      }

      return execution;
    }

    return {
      status: "failed",
      command: {
        type: "request_perception_refresh",
        tabId: this.activeTabId ?? "unknown"
      },
      reason: `Approval request ${requestId} was not found.`,
      retryable: false
    };
  }

  rejectCommand(requestId: string): BrowserCommandResult {
    return this.capabilityRegistry.rejectCommand(requestId);
  }

  listVaultSecrets(): VaultSecretSummary[] {
    return this.vault.listSecrets();
  }

  saveVaultSecrets(updates: VaultSecretInput[]): VaultSecretSummary[] {
    return this.vault.saveSecrets(updates);
  }

  getVaultStatus(): VaultStatus {
    return this.vault.getStatus();
  }

  listApprovalPolicies(): ApprovalPolicyRecord[] {
    return this.policies.listPolicies();
  }

  updateApprovalPolicy(key: ApprovalPolicyKey, decision: ApprovalDecision): ApprovalPolicyRecord[] {
    return this.policies.updatePolicy(key, decision);
  }

  getFixtureUrl(name: FixturePageName): string {
    const fixtureMap: Record<FixturePageName, string> = {
      "contact-form": path.join(this.appDir, "../../test-pages/contact-form.html")
    };

    return pathToFileURL(fixtureMap[name]).toString();
  }

  // ── Accounts ─────────────────────────────────────────────────────────────

  listAccounts(): AccountSummary[] {
    return this.accounts.listAccounts();
  }

  saveAccount(input: AccountInput): AccountSummary {
    return this.accounts.saveAccount(input);
  }

  updateAccount(id: string, update: AccountUpdate): AccountSummary {
    return this.accounts.updateAccount(id, update);
  }

  deleteAccount(id: string): void {
    this.accounts.deleteAccount(id);
  }

  lookupAccounts(origin: string): AccountSummary[] {
    return this.accounts.lookupByOrigin(origin);
  }

  generateTotp(accountId: string): TotpResult {
    return this.accounts.generateTotp(accountId);
  }

  // ── Human handoffs ───────────────────────────────────────────────────────

  listHandoffs(): HumanHandoffRecord[] {
    return this.capabilityRegistry.listHandoffs();
  }

  resolveHandoff(requestId: string): BrowserCommandResult {
    return this.capabilityRegistry.resolveHandoff(requestId);
  }

  cancelHandoff(requestId: string): BrowserCommandResult {
    return this.capabilityRegistry.cancelHandoff(requestId);
  }

  listTabs(): TabSummary[] {
    return [...this.tabs.values()].map((entry) => entry.summary);
  }

  onTabsChanged(listener: TabsChangedListener) {
    this.listeners.add(listener);
  }

  onPageObserved(listener: PageObservedListener) {
    this.observationListeners.add(listener);
  }

  onHandoffRequested(listener: (handoff: HumanHandoffRecord) => void) {
    this.capabilityRegistry.onHandoffRequested(listener);
  }

  onApprovalQueued(listener: ApprovalQueuedListener) {
    this.approvalQueuedListeners.add(listener);
  }

  listPendingApprovals() {
    return this.approvals.list();
  }

  recordObservation(observation: PageObservation) {
    const tab = this.tabs.get(observation.tabId);
    if (!tab) {
      return;
    }

    tab.lastObservation = observation;
    for (const listener of this.observationListeners) {
      listener(observation);
    }
  }

  private getTabOrigin(tabId: TabId): string {
    return originFromUrl(this.requireTab(tabId).summary.url);
  }

  private getHandoffContext(tabId: TabId): Pick<HumanHandoffRecord, "relatedTabIds" | "groupId" | "origin" | "title"> {
    const tab = this.requireTab(tabId);
    const origin = originFromUrl(tab.summary.url);
    const relatedTabIds = [...new Set(
      [...this.tabs.values()]
        .filter((entry) => entry.id === tabId || entry.parentTabId === tabId || tab.parentTabId === entry.id || originFromUrl(entry.summary.url) === origin)
        .map((entry) => entry.id)
    )];

    return {
      relatedTabIds: relatedTabIds.length ? relatedTabIds : [tabId],
      groupId: `${origin}::${tab.parentTabId ?? tabId}`,
      origin,
      title: tab.summary.title
    };
  }

  private recordCommand(tab: TabRecord, source: RecordedCommand["source"], command: unknown, outcome: RecordedCommand["outcome"]) {
    if (!tab.recording) return;
    tab.recording.commands.push({ at: Date.now(), source, command, outcome });
  }


  private async checkResourceBudget(tab: TabRecord): Promise<BrowserCommandResult | null> {
    if (!tab.resourceBudget?.maxJsHeapMb) return null;
    const usedHeapMb = await this.getCurrentJsHeapMb(tab);
    if (usedHeapMb === null || usedHeapMb <= tab.resourceBudget.maxJsHeapMb) return null;
    return {
      status: "blocked",
      command: { type: "request_perception_refresh", tabId: tab.id },
      reason: `Blocked by resource budget: JS heap ${usedHeapMb.toFixed(1)} MB exceeds ${tab.resourceBudget.maxJsHeapMb} MB.`
    };
  }

  private async getCurrentJsHeapMb(tab: TabRecord): Promise<number | null> {
    const { webContents } = tab.view;
    this.ensureDebugger(webContents);
    const metrics = await webContents.debugger.sendCommand("Performance.getMetrics") as { metrics?: Array<{ name: string; value: number }> };
    const heap = metrics.metrics?.find((metric) => metric.name === "JSHeapUsedSize")?.value;
    return typeof heap === "number" ? heap / (1024 * 1024) : null;
  }


  private bindLifecycle(tab: TabRecord) {
    const { webContents } = tab.view;

    // Route CDP messages to the log/mock handler (bound once; safe before debugger attach).
    webContents.debugger.on("message", (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
      handleCdpMessage(tab, electronCdpTarget(webContents), method, params);
    });

    const updateSummary = () => {
      const liveUrl = webContents.getURL();
      const isLoading = webContents.isLoading();
      const url =
        tab.pendingUrl && (isLoading || !liveUrl || liveUrl === tab.summary.url) ? tab.pendingUrl : liveUrl || tab.summary.url;

      if (!isLoading && tab.pendingUrl && (!liveUrl || liveUrl === tab.pendingUrl || liveUrl !== tab.summary.url)) {
        tab.pendingUrl = null;
      }

      tab.summary = {
        ...tab.summary,
        title: webContents.getTitle() || tab.summary.title,
        url,
        status: isLoading ? "loading" : "idle",
        statusMessage: isLoading ? `Loading ${url}` : `Loaded ${url}`
      };
      this.emitTabsChanged();
    };

    const updateLoadingUrl = (url: string) => {
      tab.pendingUrl = url;
      tab.summary = {
        ...tab.summary,
        url,
        status: "loading",
        statusMessage: `Loading ${url}`
      };
      this.emitTabsChanged();
    };

    webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      updateSummary();
    });
    webContents.on("did-start-navigation", (event, navigationUrl, _isInPlace, isMainFrame) => {
      if (!event.defaultPrevented && isMainFrame) {
        updateLoadingUrl(navigationUrl);
        // Clear buffered logs on every main-frame navigation.
        tab.consoleLogs = [];
        tab.networkRequests = new Map();
        tab.webSocketUrls = new Map();
        tab.webSocketFrames = [];
        tab.eventSourceEvents = [];
        tab.jsErrors = [];
      }
    });
    webContents.on("did-navigate", updateSummary);
    webContents.on("did-navigate-in-page", updateSummary);
    webContents.on("did-finish-load", () => {
      updateSummary();
      void applyLocationOverride(electronCdpTarget(webContents), tab.locationOverride);
      void applyResourceBudget(electronCdpTarget(webContents), tab.resourceBudget);
      void applyMediaEmulation(electronCdpTarget(webContents), tab.mediaEmulation);
    });
    webContents.on("did-start-loading", updateSummary);
    webContents.on("did-stop-loading", updateSummary);
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }
      tab.pendingUrl = null;
      tab.summary = {
        ...tab.summary,
        url: validatedURL || tab.summary.url,
        status: "error",
        statusMessage: `Load failed (${errorCode}): ${errorDescription || validatedURL || "Unknown error"}`
      };
      this.emitTabsChanged();
    });

    // Auto-respond to HTTP Basic Auth challenges using vault accounts.
    webContents.on("login", (_event, _request, authInfo, callback) => {
      if (authInfo.scheme !== "basic") {
        callback();
        return;
      }
      const origin = `${authInfo.isProxy ? "proxy" : (authInfo.host ? `https://${authInfo.host}` : "")}`;
      const record = this.accounts.findRecordByOrigin(origin || tab.summary.url);
      if (record) {
        callback(record.username, record.password);
      } else {
        callback();
      }
    });

    webContents.setWindowOpenHandler(({ url }) => {
      void this.createTab(url || "about:blank", tab.id);
      return { action: "deny" };
    });
  }

  // ── CDP domain management ─────────────────────────────────────────────────

  private async enableCdpLogging(tab: TabRecord): Promise<void> {
    if (tab.cdpLoggingEnabled) return;
    tab.cdpLoggingEnabled = true;
    const { webContents } = tab.view;
    await Promise.all([
      webContents.debugger.sendCommand("Runtime.enable"),
      webContents.debugger.sendCommand("Log.enable"),
      webContents.debugger.sendCommand("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }),
      webContents.debugger.sendCommand("Performance.enable", { timeDomain: "timeTicks" }).catch(() => {})
    ]);
  }


  private ensureDownloadTracking(tab: TabRecord) {
    const trackedSession = tab.view.webContents.session;
    if (this.downloadTrackingSessions.has(trackedSession)) {
      return;
    }

    this.downloadTrackingSessions.add(trackedSession);
    trackedSession.on("will-download", (_event, item, webContents) => {
      const owner = [...this.tabs.values()].find((entry) => entry.view.webContents.id === webContents.id);
      if (!owner) {
        return;
      }

      const download: DownloadEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tabId: owner.id,
        url: item.getURL(),
        filename: item.getFilename(),
        mimeType: item.getMimeType?.(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        state: "progressing",
        startedAt: Date.now()
      };
      owner.downloads.push(download);

      item.on("updated", () => {
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        download.state = item.isPaused?.() ? "interrupted" : "progressing";
      });

      item.once("done", (_doneEvent, state) => {
        download.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        download.finishedAt = Date.now();
        download.receivedBytes = item.getReceivedBytes();
      });
    });
  }

  private layoutActiveTab() {
    if (!this.activeTabId) {
      return;
    }

    const tab = this.tabs.get(this.activeTabId);
    if (!tab) {
      return;
    }

    tab.view.setBounds(this.viewport);
    tab.view.setVisible(this.viewport.width > 0 && this.viewport.height > 0);
  }

  private requireTab(tabId: TabId): TabRecord {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }
    return tab;
  }

  /**
   * Attach the CDP debugger to a WebContents if it isn't already attached, and
   * return it. Centralizes the guard so no CDP entrypoint throws
   * "Debugger is not attached".
   */
  private ensureDebugger(webContents: Electron.WebContents): Electron.Debugger {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }
    return webContents.debugger;
  }

  /** Require the tab and return its CDP target (attaches the debugger on first send). */
  private debuggerFor(tabId: TabId): CdpTarget {
    return electronCdpTarget(this.requireTab(tabId).view.webContents);
  }

  private emitTabsChanged() {
    const tabs = this.listTabs();
    for (const listener of this.listeners) {
      listener(tabs);
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────




function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}


/**
 * Returns true if url and method satisfy the given NetworkInterceptRule.
 * urlPattern supports:
 *   - star wildcard anywhere (e.g. "star/api/products*")
 *   - /regex/flags literal regex (e.g. /\/api\/v\d+\//i)
 */
