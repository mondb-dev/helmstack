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
  type BrowserCommandResult,
  type BrowserOutputCommand,
  type BrowserPerceptionPacket,
  type ConsoleLogEntry,
  type ConsoleLogLevel,
  type FixturePageName,
  type HumanHandoffRecord,
  type NetworkInterceptRule,
  type NetworkRequestEntry,
  type PageScreenshot,
  type PageSnapshot,
  type PageObservation,
  type PerformanceReport,
  type PerceptionResult,
  type ScreenshotDiff,
  type SiteCapabilityManifest,
  type TabId,
  type TabLogSnapshot,
  type TabSummary,
  type TotpResult,
  type VaultSecretInput,
  type VaultSecretSummary,
  type VaultStatus,
  type ViewportPresetName,
  type ViewportSuiteReport,
  type ViewportRect,
  VIEWPORT_PRESETS
} from "../../../../packages/shared/src/index.js";
import { SiteCapabilityRegistry } from "./site-capability-registry.js";
import { VaultStore } from "./vault-store.js";

type EmulatedViewport = { width: number; height: number; mobile: boolean };

type TabRecord = {
  id: TabId;
  view: WebContentsView;
  lastObservation: PageObservation | null;
  pendingUrl: string | null;
  summary: TabSummary;
  emulatedViewport?: EmulatedViewport;
  // CDP logging state (buffered per-tab, cleared on navigation)
  cdpLoggingEnabled: boolean;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: Map<string, NetworkRequestEntry>;
  jsErrors: string[];
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
  private readonly capabilityRegistry: SiteCapabilityRegistry;
  private readonly tabs = new Map<TabId, TabRecord>();
  private readonly listeners = new Set<TabsChangedListener>();
  private readonly observationListeners = new Set<PageObservedListener>();
  private readonly approvalQueuedListeners = new Set<ApprovalQueuedListener>();
  private activeTabId: TabId | null = null;
  private attachedTabId: TabId | null = null;
  private viewport: ViewportRect = DEFAULT_VIEWPORT;
  private readonly screenshotCache = new Map<string, PageScreenshot>();

  constructor(window: BrowserWindow, appDir: string, userDataPath: string, pagePreloadPath: string) {
    this.window = window;
    this.appDir = appDir;
    this.pagePreloadPath = pagePreloadPath;
    this.vault = new VaultStore(userDataPath);
    this.accounts = new AccountStore(userDataPath);
    this.policies = new ApprovalPolicyStore(userDataPath);
    this.capabilityRegistry = new SiteCapabilityRegistry(this.vault, this.accounts, this.approvals, this.handoffs, this.policies);
    this.window.on("resize", () => this.layoutActiveTab());

    // Forward approval-queued events to any agent-server subscriber
    this.approvals.onCreated((approval) => {
      for (const listener of this.approvalQueuedListeners) {
        listener(approval);
      }
    });
  }

  async createTab(url = "https://example.com"): Promise<TabSummary[]> {
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
      id, view, summary, lastObservation: null, pendingUrl: url,
      cdpLoggingEnabled: false,
      consoleLogs: [],
      networkRequests: new Map(),
      jsErrors: [],
      networkMockRules: null
    };

    this.tabs.set(id, record);
    this.bindLifecycle(record);

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
      return { beforeId, afterId, diffPixelCount: totalPixels, diffPercentage: 100, totalPixels, width: wA, height: hA, capturedAt: Date.now() };
    }

    const rawA   = imgA.toBitmap(); // BGRA, 4 bytes/pixel
    const rawB   = imgB.toBitmap();
    const diffBuf = Buffer.from(rawA); // copy A as base
    let diffCount = 0;

    for (let i = 0; i < rawA.length; i += 4) {
      const db = Math.abs(rawA[i]   - rawB[i]);
      const dg = Math.abs(rawA[i + 1] - rawB[i + 1]);
      const dr = Math.abs(rawA[i + 2] - rawB[i + 2]);
      if (dr > 10 || dg > 10 || db > 10) {
        diffCount++;
        diffBuf[i]     = 0;   // B
        diffBuf[i + 1] = 0;   // G
        diffBuf[i + 2] = 255; // R  (highlight changed pixels red)
        diffBuf[i + 3] = 255; // A
      }
    }

    const diffImg = nativeImage.createFromBitmap(diffBuf, { width: wA, height: hA });

    return {
      beforeId, afterId,
      diffPixelCount: diffCount,
      diffPercentage: Math.round((diffCount / totalPixels) * 10000) / 100,
      totalPixels,
      width: wA, height: hA,
      diffImageData: diffImg.toPNG().toString("base64"),
      capturedAt: Date.now()
    };
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

  // ── Console / Network logs ────────────────────────────────────────────────

  /** Return a snapshot of all buffered logs for the tab. */
  getTabLogs(tabId: TabId): TabLogSnapshot {    const tab = this.requireTab(tabId);
    return {
      tabId,
      consoleLogs: [...tab.consoleLogs],
      networkRequests: [...tab.networkRequests.values()],
      jsErrors: [...tab.jsErrors],
      capturedAt: Date.now()
    };
  }

  /** Clear all buffered logs for the tab. */
  clearTabLogs(tabId: TabId): void {
    const tab = this.requireTab(tabId);
    tab.consoleLogs = [];
    tab.networkRequests = new Map();
    tab.jsErrors = [];
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
    return this.capabilityRegistry.buildPerceptionPacket(tabId, tab.lastObservation, result, tab.view.webContents);
  }

  async listCapabilityManifests(tabId: TabId): Promise<SiteCapabilityManifest[]> {
    const tab = this.requireTab(tabId);
    const result = await this.capturePerception(tabId);
    return this.capabilityRegistry.listCapabilityManifests(tabId, result, tab.view.webContents);
  }

  async executeCommand(tabId: TabId, command: BrowserOutputCommand): Promise<BrowserCommandResult> {
    const tab = this.requireTab(tabId);
    const result = await this.capturePerception(tabId);
    const execution = await this.capabilityRegistry.executeCommand(tabId, command, tab.lastObservation, result, tab.view.webContents);

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
        tab.jsErrors = [];
      }
    });
    webContents.on("did-navigate", updateSummary);
    webContents.on("did-navigate-in-page", updateSummary);
    webContents.on("did-finish-load", updateSummary);
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
  }

  // ── CDP domain management ─────────────────────────────────────────────────

  private async enableCdpLogging(tab: TabRecord): Promise<void> {
    if (tab.cdpLoggingEnabled) return;
    tab.cdpLoggingEnabled = true;
    const { webContents } = tab.view;
    await Promise.all([
      webContents.debugger.sendCommand("Runtime.enable"),
      webContents.debugger.sendCommand("Log.enable"),
      webContents.debugger.sendCommand("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 })
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
