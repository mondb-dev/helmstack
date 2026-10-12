// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DownloadEntry, PageObservation, TabId } from "@helmstack/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TabLifecycleEvent } from "../../../packages/devtools-core/src/backend.js";
import { PERCEPTION_BINDING_NAME } from "../../../packages/devtools-core/src/perception/injector.js";
import { ChromeBackend } from "../src/chrome-backend.js";
import type { CdpSessionLike } from "../src/chrome-cdp-target.js";
import type { BrowserLike, PageLike, TargetLike } from "../src/tabs.js";

type Handler = (type: string | symbol, payload: unknown) => void;

/** Mimics puppeteer's mitt-backed "*" wildcard delivery. Unknown methods answer `{}`. */
class FakeSession implements CdpSessionLike {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly handlers = new Set<Handler>();
  responses: Record<string, (params?: Record<string, unknown>) => unknown> = {};

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    return this.responses[method]?.(params) ?? {};
  }
  on(_type: "*", handler: Handler): unknown {
    this.handlers.add(handler);
    return this;
  }
  off(_type: "*", handler: Handler): unknown {
    this.handlers.delete(handler);
    return this;
  }
  emit(type: string, payload: unknown = {}): void {
    for (const h of [...this.handlers]) h(type, payload);
  }
  count(method: string): number {
    return this.sent.filter((s) => s.method === method).length;
  }
}

class FakePage implements PageLike {
  readonly session = new FakeSession();
  readonly closeHandlers = new Set<() => void>();
  closed = false;

  constructor(
    readonly targetId: string,
    info: { url?: string; title?: string; openerId?: string } = {}
  ) {
    const url = info.url ?? "about:blank";
    this.session.responses = {
      "Page.getFrameTree": () => ({ frameTree: { frame: { id: targetId, url } } }),
      "Runtime.evaluate": (p) =>
        p?.expression === "document.readyState" ? { result: { type: "string", value: "complete" } } : { result: { type: "undefined" } },
      "Target.getTargetInfo": () => ({
        targetInfo: { targetId, type: "page", title: info.title ?? url, url, openerId: info.openerId }
      }),
      "Page.addScriptToEvaluateOnNewDocument": () => ({ identifier: "script-1" }),
      "Page.createIsolatedWorld": () => ({ executionContextId: 7 })
    };
  }
  async createCDPSession() {
    return this.session;
  }
  once(_event: "close", handler: () => void) {
    this.closeHandlers.add(handler);
  }
  off(_event: "close", handler: () => void) {
    this.closeHandlers.delete(handler);
  }
  isClosed() {
    return this.closed;
  }
  async close() {
    this.closed = true;
    for (const h of [...this.closeHandlers]) h();
  }
  async bringToFront() {}
}

class FakeBrowser implements BrowserLike {
  readonly browserSessions: FakeSession[] = [];
  readonly created = new Set<(target: TargetLike) => void>();
  #next = 1;

  constructor(readonly existing: FakePage[] = []) {}

