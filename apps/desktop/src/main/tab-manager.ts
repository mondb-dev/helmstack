/**
 * `ElectronBackend` — the desktop's thin `BrowserBackend` (ADR 0001 §4.1).
 *
 * Owns only what needs Electron: one `WebContentsView` per tab, shell
 * layout/focus, the page preload, tab lifecycle → `TabLifecycleEvent`s,
 * downloads, anti-detection, HTTP basic-auth and window-open handling. Every
 * agent tool lives once in `HelmstackCore` (packages/devtools-core) on top of
 * the per-tab `CdpTarget` handed out here.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BrowserWindow, WebContentsView } from "electron";

import type {
  BackendTab,
  BrowserBackend,
  TabLifecycleEvent
} from "../../../../packages/devtools-core/src/backend.js";
import { isStealthEnabled } from "../../../../packages/devtools-core/src/core/runtime-config.js";
import type {
  CdpTarget,
  DownloadEntry,
  ElementPickResult,
  FindInPageOptions,
  FindInPageResult,
  FixturePageName,
  PageObservation,
  TabId,
  TabSummary,
  ViewportRect,
  ZoomAction
} from "../../../../packages/shared/src/index.js";
import type { AccountStore } from "./account-store.js";
import { installAntiDetection } from "./anti-detection.js";
import { electronCdpTarget } from "./electron-cdp-target.js";
import { pickElement } from "./element-picker.js";
import { nextZoomFactor, zoomOriginOf, type ZoomStore } from "./zoom-store.js";

type LifecycleListener = (event: TabLifecycleEvent) => void;
type ObservationListener = (observation: PageObservation) => void;
type DownloadListener = (tabId: TabId, download: DownloadEntry) => void;

const DEFAULT_VIEWPORT: ViewportRect = { x: 0, y: 0, width: 0, height: 0 };

/** Closed-tab history depth (Reopen closed tab). */
export const CLOSED_TAB_HISTORY_LIMIT = 10;

/** Upper bound for waiting on a history/reload load. */
const NAVIGATION_WAIT_MS = 30_000;

/** Time the renderer needs to see a zoom change before device-metrics emulation starts. */
const ZOOM_SETTLE_MS = 50;

export type ClosedTab = { url: string; title: string; index: number };

type FindListener = (result: FindInPageResult) => void;

/** One desktop tab: a `WebContentsView` plus the backend-maintained summary. */
export class ElectronTab implements BackendTab {
  readonly cdp: CdpTarget;
  pendingUrl: string | null;
  currentSummary: TabSummary;
  /** The human's zoom for this page (1 = 100%). */
  userZoom = 1;
  /**
   * While an agent's device-metrics override is active the page renders at 100%
   * regardless of `userZoom`: browser zoom changes the CSS viewport, which would
   * skew emulated sizes and make screenshots non-100%-scale.
   */
  emulationActive = false;
  /**
   * > 0 while the shell grabs a freeze-frame for an overlay: that image must
   * match what the human sees, so the page keeps their zoom for it.
   */
  humanCaptures = 0;

  constructor(
    readonly id: TabId,
    readonly view: WebContentsView,
    private readonly emitSummaryChanged: () => void,
    initialUrl: string,
    readonly parentTabId?: TabId
  ) {
    this.cdp = electronCdpTarget(view.webContents, {
      before: async (method) => {
        if (method === "Emulation.setDeviceMetricsOverride" && this.humanCaptures === 0 && this.setEmulation(true)) {
          await settleDelay();
        }
      },
      after: (method) => {
        if (method === "Emulation.clearDeviceMetricsOverride") this.setEmulation(false);
      }
    });
    this.pendingUrl = initialUrl;
    this.currentSummary = {
      id,
      title: "New Tab",
      url: initialUrl,
      isActive: false,
      status: "loading",
      statusMessage: `Loading ${initialUrl}`,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1
    };
  }

  /** The factor the page should currently render at. */
  effectiveZoom(): number {
    return this.emulationActive ? 1 : this.userZoom;
  }

