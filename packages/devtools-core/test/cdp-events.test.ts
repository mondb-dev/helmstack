import { describe, expect, it } from "vitest";

import { type CdpEventState, handleCdpMessage } from "../src/core/cdp/cdp-events.js";
import { buildHar } from "../src/core/reports/har.js";
import type { CdpTarget } from "../../shared/src/index.js";

function emptyState(): CdpEventState {
  return {
    consoleLogs: [],
    networkRequests: new Map(),
    webSocketUrls: new Map(),
    webSocketFrames: [],
    eventSourceEvents: [],
    jsErrors: [],
    networkMockRules: null
  };
}

const cdp = {} as CdpTarget;

describe("handleCdpMessage Network.requestWillBeSent", () => {
  it("stamps requests with wall-clock time, not CDP's monotonic timestamp", () => {
    const state = emptyState();
    const wallTime = Date.parse("2026-10-13T08:30:00.000Z") / 1000;
    handleCdpMessage(state, cdp, "Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://example.com/", method: "GET", headers: {} },
      timestamp: 76.273,
      wallTime
    });

    const entry = state.networkRequests.get("r1");
    expect(entry?.timestamp).toBe(wallTime * 1000);
    const har = buildHar("https://example.com/", [...state.networkRequests.values()]);
    expect(har.log.entries[0].startedDateTime).toBe("2026-10-13T08:30:00.000Z");
  });

  it("falls back to the current time when wallTime is missing", () => {
    const state = emptyState();
    const before = Date.now();
    handleCdpMessage(state, cdp, "Network.requestWillBeSent", {
      requestId: "r2",
      request: { url: "https://example.com/", method: "GET" },
      timestamp: 76.273
    });

    expect(state.networkRequests.get("r2")?.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe("handleCdpMessage Runtime.consoleAPICalled", () => {
  const str = (value: string) => ({ type: "string", value });
  const num = (value: number) => ({ type: "number", value, description: String(value) });
  const MAIN = { id: 1, name: "", origin: "https://example.com", auxData: { isDefault: true, type: "default", frameId: "F" } };
  const ISOLATED = { id: 2, name: "helmstack", origin: "", auxData: { isDefault: false, type: "isolated", frameId: "F" } };

  function emit(state: CdpEventState, type: string, args: unknown[], extra: Record<string, unknown> = {}) {
    handleCdpMessage(state, cdp, "Runtime.consoleAPICalled", {
      type, args, executionContextId: 1, timestamp: 1_760_000_000_000, ...extra
    });
  }

  it("maps console types to levels", () => {
    const state = emptyState();
    for (const type of ["log", "info", "warning", "error", "debug", "trace", "dir", "table", "assert"]) {
      emit(state, type, [str(type)]);
    }
    expect(state.consoleLogs.map((e) => e.level)).toEqual(
      ["log", "info", "warn", "error", "debug", "log", "log", "log", "error"]
    );
    expect(state.consoleLogs.at(-1)?.text).toBe("Assertion failed: assert");
  });

  it("drops non-message calls (clear, endGroup)", () => {
    const state = emptyState();
    emit(state, "clear", []);
    emit(state, "endGroup", []);
    expect(state.consoleLogs).toEqual([]);
  });

  it("formats args like the console, joined by spaces", () => {
    const state = emptyState();
    emit(state, "log", [
      str("hello"),
      num(42),
      { type: "boolean", value: true },
      { type: "undefined" },
      { type: "object", subtype: "null", value: null },
      { type: "number", unserializableValue: "NaN", description: "NaN" },
      { type: "bigint", unserializableValue: "10n", description: "10n" },
      { type: "object", className: "Object", description: "Object", objectId: "o1" },
      { type: "function", className: "Function", description: "() => 1", objectId: "o2" }
    ]);
    expect(state.consoleLogs[0]?.text).toBe("hello 42 true undefined null NaN 10n Object () => 1");
  });

  it("applies minimal printf substitution on a leading format string", () => {
    const state = emptyState();
    emit(state, "log", [str("%s has %d items (%c%f%%)"), str("cart"), num(3.7), str("color:red"), num(1.5), str("extra")]);
    expect(state.consoleLogs[0]?.text).toBe("cart has 3 items (1.5%) extra");
  });

  it("takes url/lineNumber from the top call frame and the epoch-ms timestamp as-is", () => {
    const state = emptyState();
    const timestamp = Date.parse("2026-10-13T08:30:00.000Z");
    emit(state, "log", [str("x")], {
      timestamp,
      stackTrace: { callFrames: [{ functionName: "f", url: "https://example.com/app.js", lineNumber: 9, columnNumber: 2, scriptId: "1" }] }
    });
    expect(state.consoleLogs[0]).toEqual({
      level: "log", text: "x", url: "https://example.com/app.js", lineNumber: 9, timestamp
    });
    expect(new Date(state.consoleLogs[0]!.timestamp).toISOString()).toBe("2026-10-13T08:30:00.000Z");
  });

  it("ignores console calls from isolated worlds (our injected code) and tracks context lifecycle", () => {
    const state = emptyState();
    handleCdpMessage(state, cdp, "Runtime.executionContextCreated", { context: MAIN });
    handleCdpMessage(state, cdp, "Runtime.executionContextCreated", { context: ISOLATED });
    emit(state, "log", [str("page")], { executionContextId: 1 });
    emit(state, "log", [str("ours")], { executionContextId: 2 });
    expect(state.consoleLogs.map((e) => e.text)).toEqual(["page"]);

    // Context ids are reused only after destruction/clear; a later page context with id 2 is recorded.
    handleCdpMessage(state, cdp, "Runtime.executionContextsCleared", {});
    handleCdpMessage(state, cdp, "Runtime.executionContextCreated", { context: { ...MAIN, id: 2 } });
    emit(state, "log", [str("page2")], { executionContextId: 2 });
    handleCdpMessage(state, cdp, "Runtime.executionContextCreated", { context: { ...ISOLATED, id: 3 } });
    handleCdpMessage(state, cdp, "Runtime.executionContextDestroyed", { executionContextId: 3 });
    emit(state, "log", [str("unknown")], { executionContextId: 3 });
    expect(state.consoleLogs.map((e) => e.text)).toEqual(["page", "page2", "unknown"]);
  });

  it("does not duplicate console messages echoed via Log.entryAdded", () => {
    const state = emptyState();
    emit(state, "error", [str("boom")]);
    handleCdpMessage(state, cdp, "Log.entryAdded", {
      entry: { source: "console-api", level: "error", text: "boom", timestamp: 1_760_000_000_000 }
    });
    handleCdpMessage(state, cdp, "Log.entryAdded", {
      entry: { source: "network", level: "warning", text: "Failed to load", timestamp: 1_760_000_000_001 }
    });
    expect(state.consoleLogs.map((e) => [e.level, e.text])).toEqual([["error", "boom"], ["warn", "Failed to load"]]);
  });
});
