// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChromeCdpTarget, EvaluationError, type CdpSessionLike } from "../src/chrome-cdp-target.js";

type Handler = (type: string | symbol, payload: unknown) => void;

/** Mimics puppeteer's mitt-backed "*" wildcard delivery. */
class FakeSession implements CdpSessionLike {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly handlers = new Set<Handler>();
  responses: Record<string, (params?: Record<string, unknown>) => unknown> = {
    "Page.enable": () => ({}),
    "Page.getFrameTree": () => ({ frameTree: { frame: { id: "main", url: "about:blank" } } }),
    "Runtime.evaluate": (params) =>
      params?.expression === "document.readyState" ? { result: { type: "string", value: "complete" } } : { result: { type: "undefined" } }
  };

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params });
    const respond = this.responses[method];
    if (!respond) throw new Error(`unexpected ${method}`);
    return respond(params);
  }
  on(_type: "*", handler: Handler): unknown {
    this.handlers.add(handler);
    return this;
  }
  off(_type: "*", handler: Handler): unknown {
    this.handlers.delete(handler);
    return this;
  }
  emit(type: string | symbol, payload?: unknown): void {
    for (const h of [...this.handlers]) h(type, payload);
  }
}

describe("ChromeCdpTarget", () => {
  it("initialises url and loading state from the page", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    expect(target.url()).toBe("about:blank");
    expect(target.isLoading()).toBe(false);
    expect(session.sent.map((s) => s.method)).toContain("Page.enable");
  });

  it("forwards protocol events to listeners and filters non-protocol emits", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    const seen: string[] = [];
    const off = target.onEvent((method) => seen.push(method));
    session.emit("Network.requestWillBeSent", { requestId: "1" });
    session.emit(Symbol("CDPSession.Disconnected"));
    session.emit("sessionattached", {});
    off();
    session.emit("Network.loadingFinished", { requestId: "1" });
    expect(seen).toEqual(["Network.requestWillBeSent"]);
  });

  it("isolates listener failures", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    const seen: string[] = [];
    target.onEvent(() => {
      throw new Error("boom");
    });
    target.onEvent((m) => seen.push(m));
    session.emit("Log.entryAdded", {});
    expect(seen).toEqual(["Log.entryAdded"]);
  });

  it("tracks main-frame url and loading lifecycle", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    session.emit("Page.frameStartedLoading", { frameId: "child" });
    expect(target.isLoading()).toBe(false);
    session.emit("Page.frameStartedLoading", { frameId: "main" });
    expect(target.isLoading()).toBe(true);
    session.emit("Page.frameNavigated", { frame: { id: "c", parentId: "main", url: "https://ads.example/" } });
    session.emit("Page.frameNavigated", { frame: { id: "main", url: "https://example.com/", urlFragment: "#a" } });
    expect(target.url()).toBe("https://example.com/#a");

    const waiting = target.waitForLoadStop(10_000);
    session.emit("Page.frameStoppedLoading", { frameId: "main" });
    await waiting;
    expect(target.isLoading()).toBe(false);

    session.emit("Page.navigatedWithinDocument", { frameId: "main", url: "https://example.com/#b" });
    expect(target.url()).toBe("https://example.com/#b");
  });

  it("waitForLoadStop resolves immediately when idle and after the timeout otherwise", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    await target.waitForLoadStop(60_000);
    session.emit("Page.frameStartedLoading", { frameId: "main" });
    const start = Date.now();
    await target.waitForLoadStop(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(target.isLoading()).toBe(true);
  });

  it("evaluate sends returnByValue/awaitPromise/userGesture and returns the value", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    session.responses["Runtime.evaluate"] = () => ({ result: { type: "number", value: 42 } });
    await expect(target.evaluate("6*7", { userGesture: true })).resolves.toBe(42);
    expect(session.sent.at(-1)).toEqual({
      method: "Runtime.evaluate",
      params: { expression: "6*7", returnByValue: true, awaitPromise: true, userGesture: true }
    });
    session.responses["Runtime.evaluate"] = () => ({ result: { type: "number", unserializableValue: "NaN" } });
    await expect(target.evaluate("0/0")).resolves.toBeNaN();
  });

  it("evaluate throws EvaluationError with the exception description", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    session.responses["Runtime.evaluate"] = () => ({
      result: { type: "object" },
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 6,
        exception: { description: "ReferenceError: nope is not defined" }
      }
    });
    const error = (await target.evaluate("nope()").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(EvaluationError);
    expect(error.message).toContain("ReferenceError: nope is not defined");
  });

  it("navigate waits for load stop and surfaces errorText", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    session.responses["Page.navigate"] = () => {
      queueMicrotask(() => {
        session.emit("Page.frameStartedLoading", { frameId: "main" });
        setTimeout(() => session.emit("Page.frameStoppedLoading", { frameId: "main" }), 5);
      });
      return { frameId: "main", loaderId: "L1" };
    };
    await target.navigate("https://example.com/", 10_000);
    expect(target.isLoading()).toBe(false);

    session.responses["Page.navigate"] = () => ({ frameId: "main", loaderId: "L2", errorText: "net::ERR_NAME_NOT_RESOLVED" });
    await expect(target.navigate("https://nope.invalid/", 10_000)).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });

  it("dispose unsubscribes from the session", async () => {
    const session = new FakeSession();
    const target = await ChromeCdpTarget.attach(session);
    target.dispose();
    expect(session.handlers.size).toBe(0);
  });

  describe("reload and history", () => {
    async function attached(extra: FakeSession["responses"] = {}) {
      const session = new FakeSession();
      Object.assign(session.responses, extra);
      const target = await ChromeCdpTarget.attach(session);
      return { session, target };
    }

    it("reload sends Page.reload with ignoreCache and resolves on the next load stop", async () => {
      const { session, target } = await attached({ "Page.reload": () => ({}) });
      let resolved = false;
      const pending = target.reload(true, 1000).then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 5));
      expect(session.sent.at(-1)).toEqual({ method: "Page.reload", params: { ignoreCache: true } });
      expect(resolved).toBe(false);
      session.emit("Page.frameStoppedLoading", { frameId: "main" });
      await pending;
      expect(resolved).toBe(true);
    });

    it("navigateHistory moves to the adjacent entry and waits for the load", async () => {
      const { session, target } = await attached({
        "Page.getNavigationHistory": () => ({
          currentIndex: 1,
          entries: [{ id: 10, url: "https://a.test/" }, { id: 11, url: "https://b.test/" }, { id: 12, url: "https://c.test/" }]
        }),
        "Page.navigateToHistoryEntry": () => ({})
      });
      const back = target.navigateHistory(-1, 1000);
      await new Promise((r) => setTimeout(r, 5));
      expect(session.sent.at(-1)).toEqual({ method: "Page.navigateToHistoryEntry", params: { entryId: 10 } });
      session.emit("Page.frameStoppedLoading", { frameId: "main" });
      await expect(back).resolves.toBe(true);
    });

    it("resolves false without navigating when there is no entry that way", async () => {
      const { session, target } = await attached({
        "Page.getNavigationHistory": () => ({ currentIndex: 0, entries: [{ id: 10, url: "https://a.test/" }] })
      });
      await expect(target.navigateHistory(-1, 1000)).resolves.toBe(false);
      await expect(target.navigateHistory(1, 1000)).resolves.toBe(false);
      expect(session.sent.map((s) => s.method)).not.toContain("Page.navigateToHistoryEntry");
    });

    it("settles on a same-document history move and on a no-load commit (bfcache)", async () => {
      const { session, target } = await attached({
        "Page.getNavigationHistory": () => ({
          currentIndex: 1,
          entries: [{ id: 1, url: "https://a.test/" }, { id: 2, url: "https://a.test/#x" }]
        }),
        "Page.navigateToHistoryEntry": () => ({})
      });
      const sameDoc = target.navigateHistory(-1, 5000);
      await new Promise((r) => setTimeout(r, 5));
      session.emit("Page.navigatedWithinDocument", { frameId: "main", url: "https://a.test/" });
      await expect(sameDoc).resolves.toBe(true);

      const restore = target.navigateHistory(-1, 5000);
      await new Promise((r) => setTimeout(r, 5));
      session.emit("Page.frameNavigated", { frame: { id: "main", url: "https://a.test/" } });
      await expect(restore).resolves.toBe(true);
    });
  });
});
