import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, nativeImage, WebContentsView } from "electron";

import { normalizePerception } from "../../../../packages/perception/src/normalize.js";
import { AccountStore } from "./account-store.js";
import { installAntiDetection } from "./anti-detection.js";
import { isStealthEnabled } from "./runtime-config.js";
import { PerceptionBaselineStore, ScreenshotBaselineStore, type PerceptionBaselineEntry } from "./baseline-store.js";
import { buildHar } from "./har.js";
import { buildDesignTokensReport, designTokenCollectorScript, type RawDesignTokens } from "./design-tokens.js";
import { buildLayoutIssuesReport, layoutIssueDetectorScript, type LayoutIssuesRaw } from "./layout-issues.js";
import { buildMediaStateReport, mediaStateCollectorScript, type MediaStateRaw } from "./media-state.js";
import { exportRecordingAll } from "./recording-export.js";
import { buildHealthReport } from "./health-report.js";
import { AssertionWatchStore } from "./assertion-watch.js";
import { buildMutationReport, mutationTimelineScript, type RawMutationTimeline } from "./mutation-timeline.js";
import { buildComponentSourceReport, componentSourceCollectorScript, type RawComponentSources } from "./component-source.js";
import { comparePixels } from "./pixel-compare.js";
import { correlateRegionsToElements, elementBoundsScript } from "./element-bounds.js";
import { analyzeFocusOrder, focusableElementsScript, type RawFocusOrder } from "./focus-order.js";
import * as storage from "./storage-inspector.js";
import { capturePerformance } from "./performance-probe.js";
import { captureThreeScene } from "./threejs-inspector.js";
import { inspectStyles, assertStyles } from "./style-inspector.js";
import { clampInt } from "./util.js";
import { waitForPageSettled } from "./dom-actuator.js";
import { ApprovalPolicyStore } from "./approval-policy-store.js";
import { ApprovalStore } from "./approval-store.js";
import { HandoffStore } from "./handoff-store.js";
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
  type ConsoleLogLevel,
  type CookieEntry,
  type DownloadEntry,
  type ElementStyleAssertionReport,
  type ElementStyleInspectionReport,
  type DiffRegion,
  type EventSourceMessageEntry,
  type FileUploadTarget,
  type FixturePageName,
  type HumanHandoffRecord,
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
import { SiteCapabilityRegistry } from "./site-capability-registry.js";
import { SitePatternStore } from "./site-pattern-store.js";
import { VaultStore } from "./vault-store.js";

type EmulatedViewport = { width: number; height: number; mobile: boolean };

