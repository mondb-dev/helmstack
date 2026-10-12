import type { TabId, TabStatus, TabSummary } from "@helmstack/shared";
import type { Browser, CDPSession } from "puppeteer-core";

import { ChromeCdpTarget, type CdpSessionLike } from "./chrome-cdp-target.js";

export type ChromeTabsOptions = {
  /** Default timeout for `open`/`navigate` load waits. Default 30000 ms. */
  navigationTimeoutMs?: number;
  /** Also track pages opened outside this registry (popups, `window.open`, other clients). Default true. */
  adoptExternalPages?: boolean;
  /**
   * Size every tab's window so its content area (`innerWidth`×`innerHeight`) is
   * exactly this. Chrome's `--window-size` sets the outer window size, which in
   * headless mode leaves the viewport ~87 px shorter. Off by default so a
   * connected (user-owned) Chrome is never resized.
   */
  viewport?: { width: number; height: number };
  /** Subscribed before existing pages are adopted, so it also sees their "opened" events. */
  onTabEvent?: (event: ChromeTabsEvent) => void;
};

export type ScreenshotOptions = {
  /** Capture the full scrollable page instead of just the viewport. */
  fullPage?: boolean;
};

export type OpenTabOptions = {
  /** Recorded as the tab's `parentTabId`. Pages opened by a tracked page get their opener's id automatically. */
  parentTabId?: TabId;
};

/** Typed registry notifications. `onTabsChanged` fires for every one of these. */
export type ChromeTabsEvent =
  | { type: "opened"; id: TabId }
  | { type: "closed"; id: TabId }
  /** url, title, status or the active tab changed. */
  | { type: "changed"; id: TabId };

/** The slice of a puppeteer `Page` the registry uses (structural so tests can pass fakes). */
export interface PageLike {
  createCDPSession(): Promise<CdpSessionLike | CDPSession>;
  once(event: "close", handler: () => void): unknown;
  off(event: "close", handler: () => void): unknown;
  isClosed(): boolean;
  close(): Promise<void>;
  bringToFront(): Promise<void>;
}

export interface TargetLike {
  type(): string;
  page(): Promise<PageLike | null>;
}

/** The slice of a puppeteer `Browser` the registry uses. */
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  pages(): Promise<PageLike[]>;
  on(event: "targetcreated", handler: (target: TargetLike) => void): unknown;
  off(event: "targetcreated", handler: (target: TargetLike) => void): unknown;
  /** The browser target; used for a browser-level CDP session (target discovery, window bounds). */
  target(): { createCDPSession(): Promise<CdpSessionLike | CDPSession> };
}

type TargetInfo = { targetId: string; type?: string; title: string; url: string; openerId?: string };

type Entry = {
  id: TabId;
  page: PageLike;
  target: ChromeCdpTarget;
  /** Chrome target id; also the main frame's id. */
  targetId: string;
  parentTabId?: TabId;
  /** Cached so summaries never need a CDP round-trip. */
  title: string;
  status: TabStatus;
  statusMessage?: string;
  /** Frame ids seen in this page (for attributing browser-level events such as downloads). */
  frames: Set<string>;
  unsubscribe: () => void;
};

/** Thrown when a tab id is unknown or the tab has been closed. */
export class TabNotFoundError extends Error {
  constructor(id: string) {
    super(`No tab with id "${id}"`);
    this.name = "TabNotFoundError";
  }
}

/**
 * Registry of Chrome pages, addressed by stable ids (`tab-1`, `tab-2`, …) that
 * are never reused within a registry. Each tab is backed by a `ChromeCdpTarget`
 * on its own CDP session; titles come from a browser-level session
 * (`Target.targetInfoChanged`), a refresh on every main-frame load stop, and
 * `noteTitle` (fed by perception, which sees `document.title` mutations Chrome
 * does not report as target-info changes).
 */
