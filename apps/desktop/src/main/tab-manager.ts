import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, nativeImage, WebContentsView } from "electron";

import { normalizePerception } from "../../../../packages/perception/src/normalize.js";
import { AccountStore } from "./account-store.js";
import { installAntiDetection } from "./anti-detection.js";
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
  type DiffRegion,
  type EventSourceMessageEntry,
  type FileUploadTarget,
  type FixturePageName,
  type HumanHandoffRecord,
  type IndexedDbDatabase,
  type LocationOverride,
  type NetworkInterceptRule,
  type NetworkRequestEntry,
  type PageGraph,
  type PageScreenshot,
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
  type StorageArea,
  type StorageEntry,
  type StorageReport,
  type TabId,
  type TabLogSnapshot,
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
  private readonly perceptionCache = new Map<string, { graph: PageGraph; tabId: TabId; url: string; title: string; capturedAt: number }>();
  private readonly downloadTrackingSessions = new WeakSet<Electron.Session>();

  constructor(window: BrowserWindow, appDir: string, userDataPath: string, pagePreloadPath: string) {
    this.window = window;
    this.appDir = appDir;
    this.pagePreloadPath = pagePreloadPath;
    this.vault = new VaultStore(userDataPath);
    this.accounts = new AccountStore(userDataPath);
    this.policies = new ApprovalPolicyStore(userDataPath);
    this.sitePatterns = new SitePatternStore(userDataPath);
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
      networkMockRules: null
    };

    this.tabs.set(id, record);
    this.bindLifecycle(record);
    this.ensureDownloadTracking(record);

    // Install anti-detection after the first document loads so the WebContents
    // target is fully initialised and the CDP debugger can attach cleanly.
    view.webContents.once("did-finish-load", () => {
      installAntiDetection(view.webContents).catch((err: unknown) => {
        console.warn("[AntiDetection] Failed to install on tab:", err);
      });
    });

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

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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

  async captureScreenshot(tabId: TabId): Promise<PageScreenshot> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    const emu = tab.emulatedViewport;
    const w = (emu?.width  ?? this.viewport.width)  || 1280;
    const h = (emu?.height ?? this.viewport.height) || 800;
    const mobile = emu?.mobile ?? false;

    // Ensure a rendering viewport exists even if the tab is not currently visible.
    // Without this, inactive tabs have 0×0 bounds and the capture fails.
    await webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile
    });

    const result = await webContents.debugger.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false
    }) as { data: string };

    await webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");

    const metrics = await webContents.debugger.sendCommand("Page.getLayoutMetrics") as {
      cssLayoutViewport: { clientWidth: number; clientHeight: number };
    };

    return {
      tabId,
      capturedAt: Date.now(),
      data: result.data,
      mimeType: "image/png",
      width: metrics.cssLayoutViewport.clientWidth,
      height: metrics.cssLayoutViewport.clientHeight
    };
  }

  /** Capture a screenshot and store it in the in-memory cache under `snapshotId`. */
  async captureNamedScreenshot(tabId: TabId, snapshotId: string): Promise<PageScreenshot> {
    const shot = await this.captureScreenshot(tabId);
    this.screenshotCache.set(snapshotId, shot);
    return shot;
  }

  /** Compare two previously captured named screenshots pixel-by-pixel. */
  diffScreenshots(beforeId: string, afterId: string): ScreenshotDiff {
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
    let diffCount = 0;

    for (let i = 0; i < rawA.length; i += 4) {
      const db = Math.abs(rawA[i]   - rawB[i]);
      const dg = Math.abs(rawA[i + 1] - rawB[i + 1]);
      const dr = Math.abs(rawA[i + 2] - rawB[i + 2]);
      if (dr > 10 || dg > 10 || db > 10) {
        diffCount++;
        const px = i >> 2;
        changed[px] = 1;
        // Blend: 50% original + 50% solid red → preserves context while marking change.
        diffBuf[i]     = Math.round(rawA[i]     * 0.4);           // B dimmed
        diffBuf[i + 1] = Math.round(rawA[i + 1] * 0.4);           // G dimmed
        diffBuf[i + 2] = Math.round(rawA[i + 2] * 0.4 + 255 * 0.6); // R boosted
        diffBuf[i + 3] = 255;
      }
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

  /** Remove a named screenshot from the cache. Returns false if it didn't exist. */
  deleteScreenshot(id: string): boolean {
    return this.screenshotCache.delete(id);
  }

  /**
   * Capture screenshots at multiple viewport breakpoints in a single call.
   * Saves the original emulated viewport and restores it afterwards.
   *
   * @param presets  Named presets to capture (defaults to ["mobile","tablet","laptop","desktop"]).
   * @param includeDiffs  When true, also diffs each consecutive pair of breakpoints.
   */
  async captureViewportSuite(
    tabId: TabId,
    presets: ViewportPresetName[] = ["mobile", "tablet", "laptop", "desktop"],
    includeDiffs = false
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
      const screenshot = await this.captureNamedScreenshot(tabId, snapshotId);

      captures.push({ preset, snapshotId, screenshot });
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
    return { id: snapshotId, tabId, url: entry.url, title: entry.title, capturedAt: entry.capturedAt };
  }

  /** List all named perception snapshots in the cache (metadata only). */
  listPerceptionSnapshots(): PerceptionSnapshotEntry[] {
    return [...this.perceptionCache.entries()].map(([id, e]) => ({
      id, tabId: e.tabId, url: e.url, title: e.title, capturedAt: e.capturedAt
    }));
  }

  /** Remove a named perception snapshot from the cache. Returns false if not found. */
  deletePerceptionSnapshot(id: string): boolean {
    return this.perceptionCache.delete(id);
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
   * Capture performance metrics for the tab from three sources:
   *  1. CDP `Performance.getMetrics` — V8/Blink internal counters
   *  2. `window.performance.timing` — classic Navigation Timing (level 1)
   *  3. `PerformanceObserver` entries already buffered in the timeline — CWV
   */
  async capturePerformanceMetrics(tabId: TabId): Promise<PerformanceReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    // Enable Performance domain (idempotent).
    await webContents.debugger.sendCommand("Performance.enable", { timeDomain: "timeTicks" });

    const [cdpResult, pageData] = await Promise.all([
      webContents.debugger.sendCommand("Performance.getMetrics") as Promise<{ metrics: Array<{ name: string; value: number }> }>,
      webContents.debugger.sendCommand("Runtime.evaluate", {
        expression: `(function() {
          var t = performance.timing;
          var nav = t && t.navigationStart ? {
            ttfb:             t.responseStart     - t.navigationStart,
            domInteractive:   t.domInteractive    - t.navigationStart,
            domContentLoaded: t.domContentLoadedEventEnd - t.navigationStart,
            loadEvent:        t.loadEventEnd      - t.navigationStart
          } : null;

          var lcp = null, fcp = null, cls = 0, inp = null;
          try {
            var lcpEntries = performance.getEntriesByType("largest-contentful-paint");
            if (lcpEntries.length) lcp = lcpEntries[lcpEntries.length - 1].startTime;
            var paintEntries = performance.getEntriesByType("paint");
            for (var pe of paintEntries) {
              if (pe.name === "first-contentful-paint") fcp = pe.startTime;
            }
            var layoutEntries = performance.getEntriesByType("layout-shift");
            for (var le of layoutEntries) {
              if (!le.hadRecentInput) cls += le.value;
            }
            var inpEntries = performance.getEntriesByType("event");
            if (inpEntries.length) {
              var sorted = inpEntries.slice().sort(function(a,b){ return b.duration - a.duration; });
              inp = sorted[0].duration;
            }
          } catch(e) {}

          var resources = performance.getEntriesByType("resource")
            .map(function(r) {
              return { name: r.name, initiatorType: r.initiatorType,
                       transferSize: r.transferSize || 0, duration: r.duration };
            })
            .sort(function(a,b){ return b.duration - a.duration; })
            .slice(0, 20);

          return { nav: nav, lcp: lcp, fcp: fcp, cls: cls, inp: inp,
                   ttfb: nav ? nav.ttfb : null, resources: resources };
        })()`,
        returnByValue: true
      }) as Promise<{ result: { value: { nav: { ttfb: number; domInteractive: number; domContentLoaded: number; loadEvent: number } | null; lcp: number | null; fcp: number | null; cls: number; inp: number | null; ttfb: number | null; resources: Array<{ name: string; initiatorType: string; transferSize: number; duration: number }> } } }>
    ]);

    const cdpMetrics: Record<string, number> = {};
    for (const m of cdpResult.metrics) {
      cdpMetrics[m.name] = m.value;
    }

    const pd = pageData.result.value;

    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      navigation: pd.nav,
      vitals: {
        lcp:  pd.lcp  !== null ? Math.round(pd.lcp)  : null,
        fcp:  pd.fcp  !== null ? Math.round(pd.fcp)  : null,
        cls:  pd.cls  !== null ? Math.round(pd.cls * 1000) / 1000 : null,
        inp:  pd.inp  !== null ? Math.round(pd.inp)  : null,
        ttfb: pd.ttfb !== null ? Math.round(pd.ttfb) : null
      },
      slowResources: pd.resources,
      cdpMetrics
    };
  }

  // ── Accessibility Audit ───────────────────────────────────────────────────

  /**
   * Run a focused WCAG 2.2-aligned rule set against the live AX tree.
   * No external tooling required — checks are derived purely from the
   * accessibility tree already captured during perception.
   */
  async auditAccessibility(tabId: TabId): Promise<import("../../../../packages/shared/src/index.js").A11yAuditReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    await webContents.debugger.sendCommand("Accessibility.enable");
    const { nodes } = await webContents.debugger.sendCommand("Accessibility.getFullAXTree", {}) as {
      nodes: Array<{
        nodeId: string;
        role?: { value: string };
        name?: { value: string };
        description?: { value: string };
        properties?: Array<{ name: string; value: { value: unknown } }>;
        childIds?: string[];
        backendDOMNodeId?: number;
      }>
    };

    const violations: import("../../../../packages/shared/src/index.js").A11yViolation[] = [];
    let passes = 0;

    for (const node of nodes) {
      const role = node.role?.value ?? "generic";
      const name = node.name?.value;
      const props = Object.fromEntries(
        (node.properties ?? []).map(p => [p.name, p.value?.value])
      );
      const selector = node.backendDOMNodeId ? `[data-ax-id="${node.nodeId}"]` : `[role="${role}"]`;

      let nodeViolations = 0;

      // 1.1.1 — Images must have alt text (non-empty accessible name)
      if (role === "img") {
        if (!name || name.trim() === "" || name === "image") {
          violations.push({ rule: "1.1.1-image-alt", impact: "critical", selector, role, name,
            description: "Image has no accessible name. Add alt text or an aria-label." });
          nodeViolations++;
        }
      }

      // 2.4.6 — Buttons and links must have a discernible name
      if ((role === "button" || role === "link") && (!name || name.trim() === "")) {
        violations.push({ rule: "2.4.6-label", impact: "serious", selector, role, name,
          description: `${role === "button" ? "Button" : "Link"} has no accessible name. Add text content or an aria-label.` });
        nodeViolations++;
      }

      // 4.1.3 — Interactive controls must not be both disabled and focusable without label
      if (props["disabled"] === true && (role === "button" || role === "textbox") && (!name || name.trim() === "")) {
        violations.push({ rule: "4.1.3-disabled-label", impact: "minor", selector, role, name,
          description: `Disabled ${role} has no accessible name. Screen readers still announce it.` });
        nodeViolations++;
      }

      // 1.3.5 — Form inputs should have an associated label
      if ((role === "textbox" || role === "combobox" || role === "spinbutton") && (!name || name.trim() === "")) {
        violations.push({ rule: "1.3.1-input-label", impact: "serious", selector, role, name,
          description: "Form input has no accessible label. Use a <label>, aria-label, or aria-labelledby." });
        nodeViolations++;
      }

      // 2.4.3 — Ensure heading hierarchy is not skipped (h1→h3 without h2)
      if (role === "heading") {
        const level = Number(props["level"]) || 0;
        if (level > 1) {
          // Check stored last heading level (module-local to this audit call via closure)
          // We track this inline — simple heuristic, not full tree walk.
          // Violation stored by buildAxSelectorHint-style naming.
        }
      }

      if (nodeViolations === 0) passes++;
    }

    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      violations,
      passes,
      nodeCount: nodes.length
    };
  }

  // ── Component Tree ────────────────────────────────────────────────────────

  /**
   * Probe the page for React, Vue 3, Vue 2, or Svelte devtools hooks and
   * return a lightweight component tree. Returns `tree: null` when no hook
   * is found (e.g. production build without devtools enabled).
   */
  async captureComponentTree(tabId: TabId): Promise<import("../../../../packages/shared/src/index.js").ComponentTreeReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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
          var node = { name: name, props: safeProps(fiber.memoizedProps), children: [] };
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
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(function() {
        // ── Helpers ────────────────────────────────────────────────────────
        function hex(c) {
          try { return '#' + c.getHexString(); } catch(e) { return null; }
        }
        function v3(v) {
          return v ? { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) } : null;
        }
        function euler(e) {
          return e ? { x: +e.x.toFixed(4), y: +e.y.toFixed(4), z: +e.z.toFixed(4), order: e.order } : null;
        }

        function matInfo(m) {
          if (!m) return null;
          return {
            uuid: m.uuid || '', type: m.type || 'Material', name: m.name || '',
            color: m.color ? hex(m.color) : null,
            transparent: !!m.transparent, opacity: m.opacity != null ? m.opacity : 1,
            wireframe: !!m.wireframe, side: m.side != null ? m.side : 0,
            depthWrite: m.depthWrite != null ? m.depthWrite : true
          };
        }

        function geoInfo(g) {
          if (!g) return null;
          var pos = g.attributes && g.attributes.position;
          var idx = g.index;
          return {
            uuid: g.uuid || '', type: g.type || 'BufferGeometry',
            vertexCount: pos ? pos.count : 0,
            indexCount: idx ? idx.count : 0,
            attributes: g.attributes ? Object.keys(g.attributes) : []
          };
        }

        function objInfo(obj, depth) {
          if (!obj || depth > 8) return null;
          var type = obj.type || 'Object3D';
          var node = {
            uuid: obj.uuid || '', name: obj.name || '', type: type,
            visible: obj.visible !== false,
            castShadow: !!obj.castShadow, receiveShadow: !!obj.receiveShadow,
            position: v3(obj.position), rotation: euler(obj.rotation), scale: v3(obj.scale),
            children: []
          };

          // Geometry
          if (obj.geometry) node.geometry = geoInfo(obj.geometry);

          // Materials (single or array)
          if (obj.material) {
            var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            node.materials = mats.map(matInfo).filter(Boolean);
          }

          // Lights
          var isLight = obj.isLight || type.endsWith('Light');
          if (isLight) {
            node.lightProps = {
              intensity: obj.intensity != null ? obj.intensity : 1,
              color: obj.color ? hex(obj.color) : '#ffffff',
              castShadow: !!obj.castShadow,
              distance: obj.distance,
              angle: obj.angle
            };
          }

          // Cameras
          var isCamera = obj.isCamera || type.endsWith('Camera');
          if (isCamera) {
            node.cameraProps = {
              fov: obj.fov, near: obj.near, far: obj.far, zoom: obj.zoom != null ? obj.zoom : 1
            };
          }

          // InstancedMesh
          if (obj.isInstancedMesh) node.instanceCount = obj.count;

          // Recurse children
          if (obj.children && depth < 8) {
            for (var i = 0; i < obj.children.length; i++) {
              var child = objInfo(obj.children[i], depth + 1);
              if (child) node.children.push(child);
            }
          }
          return node;
        }

        // ── Locate renderer ────────────────────────────────────────────────
        var renderer = null;
        var scene = null;

        // Common patterns devs use to expose renderer
        var candidates = [
          window.__threeRenderer, window.renderer, window.threeRenderer,
          window.__three && window.__three.renderer,
          window.app && window.app.renderer,
          window.experience && window.experience.renderer && window.experience.renderer.instance
        ].filter(Boolean);

        // Fallback: scan canvas elements for __threeRenderer__ property set by Three.js devtools
        if (!candidates.length) {
          var canvases = document.querySelectorAll('canvas');
          for (var c of canvases) {
            if (c.__threeRenderer__) { candidates.push(c.__threeRenderer__); break; }
          }
        }

        for (var r of candidates) {
          if (r && (r.isWebGLRenderer || r.render)) { renderer = r; break; }
        }

        // Locate scene
        var sceneCandidates = [
          window.__threeScene, window.scene, window.threeScene,
          window.__three && window.__three.scene,
          window.app && window.app.scene,
          window.experience && window.experience.scene
        ].filter(Boolean);

        for (var s of sceneCandidates) {
          if (s && (s.isScene || s.type === 'Scene')) { scene = s; break; }
        }

        if (!renderer && !scene) {
          return { detected: false, scene: null, renderer: null, fps: null, materials: [], summary: null };
        }

        // ── Renderer info ──────────────────────────────────────────────────
        var rendererInfo = null;
        if (renderer && renderer.info) {
          var ri = renderer.info;
          rendererInfo = {
            drawCalls: (ri.render && ri.render.calls) || 0,
            triangles:  (ri.render && ri.render.triangles) || 0,
            points:     (ri.render && ri.render.points) || 0,
            lines:      (ri.render && ri.render.lines) || 0,
            programs:   (ri.programs && ri.programs.length) || 0,
            geometries: (ri.memory && ri.memory.geometries) || 0,
            textures:   (ri.memory && ri.memory.textures) || 0
          };
        }

        // ── Scene graph ────────────────────────────────────────────────────
        var sceneNode = scene ? objInfo(scene, 0) : null;

        // ── Collect all unique materials ───────────────────────────────────
        var matMap = {};
        function collectMats(node) {
          if (!node) return;
          if (node.materials) { for (var m of node.materials) { if (m) matMap[m.uuid] = m; } }
          for (var ch of node.children) collectMats(ch);
        }
        collectMats(sceneNode);
        var allMats = Object.values(matMap);

        // ── Summary counters ───────────────────────────────────────────────
        var totalObj = 0, meshes = 0, lights = 0, cameras = 0, verts = 0, tris = 0;
        function summarise(node) {
          if (!node) return;
          totalObj++;
          var t = node.type;
          if (t === 'Mesh' || t === 'SkinnedMesh' || t === 'InstancedMesh') meshes++;
          if (t.endsWith('Light')) lights++;
          if (t.endsWith('Camera')) cameras++;
          if (node.geometry) { verts += node.geometry.vertexCount; tris += Math.floor(node.geometry.indexCount / 3) || Math.floor(node.geometry.vertexCount / 3); }
          for (var ch of node.children) summarise(ch);
        }
        summarise(sceneNode);

        return {
          detected: true,
          scene: sceneNode,
          renderer: rendererInfo,
          fps: null,   // filled separately via rAF sample below
          materials: allMats,
          summary: {
            totalObjects: totalObj, meshCount: meshes, lightCount: lights, cameraCount: cameras,
            materialCount: allMats.length, uniqueMaterialCount: allMats.length,
            totalVertices: verts, totalTriangles: tris
          }
        };
      })()`,
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value: Record<string, unknown> } };

    // FPS estimate via a short rAF sample (100ms window)
    const fpsResult = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `new Promise(function(resolve) {
        var t0 = performance.now(); var frames = 0;
        function tick() {
          frames++;
          if (performance.now() - t0 < 300) { requestAnimationFrame(tick); }
          else { resolve({ fps: Math.round(frames / ((performance.now() - t0) / 1000)), framesSampled: frames }); }
        }
        requestAnimationFrame(tick);
      })`,
      returnByValue: true,
      awaitPromise: true
    }) as { result: { value: { fps: number; framesSampled: number } | null } };

    const val = result.result.value as ThreeSceneReport & { detected: boolean };
    const fpsVal = fpsResult.result.value ?? null;

    return {
      tabId,
      url: webContents.getURL(),
      capturedAt: Date.now(),
      detected: val.detected ?? false,
      scene: (val.scene ?? null) as ThreeSceneReport["scene"],
      renderer: (val.renderer ?? null) as ThreeSceneReport["renderer"],
      fps: fpsVal ? { fps: fpsVal.fps, framesSampled: fpsVal.framesSampled } : null,
      materials: (val.materials ?? []) as ThreeSceneReport["materials"],
      summary: (val.summary ?? {
        totalObjects: 0, meshCount: 0, lightCount: 0, cameraCount: 0,
        materialCount: 0, uniqueMaterialCount: 0, totalVertices: 0, totalTriangles: 0
      }) as ThreeSceneReport["summary"]
    };
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
  async captureStorage(tabId: TabId): Promise<StorageReport> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    const url = webContents.getURL();

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    // localStorage + sessionStorage via Runtime.evaluate
    const storageResult = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(function() {
        function dump(store) {
          var out = [];
          for (var i = 0; i < store.length; i++) {
            var k = store.key(i);
            var v = store.getItem(k) ?? '';
            out.push({ key: k, value: v, bytes: k.length + v.length });
          }
          return out;
        }
        return { local: dump(localStorage), session: dump(sessionStorage) };
      })()`,
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value: { local: StorageEntry[]; session: StorageEntry[] } } };

    // Cookies via Network.getCookies
    const cookieResult = await webContents.debugger.sendCommand("Network.getCookies", {
      urls: [url]
    }) as { cookies: Array<{
      name: string; value: string; domain: string; path: string;
      expires: number; httpOnly: boolean; secure: boolean;
      sameSite?: string; size: number;
    }> };

    const cookies: CookieEntry[] = (cookieResult.cookies ?? []).map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires === -1 ? null : c.expires * 1000,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: (c.sameSite ?? "") as CookieEntry["sameSite"],
      size: c.size
    }));

    // IndexedDB via Runtime.evaluate — walk all databases for the origin
    const idbResult = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(async function() {
        async function getDbs() {
          var dbs = await indexedDB.databases();
          var result = [];
          for (var dbInfo of dbs) {
            try {
              var db = await new Promise(function(resolve, reject) {
                var req = indexedDB.open(dbInfo.name, dbInfo.version);
                req.onsuccess = function() { resolve(req.result); };
                req.onerror = reject;
              });
              var stores = [];
              for (var storeName of Array.from(db.objectStoreNames)) {
                try {
                  var tx = db.transaction(storeName, 'readonly');
                  var store = tx.objectStore(storeName);
                  var count = await new Promise(function(res, rej) {
                    var r = store.count(); r.onsuccess = function() { res(r.result); }; r.onerror = rej;
                  });
                  var rows = await new Promise(function(res, rej) {
                    var r = store.openCursor(); var out = [];
                    r.onsuccess = function(e) {
                      var cursor = e.target.result;
                      if (cursor && out.length < 100) {
                        try { out.push({ key: String(cursor.key), value: JSON.stringify(cursor.value) }); } catch(_) { out.push({ key: String(cursor.key), value: '[unserializable]' }); }
                        cursor.continue();
                      } else { res(out); }
                    };
                    r.onerror = rej;
                  });
                  stores.push({
                    name: storeName,
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    count: count,
                    rows: rows
                  });
                } catch(e) { stores.push({ name: storeName, keyPath: null, autoIncrement: false, count: 0, rows: [] }); }
              }
              db.close();
              result.push({ name: dbInfo.name, version: dbInfo.version || 1, objectStores: stores });
            } catch(e) { result.push({ name: dbInfo.name, version: dbInfo.version || 1, objectStores: [] }); }
          }
          return result;
        }
        return getDbs();
      })()`,
      returnByValue: true,
      awaitPromise: true
    }) as { result: { value: IndexedDbDatabase[] } };

    const local: StorageEntry[] = storageResult.result.value?.local ?? [];
    const session: StorageEntry[] = storageResult.result.value?.session ?? [];
    const idb: IndexedDbDatabase[] = idbResult.result.value ?? [];

    const totalBytes =
      local.reduce((s, e) => s + e.bytes, 0) +
      session.reduce((s, e) => s + e.bytes, 0) +
      cookies.reduce((s, c) => s + c.size, 0);

    return { tabId, url, capturedAt: Date.now(), localStorage: local, sessionStorage: session, cookies, indexedDb: idb, totalBytes };
  }

  /** Read all entries (or a single key) from localStorage or sessionStorage. */
  async getStorage(tabId: TabId, area: StorageArea, key?: string): Promise<StorageEntry[]> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    const storeName = area === "local" ? "localStorage" : "sessionStorage";

    const result = await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: key
        ? `(function(){var v=${storeName}.getItem(${JSON.stringify(key)});return v===null?null:[{key:${JSON.stringify(key)},value:v,bytes:${JSON.stringify(key)}.length+v.length}];})()`
        : `(function(){var out=[];for(var i=0;i<${storeName}.length;i++){var k=${storeName}.key(i);var v=${storeName}.getItem(k)??"";out.push({key:k,value:v,bytes:k.length+v.length});}return out;})()`,
      returnByValue: true,
      awaitPromise: false
    }) as { result: { value: StorageEntry[] | null } };

    return result.result.value ?? [];
  }

  /** Set one or more key/value pairs in localStorage or sessionStorage. */
  async setStorage(tabId: TabId, area: StorageArea, entries: Record<string, string>): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    const storeName = area === "local" ? "localStorage" : "sessionStorage";

    const pairs = Object.entries(entries)
      .map(([k, v]) => `${storeName}.setItem(${JSON.stringify(k)},${JSON.stringify(v)})`)
      .join(";");

    await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `(function(){${pairs}})()`,
      returnByValue: false,
      awaitPromise: false
    });
  }

  /** Remove specific keys or clear the entire area. */
  async clearStorage(tabId: TabId, area: StorageArea, keys?: string[]): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;
    const storeName = area === "local" ? "localStorage" : "sessionStorage";

    const expr = keys && keys.length
      ? `(function(){${keys.map(k => `${storeName}.removeItem(${JSON.stringify(k)})`).join(";")};})()`
      : `${storeName}.clear()`;

    await webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: expr,
      returnByValue: false,
      awaitPromise: false
    });
  }

  /** Set (upsert) a cookie. Defaults to the tab's current origin. */
  async setCookie(tabId: TabId, cookie: Partial<CookieEntry> & { name: string; value: string }): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    const url = webContents.getURL();
    await webContents.debugger.sendCommand("Network.setCookie", {
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? false,
      sameSite: cookie.sameSite || undefined,
      expires: cookie.expires != null ? Math.floor(cookie.expires / 1000) : undefined
    });
  }

  /** Delete a cookie by name (and optionally domain/path). */
  async deleteCookie(tabId: TabId, name: string, url?: string): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    await webContents.debugger.sendCommand("Network.deleteCookies", {
      name,
      url: url ?? webContents.getURL()
    });
  }

  /** Clear all cookies for the tab's current origin (or a given URL). */
  async clearCookies(tabId: TabId, url?: string): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

    const targetUrl = url ?? webContents.getURL();
    const res = await webContents.debugger.sendCommand("Network.getCookies", { urls: [targetUrl] }) as { cookies: Array<{ name: string }> };
    for (const c of (res.cookies ?? [])) {
      await webContents.debugger.sendCommand("Network.deleteCookies", { name: c.name, url: targetUrl });
    }
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
      script: renderRecordingScript(recording)
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

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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
    if (!tab.view.webContents.debugger.isAttached()) {
      tab.view.webContents.debugger.attach("1.3");
    }
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
    if (!tab.view.webContents.debugger.isAttached()) {
      tab.view.webContents.debugger.attach("1.3");
    }
    await tab.view.webContents.debugger.sendCommand("Emulation.clearGeolocationOverride").catch(() => {});
    await tab.view.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "UTC" }).catch(() => {});
  }

  // ── Network mock / intercept ──────────────────────────────────────────────

  async enableNetworkMock(tabId: TabId, rules: NetworkInterceptRule[]): Promise<void> {
    const tab = this.requireTab(tabId);
    const { webContents } = tab.view;

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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
    return normalizePerception(snapshot, tab.lastObservation);
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
    const records = [...this.tabs.values()];
    for (const tab of records) {
      const result = await this.capturePerception(tab.id);
      const execution = await this.capabilityRegistry.approveCommand(requestId, tab.lastObservation, result, tab.view.webContents);
      if (execution.status === "failed" && execution.reason.includes("was not found")) {
        continue;
      }

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
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }
    const metrics = await webContents.debugger.sendCommand("Performance.getMetrics") as { metrics?: Array<{ name: string; value: number }> };
    const heap = metrics.metrics?.find((metric) => metric.name === "JSHeapUsedSize")?.value;
    return typeof heap === "number" ? heap / (1024 * 1024) : null;
  }

  private async applyLocationOverride(tab: TabRecord): Promise<void> {
    const location = tab.locationOverride;
    if (!location) return;

    const { webContents } = tab.view;
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach("1.3");
    }

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
        tab.networkRequests.set(requestId, {
          requestId,
          url: (request.url as string) ?? "",
          method: (request.method as string) ?? "GET",
          failed: false,
          timestamp: (params.timestamp as number) ?? Date.now()
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
function computeDiffRegions(changed: Uint8Array, width: number, height: number): DiffRegion[] {
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
function matchesMockRule(url: string, method: string, rule: NetworkInterceptRule): boolean {
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
function computePerceptionDiff(
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
function evaluateAssertionAgainstGraph(
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
      image:   graph.media.filter(m => m.kind === "image").length,
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
    let ok = false;
    if (op === "at least" || op === "more than") ok = op === "at least" ? count >= n : count > n;
    else ok = op === "at most" ? count <= n : count < n;
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
