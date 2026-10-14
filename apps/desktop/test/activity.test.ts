import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_RENDER_CAP,
  CALL_STATES,
  COLLAPSED_STORAGE_KEY,
  callState,
  connectHint,
  mountActivity,
  selectFeed,
  type ActivityController,
} from "../src/renderer/panels/activity.js";
import { activityEntry, flush, loadShellDom, status } from "./helpers/shell-fixtures.js";

let activeTab = "tab-1";
let controller: ActivityController | null = null;

function setup(extra: Partial<Parameters<typeof mountActivity>[0]> = {}) {
  const bridge = {
    setIntent: vi.fn(async () => undefined),
    getIntent: vi.fn(async () => "check the header"),
  };
  const onLayoutChange = vi.fn();
  const onShowConnection = vi.fn();
  controller = mountActivity({
    bridge,
    activeTabId: () => activeTab,
    tabLabel: (id) => (id === "tab-1" ? "localhost:3000" : undefined),
    onLayoutChange,
    onShowConnection,
    now: () => 1_700_000_100_000,
    ...extra,
  });
  return { bridge, controller, onLayoutChange, onShowConnection };
}

const rows = () => Array.from(document.querySelectorAll<HTMLLIElement>("#activity-list .activity-row"));

describe("agent activity panel", () => {
  beforeEach(() => {
    loadShellDom();
    activeTab = "tab-1";
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    controller?.destroy();
    controller = null;
  });

  it("shows connect-an-agent guidance when empty, with a link to the connection popover", () => {
    const { onShowConnection } = setup();
    const empty = document.querySelector("#activity-list .empty-state")!;
    expect(empty.textContent).toContain("No agent activity yet");
    expect(empty.textContent).not.toContain(":7070"); // port unknown until status arrives
    const button = Array.from(empty.querySelectorAll("button")).find((b) => b.textContent === "Show connection details")!;
    button.click();
    expect(onShowConnection).toHaveBeenCalled();
  });

  it("lists calls newest first with status, label, summary, time and tab", () => {
    const { controller } = setup();
    controller.setActivity([
      activityEntry({ label: "Screenshot", at: 1_700_000_000_000, tabId: "tab-1" }),
      activityEntry({ label: "Accessibility audit", summary: "4 issues", at: 1_700_000_090_000, tabId: "tab-1", agentId: "claude-code" }),
      activityEntry({ label: "Assert styles", ok: false, status: 422, at: 1_700_000_050_000, tabId: "tab-1" }),
    ]);
    const list = rows();
    expect(list.map((r) => r.querySelector(".activity-row__label")!.textContent)).toEqual([
      "Accessibility audit",
      "Assert styles",
      "Screenshot",
    ]);
    expect(list[0].className).toContain("activity-row--ok");
    expect(list[0].querySelector(".activity-row__summary")!.textContent).toBe("4 issues");
    expect(list[0].querySelector(".activity-row__meta")!.textContent).toContain("10s ago");
    expect(list[0].querySelector(".activity-row__meta")!.textContent).toContain("localhost:3000");
    expect(list[0].querySelector(".activity-row__meta")!.textContent).toContain("claude-code");
    expect(list[1].className).toContain("activity-row--fail");
    expect(list[1].textContent).toContain("Failed:");
    expect(list[1].textContent).toContain("HTTP 422");
  });

  it("appends live entries and de-duplicates by id", () => {
    const { controller } = setup();
    const entry = activityEntry({ label: "Navigate" });
    controller.addActivity(entry);
    controller.setActivity([entry]);
    controller.addActivity(entry);
    expect(rows()).toHaveLength(1);
  });

  it("filters to this tab, and switching tabs re-filters", () => {
    const { controller } = setup();
    controller.setActivity([
      activityEntry({ label: "On tab 1", tabId: "tab-1" }),
      activityEntry({ label: "On tab 2", tabId: "tab-2" }),
      activityEntry({ label: "No tab" }),
    ]);
    expect(rows()).toHaveLength(3);

    const thisTab = document.querySelector<HTMLButtonElement>('[data-filter="tab"]')!;
    thisTab.click();
    expect(thisTab.getAttribute("aria-pressed")).toBe("true");
    expect(rows().map((r) => r.querySelector(".activity-row__label")!.textContent)).toEqual(["On tab 1"]);

    activeTab = "tab-2";
    controller.refreshForTab();
    expect(rows().map((r) => r.querySelector(".activity-row__label")!.textContent)).toEqual(["On tab 2"]);

    activeTab = "tab-3";
    controller.refreshForTab();
    expect(document.querySelector("#activity-list .empty-state")!.textContent).toContain("No agent calls on this tab yet");
  });

  it(`caps rendered rows at ${ACTIVITY_RENDER_CAP} and says so`, () => {
    const { controller } = setup();
    controller.setActivity(Array.from({ length: 250 }, () => activityEntry()));
    expect(rows()).toHaveLength(ACTIVITY_RENDER_CAP);
    const footer = document.getElementById("activity-footer")!;
    expect(footer.hidden).toBe(false);
    expect(footer.textContent).toBe("Showing the latest 200 of 250.");
  });

  it("shows agent-log lines in the same feed, visually distinct, under All tabs only", () => {
    const { controller } = setup();
    controller.addActivity(activityEntry({ label: "Screenshot", tabId: "tab-1", at: 1_700_000_000_000 }));
    controller.addLog({ level: "error", message: "MCP tool failed", timestamp: 1_700_000_050_000 });
    const list = rows();
    expect(list).toHaveLength(2);
    expect(list[0].className).toContain("activity-row--log");
    expect(list[0].className).toContain("activity-row--log-error");
    expect(list[0].textContent).toContain("MCP tool failed");

    controller.setFilter("tab");
    expect(rows().some((r) => r.className.includes("activity-row--log"))).toBe(false);
  });

  it("tracks which agents touched which tabs", () => {
    const onAgentsByTabChange = vi.fn();
    const { controller } = setup({ onAgentsByTabChange });
    controller.addActivity(activityEntry({ tabId: "tab-1", agentId: "claude-code" }));
    controller.addActivity(activityEntry({ tabId: "tab-1", agentId: "cursor" }));
    controller.addActivity(activityEntry({ tabId: "tab-2" }));
    expect([...controller.agentsByTab().get("tab-1")!]).toEqual(["claude-code", "cursor"]);
    expect(controller.agentsByTab().get("tab-2")!.size).toBe(0);
    expect(onAgentsByTabChange).toHaveBeenCalledTimes(3);
  });

  it("collapses, persists the choice, and re-syncs the viewport", () => {
    const { controller, onLayoutChange } = setup();
    const toggle = document.getElementById("activity-collapse")!;
    toggle.click();
    expect(controller.isCollapsed()).toBe(true);
    expect(document.getElementById("activity-body")!.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("1");
    expect(onLayoutChange).toHaveBeenCalled();

    controller.destroy();
    loadShellDom();
    const again = setup();
    expect(again.controller.isCollapsed()).toBe(true);
  });

  it("survives storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      const { controller } = setup();
      expect(controller.isCollapsed()).toBe(false);
      document.getElementById("activity-collapse")!.click();
      expect(controller.isCollapsed()).toBe(true);
    } finally {
      spy.mockRestore();
      set.mockRestore();
    }
  });

  it("shows the intent box only while an agent listens for intents", async () => {
    const { controller, bridge } = setup();
    const form = document.getElementById("intent-form")!;
    expect(form.hidden).toBe(true);
    controller.setIntentListeners(2);
    expect(form.hidden).toBe(false);
    await flush();
    const box = document.getElementById("intent-box") as HTMLTextAreaElement;
    expect(box.value).toBe("check the header");
    box.value = "make the button blue";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(bridge.setIntent).toHaveBeenCalledWith("make the button blue");
    controller.setIntentListeners(0);
    expect(form.hidden).toBe(true);
  });
});

