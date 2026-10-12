import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { electronCdpTarget } from "../src/main/electron-cdp-target.js";

function stubWebContents(options: { loading?: boolean } = {}) {
  const debuggerEmitter = new EventEmitter();
  let attached = false;
  const dbg = Object.assign(debuggerEmitter, {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => { attached = true; }),
    sendCommand: vi.fn(async (method: string) => ({ method }))
  });
  const wc = Object.assign(new EventEmitter(), {
    debugger: dbg,
    loading: options.loading ?? false,
    isLoading() { return this.loading; },
    getURL: () => "https://example.com/",
    executeJavaScript: vi.fn(async () => 42)
  });
  return wc;
}

type Stub = ReturnType<typeof stubWebContents>;
const adapt = (wc: Stub) => electronCdpTarget(wc as unknown as Electron.WebContents);

afterEach(() => {
  vi.useRealTimers();
});

describe("electronCdpTarget", () => {
  it("attaches the debugger once and forwards commands", async () => {
    const wc = stubWebContents();
    const target = adapt(wc);
    await expect(target.send("A.b", { x: 1 })).resolves.toEqual({ method: "A.b" });
    await target.send("C.d");
    expect(wc.debugger.attach).toHaveBeenCalledTimes(1);
    expect(wc.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith("A.b", { x: 1 });
  });

  it("rejects (rather than throwing synchronously) when attach fails", async () => {
    const wc = stubWebContents();
    wc.debugger.attach.mockImplementation(() => { throw new Error("already attached by devtools"); });
    await expect(adapt(wc).send("A.b")).rejects.toThrow("already attached");
  });

  it("caches one adapter per WebContents", () => {
    const wc = stubWebContents();
    expect(adapt(wc)).toBe(adapt(wc));
    expect(adapt(wc)).not.toBe(adapt(stubWebContents()));
  });

  it("delivers CDP events until unsubscribed", () => {
    const wc = stubWebContents();
    const listener = vi.fn();
    const off = adapt(wc).onEvent(listener);
    wc.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "1" });
    expect(listener).toHaveBeenCalledWith("Network.requestWillBeSent", { requestId: "1" });
    off();
    wc.debugger.emit("message", {}, "Network.loadingFinished", {});
    expect(listener).toHaveBeenCalledTimes(1);
    expect(wc.debugger.listenerCount("message")).toBe(0);
  });

  it("delegates evaluate, url and isLoading", async () => {
    const wc = stubWebContents();
    const target = adapt(wc);
    await expect(target.evaluate("1+1", { userGesture: true })).resolves.toBe(42);
    expect(wc.executeJavaScript).toHaveBeenCalledWith("1+1", true);
    expect(target.url()).toBe("https://example.com/");
    expect(target.isLoading()).toBe(false);
  });

  it("waitForLoadStop resolves immediately when idle", async () => {
    const wc = stubWebContents();
    await adapt(wc).waitForLoadStop(10_000);
    expect(wc.listenerCount("did-stop-loading")).toBe(0);
  });

  it("waitForLoadStop resolves on did-stop-loading", async () => {
    const wc = stubWebContents({ loading: true });
    const done = adapt(wc).waitForLoadStop(10_000);
    expect(wc.listenerCount("did-stop-loading")).toBe(1);
    wc.emit("did-stop-loading");
    await done;
    expect(wc.listenerCount("did-stop-loading")).toBe(0);
  });

  it("waitForLoadStop resolves after the timeout and cleans up its listener", async () => {
    vi.useFakeTimers();
    const wc = stubWebContents({ loading: true });
    let resolved = false;
    const done = adapt(wc).waitForLoadStop(500).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(resolved).toBe(true);
    expect(wc.listenerCount("did-stop-loading")).toBe(0);
  });
});
