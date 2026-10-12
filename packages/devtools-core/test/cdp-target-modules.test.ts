import { describe, expect, it, vi } from "vitest";

import type { CdpTarget } from "../../shared/src/index.js";
import { executeBrowserAction, waitForPageSettled } from "../src/core/cdp/dom-actuator.js";
import { applyLocationOverride, applyMediaEmulation, applyResourceBudget } from "../src/core/cdp/overrides.js";

function fakeTarget(responses: Record<string, unknown> = {}) {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const target: CdpTarget = {
    send: async <T>(method: string, params?: Record<string, unknown>) => {
      sent.push({ method, params });
      return (responses[method] ?? {}) as T;
    },
    onEvent: () => () => {},
    evaluate: async <T>() => undefined as T,
    url: () => "https://example.com/",
    isLoading: () => false,
    waitForLoadStop: vi.fn(async () => {})
  };
  return { target, sent };
}

describe("overrides over CdpTarget", () => {
  it("is a no-op when the override state is unset", async () => {
    const { target, sent } = fakeTarget();
    await applyMediaEmulation(target, null);
    await applyResourceBudget(target, null);
    await applyLocationOverride(target, null);
    expect(sent).toEqual([]);
  });

  it("pushes media, budget and location overrides", async () => {
    const { target, sent } = fakeTarget();
    await applyMediaEmulation(target, { colorScheme: "dark" });
    await applyResourceBudget(target, { cpuThrottlingRate: 4, downloadThroughputKbps: 8 });
    await applyLocationOverride(target, { latitude: 1, longitude: 2, timezoneId: "Asia/Manila" });
    expect(sent.map((c) => c.method)).toEqual([
      "Emulation.setEmulatedMedia",
      "Emulation.setCPUThrottlingRate",
      "Network.emulateNetworkConditions",
      "Emulation.setGeolocationOverride",
      "Emulation.setTimezoneOverride"
    ]);
    expect(sent[0].params).toEqual({ media: "", features: [{ name: "prefers-color-scheme", value: "dark" }] });
    expect(sent[2].params).toMatchObject({ downloadThroughput: 1024, uploadThroughput: -1 });
  });

  it("swallows CDP failures", async () => {
    const target: CdpTarget = { ...fakeTarget().target, send: async () => { throw new Error("detached"); } };
    await expect(applyMediaEmulation(target, { colorScheme: "light" })).resolves.toBeUndefined();
  });
});

describe("dom-actuator over CdpTarget", () => {
  it("resolves, calls and releases the backend node on click", async () => {
    const { target, sent } = fakeTarget({ "DOM.resolveNode": { object: { objectId: "obj-1" } } });
    await executeBrowserAction(target, { type: "click", node: { tabId: "t", frameId: "0", backendNodeId: 7, role: "button" } }, (v) => v);
    expect(sent.map((c) => c.method)).toEqual(["DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject"]);
    expect(sent[0].params).toEqual({ backendNodeId: 7 });
    expect(sent[1].params).toMatchObject({ objectId: "obj-1", awaitPromise: true });
  });

  it("waitForPageSettled delegates to waitForLoadStop", async () => {
    const { target } = fakeTarget();
    await waitForPageSettled(target, 1234);
    expect(target.waitForLoadStop).toHaveBeenCalledWith(1234);
  });
});
