import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TabLifecycleEvent } from "../../../packages/devtools-core/src/backend.js";
import type { TabId } from "../../../packages/shared/src/index.js";

/** Minimal `WebContents` stand-in: an EventEmitter with the members the backend touches. */
class FakeWebContents extends EventEmitter {
  static nextId = 1;
  readonly id = FakeWebContents.nextId++;
  readonly session = sharedSession;
  readonly debugger = Object.assign(new EventEmitter(), {
    isAttached: () => false,
    attach: vi.fn(),
    sendCommand: vi.fn(async () => ({}))
  });
  url = "";
  title = "";
  loading = false;
  loadURL = vi.fn(async (url: string) => { this.url = url; });
  close = vi.fn();
  setWindowOpenHandler = vi.fn();
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
}

const sharedSession = new EventEmitter();

vi.mock("electron", () => {
  class WebContentsView {
    readonly webContents = new FakeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
  }
  return { WebContentsView, BrowserWindow: class {} };
});

const { ElectronBackend } = await import("../src/main/tab-manager.js");

function makeWindow() {
  return Object.assign(new EventEmitter(), {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }
  });
}

function makeBackend() {
  const accounts = { findRecordByOrigin: vi.fn(() => null) };
  const backend = new ElectronBackend(makeWindow() as never, "/app/dist/main", "/preload.cjs", accounts as never);
  const events: TabLifecycleEvent[] = [];
  backend.onLifecycle((event) => events.push(event));
  return { backend, events };
}

const wcOf = (tab: { view: unknown }) => (tab.view as { webContents: FakeWebContents }).webContents;
const types = (events: TabLifecycleEvent[]) => events.map((e) => e.type);

