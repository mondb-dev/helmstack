/**
 * Core events behind the desktop shell's status surfaces: approvals-changed
 * and per-tab override get/clear/changed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PageGraph, PendingApproval, TabId, TabOverrides } from "../../../shared/src/index.js";
import { HelmstackCore } from "../../src/core/helmstack-core.js";
import { ApprovalStore } from "../../src/core/stores/approval-store.js";
import { FakeBackend, makeObservation, type FakeCdpTarget } from "./fakes.js";

let dataDir: string;
let backend: FakeBackend;
let core: HelmstackCore;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "helmstack-shell-status-"));
  backend = new FakeBackend();
  core = new HelmstackCore(backend, { dataDir });
});

afterEach(() => {
  core.dispose();
  rmSync(dataDir, { recursive: true, force: true });
});

async function openTab(): Promise<{ tabId: TabId; cdp: FakeCdpTarget }> {
  const tabs = await core.createTab("https://a.test/");
  const tabId = tabs.at(-1)!.id;
  return { tabId, cdp: backend.tabs.get(tabId)!.cdp };
}

/** The core's private approval store: queues an approval as the registry would. */
function queueApproval(tabId: TabId): PendingApproval {
  const store = (core as unknown as { approvals: ApprovalStore }).approvals;
  return store.create(tabId, { type: "submit", node: { tabId, frameId: "0", backendNodeId: 1, role: "button" } }, [], "Submit form");
}

function graph(tabId: TabId): PageGraph {
  return {
    tabId, url: "https://a.test/", title: "t", kind: "generic" as PageGraph["kind"],
    headings: [], forms: [], actions: [], alerts: [], media: [], oauthProviders: [],
    accessibility: { nodeCount: 0, roleCounts: {}, headingTrail: [], interactiveNodes: [] },
    signals: { documentCount: 1, accessibilityNodeCount: 0, formCount: 0, actionCount: 0, capturedAt: 0 }
  };
}

describe("ApprovalStore.onChanged", () => {
  it("fires with the full list on create, take, reject and clearTab", () => {
    const store = new ApprovalStore();
    const order: string[] = [];
    store.onCreated(() => order.push("created"));
    store.onChanged((list) => order.push(`changed:${list.length}`));
    const cmd = { type: "request_perception_refresh", tabId: "t1" } as const;
    const a = store.create("t1", cmd, [], "a");
    store.create("t1", cmd, [], "b");
    const c = store.create("t2", cmd, [], "c");
    store.take(a.requestId);
    store.reject(c.requestId);
    store.reject("missing");
    expect(store.clearTab("t1")).toBe(1);
    expect(store.clearTab("t1")).toBe(0);
    expect(order).toEqual([
      "created", "changed:1", "created", "changed:2", "created", "changed:3",
      "changed:2", "changed:1", "changed:0"
    ]);
  });
});

