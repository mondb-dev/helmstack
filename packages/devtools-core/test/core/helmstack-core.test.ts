import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TabId } from "../../../shared/src/index.js";
import type { AgentApi } from "../../src/api.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { TabSession } from "../../src/core/tab-session.js";
import { createTabState } from "../../src/core/tab-state.js";
import { FakeBackend, FakeTab, makeObservation, type FakeCdpTarget } from "./fakes.js";

let dataDir: string;
let backend: FakeBackend;
let core: HelmstackCore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-core-"));
  backend = new FakeBackend();
});

afterEach(() => {
  core?.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

function cdpOf(tabId: TabId): FakeCdpTarget {
  return backend.tabs.get(tabId)!.cdp;
}

function consoleEntry(text: string) {
  return { entry: { level: "log", text, timestamp: 1 } };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function stubPerceptionPull(cdp: FakeCdpTarget, payload: unknown): void {
  cdp.handlers.set("Page.getFrameTree", () => ({ frameTree: { frame: { id: "main" } } }));
  cdp.handlers.set("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
  cdp.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: JSON.stringify(payload) } }));
}

describe("HelmstackCore", () => {
  it("is assignable to AgentApi and reports the backend kind", () => {
    core = new HelmstackCore(backend, { dataDir });
    const api: AgentApi = core;
    expect(api.backend).toBe("daemon");
    expect(api.pickElement).toBeUndefined();
  });

  it("exposes pickElement only when the backend provides it", async () => {
    const withPick = Object.assign(backend, {
      pickElement: async (id: TabId) => ({ tabId: id, cancelled: true }) as never
    });
    const tab = backend.addTab();
    core = new HelmstackCore(withPick, { dataDir });
    expect(typeof core.pickElement).toBe("function");
    await expect(core.pickElement!(tab.id)).resolves.toMatchObject({ tabId: tab.id });
  });

  describe("session lifecycle", () => {
    it("adopts tabs that exist before construction", () => {
      const tab = backend.addTab();
      core = new HelmstackCore(backend, { dataDir });
      expect(core.getTabLogs(tab.id).tabId).toBe(tab.id);
      expect(tab.cdp.methods()).toEqual(expect.arrayContaining(["Runtime.enable", "Log.enable", "Network.enable"]));
    });

    it("creates a session on `created`, subscribes CDP events once, and disposes on `closed`", async () => {
      core = new HelmstackCore(backend, { dataDir });
      const tabsEvents: number[] = [];
      core.onTabsChanged((tabs) => tabsEvents.push(tabs.length));

      const [summary] = await core.createTab("https://a.test/");
      const cdp = cdpOf(summary.id);
      expect(cdp.listeners.size).toBe(1);
      expect(core.listTabs().map((t) => t.url)).toEqual(["https://a.test/"]);

      cdp.emit("Log.entryAdded", consoleEntry("hello"));
      expect(core.getTabLogs(summary.id).consoleLogs.map((l) => l.text)).toEqual(["hello"]);

      await core.closeTab(summary.id);
      expect(cdp.listeners.size).toBe(0);
      expect(() => core.getTabLogs(summary.id)).toThrow(/Unknown tab/);
      expect(tabsEvents).toEqual([1, 0]);
    });

    it("removes the closed tab's assertion watches", async () => {
      core = new HelmstackCore(backend, { dataDir });
      const [summary] = await core.createTab("https://a.test/");
      core.addAssertionWatch(summary.id, "page has a heading");
      backend.emit({ type: "closed", tabId: summary.id });
      expect(core.listAssertionWatches()).toEqual([]);
    });

    it("forwards `summary-changed` to tabs listeners", () => {
      backend.addTab();
      core = new HelmstackCore(backend, { dataDir });
      let calls = 0;
      core.onTabsChanged(() => calls++);
      backend.emit({ type: "summary-changed" });
      expect(calls).toBe(1);
    });

    it("records pushed observations and fans them out", () => {
      const tab = backend.addTab();
      core = new HelmstackCore(backend, { dataDir });
      const seen: string[] = [];
      core.onPageObserved((o) => seen.push(o.title));
      backend.observe(makeObservation(tab.id, { title: "pushed" }));
      backend.observe(makeObservation("ghost" as TabId));
      expect(seen).toEqual(["pushed"]);
      return expect(core.getLatestObservation(tab.id)).resolves.toMatchObject({ title: "pushed" });
    });
  });

  it("capturePerception pulls a fresh observation before normalizing", async () => {
    const tab = backend.addTab();
    core = new HelmstackCore(backend, { dataDir });
    backend.observe(makeObservation(tab.id, { title: "stale", headings: ["Old"] }));
    stubPerceptionPull(tab.cdp, makeObservation("" as TabId, { title: "fresh", headings: ["New"] }));
    tab.cdp.handlers.set("DOMSnapshot.captureSnapshot", () => ({ documents: [], strings: [] }));
    tab.cdp.handlers.set("Accessibility.getFullAXTree", () => ({ nodes: [] }));

    await core.capturePerception(tab.id);

    expect(tab.cdp.methods()).toContain("Page.createIsolatedWorld");
    await expect(core.getLatestObservation(tab.id)).resolves.toMatchObject({ title: "fresh" });
  });

  it("skips the pull and uses the pushed observation when pullObservations is false", async () => {
    const tab = backend.addTab();
    core = new HelmstackCore(backend, { dataDir, pullObservations: false });
    backend.observe(makeObservation(tab.id, { title: "pushed" }));
    stubPerceptionPull(tab.cdp, makeObservation("" as TabId, { title: "fresh" }));
    tab.cdp.handlers.set("DOMSnapshot.captureSnapshot", () => ({ documents: [], strings: [] }));
    tab.cdp.handlers.set("Accessibility.getFullAXTree", () => ({ nodes: [] }));

    await core.capturePerception(tab.id);

    expect(tab.cdp.methods()).not.toContain("Page.createIsolatedWorld");
    await expect(core.getLatestObservation(tab.id)).resolves.toMatchObject({ title: "pushed" });
  });

  it("clears log buffers on main-frame navigation", () => {
    const tab = backend.addTab();
    core = new HelmstackCore(backend, { dataDir });
    tab.cdp.emit("Log.entryAdded", consoleEntry("old page"));
    tab.cdp.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "boom" } });
    tab.cdp.emit("Network.requestWillBeSent", { requestId: "r1", request: { url: "https://a.test/x", method: "GET" } });
    expect(core.getTabLogs(tab.id).consoleLogs).toHaveLength(1);

    backend.emit({ type: "main-frame-navigation", tabId: tab.id, url: "https://b.test/" });

    const logs = core.getTabLogs(tab.id);
    expect(logs.consoleLogs).toEqual([]);
    expect(logs.jsErrors).toEqual([]);
    expect(logs.networkRequests).toEqual([]);
  });

  it("re-applies overrides when a load finishes", async () => {
    const tab = backend.addTab();
    core = new HelmstackCore(backend, { dataDir });
    await core.setMediaEmulation(tab.id, { colorScheme: "dark" } as never);
    await core.setLocationOverride(tab.id, { latitude: 1, longitude: 2 } as never);
    tab.cdp.calls.length = 0;

    backend.emit({ type: "load-finished", tabId: tab.id });
    await flush();

    expect(tab.cdp.methods()).toEqual(expect.arrayContaining(["Emulation.setEmulatedMedia", "Emulation.setGeolocationOverride"]));
  });

  it("upserts downloads reported by the backend", () => {
    const listeners: Array<(tabId: TabId, d: never) => void> = [];
    const withDownloads = Object.assign(backend, {
      onDownload: (l: (tabId: TabId, d: never) => void) => { listeners.push(l); return () => {}; }
    });
    const tab = backend.addTab();
    core = new HelmstackCore(withDownloads, { dataDir });
    const base = { id: "d1", tabId: tab.id, url: "https://a.test/f", filename: "f", totalBytes: 10, receivedBytes: 0, state: "progressing", startedAt: 1 };
    listeners[0](tab.id, base as never);
    listeners[0](tab.id, { ...base, receivedBytes: 10, state: "completed" } as never);
    expect(core.listDownloads(tab.id)).toEqual([expect.objectContaining({ id: "d1", receivedBytes: 10, state: "completed" })]);
  });

  it("navigate records the command and delegates to the backend tab", async () => {
    const tab = backend.addTab();
    core = new HelmstackCore(backend, { dataDir });
    core.startRecording(tab.id);
    await core.navigate(tab.id, "https://b.test/");
    expect(tab.navigations).toEqual(["https://b.test/"]);
    expect(core.stopRecording(tab.id).commands).toEqual([
      expect.objectContaining({ source: "navigate", outcome: "completed" })
    ]);
  });

  it("navigate never leaks a rejected backend navigation as an unhandled rejection", async () => {
    const tab = backend.addTab();
    tab.navigate = async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); };
    core = new HelmstackCore(backend, { dataDir });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(core.navigate(tab.id, "https://nope.invalid/")).resolves.toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reload, back and forward delegate to the backend tab and return the tab list", async () => {
    const tab = backend.addTab();
    core = new HelmstackCore(backend, { dataDir });
    await expect(core.reload(tab.id)).resolves.toHaveLength(1);
    await core.reload(tab.id, { ignoreCache: true });
    await core.goBack(tab.id);
    await core.goForward(tab.id);
    expect(tab.historyCalls).toEqual(["reload", "hard-reload", "back", "forward"]);
  });

  it("history commands reject cleanly on a backend without them", async () => {
    const tab = backend.addTab();
    (tab as { reload?: unknown }).reload = undefined;
    (tab as { goBack?: unknown }).goBack = undefined;
    core = new HelmstackCore(backend, { dataDir });
    await expect(core.reload(tab.id)).rejects.toThrow(/cannot reload/);
    await expect(core.goBack(tab.id)).rejects.toThrow(/history/);
    await expect(core.reload("missing" as TabId)).rejects.toThrow(/Unknown tab/);
  });

  it("a failing reload does not reject the command (the summary carries the error)", async () => {
    const tab = backend.addTab();
    tab.reload = async () => { throw new Error("net::ERR_FAILED"); };
    core = new HelmstackCore(backend, { dataDir });
    await expect(core.reload(tab.id)).resolves.toHaveLength(1);
  });

  it("handoff context groups related tabs by parent and origin", async () => {
    core = new HelmstackCore(backend, { dataDir });
    const parent = backend.addTab("https://a.test/1");
    backend.addTab("https://other.test/", parent.id);
    backend.addTab("https://a.test/2");
    backend.addTab("https://unrelated.test/");
    const ctx = (core as unknown as { getHandoffContext(id: TabId): { relatedTabIds: TabId[]; origin: string } })
      .getHandoffContext(parent.id);
    expect(ctx.origin).toBe("https://a.test");
    expect(ctx.relatedTabIds).toHaveLength(3);
  });
});

