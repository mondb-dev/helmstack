import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TabSummary } from "../../../packages/shared/src/index.js";
import { activityEntry, approval, createFakeBridge, emptyOverrides, loadShellDom, status, type FakeBridge } from "./helpers/shell-fixtures.js";

// The shell starts viewport-stabilizer intervals/timeouts; fake them so none
// outlive the test environment.
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20);
}

const tabs: TabSummary[] = [
  { id: "tab-1", title: "App", url: "http://localhost:3000/", isActive: true, status: "idle" },
  { id: "tab-2", title: "Docs", url: "https://example.com/", isActive: false, status: "idle" },
];

let fake: FakeBridge;

async function boot(profile: "fe-dev" | "full" = "fe-dev", intentListeners = 0): Promise<void> {
  fake = createFakeBridge({
    listTabs: () => tabs,
    focusTab: () => tabs.map((t) => ({ ...t, isActive: t.id === "tab-2" })),
    getConnectionStatus: () => status({ profile, intentListeners, sseClients: 1 }),
    listAgentActivity: () => [activityEntry({ tabId: "tab-2", agentId: "claude-code", label: "Screenshot" })],
    listPendingApprovals: () => [approval({ summary: "Agent wants to submit the form" })],
    getTabOverrides: (tabId: string) =>
      tabId === "tab-1" ? { ...emptyOverrides("tab-1"), viewport: { width: 390, height: 844, mobile: true } } : emptyOverrides(tabId),
    getIntent: () => "",
    pickElement: (tabId: string) => ({ tabId, url: "", capturedAt: 0, picked: true, selector: "button.cta", tagName: "BUTTON", text: "Buy", id: null }),
  });
  (window as unknown as { browserShell: unknown }).browserShell = fake.bridge;
  vi.resetModules();
  await import("../src/renderer/shell.js");
  await flush();
  await flush();
}

describe("shell bootstrap (fake window.browserShell)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadShellDom();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("has no Demos menu, developer panel or left sidebar", async () => {
    await boot();
    expect(document.getElementById("toolbar-menu")).toBeNull();
    expect(document.getElementById("snapshot-output")).toBeNull();
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(document.getElementById("pick-button")!.textContent).toContain("Select for agent");
  });

  it("wires the connection indicator, approvals banner, override chips and activity feed", async () => {
    await boot();
    expect(document.getElementById("connection-text")!.textContent).toBe(":7070 · 1 client");
    expect(document.getElementById("approval-banner")!.hidden).toBe(false);
    expect(document.getElementById("approval-banner-summary")!.textContent).toBe("Agent wants to submit the form");
    expect(document.getElementById("override-strip")!.hidden).toBe(false);
    expect(document.querySelector("#override-chips .override-chip")!.textContent).toBe("390×844 · mobile");
    expect(document.querySelector("#activity-list .activity-row__label")!.textContent).toBe("Screenshot");
    // Agent badge derived from activity on tab-2 only.
    const [first, second] = document.querySelectorAll<HTMLElement>('#tabs [role="tab"]');
    expect(first.querySelector(".tab-agent")).toBeNull();
    expect(second.querySelector<HTMLElement>(".tab-agent")!.title).toBe("Used by agent claude-code");
  });

  it("reacts to live events", async () => {
    await boot();
    fake.emit("onApprovalsChanged", []);
    expect(document.getElementById("approval-banner")!.hidden).toBe(true);
    fake.emit("onTabOverridesChanged", emptyOverrides("tab-1"));
    expect(document.getElementById("override-strip")!.hidden).toBe(true);
    fake.emit("onConnectionStatusChanged", status({ listening: false, error: "port in use" }));
    expect(document.getElementById("connection-indicator")!.dataset.state).toBe("error");
    fake.emit("onAgentLog", { level: "agent", message: "hello from agent", timestamp: Date.now() });
    expect(document.querySelector("#activity-list .activity-row--log")!.textContent).toContain("hello from agent");
  });

  it("refetches overrides when the active tab changes", async () => {
    await boot();
    (document.querySelectorAll<HTMLElement>('#tabs [role="tab"]')[1]).click();
    await flush();
    expect(fake.fn("getTabOverrides")).toHaveBeenLastCalledWith("tab-2");
    expect(document.getElementById("override-strip")!.hidden).toBe(true);
  });

  it("gates the settings gear and the intent box from connection status", async () => {
    await boot("fe-dev", 0);
    expect(document.getElementById("settings-button")!.hidden).toBe(true);
    expect(document.getElementById("intent-form")!.hidden).toBe(true);

    loadShellDom();
    await boot("full", 1);
    expect(document.getElementById("settings-button")!.hidden).toBe(false);
    expect(document.getElementById("intent-form")!.hidden).toBe(false);
  });

  it("Select for agent runs the picker on the active tab and confirms via toast", async () => {
    await boot();
    document.getElementById("pick-button")!.click();
    await flush();
    expect(fake.fn("pickElement")).toHaveBeenCalledWith("tab-1");
    const toasts = Array.from(document.querySelectorAll(".toast--success")).map((t) => t.textContent);
    expect(toasts.some((t) => t?.includes("button.cta"))).toBe(true);
  });
});