describe("ElectronBackend", () => {
  beforeEach(() => {
    sharedSession.removeAllListeners();
  });

  it("emits `created` before focusing, then loads the URL", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    expect(types(events).slice(0, 2)).toEqual(["created", "summary-changed"]);
    expect(wcOf(tab).loadURL).toHaveBeenCalledWith("https://a.test/");
    expect(backend.getTab(tab.id)).toBe(tab);
    expect(tab.summary()).toMatchObject({ url: "https://a.test/", isActive: true, status: "loading" });
  });

  it("navigate updates the summary synchronously and emits summary-changed", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    events.length = 0;

    const pending = tab.navigate("https://b.test/");
    expect(tab.summary()).toMatchObject({ url: "https://b.test/", status: "loading", statusMessage: "Loading https://b.test/" });
    expect(types(events)).toEqual(["summary-changed"]);
    await pending;
  });

  it("a failed navigation flips the summary to error, emits and rejects", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    wcOf(tab).loadURL.mockRejectedValueOnce(new Error("ERR_NAME_NOT_RESOLVED"));
    events.length = 0;

    await expect(tab.navigate("https://nope.invalid/")).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
    expect(tab.summary()).toMatchObject({ status: "error", statusMessage: "Failed to load https://nope.invalid/" });
    expect(types(events)).toEqual(["summary-changed", "summary-changed"]);
  });

  it("did-fail-load on the main frame reports an error summary", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    events.length = 0;
    wcOf(tab).emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://a.test/", true);
    expect(tab.summary()).toMatchObject({ status: "error", statusMessage: "Load failed (-105): ERR_NAME_NOT_RESOLVED" });
    expect(types(events)).toEqual(["summary-changed"]);
  });

  it("maps webContents lifecycle to main-frame-navigation and load-finished", async () => {
    const { backend, events } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    events.length = 0;
    const wc = wcOf(tab);

    wc.emit("did-start-navigation", { defaultPrevented: false }, "https://a.test/frame", false, false);
    expect(events).toEqual([]);

    wc.emit("did-start-navigation", { defaultPrevented: false }, "https://b.test/", false, true);
    expect(events).toContainEqual({ type: "main-frame-navigation", tabId: tab.id, url: "https://b.test/" });

    wc.url = "https://b.test/";
    wc.title = "B";
    wc.emit("did-finish-load");
    expect(events).toContainEqual({ type: "load-finished", tabId: tab.id });
    expect(tab.summary()).toMatchObject({ url: "https://b.test/", title: "B", status: "idle" });
  });

  it("closes a tab, emits `closed` and focuses the next one", async () => {
    const { backend, events } = makeBackend();
    const first = await backend.createTab("https://a.test/");
    const second = await backend.createTab("https://b.test/");
    events.length = 0;

    await backend.closeTab(second.id);
    expect(events[0]).toEqual({ type: "closed", tabId: second.id });
    expect(wcOf(second).close).toHaveBeenCalled();
    expect(backend.listTabs()).toEqual([first]);
    expect(first.summary().isActive).toBe(true);
    await expect(backend.closeTab("missing" as TabId)).rejects.toThrow(/Unknown tab/);
  });

  it("closing the active tab activates the previously active tab (MRU), not the first", async () => {
    const { backend } = makeBackend();
    const a = await backend.createTab("https://a.test/");
    const b = await backend.createTab("https://b.test/");
    const c = await backend.createTab("https://c.test/");
    await backend.focusTab(b.id);
    await backend.focusTab(c.id);

    await backend.closeTab(c.id);
    expect(b.summary().isActive).toBe(true);
    expect(a.summary().isActive).toBe(false);

    // Closing a background tab leaves the active one alone and drops it from history.
    await backend.focusTab(a.id);
    await backend.closeTab(b.id);
    expect(a.summary().isActive).toBe(true);

    const d = await backend.createTab("https://d.test/");
    await backend.closeTab(d.id);
    expect(a.summary().isActive).toBe(true);
  });

  it("window.open creates a child tab", async () => {
    const { backend } = makeBackend();
    const parent = await backend.createTab("https://a.test/");
    const handler = wcOf(parent).setWindowOpenHandler.mock.calls[0][0] as (d: { url: string }) => unknown;
    expect(handler({ url: "https://popup.test/" })).toEqual({ action: "deny" });
    await Promise.resolve();
    const child = backend.listTabs().find((t) => t.id !== parent.id);
    expect(child?.parentTabId).toBe(parent.id);
  });

  it("reports downloads with the same live entry on every progress change", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    const seen: unknown[] = [];
    backend.onDownload((tabId, d) => seen.push([tabId, d, { ...d }]));

    let received = 0;
    const item = Object.assign(new EventEmitter(), {
      getURL: () => "https://a.test/f.zip",
      getFilename: () => "f.zip",
      getMimeType: () => "application/zip",
      getTotalBytes: () => 10,
      getReceivedBytes: () => received,
      isPaused: () => false
    });
    sharedSession.emit("will-download", {}, item, wcOf(tab));
    received = 5;
    item.emit("updated");
    received = 10;
    item.emit("done", {}, "completed");

    expect(seen).toHaveLength(3);
    const entries = seen.map((s) => (s as unknown[])[1]);
    expect(new Set(entries).size).toBe(1);
    expect((seen as unknown[][]).map((s) => (s[2] as { state: string }).state)).toEqual(["progressing", "progressing", "completed"]);
  });

  it("forwards preload observations only for known tabs", async () => {
    const { backend } = makeBackend();
    const tab = await backend.createTab("https://a.test/");
    const seen: string[] = [];
    backend.onObservation((o) => seen.push(o.tabId));
    backend.recordObservation({ tabId: tab.id } as never);
    backend.recordObservation({ tabId: "ghost" } as never);
    expect(seen).toEqual([tab.id]);
  });

  it("defaultViewport follows the shell rect", async () => {
    const { backend } = makeBackend();
    await backend.setViewport({ x: 0, y: 40, width: 900, height: 600 });
    expect(backend.defaultViewport()).toEqual({ width: 900, height: 600 });
  });
});