  async newPage(): Promise<FakePage> {
    const page = new FakePage(`T${this.#next++}`);
    this.announce(page);
    return page;
  }
  async pages() {
    return this.existing;
  }
  on(_event: "targetcreated", handler: (target: TargetLike) => void) {
    this.created.add(handler);
  }
  off(_event: "targetcreated", handler: (target: TargetLike) => void) {
    this.created.delete(handler);
  }
  target() {
    return {
      createCDPSession: async () => {
        const session = new FakeSession();
        this.browserSessions.push(session);
        return session;
      }
    };
  }
  announce(page: FakePage): void {
    for (const h of [...this.created]) h({ type: () => "page", page: async () => page });
  }
  /** Delivers a browser-level event to every browser session. */
  emit(type: string, payload: unknown): void {
    for (const s of this.browserSessions) s.emit(type, payload);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function observationPayload(overrides: Partial<PageObservation> = {}): string {
  return JSON.stringify({
    url: "https://example.test/",
    title: "",
    pageKind: "form",
    forms: [{ name: "contact", fields: [], submitActions: [] }],
    primaryActions: [],
    headings: [],
    alerts: [],
    media: [],
    ...overrides
  });
}

describe("ChromeBackend (fakes)", () => {
  let dataDir: string;
  let browser: FakeBrowser;
  let backend: ChromeBackend;
  let events: TabLifecycleEvent[];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "helmstack-backend-test-"));
    browser = new FakeBrowser([new FakePage("EXISTING", { url: "https://example.test/", title: "Existing" })]);
    backend = await ChromeBackend.create(browser, { dataDir, onError: () => {} });
    events = [];
    backend.onLifecycle((e) => events.push(e));
  });

  afterEach(async () => {
    await backend.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("is a daemon backend without pickElement, reporting the launch viewport", () => {
    expect(backend.kind).toBe("daemon");
    expect("pickElement" in backend).toBe(false);
    expect(backend.defaultViewport()).toEqual({ width: 1280, height: 800 });
  });

  it("adopts existing pages and installs perception once per tab", async () => {
    await flush();
    const [tab] = backend.listTabs();
    expect(tab?.summary()).toMatchObject({ id: "tab-1", title: "Existing", url: "https://example.test/", status: "idle" });
    const session = browser.existing[0]!.session;
    expect(session.count("Page.addScriptToEvaluateOnNewDocument")).toBe(1);
    expect(session.count("Runtime.addBinding")).toBe(1);
  });

  it("creates tabs: created, then perception, then navigation; createTab does not reject on load failure", async () => {
    browser.on("targetcreated", ({ page }) => {
      void page().then((p) => {
        const s = (p as FakePage).session;
        s.responses["Page.navigate"] = () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED", loaderId: "L" });
      });
    });
    const tab = await backend.createTab("https://nowhere.invalid/", { parentTabId: "tab-1" as TabId });
    expect(tab.parentTabId).toBe("tab-1");
    expect(events[0]).toEqual({ type: "created", tab });
    expect(tab.summary().status).toBe("error");
    expect(tab.summary().statusMessage).toMatch(/ERR_NAME_NOT_RESOLVED/);
    expect(backend.getTab(tab.id)).toBe(tab);
  });

  it("perception is installed before createTab navigates", async () => {
    const order: string[] = [];
    browser.on("targetcreated", ({ page }) => {
      void page().then((p) => {
        const s = (p as FakePage).session;
        const send = s.send.bind(s);
        s.send = async (method, params) => {
          if (method === "Page.addScriptToEvaluateOnNewDocument" || method === "Page.navigate") order.push(method);
          return send(method, params);
        };
      });
    });
    await backend.createTab("https://example.test/");
    expect(order).toEqual(["Page.addScriptToEvaluateOnNewDocument", "Page.navigate"]);
  });

  it("maps CDP navigation events to one main-frame-navigation per loader, before the document request", async () => {
    await flush();
    const tab = backend.listTabs()[0]!;
    const s = browser.existing[0]!.session;
    const order: string[] = [];
    backend.onLifecycle((e) => order.push(`L:${e.type}`));
    tab.cdp.onEvent((m, p) => {
      if (m === "Network.requestWillBeSent") order.push(`C:${String(p.type)}`);
    });
    events.length = 0;

    s.emit("Page.frameStartedNavigating", { frameId: "EXISTING", url: "https://a.test/", loaderId: "L1", navigationType: "differentDocument" });
    s.emit("Network.requestWillBeSent", { requestId: "L1", loaderId: "L1", frameId: "EXISTING", type: "Document", request: { url: "https://a.test/" } });
    s.emit("Page.frameNavigated", { frame: { id: "EXISTING", loaderId: "L1", url: "https://a.test/" } });
    s.emit("Page.loadEventFired", { timestamp: 1 });
    // Without frameStartedNavigating (older Chrome), the document request still triggers it.
    s.emit("Network.requestWillBeSent", { requestId: "L2", loaderId: "L2", frameId: "EXISTING", type: "Document", request: { url: "https://b.test/" } });
    // Subresources, subframes, redirects of the same loader and same-document navigations do not.
    s.emit("Network.requestWillBeSent", { requestId: "R9", loaderId: "L2", frameId: "EXISTING", type: "Script", request: { url: "https://b.test/x.js" } });
    s.emit("Network.requestWillBeSent", { requestId: "L2", loaderId: "L2", frameId: "EXISTING", type: "Document", request: { url: "https://b.test/2" } });
    s.emit("Page.frameNavigated", { frame: { id: "CHILD", parentId: "EXISTING", loaderId: "L3", url: "https://c.test/" } });
    s.emit("Page.frameStartedNavigating", { frameId: "EXISTING", url: "https://b.test/#x", loaderId: "L4", navigationType: "sameDocument" });
    // Commit-only fallback.
    s.emit("Page.frameNavigated", { frame: { id: "EXISTING", loaderId: "L5", url: "https://d.test/" } });

    const navs = events.filter((e) => e.type === "main-frame-navigation");
    expect(navs).toEqual([
      { type: "main-frame-navigation", tabId: tab.id, url: "https://a.test/" },
      { type: "main-frame-navigation", tabId: tab.id, url: "https://b.test/" },
      { type: "main-frame-navigation", tabId: tab.id, url: "https://d.test/" }
    ]);
    expect(events.filter((e) => e.type === "load-finished")).toEqual([{ type: "load-finished", tabId: tab.id }]);
    expect(order.indexOf("L:main-frame-navigation")).toBeLessThan(order.indexOf("C:Document"));
    // url changes surface as summary-changed too.
    expect(events.some((e) => e.type === "summary-changed")).toBe(true);
  });

  it("feeds observations (tab id stamped) and turns title changes into summary-changed", async () => {
    await flush();
    const tab = backend.listTabs()[0]!;
    const seen: PageObservation[] = [];
    backend.onObservation((o) => seen.push(o));
    const s = browser.existing[0]!.session;

    events.length = 0;
    s.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: observationPayload({ title: "From DOM" }) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tabId: tab.id, title: "From DOM" });
    expect(seen[0]!.forms).toHaveLength(1);
    expect(tab.title()).toBe("From DOM");
    expect(events).toEqual([{ type: "summary-changed" }]);

    // Same title again: no event. Chrome-side target info change: event.
    events.length = 0;
    s.emit("Runtime.bindingCalled", { name: PERCEPTION_BINDING_NAME, payload: observationPayload({ title: "From DOM" }) });
    expect(events).toEqual([]);
    browser.emit("Target.targetInfoChanged", { targetInfo: { targetId: "EXISTING", type: "page", title: "From Chrome", url: "https://example.test/" } });
    expect(tab.title()).toBe("From Chrome");
    expect(events).toEqual([{ type: "summary-changed" }]);
  });

  it("tracks downloads on a browser session into <dataDir>/downloads", async () => {
    await flush();
    const tab = backend.listTabs()[0]!;
    const setBehavior = browser.browserSessions.flatMap((s) => s.sent).find((m) => m.method === "Browser.setDownloadBehavior");
    expect(setBehavior?.params).toEqual({ behavior: "allow", downloadPath: path.join(dataDir, "downloads"), eventsEnabled: true });
    expect(backend.downloadsDir).toBe(path.join(dataDir, "downloads"));

    const seen: Array<[TabId, DownloadEntry]> = [];
    backend.onDownload((tabId, d) => seen.push([tabId, { ...d }]));
    browser.emit("Browser.downloadWillBegin", { frameId: "EXISTING", guid: "g1", url: "https://example.test/f", suggestedFilename: "f.txt" });
    browser.emit("Browser.downloadProgress", { guid: "g1", totalBytes: 10, receivedBytes: 5, state: "inProgress" });
    browser.emit("Browser.downloadProgress", { guid: "g1", totalBytes: 10, receivedBytes: 5, state: "inProgress" }); // duplicate
    browser.emit("Browser.downloadProgress", { guid: "g1", totalBytes: 10, receivedBytes: 10, state: "completed" });
    // Subframe download: frame learned from Page.frameAttached.
    browser.existing[0]!.session.emit("Page.frameAttached", { frameId: "SUB", parentFrameId: "EXISTING" });
    browser.emit("Browser.downloadWillBegin", { frameId: "SUB", guid: "g2", url: "https://example.test/g", suggestedFilename: "g.bin" });
    browser.emit("Browser.downloadProgress", { guid: "g2", totalBytes: 0, receivedBytes: 0, state: "canceled" });
    // Unknown frame: ignored.
    browser.emit("Browser.downloadWillBegin", { frameId: "ELSEWHERE", guid: "g3", url: "x", suggestedFilename: "x" });

    expect(seen.map(([id, d]) => [id, d.id, d.state, d.receivedBytes])).toEqual([
      [tab.id, "g1", "progressing", 0],
      [tab.id, "g1", "progressing", 5],
      [tab.id, "g1", "completed", 10],
      [tab.id, "g2", "progressing", 0],
      [tab.id, "g2", "cancelled", 0]
    ]);
    expect(seen[2]![1]).toMatchObject({ filename: "f.txt", url: "https://example.test/f", totalBytes: 10 });
    expect(seen[2]![1].finishedAt).toBeGreaterThanOrEqual(seen[2]![1].startedAt);
  });

  it("adopts popups with their opener as parent, and reports closes", async () => {
    await flush();
    const popup = new FakePage("POPUP", { openerId: "EXISTING" });
    browser.announce(popup);
    await flush();
    await flush();
    const tab = backend.getTab("tab-2" as TabId);
    expect(tab?.parentTabId).toBe("tab-1");
    expect(events.some((e) => e.type === "created" && e.tab === tab)).toBe(true);

    events.length = 0;
    await popup.close(); // closed from the page side
    expect(events).toEqual([{ type: "closed", tabId: "tab-2" }, { type: "summary-changed" }]);
    expect(backend.getTab("tab-2" as TabId)).toBeUndefined();
    expect(tab?.summary().id).toBe("tab-2"); // last summary stays readable

    events.length = 0;
    await backend.closeTab("tab-1" as TabId);
    expect(events).toEqual([{ type: "closed", tabId: "tab-1" }, { type: "summary-changed" }]);
    expect(browser.existing[0]!.closed).toBe(true);
    await expect(backend.closeTab("tab-1" as TabId)).rejects.toThrow(/No tab/);
  });

  it("close() removes perception and download behaviour from a browser it does not own", async () => {
    await flush();
    const s = browser.existing[0]!.session;
    await backend.close();
    expect(s.count("Page.removeScriptToEvaluateOnNewDocument")).toBe(1);
    const restored = browser.browserSessions.flatMap((b) => b.sent).filter((m) => m.method === "Browser.setDownloadBehavior");
    expect(restored.at(-1)?.params).toEqual({ behavior: "default" });
    expect(backend.listTabs()).toEqual([]);
    events.length = 0;
    s.emit("Page.loadEventFired", {});
    expect(events).toEqual([]);
    await backend.close(); // idempotent
  });
});