export class ChromeTabs {
  readonly #browser: BrowserLike;
  readonly #browserSession: CdpSessionLike;
  readonly #timeoutMs: number;
  readonly #viewport: { width: number; height: number } | undefined;
  readonly #entries = new Map<TabId, Entry>();
  readonly #pending = new Map<PageLike, Promise<Entry>>();
  readonly #parentHints = new Map<PageLike, TabId>();
  readonly #listeners = new Set<(event: ChromeTabsEvent) => void>();
  #activeId: TabId | null = null;
  #nextId = 1;
  #disposed = false;
  readonly #onTargetCreated = (target: TargetLike): void => {
    if (target.type() !== "page") return;
    void target
      .page()
      .then((page) => (page && !this.#disposed ? this.#register(page, false) : undefined))
      .catch(() => {});
  };
  readonly #onBrowserEvent = (type: string | symbol, payload: unknown): void => {
    if (type === "Target.targetInfoChanged") {
      const { targetInfo } = payload as { targetInfo: TargetInfo };
      const entry = this.#byTargetId(targetInfo.targetId);
      if (entry) this.#setTitle(entry, targetInfo.title);
    } else if (type === "Target.targetDestroyed") {
      const entry = this.#byTargetId((payload as { targetId: string }).targetId);
      if (entry) this.#forget(entry);
    }
  };