type TabRecord = {
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
  private readonly screenshotCache = new Map<string, PageScreenshot>();
  private readonly perceptionCache = new Map<string, PerceptionBaselineEntry>();
  private readonly screenshotStore: ScreenshotBaselineStore;
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
    this.screenshotStore = new ScreenshotBaselineStore(userDataPath);
    this.perceptionStore = new PerceptionBaselineStore(userDataPath);
    for (const { id, shot } of this.screenshotStore.all()) {
      this.screenshotCache.set(id, shot);
    }
    for (const { id, entry } of this.perceptionStore.all()) {
      this.perceptionCache.set(id, entry);
    }
    this.capabilityRegistry = new SiteCapabilityRegistry(
      this.vault,
      this.accounts,
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
    this.screenshotCache.set(snapshotId, shot);
    if (persist) {
      this.screenshotStore.put(snapshotId, shot);
    }
    return shot;
  }

  /** Compare two previously captured named screenshots pixel-by-pixel. */
  diffScreenshots(
    beforeId: string,
    afterId: string,
    options: { ignoreRegions?: DiffRegion[]; perceptual?: boolean; threshold?: number } = {}
  ): ScreenshotDiff {
    const before = this.screenshotCache.get(beforeId);
    const after  = this.screenshotCache.get(afterId);
    if (!before) throw new Error(`Screenshot "${beforeId}" not found in cache`);
    if (!after)  throw new Error(`Screenshot "${afterId}" not found in cache`);

    const imgA = nativeImage.createFromDataURL(`data:image/png;base64,${before.data}`);
    const imgB = nativeImage.createFromDataURL(`data:image/png;base64,${after.data}`);

    const { width: wA, height: hA } = imgA.getSize();
    const { width: wB, height: hB } = imgB.getSize();
    const totalPixels = wA * hA;

    if (wA !== wB || hA !== hB) {
      return {
        beforeId, afterId,
        diffPixelCount: totalPixels, diffPercentage: 100, totalPixels,
        width: wA, height: hA, diffRegions: [{ x: 0, y: 0, width: wA, height: hA }],
        capturedAt: Date.now()
      };
    }

    const rawA   = imgA.toBitmap(); // BGRA, 4 bytes/pixel
    const rawB   = imgB.toBitmap();
    // Start with the "before" image as the base — changed areas will be tinted.
    const diffBuf = Buffer.from(rawA);
    // Track which pixels changed as a flat boolean array for region detection.
    const changed = new Uint8Array(totalPixels);
    // Optional mask of pixels to ignore (e.g. dynamic timestamps/ads).
    const ignoreMask = options.ignoreRegions?.length ? buildIgnoreMask(options.ignoreRegions, wA, hA) : null;
    let diffCount = 0;

    if (options.perceptual) {
      // Perceptual (YIQ) comparison: ignores anti-aliasing / sub-pixel noise.
      const cmp = comparePixels(rawA, rawB, wA, hA, { threshold: options.threshold, ignoreMask });
      changed.set(cmp.changed);
      diffCount = cmp.diffCount;
    } else {
      // Default: raw per-channel ±10 comparison (unchanged behavior).
      for (let i = 0; i < rawA.length; i += 4) {
        const px = i >> 2;
        if (ignoreMask && ignoreMask[px]) continue;
        const db = Math.abs(rawA[i]   - rawB[i]);
        const dg = Math.abs(rawA[i + 1] - rawB[i + 1]);
        const dr = Math.abs(rawA[i + 2] - rawB[i + 2]);
        if (dr > 10 || dg > 10 || db > 10) {
          diffCount++;
          changed[px] = 1;
        }
      }
    }

    // Tint changed pixels red over the dimmed original so context stays legible.
    for (let px = 0; px < totalPixels; px++) {
      if (!changed[px]) continue;
      const i = px * 4;
      diffBuf[i]     = Math.round(rawA[i]     * 0.4);            // B dimmed
      diffBuf[i + 1] = Math.round(rawA[i + 1] * 0.4);            // G dimmed
      diffBuf[i + 2] = Math.round(rawA[i + 2] * 0.4 + 255 * 0.6); // R boosted
      diffBuf[i + 3] = 255;
    }

    const diffImg = nativeImage.createFromBitmap(diffBuf, { width: wA, height: hA });

    return {
      beforeId, afterId,
      diffPixelCount: diffCount,
      diffPercentage: Math.round((diffCount / totalPixels) * 10000) / 100,
      totalPixels,
      width: wA, height: hA,
      diffRegions: computeDiffRegions(changed, wA, hA),
      diffImageData: diffImg.toPNG().toString("base64"),
      capturedAt: Date.now()
    };
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
    for (const [id, shot] of this.screenshotCache) {
      const tab = this.tabs.get(shot.tabId);
      const url = tab ? tab.view.webContents.getURL() : "";
      out.push({ id, tabId: shot.tabId, url, width: shot.width, height: shot.height, capturedAt: shot.capturedAt });
    }
    return out;
  }

  /** Remove a named screenshot from the cache and disk. Returns false if it didn't exist. */
  deleteScreenshot(id: string): boolean {
    const existed = this.screenshotCache.delete(id);
    this.screenshotStore.remove(id);
    return existed;
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
  async auditAccessibility(tabId: TabId): Promise<import("../../../../packages/shared/src/index.js").A11yAuditReport> {
    type A11yViolation = import("../../../../packages/shared/src/index.js").A11yViolation;
    type A11yRuleSummary = import("../../../../packages/shared/src/index.js").A11yRuleSummary;
    type A11yWcagPrinciple = import("../../../../packages/shared/src/index.js").A11yWcagPrinciple;

    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    // ── Rule metadata ───────────────────────────────────────────────────────

    type RuleMeta = {
      wcag: string;
      level: "A" | "AA" | "AAA";
      principle: A11yWcagPrinciple;
      impact: import("../../../../packages/shared/src/index.js").A11yImpact;
      title: string;
    };

    const RULES: Record<string, RuleMeta> = {
      "1.1.1-image-alt":          { wcag: "1.1.1", level: "A",  principle: "perceivable",     impact: "critical", title: "Images must have a non-empty accessible name" },
      "1.3.1-input-label":        { wcag: "1.3.1", level: "A",  principle: "perceivable",     impact: "serious",  title: "Form inputs must have an accessible label" },
      "1.3.1-table-header":       { wcag: "1.3.1", level: "A",  principle: "perceivable",     impact: "moderate", title: "Table header cells must have a discernible name" },
      "2.1.1-interactive-label":  { wcag: "2.1.1", level: "A",  principle: "operable",        impact: "critical", title: "Interactive elements must be keyboard-operable" },
      "2.4.2-page-title":         { wcag: "2.4.2", level: "A",  principle: "operable",        impact: "serious",  title: "Page must have a descriptive <title>" },
      "2.4.3-heading-order":      { wcag: "2.4.3", level: "A",  principle: "operable",        impact: "moderate", title: "Heading levels must not skip ranks" },
      "2.4.4-link-purpose":       { wcag: "2.4.4", level: "A",  principle: "operable",        impact: "moderate", title: "Link text must be meaningful out of context" },
      "2.4.6-button-label":       { wcag: "2.4.6", level: "AA", principle: "operable",        impact: "serious",  title: "Buttons must have an accessible name" },
      "2.4.6-link-label":         { wcag: "2.4.6", level: "AA", principle: "operable",        impact: "serious",  title: "Links must have an accessible name" },
      "3.1.1-page-lang":          { wcag: "3.1.1", level: "A",  principle: "understandable",  impact: "serious",  title: "HTML element must have a lang attribute" },
      "4.1.2-aria-required-attr": { wcag: "4.1.2", level: "A",  principle: "robust",          impact: "critical", title: "ARIA widget roles must have required state attributes" },
      "4.1.3-disabled-label":     { wcag: "4.1.3", level: "AA", principle: "robust",          impact: "minor",    title: "Disabled controls must still have an accessible name" },
    };

    // ── Fetch AX tree and DOM-level checks in parallel ──────────────────────

    await webContents.debugger.sendCommand("Accessibility.enable");

    const [axResult, domChecks] = await Promise.all([
      webContents.debugger.sendCommand("Accessibility.getFullAXTree", {}) as Promise<{
        nodes: Array<{
          nodeId: string;
          role?: { value: string };
          name?: { value: string };
          ignored?: boolean;
          properties?: Array<{ name: string; value: { value: unknown } }>;
          childIds?: string[];
          backendDOMNodeId?: number;
        }>;
      }>,
      webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: `(function() {
          var html = document.documentElement;
          var lang = html ? html.getAttribute('lang') : null;
          var title = document.title;
          return { lang: lang, title: title };
        })()`,
        returnByValue: true,
      }) as Promise<{ result: { value: { lang: string | null; title: string } } }>,
    ]);

    const { nodes } = axResult;
    const { lang: pageLang, title: pageTitle } = domChecks.result.value;

    const violations: A11yViolation[] = [];
    let passes = 0;

    // Helper to build a stable selector hint from an AX node.
    const selectorFor = (node: (typeof nodes)[number], role: string): string =>
      node.backendDOMNodeId ? `[data-ax-node="${node.nodeId}"]` : `[role="${role}"]`;

    // Helper to push a violation using the rule metadata.
    const push = (ruleId: string, node: (typeof nodes)[number], role: string, name: string | undefined, description: string, remediation: string) => {
      const meta = RULES[ruleId];
      violations.push({
        rule: ruleId,
        impact: meta.impact,
        wcagCriteria: meta.wcag,
        wcagLevel: meta.level,
        principle: meta.principle,
        selector: selectorFor(node, role),
        description,
        remediation,
        role,
        name,
      });
    };

    // ── DOM-level checks (page-wide) ────────────────────────────────────────

    // 3.1.1 — HTML lang attribute
    if (!pageLang || pageLang.trim() === "") {
      violations.push({
        rule: "3.1.1-page-lang",
        impact: RULES["3.1.1-page-lang"].impact,
        wcagCriteria: "3.1.1",
        wcagLevel: "A",
        principle: "understandable",
        selector: "html",
        description: "The <html> element has no lang attribute.",
        remediation: 'Add a lang attribute to the root element: <html lang="en">. Use a valid BCP 47 language tag matching the page\'s primary language.',
        role: "document",
      });
    }

    // 2.4.2 — Page title
    if (!pageTitle || pageTitle.trim() === "") {
      violations.push({
        rule: "2.4.2-page-title",
        impact: RULES["2.4.2-page-title"].impact,
        wcagCriteria: "2.4.2",
        wcagLevel: "A",
        principle: "operable",
        selector: "head > title",
        description: "The page has no <title> or its title is empty.",
        remediation: "Add a <title> element inside <head> that briefly describes the page's purpose or current view. Avoid generic titles like 'Page' or 'Untitled'.",
        role: "document",
      });
    }

    // ── Ambiguous-link-text word list (2.4.4) ───────────────────────────────
    const GENERIC_LINK_TEXTS = new Set([
      "click here", "here", "read more", "more", "details", "learn more",
      "this", "link", "click", "go", "view", "see more", "continue", "next",
    ]);

    // ── ARIA roles that require specific state properties ───────────────────
    // Maps AX property name (as returned by CDP) to the role(s) that require it.
    const ARIA_REQUIRED: Record<string, string[]> = {
      checked:    ["checkbox", "radio", "menuitemcheckbox", "menuitemradio", "treeitem", "switch"],
      expanded:   ["combobox", "listbox", "tree", "treegrid", "rowgroup"],
      valuenow:   ["slider", "scrollbar", "spinbutton"],
    };

    // ── Per-node checks ─────────────────────────────────────────────────────

    let lastHeadingLevel = 0;

    for (const node of nodes) {
      if (node.ignored) continue;

      const role = node.role?.value ?? "generic";
      const name = node.name?.value;
      const trimmedName = name?.trim() ?? "";
      const props = Object.fromEntries(
        (node.properties ?? []).map(p => [p.name, p.value?.value])
      );

      let nodeViolations = 0;

      // ── 1.1.1 — Images must have a non-empty accessible name ───────────────
      if (role === "img") {
        if (!trimmedName || trimmedName === "image") {
          push(
            "1.1.1-image-alt", node, role, name,
            "Image is missing an accessible name.",
            'Add descriptive alt text (alt="...") to the <img> element. For decorative images use alt="" and role="presentation". Avoid generic text like "image" or "photo".'
          );
          nodeViolations++;
        }
      }

      // ── 1.3.1 — Form inputs must have an accessible label ──────────────────
      if ((role === "textbox" || role === "combobox" || role === "spinbutton" || role === "searchbox") && !trimmedName) {
        push(
          "1.3.1-input-label", node, role, name,
          `${role} input has no accessible label.`,
          "Associate a <label> element using the for/id pair, or add an aria-label / aria-labelledby attribute. Placeholder text alone does not count as a label."
        );
        nodeViolations++;
      }

      // ── 1.3.1 — Table header cells must have a name ────────────────────────
      if ((role === "columnheader" || role === "rowheader") && !trimmedName) {
        push(
          "1.3.1-table-header", node, role, name,
          `${role === "columnheader" ? "Column" : "Row"} header cell has no accessible name.`,
          "Add descriptive text content to the <th> element. Avoid empty header cells — if a column needs no visual header, provide a visually-hidden text label."
        );
        nodeViolations++;
      }

      // ── 2.4.3 — Heading levels must not skip ranks ─────────────────────────
      if (role === "heading") {
        const level = Number(props["level"]) || 0;
        if (level > 0) {
          if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
            push(
              "2.4.3-heading-order", node, role, name,
              `Heading level skips from h${lastHeadingLevel} to h${level}.`,
              `Use consecutive heading levels. Add an h${lastHeadingLevel + 1} between h${lastHeadingLevel} and h${level}, or restructure the document outline so no levels are skipped.`
            );
            nodeViolations++;
          }
          lastHeadingLevel = level;
        }
      }

      // ── 2.4.4 — Links must have meaningful text ────────────────────────────
      if (role === "link") {
        if (!trimmedName) {
          push(
            "2.4.6-link-label", node, role, name,
            "Link has no accessible name.",
            "Add descriptive text content to the <a> element, or use aria-label / aria-labelledby to provide a name that describes the link destination."
          );
          nodeViolations++;
        } else if (GENERIC_LINK_TEXTS.has(trimmedName.toLowerCase())) {
          push(
            "2.4.4-link-purpose", node, role, name,
            `Link text "${trimmedName}" is ambiguous out of context.`,
            `Replace or augment the link text to describe the destination. Use aria-label to add context, e.g. aria-label="Read more about pricing". Avoid generic phrases like "click here" or "read more".`
          );
          nodeViolations++;
        }
      }

      // ── 2.4.6 — Buttons must have an accessible name ───────────────────────
      if (role === "button" && !trimmedName) {
        push(
          "2.4.6-button-label", node, role, name,
          "Button has no accessible name.",
          "Add visible text content inside the <button>, or use aria-label for icon-only buttons. If using an icon, add a visually-hidden <span> or aria-label describing the action."
        );
        nodeViolations++;
      }

      // ── 4.1.2 — ARIA widget roles must have required state attributes ───────
      for (const [prop, requiredByRoles] of Object.entries(ARIA_REQUIRED)) {
        if (requiredByRoles.includes(role) && props[prop] === undefined) {
          push(
            "4.1.2-aria-required-attr", node, role, name,
            `Element with role="${role}" is missing required ARIA state: ${prop}.`,
            `Add the ${prop === "checked" ? "aria-checked" : prop === "expanded" ? "aria-expanded" : "aria-valuenow"} attribute to satisfy the WAI-ARIA spec for role="${role}". Update it dynamically to reflect the current widget state.`
          );
          nodeViolations++;
        }
      }

      // ── 4.1.3 — Disabled controls must still have an accessible name ────────
      if (props["disabled"] === true && (role === "button" || role === "textbox" || role === "combobox") && !trimmedName) {
        push(
          "4.1.3-disabled-label", node, role, name,
          `Disabled ${role} has no accessible name.`,
          "Screen readers still announce disabled elements. Add an aria-label or aria-labelledby so users understand what the control is for even when disabled."
        );
        nodeViolations++;
      }

      if (nodeViolations === 0) passes++;
    }

    // ── Aggregate results ───────────────────────────────────────────────────

    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const byPrinciple: Record<A11yWcagPrinciple, number> = {
      perceivable: 0, operable: 0, understandable: 0, robust: 0,
    };
    const ruleViolationCounts: Record<string, number> = {};

    for (const v of violations) {
      counts[v.impact]++;
      byPrinciple[v.principle]++;
      ruleViolationCounts[v.rule] = (ruleViolationCounts[v.rule] ?? 0) + 1;
    }

    // Score: start at 100, deduct weighted penalty capped per tier
    const penalty =
      Math.min(counts.critical * 8,  48) +
      Math.min(counts.serious  * 4,  32) +
      Math.min(counts.moderate * 2,  12) +
      Math.min(counts.minor    * 1,   5);
    const score = Math.max(0, 100 - penalty);

    // Deduplicated rule summaries, sorted by severity then count
    const severityOrder: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const violatedRules: A11yRuleSummary[] = Object.entries(ruleViolationCounts)
      .map(([ruleId, count]): A11yRuleSummary => {
        const meta = RULES[ruleId];
        return {
          ruleId,
          wcagCriteria: meta.wcag,
          wcagLevel: meta.level,
          principle: meta.principle,
          impact: meta.impact,
          description: meta.title,
          count,
        };
      })
      .sort((a, b) =>
        severityOrder[a.impact] - severityOrder[b.impact] ||
        b.count - a.count
      );

    // Top-priority plain-English recommendations (deduplicated, ordered by impact)
    const recommendations: string[] = [];
    const seen = new Set<string>();
    for (const r of violatedRules) {
      if (seen.has(r.ruleId)) continue;
      seen.add(r.ruleId);
      switch (r.ruleId) {
        case "1.1.1-image-alt":
          recommendations.push(`Add descriptive alt text to ${r.count} image${r.count > 1 ? "s" : ""}. Use alt="" for purely decorative images.`);
          break;
        case "1.3.1-input-label":
          recommendations.push(`Label ${r.count} form input${r.count > 1 ? "s" : ""} using <label for="…">, aria-label, or aria-labelledby.`);
          break;
        case "1.3.1-table-header":
          recommendations.push(`Add descriptive text to ${r.count} empty table header cell${r.count > 1 ? "s" : ""}.`);
          break;
        case "2.1.1-interactive-label":
          recommendations.push(`Ensure all ${r.count} interactive element${r.count > 1 ? "s" : ""} are keyboard-operable (Tab / Enter / Space).`);
          break;
        case "2.4.2-page-title":
          recommendations.push("Add a meaningful <title> element that describes the page's content or current view.");
          break;
        case "2.4.3-heading-order":
          recommendations.push(`Fix ${r.count} heading level skip${r.count > 1 ? "s" : ""} — use consecutive h1→h2→h3 levels without gaps.`);
          break;
        case "2.4.4-link-purpose":
          recommendations.push(`Replace ${r.count} generic link text${r.count > 1 ? "s" : ""} ("click here", "read more") with descriptive labels.`);
          break;
        case "2.4.6-button-label":
          recommendations.push(`Name ${r.count} unlabelled button${r.count > 1 ? "s" : ""}. Use visible text or aria-label for icon-only buttons.`);
          break;
        case "2.4.6-link-label":
          recommendations.push(`Add accessible names to ${r.count} link${r.count > 1 ? "s" : ""} that currently have no text.`);
          break;
        case "3.1.1-page-lang":
          recommendations.push('Set the page language on the <html> element (e.g. <html lang="en">) so screen readers use the correct pronunciation engine.');
          break;
        case "4.1.2-aria-required-attr":
          recommendations.push(`Add missing ARIA state attributes to ${r.count} widget${r.count > 1 ? "s" : ""} (aria-checked, aria-expanded, aria-valuenow as appropriate).`);
          break;
        case "4.1.3-disabled-label":
          recommendations.push(`Add accessible names to ${r.count} disabled control${r.count > 1 ? "s" : ""} so screen readers can still identify them.`);
          break;
      }
    }

    if (counts.critical === 0 && counts.serious === 0 && violations.length === 0) {
      recommendations.push("No violations detected. Use the element style inspector for text contrast (WCAG 1.4.3), then manually review focus-visible styling (WCAG 2.4.7) and motion sensitivity (WCAG 2.3.3).");
    } else if (counts.critical > 0 || counts.serious > 0) {
      recommendations.push("Prioritise critical and serious violations first — they block access for screen reader and keyboard-only users.");
    }

    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      score,
      violations,
      violationCounts: counts,
      byPrinciple,
      violatedRules,
      recommendations,
      passes,
      nodeCount: nodes.length,
    };
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
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    this.ensureDebugger(webContents);

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(function() {
        function truncate(v) {
          var s = String(v);
          return s.length > 80 ? s.slice(0, 77) + '...' : s;
        }
        function safeProps(p) {
          if (!p || typeof p !== 'object') return {};
          var out = {};
          try {
            for (var k in p) {
              if (Object.prototype.hasOwnProperty.call(p, k)) {
                var t = typeof p[k];
                if (t === 'function') out[k] = '[function]';
                else if (t === 'object' && p[k] !== null) out[k] = '[object]';
                else out[k] = truncate(p[k]);
              }
            }
          } catch(e) { out['_err'] = 'failed'; }
          return out;
        }

        // React 18+ __reactFiber / React 16-17 __reactInternalInstance
        function buildReactTree(fiber, depth) {
          if (!fiber || depth > 30) return null;
          var name = null;
          var t = fiber.type;
          if (typeof t === 'function') name = t.displayName || t.name || null;
          else if (typeof t === 'string') name = t;
          if (!name || name.length === 0) {
            return buildReactTree(fiber.child, depth + 1);
          }
          var src = fiber._debugSource;
          var node = { name: name, props: safeProps(fiber.memoizedProps), children: [] };
          if (src && src.fileName) node.source = src.fileName + ':' + src.lineNumber;
          var child = fiber.child;
          while (child) {
            var childNode = buildReactTree(child, depth + 1);
            if (childNode) node.children.push(childNode);
            child = child.sibling;
          }
          return node;
        }

        // Vue 3: __vue_app__ on #app or body
        function buildVue3Tree(vnode, depth) {
          if (!vnode || depth > 30) return null;
          var name = vnode.type && (vnode.type.__name || vnode.type.name || vnode.type) || 'Anonymous';
          if (typeof name !== 'string') name = String(name);
          var node = { name: name, props: safeProps(vnode.props), children: [] };
          if (vnode.type && vnode.type.__file) node.source = vnode.type.__file;
          var children = vnode.component && vnode.component.subTree
            ? [vnode.component.subTree] : (vnode.children ? [].concat(vnode.children) : []);
          for (var c of children) {
            var cn = buildVue3Tree(c, depth + 1);
            if (cn) node.children.push(cn);
          }
          return node;
        }

        // Svelte: window.__svelte__
        function buildSvelteTree() {
          var comps = window.__svelte__ ? Object.keys(window.__svelte__) : [];
          if (!comps.length) return null;
          return { name: 'SvelteRoot', props: {}, children: comps.map(function(k) {
            return { name: k, props: {}, children: [] };
          })};
        }

        // Detect and build
        var framework = 'unknown', tree = null, count = 0;

        // React: walk DOM looking for __reactFiber
        var roots = document.querySelectorAll('[data-reactroot], #root, #app, body > div');
        for (var el of roots) {
          var fiberKey = Object.keys(el).find(function(k) {
            return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
          });
          if (fiberKey) {
            framework = 'react';
            tree = buildReactTree(el[fiberKey], 0);
            break;
          }
        }

        // Vue 3
        if (!tree) {
          var vueRoot = document.querySelector('#app') || document.querySelector('[data-v-app]');
          if (vueRoot && vueRoot.__vue_app__) {
            framework = 'vue';
            var vnode = vueRoot.__vue_app__._context && vueRoot.__vue_app__._context.app
              ? vueRoot.__vue_app__._instance && vueRoot.__vue_app__._instance.subTree : null;
            tree = buildVue3Tree(vueRoot.__vue_app__._instance && vueRoot.__vue_app__._instance.subTree, 0);
          }
        }

        // Vue 2
        if (!tree) {
          var vue2Root = document.querySelector('#app');
          if (vue2Root && vue2Root.__vue__) {
            framework = 'vue';
            var vm = vue2Root.__vue__;
            tree = { name: vm.$options.name || 'App', props: safeProps(vm.$props), children: [] };
          }
        }

        // Svelte
        if (!tree) {
          var svelteTree = buildSvelteTree();
          if (svelteTree) { framework = 'svelte'; tree = svelteTree; }
        }

        function countNodes(n) {
          if (!n) return 0;
          return 1 + n.children.reduce(function(s, c) { return s + countNodes(c); }, 0);
        }

        return { framework: framework, tree: tree, nodeCount: countNodes(tree) };
      })()`,
      returnByValue: true
    }) as { result: { value: { framework: string; tree: unknown; nodeCount: number } } };

    const val = result.result.value;
    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      framework: (val.framework as import("../../../../packages/shared/src/index.js").ComponentFramework),
      tree: val.tree as import("../../../../packages/shared/src/index.js").ComponentNode | null,
      nodeCount: val.nodeCount ?? 0
    };
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
    await this.applyResourceBudget(tab);
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
    await this.applyLocationOverride(tab);
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
    await this.applyMediaEmulation(tab);
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

  private async applyMediaEmulation(tab: TabRecord): Promise<void> {
    const emulation = tab.mediaEmulation;
    if (!emulation) return;

    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    const features: Array<{ name: string; value: string }> = [];
    if (emulation.colorScheme) features.push({ name: "prefers-color-scheme", value: emulation.colorScheme });
    if (emulation.reducedMotion) features.push({ name: "prefers-reduced-motion", value: emulation.reducedMotion });
    if (emulation.forcedColors) features.push({ name: "forced-colors", value: emulation.forcedColors });

    await webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
      media: emulation.media ?? "",
      features
    }).catch(() => {});
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
    const packet = await this.capabilityRegistry.buildPerceptionPacket(tabId, tab.lastObservation, result, tab.view.webContents);
    return {
      ...packet,
      sitePatterns: this.sitePatterns.get(originFromUrl(result.graph.url))
    };
  }

  async listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]> {
    const tab = this.requireTab(tabId);
    const result = await this.capturePerception(tabId);
    return this.capabilityRegistry.listCapabilityManifests(tabId, result, tab.view.webContents);
  }

  async executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult> {
    const tab = this.requireTab(tabId);
    const budgetBlock = await this.checkResourceBudget(tab);
    if (budgetBlock) {
      this.recordCommand(tab, "command", command, "blocked");
      return budgetBlock;
    }
    const result = await this.capturePerception(tabId);
    const execution = await this.capabilityRegistry.executeCommand(tabId, command, tab.lastObservation, result, tab.view.webContents);
    this.recordCommand(tab, "command", command, execution.status);

    if (execution.status !== "completed") {
      return execution;
    }

    await waitForPageSettled(tab.view.webContents);

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
      const execution = await this.capabilityRegistry.approveCommand(requestId, tab.lastObservation, result, tab.view.webContents);

      if (execution.status === "completed") {
        await waitForPageSettled(tab.view.webContents);
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

  private async applyResourceBudget(tab: TabRecord): Promise<void> {
    const budget = tab.resourceBudget;
    if (!budget) return;

    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    await webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", {
      rate: Math.max(1, budget.cpuThrottlingRate ?? 1)
    }).catch(() => {});

    await webContents.debugger.sendCommand("Network.emulateNetworkConditions", {
      offline: budget.offline ?? false,
      latency: budget.latencyMs ?? 0,
      downloadThroughput: budget.downloadThroughputKbps ? budget.downloadThroughputKbps * 1024 / 8 : -1,
      uploadThroughput: budget.uploadThroughputKbps ? budget.uploadThroughputKbps * 1024 / 8 : -1
    }).catch(() => {});
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

  private async applyLocationOverride(tab: TabRecord): Promise<void> {
    const location = tab.locationOverride;
    if (!location) return;

    const { webContents } = tab.view;
    this.ensureDebugger(webContents);

    await webContents.debugger.sendCommand("Emulation.setGeolocationOverride", {
      latitude: location.latitude,
      longitude: location.longitude,
      accuracy: location.accuracy ?? 1
    }).catch(() => {});

    if (location.timezoneId) {
      await webContents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: location.timezoneId }).catch(() => {});
    }

    if (location.locale) {
      await webContents.debugger.sendCommand("Emulation.setLocaleOverride", { locale: location.locale }).catch(() => {});
    }
  }

  private bindLifecycle(tab: TabRecord) {
    const { webContents } = tab.view;

    // Route CDP messages to the log/mock handler (bound once; safe before debugger attach).
    webContents.debugger.on("message", (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
      this.handleCdpMessage(tab, method, params);
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
      void this.applyLocationOverride(tab);
      void this.applyResourceBudget(tab);
      void this.applyMediaEmulation(tab);
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

  private handleCdpMessage(tab: TabRecord, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Log.entryAdded": {
        const entry = params.entry as Record<string, unknown> | undefined;
        if (!entry) break;
        const rawLevel = (entry.level as string) ?? "log";
        const level: ConsoleLogLevel = ["log", "info", "warn", "error", "debug"].includes(rawLevel)
          ? rawLevel as ConsoleLogLevel
          : "log";
        tab.consoleLogs.push({
          level,
          text: (entry.text as string) ?? "",
          url: entry.url as string | undefined,
          lineNumber: entry.lineNumber as number | undefined,
          timestamp: (entry.timestamp as number) ?? Date.now()
        });
        break;
      }

      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails as Record<string, unknown> | undefined;
        if (!details) break;
        const exception = details.exception as Record<string, unknown> | undefined;
        const text = (exception?.description as string)
          ?? (details.text as string)
          ?? "Uncaught exception";
        tab.jsErrors.push(text);
        break;
      }

      case "Network.requestWillBeSent": {
        const requestId = params.requestId as string | undefined;
        const request = params.request as Record<string, unknown> | undefined;
        if (!requestId || !request) break;
        const rawReqHeaders = request.headers as Record<string, unknown> | undefined;
        const requestHeaders: Record<string, string> | undefined = rawReqHeaders
          ? Object.fromEntries(
              Object.entries(rawReqHeaders).map(([k, v]) => [k, String(v)])
            )
          : undefined;
        tab.networkRequests.set(requestId, {
          requestId,
          url: (request.url as string) ?? "",
          method: (request.method as string) ?? "GET",
          failed: false,
          timestamp: (params.timestamp as number) ?? Date.now(),
          requestHeaders
        });
        break;
      }

      case "Network.responseReceived": {
        const requestId = params.requestId as string | undefined;
        const response = params.response as Record<string, unknown> | undefined;
        if (!requestId || !response) break;
        const existing = tab.networkRequests.get(requestId);
        if (existing) {
          existing.statusCode = response.status as number | undefined;
          existing.statusText = response.statusText as string | undefined;
          existing.mimeType   = response.mimeType   as string | undefined;
          existing.fromDiskCache    = (response.fromDiskCache    as boolean | undefined) ?? false;
          existing.fromServiceWorker = (response.fromServiceWorker as boolean | undefined) ?? false;

          const rawHeaders = response.headers as Record<string, unknown> | undefined;
          if (rawHeaders) {
            existing.responseHeaders = Object.fromEntries(
              Object.entries(rawHeaders).map(([k, v]) => [k, String(v)])
            );
          }

          const sd = response.securityDetails as Record<string, unknown> | undefined;
          if (sd) {
            existing.securityDetails = {
              protocol:    (sd.protocol    as string) ?? "",
              keyExchange: (sd.keyExchange as string) ?? "",
              cipher:      (sd.cipher      as string) ?? "",
              subjectName: (sd.subjectName as string) ?? "",
              issuer:      (sd.issuer      as string) ?? "",
              validFrom:   (sd.validFrom   as number) ?? 0,
              validTo:     (sd.validTo     as number) ?? 0,
              sanList:     Array.isArray(sd.sanList) ? (sd.sanList as string[]) : []
            };
          }
        }
        break;
      }

      case "Network.loadingFailed": {
        const requestId = params.requestId as string | undefined;
        if (!requestId) break;
        const existing = tab.networkRequests.get(requestId);
        if (existing) {
          existing.failed    = true;
          existing.errorText = params.errorText as string | undefined;
        }
        break;
      }

      case "Network.webSocketCreated": {
        const requestId = params.requestId as string | undefined;
        const url = params.url as string | undefined;
        if (!requestId) break;
        if (url) {
          tab.webSocketUrls.set(requestId, url);
        }
        tab.webSocketFrames.push({
          requestId,
          url,
          direction: "opened",
          payload: "",
          timestamp: Date.now()
        });
        break;
      }

      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived": {
        const requestId = params.requestId as string | undefined;
        const response = params.response as Record<string, unknown> | undefined;
        if (!requestId || !response) break;
        tab.webSocketFrames.push({
          requestId,
          url: tab.webSocketUrls.get(requestId),
          direction: method.endsWith("Sent") ? "sent" : "received",
          opcode: response.opcode as number | undefined,
          payload: String(response.payloadData ?? ""),
          timestamp: Date.now()
        });
        break;
      }

      case "Network.webSocketClosed": {
        const requestId = params.requestId as string | undefined;
        if (!requestId) break;
        tab.webSocketFrames.push({
          requestId,
          url: tab.webSocketUrls.get(requestId),
          direction: "closed",
          payload: "",
          timestamp: Date.now()
        });
        break;
      }

      case "Network.eventSourceMessageReceived": {
        const requestId = params.requestId as string | undefined;
        if (!requestId) break;
        tab.eventSourceEvents.push({
          requestId,
          url: String(params.url ?? ""),
          eventName: String(params.eventName ?? "message"),
          eventId: String(params.eventId ?? ""),
          data: String(params.data ?? ""),
          timestamp: Date.now()
        });
        break;
      }

      case "Fetch.requestPaused": {
        const requestId = params.requestId as string | undefined;
        const request   = params.request   as Record<string, unknown> | undefined;
        if (!requestId) break;

        if (!tab.networkMockRules || !request) {
          // Fetch domain enabled but no rules active — pass through.
          void tab.view.webContents.debugger
            .sendCommand("Fetch.continueRequest", { requestId })
            .catch(() => {});
          break;
        }

        const url           = (request.url    as string) ?? "";
        const requestMethod = (request.method as string) ?? "GET";
        const matched = tab.networkMockRules.find(rule => matchesMockRule(url, requestMethod, rule));

        if (matched) {
          const body = matched.responseBody !== undefined
            ? (typeof matched.responseBody === "string"
              ? matched.responseBody
              : JSON.stringify(matched.responseBody))
            : "";
          const headers = Object.entries({
            "Content-Type": (typeof matched.responseBody === "object" && matched.responseBody !== null)
              ? "application/json"
              : "text/plain",
            ...matched.responseHeaders
          }).map(([name, value]) => ({ name, value }));

          void tab.view.webContents.debugger
            .sendCommand("Fetch.fulfillRequest", {
              requestId,
              responseCode: matched.responseStatus ?? 200,
              responseHeaders: headers,
              body: Buffer.from(body).toString("base64")
            })
            .catch(() => {});
        } else {
          void tab.view.webContents.debugger
            .sendCommand("Fetch.continueRequest", { requestId })
            .catch(() => {});
        }
        break;
      }
    }
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

  /** Require the tab and ensure its CDP debugger is attached; returns its WebContents. */
  private debuggerFor(tabId: TabId): Electron.WebContents {
    const webContents = this.requireTab(tabId).view.webContents;
    this.ensureDebugger(webContents);
    return webContents;
  }

  private emitTabsChanged() {
    const tabs = this.listTabs();
    for (const listener of this.listeners) {
      listener(tabs);
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────



function renderRecordingScript(recording: RecordingSession): string {
  const lines = [
    'import { createBrowserClient } from "@helmstack/agent-sdk";',
    "",
    "const browser = createBrowserClient();",
    `const tabId = ${JSON.stringify(recording.tabId)};`,
    "",
    "async function run() {"
  ];

  for (const entry of recording.commands) {
    if (entry.source === "navigate") {
      const navigate = entry.command as { url?: string };
      lines.push(`  await browser.navigate(tabId, ${JSON.stringify(navigate.url ?? "")});`);
      continue;
    }
    lines.push(`  await browser.execute(tabId, ${JSON.stringify(entry.command, null, 2).replace(/\n/g, "\n  ")});`);
  }

  lines.push("}");
  lines.push("");
  lines.push("run().catch((error) => {");
  lines.push("  console.error(error);");
  lines.push("  process.exitCode = 1;");
  lines.push("});");
  return lines.join("\n");
}

function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

/**
 * Given a flat Uint8Array of changed-pixel flags (1 = changed, indexed row-major)
 * and image dimensions, returns merged axis-aligned bounding boxes of changed clusters.
 * Pixels within MERGE_GAP pixels of an existing box are absorbed into it.
 */
/**
 * Build a boolean pixel mask (1 = ignore) from a set of rectangles. Used to
 * exclude dynamic regions (timestamps, ads, carousels) from a visual diff.
 * Pure — unit-testable.
 */
export function buildIgnoreMask(regions: DiffRegion[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.floor(r.x + r.width));
    const y1 = Math.min(height, Math.floor(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

export function computeDiffRegions(changed: Uint8Array, width: number, height: number): DiffRegion[] {
  const MERGE_GAP = 8;
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!changed[y * width + x]) continue;

      // Find an existing box to absorb this pixel into (within MERGE_GAP).
      let merged = false;
      for (const box of boxes) {
        if (
          x >= box.x1 - MERGE_GAP && x <= box.x2 + MERGE_GAP &&
          y >= box.y1 - MERGE_GAP && y <= box.y2 + MERGE_GAP
        ) {
          box.x1 = Math.min(box.x1, x);
          box.y1 = Math.min(box.y1, y);
          box.x2 = Math.max(box.x2, x);
          box.y2 = Math.max(box.y2, y);
          merged = true;
          break;
        }
      }
      if (!merged) boxes.push({ x1: x, y1: y, x2: x, y2: y });
    }
  }

  return boxes.map(b => ({ x: b.x1, y: b.y1, width: b.x2 - b.x1 + 1, height: b.y2 - b.y1 + 1 }));
}

/**
 * Returns true if url and method satisfy the given NetworkInterceptRule.
 * urlPattern supports:
 *   - star wildcard anywhere (e.g. "star/api/products*")
 *   - /regex/flags literal regex (e.g. /\/api\/v\d+\//i)
 */
export function matchesMockRule(url: string, method: string, rule: NetworkInterceptRule): boolean {
  if (rule.method && rule.method.toUpperCase() !== method.toUpperCase()) return false;

  const pattern = rule.urlPattern;

  // Regex syntax: /pattern/flags
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2] ?? "").test(url);
    } catch {
      return false;
    }
  }

  // Glob: escape regex special chars then replace * with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

/**
 * Pure structural diff of two perception graph snapshots.
 * Operates on PageGraph fields: headings, forms, actions, alerts, title, kind, media.
 */
export function computePerceptionDiff(
  beforeId: string,
  afterId: string,
  before: { graph: PageGraph; url: string; title: string; capturedAt: number },
  after:  { graph: PageGraph; url: string; title: string; capturedAt: number }
): import("../../../../packages/shared/src/index.js").PerceptionDiff {
  const changes: import("../../../../packages/shared/src/index.js").PerceptionChange[] = [];

  const bg = before.graph;
  const ag = after.graph;

  // Title change
  if (bg.title !== ag.title) {
    changes.push({ kind: "title_changed", description: `Page title changed`, before: bg.title, after: ag.title });
  }

  // Page kind change
  if (bg.kind !== ag.kind) {
    changes.push({ kind: "page_kind_changed", description: `Page kind changed from "${bg.kind}" to "${ag.kind}"`, before: bg.kind, after: ag.kind });
  }

  // Headings diff
  const beforeHeadings = new Set(bg.headings);
  const afterHeadings  = new Set(ag.headings);
  for (const h of bg.headings) {
    if (!afterHeadings.has(h)) changes.push({ kind: "heading_removed", description: `Heading removed: "${h}"` });
  }
  for (const h of ag.headings) {
    if (!beforeHeadings.has(h)) changes.push({ kind: "heading_added", description: `Heading added: "${h}"` });
  }

  // Forms diff — match by id, then name, then index
  const beforeForms = new Map(bg.forms.map(f => [f.id, f]));
  const afterForms  = new Map(ag.forms.map(f => [f.id, f]));
  const allFormIds = new Set([...beforeForms.keys(), ...afterForms.keys()]);
  for (const id of allFormIds) {
    const bf = beforeForms.get(id);
    const af = afterForms.get(id);
    if (bf && !af) {
      changes.push({ kind: "form_removed", description: `Form removed: "${bf.name ?? bf.purpose}" (${bf.fields.length} fields)` });
    } else if (!bf && af) {
      changes.push({ kind: "form_added", description: `Form added: "${af.name ?? af.purpose}" (${af.fields.length} fields)` });
    } else if (bf && af) {
      const bFieldIds = new Set(bf.fields.map(f => f.id));
      const aFieldIds = new Set(af.fields.map(f => f.id));
      const removedFields = bf.fields.filter(f => !aFieldIds.has(f.id)).map(f => f.label);
      const addedFields   = af.fields.filter(f => !bFieldIds.has(f.id)).map(f => f.label);
      if (removedFields.length || addedFields.length) {
        const parts: string[] = [];
        if (removedFields.length) parts.push(`removed fields: ${removedFields.join(", ")}`);
        if (addedFields.length)   parts.push(`added fields: ${addedFields.join(", ")}`);
        changes.push({ kind: "form_changed", description: `Form "${af.name ?? af.purpose}" changed — ${parts.join("; ")}` });
      }
    }
  }

  // Actions diff — match by label+kind key
  const actionKey = (a: { label: string; kind: string }) => `${a.kind}::${a.label}`;
  const beforeActions = new Set(bg.actions.map(actionKey));
  const afterActions  = new Set(ag.actions.map(actionKey));
  for (const a of bg.actions) {
    if (!afterActions.has(actionKey(a))) changes.push({ kind: "action_removed", description: `Action removed: "${a.label}" (${a.kind})` });
  }
  for (const a of ag.actions) {
    if (!beforeActions.has(actionKey(a))) changes.push({ kind: "action_added", description: `Action added: "${a.label}" (${a.kind})` });
  }

  // Alerts diff
  const beforeAlerts = new Set(bg.alerts);
  const afterAlerts  = new Set(ag.alerts);
  for (const al of bg.alerts) {
    if (!afterAlerts.has(al))  changes.push({ kind: "alert_removed", description: `Alert removed: "${al}"` });
  }
  for (const al of ag.alerts) {
    if (!beforeAlerts.has(al)) changes.push({ kind: "alert_added",   description: `Alert added: "${al}"` });
  }

  // Media diff (by src/url key)
  const mediaKey = (m: { src?: string; alt?: string }) => m.src ?? m.alt ?? "";
  const beforeMedia = new Set(bg.media.map(mediaKey));
  const afterMedia  = new Set(ag.media.map(mediaKey));
  for (const m of bg.media) {
    if (!afterMedia.has(mediaKey(m)))  changes.push({ kind: "media_removed", description: `Media removed: ${mediaKey(m) || "(unknown)"}` });
  }
  for (const m of ag.media) {
    if (!beforeMedia.has(mediaKey(m))) changes.push({ kind: "media_added",   description: `Media added: ${mediaKey(m) || "(unknown)"}` });
  }

  // Build summary
  let summary: string;
  if (changes.length === 0) {
    summary = "No structural changes detected.";
  } else {
    const counts: Record<string, number> = {};
    for (const c of changes) {
      const group = c.kind.replace(/_added|_removed|_changed/, "");
      counts[group] = (counts[group] ?? 0) + 1;
    }
    const parts = Object.entries(counts).map(([g, n]) => `${n} ${g}${n > 1 ? "s" : ""} changed`);
    summary = parts.join(", ") + ".";
  }

  return {
    beforeId, afterId,
    beforeUrl: before.url, afterUrl: after.url,
    capturedAt: Date.now(),
    changes,
    summary,
    identical: changes.length === 0
  };
}

// evaluateAssertionAgainstGraph (module-level)

/**
 * Pure, synchronous heuristic evaluator.  Takes a pre-captured `PageGraph`
 * and a free-text assertion and returns an `AssertionResult`.
 *
 * Strategy (in order of confidence):
 *  1. Quantitative  "N items/results/errors/buttons/fields/forms/links"patterns 
 *  2. Absence  "no X", "not visible", "does not exist"patterns 
 *  3. Presence  label/text appears in actions/headings/alerts/formspatterns 
 *  4. Title / URL exact or contains checks
 *  5. Disabled-state  "X is disabled / enabled"checks 
 *  6. Count  "at least N", "more than N", "fewer than N"comparisons 
 *  7.  low-confidence pass/fail based on keyword scanFallback 
 */
export function evaluateAssertionAgainstGraph(
  tabId: TabId,
  assertion: string,
  graph: PageGraph
): AssertionResult {
  const norm = assertion.toLowerCase().trim();

  // Build evidence bundle
  const allFields = graph.forms.flatMap(f => f.fields.map(ff => ff.id ?? ff.label ?? ""));
  const evidence: import("../../../../packages/shared/src/index.js").AssertionEvidence = {
    url: graph.url,
    title: graph.title,
    headings: graph.headings,
    actionLabels: graph.actions.map(a => a.label),
    alertTexts: graph.alerts,
    formSummaries: graph.forms.map(f =>
      `${f.purpose}: ${f.fields.map(ff => ff.id ?? ff.label ?? "field").join(", ")}`
    ),
    counts: {
      headings: graph.headings.length,
      actions: graph.actions.length,
      forms: graph.forms.length,
      alerts: graph.alerts.length,
      fields: allFields.length,
      mediaItems: graph.media.length
    }
  };

  // Helpers
  /** All searchable text on the page as a single lowercase string. */
  const fullText = [
    graph.title,
    ...graph.headings,
    ...graph.actions.map(a => a.label),
    ...graph.alerts,
    ...allFields,
    ...graph.forms.map(f => f.name ?? ""),
    graph.url
  ].join(" ").toLowerCase();

  function pass(explanation: string, confidence: import("../../../../packages/shared/src/index.js").AssertionConfidence = "high"): AssertionResult {
    return { tabId, assertion, pass: true, confidence, explanation, evidence };
  }
  function fail(explanation: string, confidence: import("../../../../packages/shared/src/index.js").AssertionConfidence = "high"): AssertionResult {
    return { tabId, assertion, pass: false, confidence, explanation, evidence };
  }

  // 1. Quantitative: "shows N items / results / " errors
  const qtyMatch = norm.match(/\b(\d+)\s+(item|result|error|warning|button|link|field|form|message|alert|heading|image|video)s?\b/);
  if (qtyMatch) {
    const expected = parseInt(qtyMatch[1], 10);
    const noun = qtyMatch[2];
    const nounCounts: Record<string, number> = {
      item:    graph.actions.length,   // best  no cart-specific fieldproxy 
      result:  graph.headings.length,
      error:   graph.alerts.filter(a => /error|invalid|fail/i.test(a)).length,
      warning: graph.alerts.filter(a => /warn/i.test(a)).length,
      button:  graph.actions.filter(a => a.kind === "button" || a.kind === "submit").length,
      link:    graph.actions.filter(a => a.kind === "link").length,
      field:   allFields.length,
      form:    graph.forms.length,
      message: graph.alerts.length,
      alert:   graph.alerts.length,
      heading: graph.headings.length,
      image:   (graph.accessibility.roleCounts.img ?? 0) + (graph.accessibility.roleCounts.image ?? 0),
      video:   graph.media.filter(m => m.kind === "video").length
    };
    // Also check if the exact number appears in visible text (e.g. "3 items in cart")
    const numInText = fullText.includes(String(expected)) && fullText.includes(noun);
    const actual = nounCounts[noun] ?? 0;
    if (numInText) {
      return pass(`The text "${expected} ${noun}" was found on the page.`);
    }
    if (actual === expected) {
      return pass(`Found exactly ${actual} ${noun}(s) matches expected ${expected}.`);
    }
    if (Math.abs(actual - expected) <= 1) {
      return fail(`Expected ${expected} ${noun}(s) but found ${actual}, close but not matching.`, "medium");
    }
    return fail(`Expected ${expected} ${noun}(s) but found ${actual}.`);
  }

  // 2. Absence: "no X", "not visible", "does not exist", "hidden"
  const absenceMatch = norm.match(/\b(no |not |doesn't |does not |isn't |is not |never |hidden |absent )([\w\s]{2,40})/);
  if (absenceMatch) {
    const subject = absenceMatch[2].trim();
    const found = fullText.includes(subject);
    if (!found) {
      return pass(`"${subject}" was not found on the page, absence confirmed.`);
    }
    return fail(`"${subject}" was found on the page but the assertion expects it to be absent.`);
  }

  // 3. Disabled / enabled state
  const disabledMatch = norm.match(/\b([\w\s]{2,30})\s+is\s+(disabled|enabled|clickable|active|inactive)\b/);
  if (disabledMatch) {
    const label = disabledMatch[1].trim();
    const state = disabledMatch[2];
    const action = graph.actions.find(a => a.label.toLowerCase().includes(label));
    if (!action) {
      return fail(`Could not find an action with label matching "${label}".`, "medium");
    }
    const expectDisabled = state === "disabled" || state === "inactive";
    if (action.disabled === expectDisabled) {
      return pass(`Action "${action.label}" is ${state} as expected.`);
    }
    return fail(`Action "${action.label}" is ${action.disabled ? "disabled" : "enabled"} but assertion expects ${state}.`);
  }

  // 4. Title assertion
  if (norm.includes("title") || norm.includes("page is") || norm.includes("page title")) {
    const quoted = norm.match(/["']([^"']+)["']/);
    const titleLower = graph.title.toLowerCase();
    if (quoted) {
      const q = quoted[1].toLowerCase();
      if (titleLower.includes(q)) return pass(`Page title "${graph.title}" contains "${quoted[1]}".`);
      return fail(`Page title is "${graph.title}" does not contain "${quoted[1]}".`);
    }
    // No quote, just check that title is non-empty
    if (graph.title.trim()) return pass(`Page title is "${graph.title}".`, "medium");
    return fail("Page has no title.", "medium");
  }

  // 5. At-least / more-than / fewer-than
  const compMatch = norm.match(/\b(at least|more than|fewer than|less than|at most)\s+(\d+)\s+([\w]+)s?\b/);
  if (compMatch) {
    const op = compMatch[1];
    const n = parseInt(compMatch[2], 10);
    const noun = compMatch[3];
    const count = evidence.counts[noun as keyof typeof evidence.counts] ?? 0;
    const ok = (op === "at least" || op === "more than")
      ? (op === "at least" ? count >= n : count > n)
      : (op === "at most" ? count <= n : count < n);
    if (ok) return pass(`There are ${count} ${noun}(s) that satisfy "${op} ${n}".`);
    return fail(`There are ${count} ${noun}(s) that do not satisfy "${op} ${n}".`);
  }

  // 6. Presence: label/text appears anywhere
  // Strip common filler words to get the core subject
  const stripped = norm
    .replace(/\b(the|a|an|is|are|shows?|displays?|contains?|has|have|visible|present|exists?|on the page)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (stripped.length >= 3) {
    if (fullText.includes(stripped)) {
      return pass(`"${stripped}" was found in the page content.`, "medium");
    }
    // Try word-by-word: all significant words present?
    const words = stripped.split(" ").filter(w => w.length > 2);
    const allPresent = words.length > 0 && words.every(w => fullText.includes(w));
    if (allPresent) {
      return pass(`All key terms (${words.join(", ")}) were found on the page.`, "medium");
    }
    const anyPresent = words.some(w => fullText.includes(w));
    if (!anyPresent) {
      return fail(`None of the key terms (${words.join(", ")}) were found on the page.`, "low");
    }
    return fail(`Only some key terms were found. Assertion may not hold. Review evidence.`, "low");
  }

  // 7. Fallback
  return {
    tabId, assertion, pass: false,
    confidence: "low",
    explanation: "Could not determine truth of assertion from page graph alone. Provide the evidence bundle to an LLM for a second opinion.",
    evidence
  };
}
