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
  FixturePageName,
  PageObservation,
  TabId,
  TabSummary,
  ViewportRect
} from "../../../../packages/shared/src/index.js";
import type { AccountStore } from "./account-store.js";
import { installAntiDetection } from "./anti-detection.js";
import { electronCdpTarget } from "./electron-cdp-target.js";
import { pickElement } from "./element-picker.js";

type LifecycleListener = (event: TabLifecycleEvent) => void;
type ObservationListener = (observation: PageObservation) => void;
type DownloadListener = (tabId: TabId, download: DownloadEntry) => void;

const DEFAULT_VIEWPORT: ViewportRect = { x: 0, y: 0, width: 0, height: 0 };

/** One desktop tab: a `WebContentsView` plus the backend-maintained summary. */
export class ElectronTab implements BackendTab {
  readonly cdp: CdpTarget;
  pendingUrl: string | null;
  currentSummary: TabSummary;

  constructor(
    readonly id: TabId,
    readonly view: WebContentsView,
    private readonly emitSummaryChanged: () => void,
    initialUrl: string,
    readonly parentTabId?: TabId
  ) {
    this.cdp = electronCdpTarget(view.webContents);
    this.pendingUrl = initialUrl;
    this.currentSummary = {
      id,
      title: "New Tab",
      url: initialUrl,
      isActive: false,
      status: "loading",
      statusMessage: `Loading ${initialUrl}`
    };
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
      statusMessage: isLoading ? `Loading ${url}` : `Loaded ${url}`
    };
    this.emitSummaryChanged();
  }
}

export class ElectronBackend implements BrowserBackend {
  readonly kind = "desktop" as const;

  private readonly tabs = new Map<TabId, ElectronTab>();
  private readonly lifecycleListeners = new Set<LifecycleListener>();
  private readonly observationListeners = new Set<ObservationListener>();
  private readonly downloadListeners = new Set<DownloadListener>();
  private readonly downloadTrackingSessions = new WeakSet<Electron.Session>();
  private activeTabId: TabId | null = null;
  /** Tab ids in activation order, most recent last — closing the active tab returns to the previous one. */
  private activationOrder: TabId[] = [];
  private attachedTabId: TabId | null = null;
  private viewport: ViewportRect = DEFAULT_VIEWPORT;

  constructor(
    private readonly window: BrowserWindow,
    private readonly appDir: string,
    private readonly pagePreloadPath: string,
    private readonly accounts: AccountStore
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
    webContents.on("did-start-navigation", (event, navigationUrl, _isInPlace, isMainFrame) => {
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
