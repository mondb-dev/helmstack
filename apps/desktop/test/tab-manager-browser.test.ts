import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TabLifecycleEvent } from "../../../packages/devtools-core/src/backend.js";
import type { FindInPageResult, TabId } from "../../../packages/shared/src/index.js";

const sharedSession = new EventEmitter();

class FakeWebContents extends EventEmitter {
  static nextId = 1;
  readonly id = FakeWebContents.nextId++;
  readonly session = sharedSession;
  readonly debugger = Object.assign(new EventEmitter(), {
    attached: false,
    isAttached() { return this.attached; },
    attach: vi.fn(function (this: { attached: boolean }) { this.attached = true; }),
    sendCommand: vi.fn(async (..._args: string[]) => ({}))
  });
  url = "";
  title = "";
  loading = false;
  zoom = 1;
  history: string[] = [];
  index = -1;
  devtools = false;
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
    this.history = [...this.history.slice(0, this.index + 1), url];
    this.index = this.history.length - 1;
  });
  close = vi.fn();
  setWindowOpenHandler = vi.fn();
  reload = vi.fn(() => queueMicrotask(() => this.emit("did-stop-loading")));
  reloadIgnoringCache = vi.fn(() => queueMicrotask(() => this.emit("did-stop-loading")));
  stop = vi.fn();
  focus = vi.fn();
  print = vi.fn();
  findInPage = vi.fn();
  stopFindInPage = vi.fn();
  setZoomFactor = vi.fn((factor: number) => { this.zoom = factor; });
  getZoomFactor = () => this.zoom;
  isDevToolsOpened = () => this.devtools;
  openDevTools = vi.fn(() => { this.devtools = true; });
  closeDevTools = vi.fn(() => { this.devtools = false; });
  isDestroyed = () => false;
  navigationHistory = {
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index >= 0 && this.index < this.history.length - 1,
    goBack: vi.fn(() => { this.index -= 1; this.url = this.history[this.index]!; queueMicrotask(() => this.emit("did-stop-loading")); }),
    goForward: vi.fn(() => { this.index += 1; this.url = this.history[this.index]!; queueMicrotask(() => this.emit("did-stop-loading")); })
  };
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
}