describe("TabSession", () => {
  function makeSession(defaultViewport = { width: 1000, height: 700 }) {
    const tab = new FakeTab("t1" as TabId);
    tab.cdp.handlers.set("Page.captureScreenshot", () => ({ data: "iVBOR" }));
    tab.cdp.handlers.set("Page.getLayoutMetrics", () => ({ cssLayoutViewport: { clientWidth: 1, clientHeight: 2 } }));
    const session = new TabSession(tab, createTabState(), { defaultViewport: () => defaultViewport });
    return { tab, session };
  }

  function emulationCalls(cdp: FakeCdpTarget) {
    return cdp.calls.filter((c) => c.method.startsWith("Emulation."));
  }

  it("re-applies the emulated viewport after a screenshot instead of clearing it", async () => {
    const { tab, session } = makeSession();
    await session.setEmulatedViewport(390, 844, true);
    tab.cdp.calls.length = 0;

    await session.captureScreenshot();

    const calls = emulationCalls(tab.cdp);
    expect(calls.map((c) => c.method)).not.toContain("Emulation.clearDeviceMetricsOverride");
    expect(calls.at(-1)).toEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
    });
    expect(session.state.emulatedViewport).toEqual({ width: 390, height: 844, mobile: true });
  });

  it("re-applies the emulated viewport even when the capture fails", async () => {
    const { tab, session } = makeSession();
    await session.setEmulatedViewport(390, 844, true);
    tab.cdp.handlers.set("Page.captureScreenshot", () => { throw new Error("capture failed"); });
    tab.cdp.calls.length = 0;

    await expect(session.captureScreenshot()).rejects.toThrow("capture failed");
    expect(emulationCalls(tab.cdp).at(-1)?.params).toMatchObject({ width: 390, height: 844 });
  });

  it("uses the backend default viewport and clears the override when none is emulated", async () => {
    const { tab, session } = makeSession({ width: 1000, height: 700 });
    await session.captureScreenshot();
    const calls = emulationCalls(tab.cdp);
    expect(calls[0].params).toMatchObject({ width: 1000, height: 700, mobile: false });
    expect(calls.at(-1)?.method).toBe("Emulation.clearDeviceMetricsOverride");
  });

  it("pulls a fresh observation for perception", async () => {
    const { tab, session } = makeSession();
    session.recordObservation(makeObservation(tab.id, { title: "stale push" }));
    stubPerceptionPull(tab.cdp, makeObservation("" as TabId, { title: "fresh pull" }));

    const observation = await session.refreshObservation();

    expect(observation).toMatchObject({ title: "fresh pull", tabId: tab.id });
    expect(session.state.lastObservation?.title).toBe("fresh pull");
    expect(tab.cdp.calls.find((c) => c.method === "Runtime.evaluate")?.params).toMatchObject({ contextId: 7 });
  });

  it("falls back to the last pushed observation when the pull fails", async () => {
    const { tab, session } = makeSession();
    session.recordObservation(makeObservation(tab.id, { title: "pushed" }));
    tab.cdp.handlers.set("Page.getFrameTree", () => { throw new Error("no frame"); });

    await expect(session.refreshObservation()).resolves.toMatchObject({ title: "pushed" });
  });

  it("falls back when the page has no document to observe", async () => {
    const { tab, session } = makeSession();
    session.recordObservation(makeObservation(tab.id, { title: "pushed" }));
    stubPerceptionPull(tab.cdp, null);
    tab.cdp.handlers.set("Runtime.evaluate", () => ({ result: { type: "undefined" } }));

    await expect(session.refreshObservation()).resolves.toMatchObject({ title: "pushed" });
  });

  it("unsubscribes ad-hoc trace listeners when the capture ends", async () => {
    const { tab, session } = makeSession();
    tab.cdp.handlers.set("Tracing.end", () => {
      queueMicrotask(() => {
        tab.cdp.emit("Tracing.dataCollected", { value: [] });
        tab.cdp.emit("Tracing.tracingComplete");
      });
      return {};
    });
    await session.captureTrace(200);
    expect(tab.cdp.listeners.size).toBe(1); // only the session's own handleCdpMessage subscription
  });

  it("blocks commands when the JS heap exceeds the resource budget", async () => {
    const { tab, session } = makeSession();
    await session.setResourceBudget({ maxJsHeapMb: 1 } as never);
    tab.cdp.handlers.set("Performance.getMetrics", () => ({ metrics: [{ name: "JSHeapUsedSize", value: 5 * 1024 * 1024 }] }));
    await expect(session.checkResourceBudget()).resolves.toMatchObject({ status: "blocked" });
  });
});
