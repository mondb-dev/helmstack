import { describe, expect, it, vi } from "vitest";

import type { TabSummary } from "../../../packages/shared/src/index.js";
import { agentBadgeTooltip, renderTabStrip } from "../src/renderer/panels/tabs.js";

const tabs: TabSummary[] = [
  { id: "a", title: "Home", url: "http://localhost:3000/", isActive: true, status: "idle" },
  { id: "b", title: "Docs", url: "https://example.com/docs", isActive: false, status: "idle" },
];

describe("tab strip", () => {
  it("renders an ARIA tablist with roving tabindex", () => {
    const container = document.createElement("div");
    renderTabStrip(container, tabs, new Map(), { onActivate: vi.fn(), onClose: vi.fn() });
    const items = container.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("aria-selected")).toBe("true");
    expect(items[0].tabIndex).toBe(0);
    expect(items[1].tabIndex).toBe(-1);
  });

  it("badges tabs agents touched, naming the agents in the tooltip", () => {
    const container = document.createElement("div");
    renderTabStrip(container, tabs, new Map([["b", new Set(["claude-code"])]]), { onActivate: vi.fn(), onClose: vi.fn() });
    const [first, second] = container.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(first.querySelector(".tab-agent")).toBeNull();
    const badge = second.querySelector<HTMLElement>(".tab-agent")!;
    expect(badge.title).toBe("Used by agent claude-code");
    expect(second.textContent).toContain("Used by agent claude-code");
  });

  it("formats the tooltip for anonymous and multiple agents", () => {
    expect(agentBadgeTooltip([])).toBe("Used by an agent");
    expect(agentBadgeTooltip(["a", "b"])).toBe("Used by agents a, b");
  });

  it("activates and closes through the handlers", () => {
    const container = document.createElement("div");
    const onActivate = vi.fn();
    const onClose = vi.fn();
    renderTabStrip(container, tabs, new Map(), { onActivate, onClose });
    const second = container.querySelectorAll<HTMLElement>('[role="tab"]')[1];
    second.click();
    expect(onActivate).toHaveBeenCalledWith(tabs[1]);
    second.querySelector<HTMLButtonElement>(".tab-close")!.click();
    expect(onClose).toHaveBeenCalledWith(tabs[1]);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