vi.mock("electron", () => {
  class WebContentsView {
    readonly webContents = new FakeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  return { WebContentsView, BrowserWindow: class {} };
});

const { ElectronBackend, CLOSED_TAB_HISTORY_LIMIT } = await import("../src/main/tab-manager.js");
const { ZoomStore } = await import("../src/main/zoom-store.js");

const tmpDirs: string[] = [];
function makeBackend(withZoom = false) {
  const window = Object.assign(new EventEmitter(), { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helmstack-tabs-"));
  tmpDirs.push(dir);
  const zoomStore = withZoom ? new ZoomStore(dir) : undefined;
  const backend = new ElectronBackend(window as never, "/app", "/preload.cjs", { findRecordByOrigin: () => null } as never, zoomStore);
  const events: TabLifecycleEvent[] = [];
  backend.onLifecycle((e) => events.push(e));
  return { backend, events, dir };
}

const wcOf = (tab: { view: unknown }) => (tab.view as { webContents: FakeWebContents }).webContents;

/** A page load as Electron reports it. */
function load(tab: { view: unknown }, url: string): void {
  const wc = wcOf(tab);
  wc.emit("did-start-navigation", { defaultPrevented: false }, url, false, true);
  wc.url = url;
  if (wc.history[wc.index] !== url) {
    wc.history = [...wc.history.slice(0, wc.index + 1), url];
    wc.index = wc.history.length - 1;
  }
  wc.emit("did-navigate");
  wc.emit("did-finish-load");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sharedSession.removeAllListeners();
});

describe("history and summary flags", () => {
  it("starts with no history and follows the live navigation history", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    expect(tab.summary()).toMatchObject({ canGoBack: false, canGoForward: false, zoomFactor: 1 });

    load(tab, "https://a.test/");
    load(tab, "https://b.test/");
    expect(tab.summary()).toMatchObject({ canGoBack: true, canGoForward: false });

    await backend.goBack(tab.id);
    wcOf(tab).emit("did-navigate");
    expect(tab.summary()).toMatchObject({ canGoBack: false, canGoForward: true });
  });

  it("goBack/goForward are no-ops (false) with nothing to go to", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    load(tab, "https://a.test/");
    expect(await backend.goBack(tab.id)).toBe(false);
    expect(await backend.goForward(tab.id)).toBe(false);
    expect(wcOf(tab).navigationHistory.goBack).not.toHaveBeenCalled();
  });

  it("the BackendTab methods wait for the load to settle", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    load(tab, "https://a.test/");
    load(tab, "https://b.test/");

    let settled = false;
    wcOf(tab).navigationHistory.goBack.mockImplementationOnce(() => {
      wcOf(tab).index -= 1;
      setTimeout(() => wcOf(tab).emit("did-stop-loading"), 10);
    });
    const pending = tab.goBack().then((moved) => {
      settled = true;
      return moved;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(pending).resolves.toBe(true);
  });

  it("reload and hard reload mark the tab loading and wait for the load", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    load(tab, "https://a.test/");
    events.length = 0;

    await backend.reload(tab.id, {}, true);
    expect(wcOf(tab).reload).toHaveBeenCalled();
    expect(events.some((e) => e.type === "summary-changed")).toBe(true);

    await tab.reload({ ignoreCache: true });
    expect(wcOf(tab).reloadIgnoringCache).toHaveBeenCalled();
  });

  it("stop forwards to the page and isLoading reflects it", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    wcOf(tab).loading = true;
    expect(backend.isLoading(tab.id)).toBe(true);
    backend.stop(tab.id);
    expect(wcOf(tab).stop).toHaveBeenCalled();
  });

  it("reload on an unknown tab rejects", async () => {
    const { backend } = makeBackend();
    await expect(backend.reload("nope" as TabId)).rejects.toThrow(/Unknown tab/);
  });
});

describe("tab navigation helpers", () => {
  it("cycles and indexes tabs in strip order, wrapping", async () => {
    const { backend } = makeBackend();
    const a = await backend.createTab("https://a.test/");
    const b = await backend.createTab("https://b.test/");
    const c = await backend.createTab("https://c.test/");
    expect(backend.activeId()).toBe(c.id);
    expect(backend.tabAtOffset(1)).toBe(a.id);
    expect(backend.tabAtOffset(-1)).toBe(b.id);
    expect(backend.tabAtIndex(0)).toBe(a.id);
    expect(backend.tabAtIndex(-1)).toBe(c.id);
    expect(backend.tabAtIndex(7)).toBeNull();
  });
});

describe("closed-tab history", () => {
  it("remembers url and index, newest first out, capped at 10", async () => {
    const { backend } = makeBackend();
    const keep = await backend.createTab("https://keep.test/");
    const ids: TabId[] = [];
    for (let i = 0; i < CLOSED_TAB_HISTORY_LIMIT + 3; i += 1) {
      ids.push((await backend.createTab(`https://t${i}.test/`)).id);
    }
    for (const id of ids) await backend.closeTab(id);

    expect(backend.closedTabHistory()).toHaveLength(CLOSED_TAB_HISTORY_LIMIT);
    const last = backend.popClosedTab();
    expect(last).toMatchObject({ url: `https://t${CLOSED_TAB_HISTORY_LIMIT + 2}.test/` });
    expect(backend.popClosedTab()?.url).toBe(`https://t${CLOSED_TAB_HISTORY_LIMIT + 1}.test/`);
    expect(backend.listTabs()).toEqual([keep]);
  });

  it("skips blank pages and restores at the same strip index", async () => {
    const { backend } = makeBackend();
    const a = await backend.createTab("https://a.test/");
    const b = await backend.createTab("https://b.test/");
    const c = await backend.createTab("https://c.test/");
    const blank = await backend.createTab("about:blank");

    await backend.closeTab(blank.id);
    expect(backend.popClosedTab()).toBeNull();

    await backend.closeTab(b.id);
    const closed = backend.popClosedTab();
    expect(closed).toMatchObject({ url: "https://b.test/", index: 1 });

    const restored = await backend.createTab(closed!.url);
    expect(backend.listTabs().map((t) => t.id)).toEqual([a.id, c.id, restored.id]);
    backend.moveTab(restored.id, closed!.index);
    expect(backend.listTabs().map((t) => t.id)).toEqual([a.id, restored.id, c.id]);
  });
});

