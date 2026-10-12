import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { DownloadEntry, PageObservation, TabId, TabSummary } from "@helmstack/shared";
import type { Browser } from "puppeteer-core";

import type { BackendTab, BrowserBackend, TabLifecycleEvent } from "../../../packages/devtools-core/src/backend.js";
import { installPerception } from "../../../packages/devtools-core/src/perception/injector.js";
import { launchChrome, type ChromeHandle, type LaunchChromeOptions } from "./chrome.js";
import type { CdpSessionLike, ChromeCdpTarget } from "./chrome-cdp-target.js";
import { ChromeTabs, TabNotFoundError, type BrowserLike, type ChromeTabsEvent } from "./tabs.js";

/** ADR 0001 §6.2: Chrome's headless default is 800×600; the daemon renders at 1280×800. */
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** ADR 0001 §6.3: the daemon keeps its own data dir, apart from the desktop's. */
export function defaultDataDir(): string {
  return path.join(homedir(), ".helmstack", "daemon");
}

export type ChromeBackendOptions = {
  /** Root for daemon state. Downloads go to `<dataDir>/downloads`. Default `~/.helmstack/daemon`. */
  dataDir?: string;
  /** Overrides the download directory. */
  downloadsDir?: string;
  /** Content-area size reported by `defaultViewport()`. Default 1280×800. */
  viewport?: { width: number; height: number };
  /**
   * Resize each tab's window so its content area equals `viewport`. Default
   * false for `create` (never resize a user's Chrome), true for `launch`.
   */
  fitViewport?: boolean;
  /** Social-surface perception (desktop's `HELMSTACK_SOCIAL`). Default false. */
  includeSocial?: boolean;
  /** Load-wait timeout for `createTab`/`navigate`. Default 30000 ms. */
  navigationTimeoutMs?: number;
  /** Non-fatal errors (perception injection, download setup). Default: `console.warn`. */
  onError?: (error: Error) => void;
};

export type LaunchChromeBackendOptions = ChromeBackendOptions & {
  /** Passed to `launchChrome`; `windowSize` defaults to `viewport`. */
  chrome?: LaunchChromeOptions;
};

type DownloadWillBegin = { frameId: string; guid: string; url: string; suggestedFilename: string };
type DownloadProgress = {
  guid: string;
  totalBytes: number;
  receivedBytes: number;
  state: "inProgress" | "completed" | "canceled";
};

/** Navigation types that do not replace the document (Electron's in-page navigations). */
const SAME_DOCUMENT = new Set(["sameDocument", "historySameDocument"]);

class ChromeBackendTab implements BackendTab {
  readonly id: TabId;
  readonly parentTabId?: TabId;
  readonly cdp: ChromeCdpTarget;
  readonly #tabs: ChromeTabs;
  #last: TabSummary;

  constructor(id: TabId, tabs: ChromeTabs) {
    this.id = id;
    this.#tabs = tabs;
    this.cdp = tabs.get(id);
    const parent = tabs.parentOf(id);
    if (parent) this.parentTabId = parent;
    this.#last = tabs.summary(id);
  }