describe("selectFeed", () => {
  it("sorts newest first and caps", () => {
    const items = [1, 3, 2].map((n) => ({ kind: "call" as const, id: `c${n}`, at: n, entry: activityEntry({ at: n }) }));
    const { rows: out, total } = selectFeed(items, "all", undefined, 2);
    expect(out.map((i) => i.at)).toEqual([3, 2]);
    expect(total).toBe(3);
  });

});

describe("agent activity panel — connection hint, row states, closed tabs", () => {
  beforeEach(() => {
    loadShellDom();
    activeTab = "tab-1";
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    controller?.destroy();
    controller = null;
  });

  it("empty-state hint uses the live port, or explains the API is off", () => {
    const { controller } = setup();
    const empty = () => document.querySelector("#activity-list .empty-state")!.textContent!;
    controller.setConnection(status({ port: 7171 }));
    expect(empty()).toContain("(:7171)");
    expect(empty()).not.toContain(":7070");
    controller.setConnection(status({ listening: false, port: null, error: "port in use" }));
    expect(empty()).toContain("agent API is off");
    expect(empty()).not.toMatch(/:\d{4}/);
  });

  it("awaiting approval / human rows get a pending clock icon in the warning tone, not a success check", () => {
    const { controller } = setup();
    controller.setActivity([
      activityEntry({ label: "Run page command", summary: "awaiting approval", at: 1_700_000_090_000 }),
      activityEntry({ label: "Approve action", summary: "completed", at: 1_700_000_080_000 }),
      activityEntry({ label: "Run page command", summary: "blocked", at: 1_700_000_070_000 }),
    ]);
    const [pending, done, blocked] = rows();
    expect(pending.className).toContain("activity-row--pending");
    expect(pending.textContent).toContain("Awaiting approval:");
    expect(pending.querySelector(".activity-row__status svg circle")).not.toBeNull(); // clock face
    expect(pending.textContent).not.toContain("Succeeded:");
    expect(done.className).toContain("activity-row--ok");
    expect(blocked.className).toContain("activity-row--fail");
  });

  it("maps summary states to icons in one table", () => {
    expect(CALL_STATES["awaiting approval"]).toMatchObject({ icon: "clock", tone: "pending" });
    expect(CALL_STATES["awaiting human"]).toMatchObject({ icon: "clock", tone: "pending" });
    expect(CALL_STATES.completed).toMatchObject({ icon: "check", tone: "ok" });
    expect(callState(activityEntry({ summary: "4 issues" }))).toBe(CALL_STATES.completed);
    expect(callState(activityEntry({ ok: false, summary: "awaiting approval" }))).toBe(CALL_STATES.failed);
  });

  it("shows 'Closed tab' instead of a raw tab id when the tab is unknown", () => {
    const { controller } = setup();
    controller.setActivity([activityEntry({ tabId: "9f1c2d3e-0000-4000-8000-abcdefabcdef" })]);
    const meta = rows()[0].querySelector(".activity-row__meta")!.textContent!;
    expect(meta).toContain("Closed tab");
    expect(meta).not.toContain("9f1c2d3e");
  });

  it("connectHint never invents a port", () => {
    expect(connectHint(null)).not.toMatch(/:\d+/);
    expect(connectHint(status({ port: 7070 }))).toContain("(:7070)");
  });
});
