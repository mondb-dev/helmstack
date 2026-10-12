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