describe("zoom", () => {
  it("steps per tab, applies to same-origin tabs and persists by origin", async () => {
    const { backend, dir } = makeBackend(true);
    const a = await backend.createTab("https://a.test/one");
    const a2 = await backend.createTab("https://a.test/two");
    const other = await backend.createTab("https://b.test/");
    for (const t of [a, a2, other]) wcOf(t).url = (wcOf(t).loadURL.mock.calls[0] as string[])[0]!;

    backend.zoomTab(a.id, "in");
    expect(wcOf(a).zoom).toBe(1.1);
    expect(wcOf(a2).zoom).toBe(1.1);
    expect(wcOf(other).zoom).toBe(1);
    expect(a.summary().zoomFactor).toBe(1.1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "helmstack-zoom.json"), "utf8")).origins).toEqual({ "https://a.test": 1.1 });

    backend.zoomTab(a.id, "reset");
    expect(wcOf(a2).zoom).toBe(1);
    expect(a2.summary().zoomFactor).toBe(1);
  });

  it("applies the stored zoom when navigating to an origin", async () => {
    const { backend, dir } = makeBackend(true);
    fs.writeFileSync(path.join(dir, "helmstack-zoom.json"), JSON.stringify({ version: 1, origins: { "https://z.test": 1.5 } }));
    const fresh = new ElectronBackend(
      Object.assign(new EventEmitter(), { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }) as never,
      "/app",
      "/p.cjs",
      { findRecordByOrigin: () => null } as never,
      new ZoomStore(dir)
    );
    const tab = await fresh.createTab("https://a.test/");
    wcOf(tab).emit("did-start-navigation", { defaultPrevented: false }, "https://z.test/page", false, true);
    expect(wcOf(tab).zoom).toBe(1.5);
    expect(tab.summary().zoomFactor).toBe(1.5);
    wcOf(tab).emit("did-start-navigation", { defaultPrevented: false }, "https://a.test/", false, true);
    expect(wcOf(tab).zoom).toBe(1);
    void backend;
  });

  it("renders at 100% while an agent's device-metrics override is active, then restores the human's zoom", async () => {
    const { backend } = makeBackend(true);
    const tab = await backend.createTab("https://a.test/");
    wcOf(tab).url = "https://a.test/";
    backend.zoomTab(tab.id, "in");
    backend.zoomTab(tab.id, "in");
    expect(wcOf(tab).zoom).toBe(1.25);

    const order: string[] = [];
    wcOf(tab).debugger.sendCommand.mockImplementation(async (method: string, ..._rest: string[]) => {
      order.push(`${method}@${wcOf(tab).zoom}`);
      return {};
    });
    await tab.cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await tab.cdp.send("Page.captureScreenshot", { format: "png" });
    expect(order).toEqual(["Emulation.setDeviceMetricsOverride@1", "Page.captureScreenshot@1"]);
    // The human's choice is remembered, not lost, and the chip keeps showing it.
    expect(tab.summary().zoomFactor).toBe(1.25);

    await tab.cdp.send("Emulation.clearDeviceMetricsOverride");
    expect(wcOf(tab).zoom).toBe(1.25);
  });

  it("keeps the human's zoom for a shell freeze-frame capture", async () => {
    const { backend } = makeBackend(true);
    const tab = await backend.createTab("https://a.test/");
    wcOf(tab).url = "https://a.test/";
    backend.zoomTab(tab.id, "in");
    const during: number[] = [];
    await backend.withHumanCapture(tab.id, async () => {
      await tab.cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600 });
      during.push(wcOf(tab).zoom);
      await tab.cdp.send("Emulation.clearDeviceMetricsOverride");
    });
    expect(during).toEqual([1.1]);
    expect(wcOf(tab).zoom).toBe(1.1);
  });
});