  /** Applies `effectiveZoom()` to the page. Returns whether the rendered factor changed. */
  applyZoom(): boolean {
    const { webContents } = this.view;
    if (typeof webContents.setZoomFactor !== "function") return false;
    const target = this.effectiveZoom();
    const current = typeof webContents.getZoomFactor === "function" ? webContents.getZoomFactor() : 1;
    if (Math.abs(current - target) < 0.001) return false;
    webContents.setZoomFactor(target);
    return true;
  }

  private setEmulation(active: boolean): boolean {
    if (this.emulationActive === active) return false;
    this.emulationActive = active;
    return this.applyZoom();
  }

  canGoBack(): boolean {
    return historyOf(this.view.webContents).canGoBack();
  }

  canGoForward(): boolean {
    return historyOf(this.view.webContents).canGoForward();
  }

  /** Reload; resolves once the page has loaded (or failed / timed out). */
  async reload(options: { ignoreCache?: boolean } = {}, wait = true): Promise<void> {
    const { webContents } = this.view;
    const settled = wait ? waitForSettled(webContents) : Promise.resolve();
    this.markLoading(this.currentSummary.url);
    if (options.ignoreCache) webContents.reloadIgnoringCache();
    else webContents.reload();
    await settled;
  }

  /** History back/forward; `false` (no-op) when there is no entry that way. */
  async step(direction: "back" | "forward", wait = true): Promise<boolean> {
    const { webContents } = this.view;
    const history = historyOf(webContents);
    if (direction === "back" ? !history.canGoBack() : !history.canGoForward()) return false;
    const settled = wait ? waitForSettled(webContents) : Promise.resolve();
    if (direction === "back") history.goBack();
    else history.goForward();
    await settled;
    return true;
  }

  goBack(): Promise<boolean> {
    return this.step("back");
  }

  goForward(): Promise<boolean> {
    return this.step("forward");
  }

  summary(): TabSummary {
    return this.currentSummary;
  }

  title(): string {
    return this.view.webContents.getTitle();
  }

  /**
   * Marks the tab loading synchronously (and emits `summary-changed`), then
   * loads. A failed load flips the summary to `error`, emits again and rejects.
   */
  async navigate(url: string): Promise<void> {
    this.markLoading(url);
    try {
      await this.view.webContents.loadURL(url);
    } catch (error) {
      this.markFailed(`Failed to load ${url}`);
      throw error;
    }
  }

  markLoading(url: string): void {
    this.pendingUrl = url;
    this.currentSummary = { ...this.currentSummary, url, status: "loading", statusMessage: `Loading ${url}` };
    this.emitSummaryChanged();
  }

  markFailed(statusMessage: string, url?: string): void {
    this.pendingUrl = null;
    this.currentSummary = { ...this.currentSummary, url: url || this.currentSummary.url, status: "error", statusMessage };
    this.emitSummaryChanged();
  }

  /** Re-derives url/title/status from the live `WebContents`. */
  refreshSummary(): void {
    const { webContents } = this.view;
    const liveUrl = webContents.getURL();
    const isLoading = webContents.isLoading();
    const url =
      this.pendingUrl && (isLoading || !liveUrl || liveUrl === this.currentSummary.url) ? this.pendingUrl : liveUrl || this.currentSummary.url;

    if (!isLoading && this.pendingUrl && (!liveUrl || liveUrl === this.pendingUrl || liveUrl !== this.currentSummary.url)) {
      this.pendingUrl = null;
    }

    this.currentSummary = {
      ...this.currentSummary,
      title: webContents.getTitle() || this.currentSummary.title,
      url,
      status: isLoading ? "loading" : "idle",
      statusMessage: isLoading ? `Loading ${url}` : `Loaded ${url}`,
      canGoBack: this.canGoBack(),
      canGoForward: this.canGoForward(),
      zoomFactor: this.userZoom
    };
    this.emitSummaryChanged();
  }
}

/** `webContents.navigationHistory` (Electron 35+), tolerant of its absence. */
function historyOf(webContents: Electron.WebContents): { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void } {
  const history = (webContents as { navigationHistory?: Electron.NavigationHistory }).navigationHistory;
  return {
    canGoBack: () => history?.canGoBack?.() ?? false,
    canGoForward: () => history?.canGoForward?.() ?? false,
    goBack: () => history?.goBack?.(),
    goForward: () => history?.goForward?.()
  };
}

function settleDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ZOOM_SETTLE_MS));
}

/** Resolves when the current navigation finishes, fails, or after `NAVIGATION_WAIT_MS`. */
function waitForSettled(webContents: Electron.WebContents): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      webContents.removeListener("did-stop-loading", done);
      webContents.removeListener("did-navigate-in-page", done);
      webContents.removeListener("did-fail-load", done);
      resolve();
    };
    const timer = setTimeout(done, NAVIGATION_WAIT_MS);
    webContents.on("did-stop-loading", done);
    webContents.on("did-navigate-in-page", done);
    webContents.on("did-fail-load", done);
  });
}

export class ElectronBackend implements BrowserBackend {
  readonly kind = "desktop" as const;

  private readonly tabs = new Map<TabId, ElectronTab>();
  private readonly lifecycleListeners = new Set<LifecycleListener>();
  private readonly observationListeners = new Set<ObservationListener>();
  private readonly downloadListeners = new Set<DownloadListener>();
  private readonly findListeners = new Set<FindListener>();
  /** Most recent last; capped at `CLOSED_TAB_HISTORY_LIMIT`. */
  private closedTabs: ClosedTab[] = [];
  private readonly downloadTrackingSessions = new WeakSet<Electron.Session>();
  private activeTabId: TabId | null = null;
  /** Tab ids in activation order, most recent last — closing the active tab returns to the previous one. */
  private activationOrder: TabId[] = [];
  private attachedTabId: TabId | null = null;
  /** `before-input-event` router installed on every page view (browser shortcuts). */
  private keyRouter: ((event: Electron.Event, input: Electron.Input) => void) | null = null;
  private viewport: ViewportRect = DEFAULT_VIEWPORT;

  constructor(
    private readonly window: BrowserWindow,
    private readonly appDir: string,
    private readonly pagePreloadPath: string,
    private readonly accounts: AccountStore,
    private readonly zoomStore?: ZoomStore
  ) {
    this.window.on("resize", () => this.layoutActiveTab());
  }

  // ── BrowserBackend ────────────────────────────────────────────────────────

  defaultViewport(): { width: number; height: number } {
    return { width: this.viewport.width, height: this.viewport.height };
  }

  listTabs(): ElectronTab[] {
    return [...this.tabs.values()];
  }

  getTab(id: TabId): ElectronTab | undefined {
    return this.tabs.get(id);
  }

  async createTab(url = "https://example.com", opts: { parentTabId?: TabId } = {}): Promise<ElectronTab> {
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

    const tab = new ElectronTab(id, view, () => this.emit({ type: "summary-changed" }), url, opts.parentTabId);
    this.tabs.set(id, tab);
    this.bindLifecycle(tab);
    if (this.keyRouter) view.webContents.on("before-input-event", this.keyRouter);
    this.ensureDownloadTracking(tab);
    this.emit({ type: "created", tab });

    // Install anti-detection after the first document loads so the WebContents
    // target is fully initialised and the CDP debugger can attach cleanly.
    // Stealth is opt-in (HELMSTACK_STEALTH=1).
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
      console.warn("[ElectronBackend] focusTab failed during createTab:", err);
    }