describe("HelmstackCore approvals-changed", () => {
  it("fires on queue (after approval_queued), reject and tab-close cleanup", async () => {
    const { tabId } = await openTab();
    const order: string[] = [];
    const lists: PendingApproval[][] = [];
    core.onApprovalQueued(() => order.push("queued"));
    core.onApprovalsChanged((list) => {
      order.push("changed");
      lists.push(list);
    });

    const first = queueApproval(tabId);
    queueApproval(tabId);
    expect(order).toEqual(["queued", "changed", "queued", "changed"]);
    expect(lists.at(-1)!.map((a) => a.requestId)).toContain(first.requestId);

    core.rejectCommand(first.requestId);
    expect(lists.at(-1)).toHaveLength(1);

    await core.closeTab(tabId);
    expect(lists.at(-1)).toEqual([]);
    expect(core.listPendingApprovals()).toEqual([]);
  });

  it("fires when an approval is taken for execution", async () => {
    const { tabId, cdp } = await openTab();
    // Minimal perception so approveCommand gets as far as taking the approval.
    cdp.handlers.set("Page.getFrameTree", () => ({ frameTree: { frame: { id: "main" } } }));
    cdp.handlers.set("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
    cdp.handlers.set("Runtime.evaluate", () => ({ result: { type: "string", value: JSON.stringify(makeObservation("" as TabId)) } }));
    cdp.handlers.set("DOMSnapshot.captureSnapshot", () => ({ documents: [], strings: [] }));
    cdp.handlers.set("Accessibility.getFullAXTree", () => ({ nodes: [] }));
    const approval = queueApproval(tabId);
    const lists: PendingApproval[][] = [];
    const off = core.onApprovalsChanged((list) => lists.push(list));
    // Executing the submit on the fake page may fail; the take must still be announced.
    await core.approveCommand(approval.requestId).catch(() => {});
    expect(lists[0]).toEqual([]);
    off();
    queueApproval(tabId);
    expect(lists).toHaveLength(1);
  });
});

describe("HelmstackCore tab overrides", () => {
  it("starts empty", async () => {
    const { tabId } = await openTab();
    expect(core.getTabOverrides(tabId)).toEqual({
      tabId, viewport: null, media: null, resourceBudget: null, location: null,
      networkMockRuleCount: 0, recording: false, watches: { total: 0, passing: 0, failing: 0 }
    });
  });

  it("reflects every override and emits on each change", async () => {
    const { tabId } = await openTab();
    const events: TabOverrides[] = [];
    core.onTabOverridesChanged((o) => events.push(o));

    await core.setEmulatedViewport(tabId, 390, 844, true);
    await core.setMediaEmulation(tabId, { colorScheme: "dark" });
    await core.setResourceBudget(tabId, { cpuThrottlingRate: 4 });
    await core.setLocationOverride(tabId, { latitude: 1, longitude: 2, timezoneId: "Asia/Manila", locale: "fil-PH" });
    await core.enableNetworkMock(tabId, [{ urlPattern: "*/api/*", status: 200, body: "{}" }] as never);
    core.startRecording(tabId);
    core.addAssertionWatch(tabId, "page has a heading");

    expect(events).toHaveLength(7);
    expect(events.at(-1)).toEqual({
      tabId,
      viewport: { width: 390, height: 844, mobile: true },
      media: { colorScheme: "dark" },
      resourceBudget: { cpuThrottlingRate: 4 },
      location: { latitude: 1, longitude: 2, timezoneId: "Asia/Manila", locale: "fil-PH" },
      networkMockRuleCount: 1,
      recording: true,
      watches: { total: 1, passing: 0, failing: 0 }
    });
    expect(core.getTabOverrides(tabId)).toEqual(events.at(-1));
  });

  it("emits on watch pass/fail transitions only", async () => {
    const { tabId } = await openTab();
    core.addAssertionWatch(tabId, "the page shows an error alert");
    const events: TabOverrides[] = [];
    core.onTabOverridesChanged((o) => events.push(o));
    const evaluate = (core as unknown as { evaluateAssertionWatches(t: TabId, g: PageGraph): void }).evaluateAssertionWatches.bind(core);

    evaluate(tabId, graph(tabId));
    expect(events).toHaveLength(1);
    const { watches } = events[0]!;
    expect(watches.total).toBe(1);
    expect(watches.passing + watches.failing).toBe(1);

    evaluate(tabId, graph(tabId)); // same result → no transition
    expect(events).toHaveLength(1);
  });

  it("clears one kind, undoing its CDP state", async () => {
    const { tabId, cdp } = await openTab();
    await core.setLocationOverride(tabId, { latitude: 1, longitude: 2, timezoneId: "Asia/Manila", locale: "fil-PH" });
    await core.setMediaEmulation(tabId, { colorScheme: "dark" });
    cdp.calls.length = 0;

    const after = await core.clearTabOverrides(tabId, "location");
    expect(after.location).toBeNull();
    expect(after.media).toEqual({ colorScheme: "dark" });
    expect(cdp.calls).toEqual([
      { method: "Emulation.clearGeolocationOverride", params: undefined },
      { method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } },
      { method: "Emulation.setLocaleOverride", params: {} }
    ]);
  });

  it('clears "all" via the existing clear paths, emitting once', async () => {
    const { tabId, cdp } = await openTab();
    await core.setEmulatedViewport(tabId, 390, 844, true);
    await core.setMediaEmulation(tabId, { colorScheme: "dark" });
    await core.setResourceBudget(tabId, { cpuThrottlingRate: 4 });
    await core.setLocationOverride(tabId, { latitude: 1, longitude: 2 });
    await core.enableNetworkMock(tabId, [{ urlPattern: "*" }] as never);
    core.startRecording(tabId);
    core.addAssertionWatch(tabId, "page has a heading");
    cdp.calls.length = 0;
    const events: TabOverrides[] = [];
    core.onTabOverridesChanged((o) => events.push(o));

    const after = await core.clearTabOverrides(tabId, "all");

    expect(after).toEqual({
      tabId, viewport: null, media: null, resourceBudget: null, location: null,
      networkMockRuleCount: 0, recording: false, watches: { total: 0, passing: 0, failing: 0 }
    });
    expect(events).toEqual([after]);
    expect(core.listAssertionWatches(tabId)).toEqual([]);
    expect(core.getRecording(tabId)).toBeNull();
    expect(cdp.methods()).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setEmulatedMedia",
      "Emulation.setCPUThrottlingRate",
      "Network.emulateNetworkConditions",
      "Emulation.clearGeolocationOverride",
      "Emulation.setTimezoneOverride",
      "Emulation.setLocaleOverride",
      "Fetch.disable"
    ]);
    expect(cdp.calls.find((c) => c.method === "Emulation.setCPUThrottlingRate")!.params).toEqual({ rate: 1 });
  });

  it("is a no-op on CDP when nothing is set", async () => {
    const { tabId, cdp } = await openTab();
    cdp.calls.length = 0;
    await core.clearTabOverrides(tabId, "all");
    expect(cdp.calls).toEqual([]);
  });

  it("emits on clears through the agent API and on removing a watch", async () => {
    const { tabId } = await openTab();
    await core.setMediaEmulation(tabId, { colorScheme: "dark" });
    const watch = core.addAssertionWatch(tabId, "page has a heading");
    const events: TabOverrides[] = [];
    core.onTabOverridesChanged((o) => events.push(o));

    await core.clearMediaEmulation(tabId);
    core.removeAssertionWatch(watch.id);
    core.removeAssertionWatch("missing");
    expect(events.map((e) => [e.media, e.watches.total])).toEqual([[null, 1], [null, 0]]);
  });

  it("emits a final empty state once when the tab closes", async () => {
    const { tabId } = await openTab();
    await core.setMediaEmulation(tabId, { colorScheme: "dark" });
    const events: TabOverrides[] = [];
    core.onTabOverridesChanged((o) => events.push(o));
    await core.closeTab(tabId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tabId, media: null, recording: false, networkMockRuleCount: 0 });
  });
});