describe("find in page", () => {
  it("forwards found-in-page results with the tab id", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    const results: FindInPageResult[] = [];
    backend.onFindResult((r) => results.push(r));
    wcOf(tab).emit("found-in-page", {}, { requestId: 1, activeMatchOrdinal: 2, matches: 7, finalUpdate: true });
    expect(results).toEqual([{ tabId: tab.id, activeMatchOrdinal: 2, matches: 7, finalUpdate: true }]);
  });

  it("maps our 'continue' flag onto Electron's inverted findNext, and clears on empty text", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    backend.findInPage(tab.id, "x", { forward: true });
    expect(wcOf(tab).findInPage).toHaveBeenLastCalledWith("x", { forward: true, findNext: true, matchCase: false });
    backend.findInPage(tab.id, "x", { forward: false, findNext: true });
    expect(wcOf(tab).findInPage).toHaveBeenLastCalledWith("x", { forward: false, findNext: false, matchCase: false });
    backend.findInPage(tab.id, "");
    expect(wcOf(tab).stopFindInPage).toHaveBeenCalledWith("clearSelection");
  });

  it("clears find state on a main-frame navigation, not on in-page changes", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    const results: FindInPageResult[] = [];
    backend.onFindResult((r) => results.push(r));

    wcOf(tab).emit("did-start-navigation", { defaultPrevented: false }, "https://a.test/#frag", true, true);
    expect(results).toEqual([]);

    wcOf(tab).emit("did-start-navigation", { defaultPrevented: false }, "https://b.test/", false, true);
    expect(wcOf(tab).stopFindInPage).toHaveBeenCalledWith("clearSelection");
    expect(results).toEqual([{ tabId: tab.id, activeMatchOrdinal: 0, matches: 0, finalUpdate: true, cleared: true }]);
  });
});

describe("page devtools", () => {
  it("toggles devtools on the page's own webContents", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    backend.toggleDevTools(tab.id);
    expect(wcOf(tab).openDevTools).toHaveBeenCalledWith({ mode: "detach" });
    backend.toggleDevTools(tab.id);
    expect(wcOf(tab).closeDevTools).toHaveBeenCalled();
  });

  it("re-attaches the CDP debugger when opening DevTools detaches it, and asks the core to re-apply overrides", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    const dbg = wcOf(tab).debugger;
    dbg.attached = false;
    events.length = 0;

    dbg.emit("detach", {}, "replaced_with_devtools");
    expect(dbg.attach).toHaveBeenCalledWith("1.3");
    expect(events).toContainEqual({ type: "load-finished", tabId: tab.id });

    // Tab closing is not a reason to re-attach.
    dbg.attach.mockClear();
    dbg.attached = false;
    dbg.emit("detach", {}, "target closed");
    expect(dbg.attach).not.toHaveBeenCalled();
  });
});

describe("key router", () => {
  it("installs on existing and future page views", async () => {
    const { backend } = makeBackend();
    const first = await backend.createTab("https://a.test/");
    const router = vi.fn();
    backend.setKeyRouter(router);
    const second = await backend.createTab("https://b.test/");
    wcOf(first).emit("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "t" });
    wcOf(second).emit("before-input-event", { preventDefault: vi.fn() }, { type: "keyDown", key: "t" });
    expect(router).toHaveBeenCalledTimes(2);
  });
});