  /** Live summary; after the tab closes, the last one seen. */
  summary(): TabSummary {
    if (this.#tabs.has(this.id)) this.#last = this.#tabs.summary(this.id);
    return { ...this.#last };
  }

  title(): string {
    return this.summary().title;
  }

  /** `Page.navigate` and wait for the main frame to stop loading. Rejects on network errors (status "error"). */
  navigate(url: string): Promise<void> {
    return this.#tabs.navigate(this.id, url);
  }
}

type TabRecord = {
  tab: ChromeBackendTab;
  offEvents: () => void;
  /** Resolves (never rejects) once perception is installed or has failed. */
  perception: Promise<void>;
  disposePerception?: () => Promise<void>;
  /** Navigation loader ids already reported as main-frame-navigation. */
  navigations: Set<string>;
};

/**
 * `BrowserBackend` over a plain Chrome (ADR 0001 §4.1, WP-F).
 *
 * - Tabs come from `ChromeTabs` (one dedicated `CDPSession` per page wrapped in
 *   `ChromeCdpTarget`); pages opened by other pages are adopted with their
 *   opener as `parentTabId`.
 * - Lifecycle events are derived from each tab's own session (see `#onCdpEvent`)
 *   and from registry changes (open/close/url/title/status/active).
 * - Perception is injected once per tab over CDP (`installPerception`).
 * - Downloads use a browser-level session: `Browser.setDownloadBehavior` into
 *   `<dataDir>/downloads` plus `downloadWillBegin`/`downloadProgress`.
 * - No `pickElement`: there is no human at a headless browser.
 */
export class ChromeBackend implements BrowserBackend {
  readonly kind = "daemon" as const;
  readonly downloadsDir: string;
  readonly #tabs: ChromeTabs;
  readonly #downloadSession: CdpSessionLike;
  readonly #handle: ChromeHandle | null;
  readonly #viewport: { width: number; height: number };
  readonly #options: ChromeBackendOptions;
  readonly #records = new Map<TabId, TabRecord>();
  readonly #lifecycle = new Set<(event: TabLifecycleEvent) => void>();
  readonly #observations = new Set<(observation: PageObservation) => void>();
  readonly #downloadListeners = new Set<(tabId: TabId, download: DownloadEntry) => void>();
  readonly #downloads = new Map<string, DownloadEntry>();
  #closed = false;
  #closing: Promise<void> | null = null;
  readonly #onBrowserEvent = (type: string | symbol, payload: unknown): void => {
    if (type === "Browser.downloadWillBegin") this.#onDownloadBegin(payload as DownloadWillBegin);
    else if (type === "Browser.downloadProgress") this.#onDownloadProgress(payload as DownloadProgress);
  };

  private constructor(
    tabs: ChromeTabs,
    downloadSession: CdpSessionLike,
    downloadsDir: string,
    handle: ChromeHandle | null,
    options: ChromeBackendOptions
  ) {
    this.#tabs = tabs;
    this.#downloadSession = downloadSession;
    this.downloadsDir = downloadsDir;
    this.#handle = handle;
    this.#options = options;
    this.#viewport = { ...(options.viewport ?? DEFAULT_VIEWPORT) };
    downloadSession.on("*", this.#onBrowserEvent);
  }

  /** Wraps an already launched or connected browser. Existing pages are adopted. */
  static async create(browser: Browser | BrowserLike, options: ChromeBackendOptions = {}): Promise<ChromeBackend> {
    return ChromeBackend.#create(browser as unknown as BrowserLike, null, options);
  }

  /** Launches Chrome (headless, `pipe`, window = viewport) and owns it: `close()` kills it. */
  static async launch(options: LaunchChromeBackendOptions = {}): Promise<ChromeBackend> {
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const handle = await launchChrome({ windowSize: viewport, ...options.chrome });
    try {
      return await ChromeBackend.#create(handle.browser as unknown as BrowserLike, handle, {
        fitViewport: handle.mode === "launched",
        ...options,
        viewport
      });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  static async #create(browser: BrowserLike, handle: ChromeHandle | null, options: ChromeBackendOptions): Promise<ChromeBackend> {
    const dataDir = options.dataDir ?? defaultDataDir();
    const downloadsDir = options.downloadsDir ?? path.join(dataDir, "downloads");
    await mkdir(downloadsDir, { recursive: true });

    const downloadSession = (await browser.target().createCDPSession()) as unknown as CdpSessionLike;
    await downloadSession.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadsDir,
      eventsEnabled: true
    });

    // ChromeTabs adopts existing pages inside create(); buffer their events until the backend exists.
    const sink: { backend?: ChromeBackend } = {};
    const early: ChromeTabsEvent[] = [];
    const tabs = await ChromeTabs.create(browser, {
      navigationTimeoutMs: options.navigationTimeoutMs,
      viewport: options.fitViewport ? (options.viewport ?? DEFAULT_VIEWPORT) : undefined,
      onTabEvent: (event) => (sink.backend ? sink.backend.#onTabEvent(event) : early.push(event))
    });
    const backend = new ChromeBackend(tabs, downloadSession, downloadsDir, handle, options);
    sink.backend = backend;
    for (const event of early) backend.#onTabEvent(event);
    return backend;
  }