    void view.webContents.loadURL(url).catch(() => tab.markFailed(`Failed to load ${url}`));
    return tab;
  }

  async closeTab(tabId: TabId): Promise<void> {
    const tab = this.requireTab(tabId);
    this.rememberClosed(tab);

    if (this.attachedTabId === tabId) {
      this.window.contentView.removeChildView(tab.view);
      this.attachedTabId = null;
    }
    tab.view.webContents.close();
    this.tabs.delete(tabId);
    this.activationOrder = this.activationOrder.filter((id) => id !== tabId && this.tabs.has(id));
    this.emit({ type: "closed", tabId });

    if (this.activeTabId === tabId) {
      const previousId = this.activationOrder.at(-1);
      const next = (previousId ? this.tabs.get(previousId) : undefined) ?? (this.tabs.values().next().value as ElectronTab | undefined);
      this.activeTabId = next?.id ?? null;
      if (next) {
        await this.focusTab(next.id);
      }
    }
  }

  /** Installs the key router on every existing and future page view. */
  setKeyRouter(router: (event: Electron.Event, input: Electron.Input) => void): void {
    this.keyRouter = router;
    for (const tab of this.tabs.values()) tab.view.webContents.on("before-input-event", router);
  }

  /** Moves keyboard focus into the active page (after keyboard tab switches). */
  focusActivePage(): void {
    if (!this.activeTabId) return;
    const { webContents } = this.tabs.get(this.activeTabId)?.view ?? {};
    if (webContents && !webContents.isDestroyed()) webContents.focus();
  }

  onLifecycle(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  onObservation(listener: ObservationListener): () => void {
    this.observationListeners.add(listener);
    return () => this.observationListeners.delete(listener);
  }

  onDownload(listener: DownloadListener): () => void {
    this.downloadListeners.add(listener);
    return () => this.downloadListeners.delete(listener);
  }

  // ── Browser navigation, find, zoom (human shell + shortcuts) ─────────────

  /** Reload; `wait` resolves after the load (agent API) instead of immediately (shell). */
  async reload(tabId: TabId, options: { ignoreCache?: boolean } = {}, wait = false): Promise<void> {
    await this.requireTab(tabId).reload(options, wait);
  }

  async goBack(tabId: TabId, wait = false): Promise<boolean> {
    return this.requireTab(tabId).step("back", wait);
  }

  async goForward(tabId: TabId, wait = false): Promise<boolean> {
    return this.requireTab(tabId).step("forward", wait);
  }

  stop(tabId: TabId): void {
    this.requireTab(tabId).view.webContents.stop();
  }

  isLoading(tabId: TabId): boolean {
    return this.tabs.get(tabId)?.view.webContents.isLoading() ?? false;
  }

  activeId(): TabId | null {
    return this.activeTabId;
  }

  /** The tab `delta` positions from the active one in strip order, wrapping. */
  tabAtOffset(delta: number): TabId | null {
    const ids = [...this.tabs.keys()];
    if (ids.length === 0) return null;
    const current = this.activeTabId ? ids.indexOf(this.activeTabId) : -1;
    const base = current < 0 ? 0 : current;
    return ids[(((base + delta) % ids.length) + ids.length) % ids.length] ?? null;
  }

  /** Index into strip order; negative counts from the end (-1 = last). */
  tabAtIndex(index: number): TabId | null {
    const ids = [...this.tabs.keys()];
    const at = index < 0 ? ids.length + index : index;
    return ids[at] ?? null;
  }

  onFindResult(listener: FindListener): () => void {
    this.findListeners.add(listener);
    return () => this.findListeners.delete(listener);
  }

  findInPage(tabId: TabId, text: string, options: FindInPageOptions = {}): void {
    const { webContents } = this.requireTab(tabId).view;
    if (!text) {
      webContents.stopFindInPage("clearSelection");
      return;
    }
    webContents.findInPage(text, {
      forward: options.forward !== false,
      // Electron's `findNext` is literally "begin a new session" (Blink `new_session`);
      // ours means "continue the current one", hence the inversion.
      findNext: options.findNext !== true,
      matchCase: options.matchCase === true
    });
  }

  stopFindInPage(tabId: TabId): void {
    this.tabs.get(tabId)?.view.webContents.stopFindInPage("clearSelection");
  }

  /** Applies a zoom step to the tab and every tab on the same origin; persists it. */
  zoomTab(tabId: TabId, action: ZoomAction): void {
    const tab = this.requireTab(tabId);
    const next = action === "reset" ? 1 : nextZoomFactor(tab.userZoom, action);
    const origin = zoomOriginOf(tab.view.webContents.getURL() || tab.currentSummary.url);
    this.zoomStore?.set(origin, next);
    for (const entry of this.tabs.values()) {
      const sameOrigin = entry.id === tab.id || (origin !== null && zoomOriginOf(entry.view.webContents.getURL()) === origin);
      if (!sameOrigin) continue;
      entry.userZoom = next;
      entry.applyZoom();
      entry.currentSummary = { ...entry.currentSummary, zoomFactor: next };
    }
    this.emit({ type: "summary-changed" });
  }

  /** Runs a shell-initiated capture (overlay freeze-frame) without neutralising the human's zoom. */
  async withHumanCapture<T>(tabId: TabId, run: () => Promise<T>): Promise<T> {
    const tab = this.tabs.get(tabId);
    if (!tab) return run();
    tab.humanCaptures += 1;
    try {
      return await run();
    } finally {
      tab.humanCaptures -= 1;
    }
  }

  toggleDevTools(tabId: TabId): void {
    const { webContents } = this.requireTab(tabId).view;
    if (webContents.isDevToolsOpened()) webContents.closeDevTools();
    else webContents.openDevTools({ mode: "detach" });
  }

  print(tabId: TabId): void {
    this.requireTab(tabId).view.webContents.print();
  }

  /** Pops the most recently closed tab, or null. The caller re-creates it and calls `moveTab`. */
  popClosedTab(): ClosedTab | null {
    return this.closedTabs.pop() ?? null;
  }

  closedTabHistory(): readonly ClosedTab[] {
    return this.closedTabs;
  }

  /** Reorders the tab strip: moves `tabId` so it sits at `index` (clamped). */
  moveTab(tabId: TabId, index: number): void {
    const entries = [...this.tabs.entries()];
    const from = entries.findIndex(([id]) => id === tabId);
    if (from < 0) return;
    const [moved] = entries.splice(from, 1);
    entries.splice(Math.max(0, Math.min(index, entries.length)), 0, moved!);
    this.tabs.clear();
    for (const [id, tab] of entries) this.tabs.set(id, tab);
    this.emit({ type: "summary-changed" });
  }

  private rememberClosed(tab: ElectronTab): void {
    const url = tab.view.webContents.getURL() || tab.currentSummary.url;
    if (!url || url === "about:blank") return;
    const index = [...this.tabs.keys()].indexOf(tab.id);
    this.closedTabs.push({ url, title: tab.currentSummary.title, index: Math.max(0, index) });
    if (this.closedTabs.length > CLOSED_TAB_HISTORY_LIMIT) this.closedTabs.shift();
  }

  /** Inspect overlay; resolves when the human clicks an element (or cancels). */
  async pickElement(tabId: TabId): Promise<ElementPickResult> {
    return pickElement(this.requireTab(tabId).view.webContents, tabId);
  }

  // ── Desktop shell ─────────────────────────────────────────────────────────

  /** Feed from the page preload (`PageObserved` IPC). */
  recordObservation(observation: PageObservation): void {
    if (!this.tabs.has(observation.tabId)) return;
    for (const listener of this.observationListeners) listener(observation);
  }

  summaries(): TabSummary[] {
    return this.listTabs().map((tab) => tab.summary());
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
      entry.currentSummary = { ...entry.currentSummary, isActive: entry.id === tabId };
      entry.view.setVisible(entry.id === tabId);
    }

    this.activeTabId = tabId;
    this.activationOrder = [...this.activationOrder.filter((id) => id !== tabId), tabId];
    if (this.attachedTabId !== tabId) {
      this.window.contentView.addChildView(tab.view);
      this.attachedTabId = tabId;
    }
    this.layoutActiveTab();
    this.emit({ type: "summary-changed" });

    return this.summaries();
  }

  async setViewport(rect: ViewportRect): Promise<void> {
    this.viewport = rect;
    this.layoutActiveTab();
  }

  getFixtureUrl(name: FixturePageName): string {
    const fixtureMap: Record<FixturePageName, string> = {
      "contact-form": path.join(this.appDir, "../../test-pages/contact-form.html")
    };
    return pathToFileURL(fixtureMap[name]).toString();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private emit(event: TabLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) listener(event);
  }

  private bindLifecycle(tab: ElectronTab): void {
    const { webContents } = tab.view;
    const update = () => tab.refreshSummary();

    webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      update();
    });
    webContents.on("found-in-page", (_event, result) => {
      for (const listener of this.findListeners) {
        listener({
          tabId: tab.id,
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
          finalUpdate: result.finalUpdate
        });
      }
    });
    webContents.on("did-start-navigation", (event, navigationUrl, isInPlace, isMainFrame) => {
      if (!event.defaultPrevented && isMainFrame && !isInPlace) {
        // Zoom follows the origin being loaded (applied before first paint); find state is per document.
        this.applyOriginZoom(tab, navigationUrl);
        if (typeof webContents.stopFindInPage === "function") webContents.stopFindInPage("clearSelection");
        for (const listener of this.findListeners) {
          listener({ tabId: tab.id, activeMatchOrdinal: 0, matches: 0, finalUpdate: true, cleared: true });
        }
      }
      if (!event.defaultPrevented && isMainFrame) {
        tab.markLoading(navigationUrl);
        // The core clears buffered logs on every main-frame navigation.
        this.emit({ type: "main-frame-navigation", tabId: tab.id, url: navigationUrl });
      }
    });
    webContents.on("did-navigate", update);
    webContents.on("did-navigate-in-page", update);
    webContents.on("did-finish-load", () => {
      update();
      // The core re-applies location/budget/media overrides.
      this.emit({ type: "load-finished", tabId: tab.id });
    });
    webContents.on("did-start-loading", update);
    webContents.on("did-stop-loading", update);
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      tab.markFailed(`Load failed (${errorCode}): ${errorDescription || validatedURL || "Unknown error"}`, validatedURL);
    });

    // Opening the page's DevTools may detach the agent's CDP session (Electron
    // documents `detach` "when devtools is invoked"). Re-attach so agent tooling
    // keeps working, and let the core re-apply its overrides.
    webContents.debugger.on("detach", (_event, reason) => {
      if (!this.tabs.has(tab.id) || webContents.isDestroyed() || reason === "target closed") return;
      try {
        if (!webContents.debugger.isAttached()) webContents.debugger.attach("1.3");
      } catch (error) {
        console.warn("[ElectronBackend] could not re-attach the debugger after detach:", error);
        return;
      }
      this.emit({ type: "load-finished", tabId: tab.id });
    });

    // Auto-respond to HTTP Basic Auth challenges using vault accounts.
    webContents.on("login", (_event, _request, authInfo, callback) => {
      if (authInfo.scheme !== "basic") {
        callback();
        return;
      }
      const origin = `${authInfo.isProxy ? "proxy" : (authInfo.host ? `https://${authInfo.host}` : "")}`;
      const record = this.accounts.findRecordByOrigin(origin || tab.summary().url);
      if (record) {
        callback(record.username, record.password);
      } else {
        callback();
      }
    });

    webContents.setWindowOpenHandler(({ url }) => {
      void this.createTab(url || "about:blank", { parentTabId: tab.id });
      return { action: "deny" };
    });
  }

  private applyOriginZoom(tab: ElectronTab, url: string): void {
    if (!this.zoomStore) return;
    const factor = this.zoomStore.get(zoomOriginOf(url));
    if (Math.abs(factor - tab.userZoom) < 0.001) return;
    tab.userZoom = factor;
    tab.applyZoom();
    tab.currentSummary = { ...tab.currentSummary, zoomFactor: factor };
  }

  private ensureDownloadTracking(tab: ElectronTab): void {
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
      const report = () => {
        for (const listener of this.downloadListeners) listener(owner.id, download);
      };
      report();

      item.on("updated", () => {
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        download.state = item.isPaused?.() ? "interrupted" : "progressing";
        report();
      });

      item.once("done", (_doneEvent, state) => {
        download.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        download.finishedAt = Date.now();
        download.receivedBytes = item.getReceivedBytes();
        report();
      });
    });
  }

  private layoutActiveTab(): void {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    tab.view.setBounds(this.viewport);
    tab.view.setVisible(this.viewport.width > 0 && this.viewport.height > 0);
  }

  private requireTab(tabId: TabId): ElectronTab {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }
    return tab;
  }
}
