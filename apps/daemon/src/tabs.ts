import type { CdpTarget, TabId, TabStatus, TabSummary } from "@helmstack/shared";
import type { Browser, Page, Target } from "puppeteer-core";

import { ChromeCdpTarget } from "./chrome-cdp-target.js";

export type ChromeTabsOptions = {
  /** Default timeout for `open`/`navigate` load waits. Default 30000 ms. */
  navigationTimeoutMs?: number;
  /** Also track pages opened outside this registry (popups, `window.open`, other clients). Default true. */
  adoptExternalPages?: boolean;
};

export type ScreenshotOptions = {
  /** Capture the full scrollable page instead of just the viewport. */
  fullPage?: boolean;
};

type Entry = {
  id: TabId;
  page: Page;
  target: ChromeCdpTarget;
  status: TabStatus;
  statusMessage?: string;
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
 * on its own CDP session.
 */
export class ChromeTabs {
  readonly #browser: Browser;
  readonly #timeoutMs: number;
  readonly #entries = new Map<TabId, Entry>();
  readonly #pending = new Map<Page, Promise<Entry>>();
  readonly #listeners = new Set<() => void>();
  #activeId: TabId | null = null;
  #nextId = 1;
  #disposed = false;
  readonly #onTargetCreated = (target: Target): void => {
    if (target.type() !== "page") return;
    void target
      .page()
      .then((page) => (page && !this.#disposed ? this.#register(page, false) : undefined))
      .catch(() => {});
  };

  private constructor(browser: Browser, options: ChromeTabsOptions) {
    this.#browser = browser;
    this.#timeoutMs = options.navigationTimeoutMs ?? 30_000;
    if (options.adoptExternalPages ?? true) browser.on("targetcreated", this.#onTargetCreated);
  }

  /** Creates a registry and adopts the browser's existing pages (e.g. when connected to a running Chrome). */
  static async create(browser: Browser, options: ChromeTabsOptions = {}): Promise<ChromeTabs> {
    const tabs = new ChromeTabs(browser, options);
    if (options.adoptExternalPages ?? true) {
      for (const page of await browser.pages()) await tabs.#register(page, false).catch(() => {});
    }
    return tabs;
  }

  /** Opens a new tab, optionally navigating it to `url` and waiting for load. */
  async open(url?: string): Promise<TabSummary> {
    const page = await this.#browser.newPage();
    const entry = await this.#register(page, true);
    if (url) await this.navigate(entry.id, url);
    return this.#summary(entry);
  }

  async list(): Promise<TabSummary[]> {
    return Promise.all([...this.#entries.values()].map((entry) => this.#summary(entry)));
  }

  /** The tab's `CdpTarget`. Throws `TabNotFoundError` for unknown ids. */
  get(id: TabId): CdpTarget {
    return this.#entry(id).target;
  }

  has(id: TabId): boolean {
    return this.#entries.has(id);
  }

  get activeId(): TabId | null {
    return this.#activeId;
  }

  /** Brings a tab to the front and marks it active. */
  async activate(id: TabId): Promise<void> {
    const entry = this.#entry(id);
    await entry.page.bringToFront();
    this.#activeId = id;
    this.#emit();
  }

  /** Navigates and waits for the main frame to stop loading. Navigation errors set status "error" and throw. */
  async navigate(id: TabId, url: string, timeoutMs = this.#timeoutMs): Promise<void> {
    const entry = this.#entry(id);
    entry.status = "loading";
    entry.statusMessage = undefined;
    this.#emit();
    try {
      await entry.target.navigate(url, timeoutMs);
      entry.status = entry.target.isLoading() ? "loading" : "idle";
    } catch (error) {
      entry.status = "error";
      entry.statusMessage = (error as Error).message;
      throw error;
    } finally {
      this.#emit();
    }
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

  /** Called whenever tabs are opened/closed or a tab's url/status changes. Returns an unsubscribe function. */
  onTabsChanged(listener: () => void): () => void {
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
    for (const entry of [...this.#entries.values()]) this.#forget(entry, false);
    this.#listeners.clear();
  }

  #entry(id: TabId): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new TabNotFoundError(id);
    return entry;
  }

  /** Idempotent per page: concurrent open() + targetcreated resolve to the same entry. */
  #register(page: Page, activate: boolean): Promise<Entry> {
    let pending = this.#pending.get(page);
    if (!pending) {
      pending = this.#createEntry(page);
      this.#pending.set(page, pending);
      pending.catch(() => this.#pending.delete(page));
    }
    return pending.then((entry) => {
      if (activate && this.#entries.has(entry.id)) {
        this.#activeId = entry.id;
        this.#emit();
      }
      return entry;
    });
  }

  async #createEntry(page: Page): Promise<Entry> {
    const session = await page.createCDPSession();
    const target = await ChromeCdpTarget.attach(session);
    const id = `tab-${this.#nextId++}`;
    const entry: Entry = {
      id,
      page,
      target,
      status: target.isLoading() ? "loading" : "idle",
      unsubscribe: () => {}
    };
    const offEvent = target.onEvent((method) => {
      if (method === "Page.frameStartedLoading" || method === "Page.frameStoppedLoading") {
        const next: TabStatus = target.isLoading() ? "loading" : entry.status === "error" ? "error" : "idle";
        if (next !== entry.status) {
          entry.status = next;
          this.#emit();
        }
      } else if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument") {
        this.#emit();
      }
    });
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
    this.#entries.set(id, entry);
    this.#activeId ??= id;
    this.#emit();
    return entry;
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
    if (emit) this.#emit();
  }

  async #summary(entry: Entry): Promise<TabSummary> {
    let title = "";
    let url = entry.target.url();
    try {
      const { targetInfo } = await entry.target.send<{ targetInfo: { title: string; url: string } }>(
        "Target.getTargetInfo"
      );
      title = targetInfo.title;
      url = targetInfo.url || url;
    } catch {
      // Tab is closing; fall back to tracked state.
    }
    const summary: TabSummary = {
      id: entry.id,
      title,
      url,
      isActive: entry.id === this.#activeId,
      status: entry.status
    };
    if (entry.statusMessage) summary.statusMessage = entry.statusMessage;
    return summary;
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // Listener errors must not break the registry.
      }
    }
  }
}