  private constructor(browser: BrowserLike, browserSession: CdpSessionLike, options: ChromeTabsOptions) {
    this.#browser = browser;
    this.#browserSession = browserSession;
    this.#timeoutMs = options.navigationTimeoutMs ?? 30_000;
    this.#viewport = options.viewport;
    if (options.onTabEvent) this.#listeners.add(options.onTabEvent);
    browserSession.on("*", this.#onBrowserEvent);
    if (options.adoptExternalPages ?? true) browser.on("targetcreated", this.#onTargetCreated);
  }

  /** Creates a registry and adopts the browser's existing pages (e.g. when connected to a running Chrome). */
  static async create(browser: Browser | BrowserLike, options: ChromeTabsOptions = {}): Promise<ChromeTabs> {
    const b = browser as unknown as BrowserLike;
    const session = (await b.target().createCDPSession()) as unknown as CdpSessionLike;
    const tabs = new ChromeTabs(b, session, options);
    await session.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    if (options.adoptExternalPages ?? true) {
      for (const page of await b.pages()) await tabs.#register(page, false).catch(() => {});
    }
    return tabs;
  }

  /** Opens a new tab, optionally navigating it to `url` and waiting for load. */
  async open(url?: string, options: OpenTabOptions = {}): Promise<TabSummary> {
    const page = await this.#browser.newPage();
    if (options.parentTabId) this.#parentHints.set(page, options.parentTabId);
    const entry = await this.#register(page, true);
    if (url) await this.navigate(entry.id, url);
    return this.#summary(entry);
  }

  list(): TabSummary[] {
    return [...this.#entries.values()].map((entry) => this.#summary(entry));
  }

  /** Synchronous summary from cached state. Throws `TabNotFoundError` for unknown ids. */
  summary(id: TabId): TabSummary {
    return this.#summary(this.#entry(id));
  }

  /** The tab's `CdpTarget`. Throws `TabNotFoundError` for unknown ids. */
  get(id: TabId): ChromeCdpTarget {
    return this.#entry(id).target;
  }

  has(id: TabId): boolean {
    return this.#entries.has(id);
  }

  parentOf(id: TabId): TabId | undefined {
    return this.#entry(id).parentTabId;
  }

  /** The tab owning a frame (main frame = target id, or any frame seen in that page). */
  tabForFrame(frameId: string): TabId | undefined {
    for (const entry of this.#entries.values()) {
      if (entry.targetId === frameId || entry.frames.has(frameId)) return entry.id;
    }
    return undefined;
  }

  get activeId(): TabId | null {
    return this.#activeId;
  }

  /** Brings a tab to the front and marks it active. */
  async activate(id: TabId): Promise<void> {
    const entry = this.#entry(id);
    await entry.page.bringToFront();
    this.#activeId = id;
    this.#emit({ type: "changed", id });
  }

  /** Navigates and waits for the main frame to stop loading. Navigation errors set status "error" and throw. */
  async navigate(id: TabId, url: string, timeoutMs = this.#timeoutMs): Promise<void> {
    const entry = this.#entry(id);
    entry.status = "loading";
    entry.statusMessage = undefined;
    this.#emit({ type: "changed", id });
    try {
      await entry.target.navigate(url, timeoutMs);
      entry.status = entry.target.isLoading() ? "loading" : "idle";
      await this.#refreshTitle(entry);
    } catch (error) {
      entry.status = "error";
      entry.statusMessage = (error as Error).message;
      throw error;
    } finally {
      this.#emit({ type: "changed", id });
    }
  }

  /**
   * Records a title observed by other means (e.g. perception's `document.title`).
   * Empty titles are ignored: Chrome reports the URL for untitled pages.
   */
  noteTitle(id: TabId, title: string): void {
    const entry = this.#entries.get(id);
    if (entry && title) this.#setTitle(entry, title);
  }

  async close(id: TabId): Promise<void> {
    const entry = this.#entry(id);
    this.#forget(entry);
    await entry.page.close().catch(() => {});
  }

  async setViewport(id: TabId, width: number, height: number, deviceScaleFactor = 1): Promise<void> {
    await this.#entry(id).target.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor,
      mobile: false
    });
  }

  /** PNG screenshot of the viewport, or of the full scrollable page with `fullPage`. */
  async screenshot(id: TabId, options: ScreenshotOptions = {}): Promise<Buffer> {
    const target = this.#entry(id).target;
    const params: Record<string, unknown> = { format: "png", fromSurface: true };
    if (options.fullPage) {
      const metrics = await target.send<{ cssContentSize?: { width: number; height: number }; contentSize: { width: number; height: number } }>(
        "Page.getLayoutMetrics"
      );
      const size = metrics.cssContentSize ?? metrics.contentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    }
    const { data } = await target.send<{ data: string }>("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }

  /** Called whenever tabs are opened/closed or a tab's url/title/status changes. Returns an unsubscribe function. */
  onTabsChanged(listener: () => void): () => void {
    return this.onTabEvent(() => listener());
  }

  /** Typed variant of `onTabsChanged`. Returns an unsubscribe function. */
  onTabEvent(listener: (event: ChromeTabsEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops tracking; does not close pages (close the browser for that). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#browser.off("targetcreated", this.#onTargetCreated);
    this.#browserSession.off("*", this.#onBrowserEvent);
    void this.#browserSession.detach?.().catch(() => {});
    for (const entry of [...this.#entries.values()]) this.#forget(entry, false);
    this.#listeners.clear();
  }

  #entry(id: TabId): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new TabNotFoundError(id);
    return entry;
  }

  #byTargetId(targetId: string): Entry | undefined {
    for (const entry of this.#entries.values()) if (entry.targetId === targetId) return entry;
    return undefined;
  }

  /** Idempotent per page: concurrent open() + targetcreated resolve to the same entry. */
  #register(page: PageLike, activate: boolean): Promise<Entry> {
    let pending = this.#pending.get(page);
    if (!pending) {
      pending = this.#createEntry(page);
      this.#pending.set(page, pending);
      pending.catch(() => this.#pending.delete(page));
    }
    return pending.then((entry) => {
      if (activate && this.#entries.has(entry.id) && this.#activeId !== entry.id) {
        this.#activeId = entry.id;
        this.#emit({ type: "changed", id: entry.id });
      }
      return entry;
    });
  }

  async #createEntry(page: PageLike): Promise<Entry> {
    const session = (await page.createCDPSession()) as unknown as CdpSessionLike;
    const target = await ChromeCdpTarget.attach(session);
    const { targetInfo } = await target.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo");
    if (this.#viewport) await this.#fitWindow(targetInfo.targetId, target, this.#viewport).catch(() => {});

    const hinted = this.#parentHints.get(page);
    this.#parentHints.delete(page);
    const opener = targetInfo.openerId ? this.#byTargetId(targetInfo.openerId)?.id : undefined;
    const entry: Entry = {
      id: `tab-${this.#nextId++}`,
      page,
      target,
      targetId: targetInfo.targetId,
      title: targetInfo.title,
      status: target.isLoading() ? "loading" : "idle",
      frames: new Set([target.mainFrameId()]),
      unsubscribe: () => {}
    };
    const parentTabId = hinted ?? opener;
    if (parentTabId) entry.parentTabId = parentTabId;

    const offEvent = target.onEvent((method, params) => this.#onPageEvent(entry, method, params));
    const onClose = (): void => this.#forget(entry);
    page.once("close", onClose);
    entry.unsubscribe = () => {
      offEvent();
      page.off("close", onClose);
    };

    if (this.#disposed || page.isClosed()) {
      entry.unsubscribe();
      target.dispose();
      throw new Error("Page closed before it was registered");
    }
    this.#entries.set(entry.id, entry);
    this.#activeId ??= entry.id;
    this.#emit({ type: "opened", id: entry.id });
    return entry;
  }

  #onPageEvent(entry: Entry, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "Page.frameStartedLoading":
      case "Page.frameStoppedLoading": {
        const next: TabStatus = entry.target.isLoading() ? "loading" : entry.status === "error" ? "error" : "idle";
        if (next !== entry.status) {
          entry.status = next;
          this.#emit({ type: "changed", id: entry.id });
        }
        if (method === "Page.frameStoppedLoading" && params.frameId === entry.target.mainFrameId()) {
          void this.#refreshTitle(entry);
        }
        break;
      }
      case "Page.frameAttached":
        entry.frames.add(String(params.frameId));
        break;
      case "Page.frameDetached":
        if (params.frameId !== entry.target.mainFrameId()) entry.frames.delete(String(params.frameId));
        break;
      case "Page.frameNavigated": {
        const frame = params.frame as { id: string; parentId?: string };
        entry.frames.add(frame.id);
        if (!frame.parentId) this.#emit({ type: "changed", id: entry.id });
        break;
      }
      case "Page.navigatedWithinDocument":
        if (params.frameId === entry.target.mainFrameId()) this.#emit({ type: "changed", id: entry.id });
        break;
    }
  }

  async #refreshTitle(entry: Entry): Promise<void> {
    try {
      const { targetInfo } = await entry.target.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo");
      this.#setTitle(entry, targetInfo.title);
    } catch {
      // Tab is closing; keep the cached title.
    }
  }

  #setTitle(entry: Entry, title: string): void {
    if (entry.title === title || this.#entries.get(entry.id) !== entry) return;
    entry.title = title;
    this.#emit({ type: "changed", id: entry.id });
  }

  /** Resizes the page's window so its content area matches `size`. */
  async #fitWindow(targetId: string, target: ChromeCdpTarget, size: { width: number; height: number }): Promise<void> {
    const [innerWidth, innerHeight] = await target.evaluate<[number, number]>("[innerWidth, innerHeight]");
    if (innerWidth === size.width && innerHeight === size.height) return;
    const { windowId, bounds } = (await this.#browserSession.send("Browser.getWindowForTarget", { targetId })) as {
      windowId: number;
      bounds: { width: number; height: number; windowState?: string };
    };
    if (bounds.windowState && bounds.windowState !== "normal") return;
    await this.#browserSession.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: bounds.width + size.width - innerWidth, height: bounds.height + size.height - innerHeight }
    });
  }

  #forget(entry: Entry, emit = true): void {
    if (this.#entries.get(entry.id) !== entry) return;
    this.#entries.delete(entry.id);
    this.#pending.delete(entry.page);
    entry.unsubscribe();
    entry.target.dispose();
    if (this.#activeId === entry.id) {
      const last = [...this.#entries.keys()].pop();
      this.#activeId = last ?? null;
    }
    if (emit) this.#emit({ type: "closed", id: entry.id });
  }

  #summary(entry: Entry): TabSummary {
    const summary: TabSummary = {
      id: entry.id,
      title: entry.title,
      url: entry.target.url(),
      isActive: entry.id === this.#activeId,
      status: entry.status
    };
    if (entry.statusMessage) summary.statusMessage = entry.statusMessage;
    return summary;
  }

  #emit(event: ChromeTabsEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break the registry.
      }
    }
  }
}