  /** PID of the Chrome this backend launched (undefined when connected). */
  get browserProcessId(): number | undefined {
    return this.#handle?.mode === "launched" ? this.#handle.browser.process()?.pid : undefined;
  }

  defaultViewport(): { width: number; height: number } {
    return { ...this.#viewport };
  }

  listTabs(): BackendTab[] {
    return [...this.#records.values()].map((record) => record.tab);
  }

  getTab(id: TabId): BackendTab | undefined {
    return this.#records.get(id)?.tab;
  }

  /**
   * Opens a tab, installs perception, then navigates and waits for load. Like
   * the desktop, a failed load does not reject: the tab is returned with
   * status "error".
   */
  async createTab(url: string, opts: { parentTabId?: TabId } = {}): Promise<BackendTab> {
    const summary = await this.#tabs.open(undefined, { parentTabId: opts.parentTabId });
    const record = this.#records.get(summary.id);
    if (!record) throw new Error(`Tab ${summary.id} closed while opening`);
    await record.perception;
    if (url) await record.tab.navigate(url).catch(() => {});
    return record.tab;
  }

  async closeTab(id: TabId): Promise<void> {
    if (!this.#records.has(id)) throw new TabNotFoundError(id);
    await this.#tabs.close(id);
  }

  onLifecycle(listener: (event: TabLifecycleEvent) => void): () => void {
    return subscribe(this.#lifecycle, listener);
  }

  onObservation(listener: (observation: PageObservation) => void): () => void {
    return subscribe(this.#observations, listener);
  }

  /**
   * Fires when a download starts and on every change after that, always with
   * the same (live) `DownloadEntry` object for a given `id`.
   */
  onDownload(listener: (tabId: TabId, download: DownloadEntry) => void): () => void {
    return subscribe(this.#downloadListeners, listener);
  }

  /**
   * Stops tracking. A launched Chrome is killed; a connected one gets its
   * perception scripts and download behaviour removed and is left running.
   * Idempotent.
   */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.#closed = true;
      const records = [...this.#records.values()];
      this.#records.clear();
      for (const record of records) record.offEvents();
      if (!this.#handle || this.#handle.mode === "connected") {
        await Promise.allSettled(records.map((record) => record.disposePerception?.()));
        await this.#downloadSession.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
      }
      this.#downloadSession.off("*", this.#onBrowserEvent);
      await this.#downloadSession.detach?.().catch(() => {});
      this.#tabs.dispose();
      this.#lifecycle.clear();
      this.#observations.clear();
      this.#downloadListeners.clear();
      await this.#handle?.close();
    })();
    return this.#closing;
  }

  #onTabEvent(event: ChromeTabsEvent): void {
    if (this.#closed) return;
    switch (event.type) {
      case "opened":
        this.#adopt(event.id);
        break;
      case "closed": {
        const record = this.#records.get(event.id);
        if (!record) return;
        this.#records.delete(event.id);
        record.offEvents();
        this.#emit({ type: "closed", tabId: event.id });
        this.#emit({ type: "summary-changed" });
        break;
      }
      case "changed":
        if (this.#records.has(event.id)) this.#emit({ type: "summary-changed" });
        break;
    }
  }

  #adopt(id: TabId): void {
    if (this.#records.has(id) || !this.#tabs.has(id)) return;
    const tab = new ChromeBackendTab(id, this.#tabs);
    const record: TabRecord = {
      tab,
      offEvents: () => {},
      perception: Promise.resolve(),
      navigations: new Set()
    };
    record.offEvents = tab.cdp.onEvent((method, params) => this.#onCdpEvent(record, method, params));
    this.#records.set(id, record);
    this.#emit({ type: "created", tab });
    this.#emit({ type: "summary-changed" });
    record.perception = installPerception(tab.cdp, {
      tabId: id,
      includeSocial: this.#options.includeSocial,
      onObservation: (observation) => {
        if (!this.#records.has(id)) return;
        // Chrome does not report document.title changes as target-info changes; perception sees them.
        this.#tabs.noteTitle(id, observation.title);
        for (const listener of [...this.#observations]) safeCall(() => listener(observation));
      },
      onError: (error) => this.#reportError(error)
    }).then(
      (dispose) => {
        record.disposePerception = dispose;
        // Closed (or backend closed) while installing: the session is gone or going.
        if (this.#records.get(id) !== record) void dispose();
      },
      (error: unknown) => {
        if (this.#records.get(id) === record) this.#reportError(error);
      }
    );
  }

  /**
   * CDP → lifecycle mapping (all on the tab's own session, main frame only):
   * - main-frame-navigation: first of `Page.frameStartedNavigating` (cross-document),
   *   `Network.requestWillBeSent` for the document request (`type` Document,
   *   `requestId === loaderId`) or `Page.frameNavigated`, de-duplicated by
   *   loader id. The first two precede the document request being recorded
   *   (Electron's `did-start-navigation`); the commit is a fallback.
   * - load-finished: `Page.loadEventFired` (Electron's `did-finish-load`).
   */
  #onCdpEvent(record: TabRecord, method: string, params: Record<string, unknown>): void {
    const tabId = record.tab.id;
    const mainFrameId = record.tab.cdp.mainFrameId();
    switch (method) {
      case "Page.frameStartedNavigating":
        if (params.frameId === mainFrameId && !SAME_DOCUMENT.has(String(params.navigationType))) {
          this.#mainFrameNavigation(record, String(params.loaderId ?? ""), String(params.url));
        }
        break;
      case "Network.requestWillBeSent":
        if (params.type === "Document" && params.frameId === mainFrameId && params.requestId === params.loaderId) {
          this.#mainFrameNavigation(record, String(params.loaderId), (params.request as { url: string }).url);
        }
        break;
      case "Page.frameNavigated": {
        const frame = params.frame as { id: string; parentId?: string; url: string; urlFragment?: string; loaderId?: string };
        if (!frame.parentId) this.#mainFrameNavigation(record, frame.loaderId ?? "", frame.url + (frame.urlFragment ?? ""));
        break;
      }
      case "Page.loadEventFired":
        this.#emit({ type: "load-finished", tabId });
        break;
    }
  }

  #mainFrameNavigation(record: TabRecord, loaderId: string, url: string): void {
    if (loaderId) {
      if (record.navigations.has(loaderId)) return;
      if (record.navigations.size > 32) record.navigations.clear();
      record.navigations.add(loaderId);
    }
    this.#emit({ type: "main-frame-navigation", tabId: record.tab.id, url });
  }

  #onDownloadBegin(event: DownloadWillBegin): void {
    const tabId = this.#tabs.tabForFrame(event.frameId);
    if (!tabId || !this.#records.has(tabId)) return; // not one of our tabs (desktop ignores these too)
    const download: DownloadEntry = {
      id: event.guid,
      tabId,
      url: event.url,
      filename: event.suggestedFilename,
      totalBytes: 0,
      receivedBytes: 0,
      state: "progressing",
      startedAt: Date.now()
    };
    this.#downloads.set(event.guid, download);
    this.#emitDownload(download);
  }

  #onDownloadProgress(event: DownloadProgress): void {
    const download = this.#downloads.get(event.guid);
    if (!download) return;
    const state: DownloadEntry["state"] =
      event.state === "completed" ? "completed" : event.state === "canceled" ? "cancelled" : "progressing";
    if (download.state === state && download.receivedBytes === event.receivedBytes && download.totalBytes === event.totalBytes) {
      return;
    }
    download.receivedBytes = event.receivedBytes;
    download.totalBytes = event.totalBytes;
    download.state = state;
    if (state !== "progressing") {
      download.finishedAt = Date.now();
      this.#downloads.delete(event.guid);
    }
    this.#emitDownload(download);
  }

  #emitDownload(download: DownloadEntry): void {
    for (const listener of [...this.#downloadListeners]) safeCall(() => listener(download.tabId, download));
  }

  #emit(event: TabLifecycleEvent): void {
    for (const listener of [...this.#lifecycle]) safeCall(() => listener(event));
  }

  #reportError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    if (this.#options.onError) safeCall(() => this.#options.onError!(err));
    else console.warn("[ChromeBackend]", err.message);
  }
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // A faulty subscriber must not break delivery to others.
  }
}
