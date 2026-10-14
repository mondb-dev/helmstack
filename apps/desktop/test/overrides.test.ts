import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TabOverrides } from "../../../packages/shared/src/index.js";
import { describeOverrides, mountOverridesStrip } from "../src/renderer/panels/overrides.js";
import { emptyOverrides, flush, loadShellDom } from "./helpers/shell-fixtures.js";

function withAll(tabId = "tab-1"): TabOverrides {
  return {
    ...emptyOverrides(tabId),
    viewport: { width: 390, height: 844, mobile: true },
    media: { colorScheme: "dark", reducedMotion: "reduce", media: "print" },
    resourceBudget: { cpuThrottlingRate: 4, downloadThroughputKbps: 400, latencyMs: 150 },
    location: { latitude: 37.77, longitude: -122.42, timezoneId: "America/Los_Angeles" },
    networkMockRuleCount: 3,
    recording: true,
    watches: { total: 3, passing: 2, failing: 1 },
  };
}

describe("describeOverrides", () => {
  it("returns no chips for a clean tab", () => {
    expect(describeOverrides(emptyOverrides("t"))).toEqual([]);
  });

  it("labels every kind, in canonical order", () => {
    const chips = describeOverrides(withAll());
    expect(chips.map((c) => [c.kind, c.label])).toEqual([
      ["viewport", "390×844 · mobile"],
      ["media", "Dark · Reduced motion · Print"],
      ["resourceBudget", "4× CPU · Slow network"],
      ["location", "Location · America/Los_Angeles"],
      ["networkMock", "3 mocks"],
      ["recording", "Recording"],
      ["watches", "Watches 2/3"],
    ]);
  });

  it("uses warning tone, and danger only for failing watches", () => {
    const chips = describeOverrides(withAll());
    expect(chips.filter((c) => c.tone === "danger").map((c) => c.kind)).toEqual(["watches"]);
    const passing = describeOverrides({ ...emptyOverrides("t"), watches: { total: 2, passing: 2, failing: 0 } });
    expect(passing[0].tone).toBe("warning");
  });

  it("handles offline, singular mocks and desktop viewports", () => {
    const chips = describeOverrides({
      ...emptyOverrides("t"),
      viewport: { width: 1280, height: 800, mobile: false },
      resourceBudget: { offline: true },
      networkMockRuleCount: 1,
    });
    expect(chips.map((c) => c.label)).toEqual(["1280×800", "Offline", "1 mock"]);
  });
});

describe("override chips strip", () => {
  beforeEach(() => {
    loadShellDom();
  });

  function setup(initial: TabOverrides) {
    const bridge = {
      getTabOverrides: vi.fn(async (tabId: string) => (tabId === initial.tabId ? initial : emptyOverrides(tabId))),
      clearTabOverrides: vi.fn(async (tabId: string, kind: string) => {
        if (kind === "all") return emptyOverrides(tabId);
        return { ...initial, ...(kind === "viewport" ? { viewport: null } : {}), ...(kind === "networkMock" ? { networkMockRuleCount: 0 } : {}) };
      }),
    };
    const onLayoutChange = vi.fn();
    const strip = mountOverridesStrip({ bridge, onLayoutChange, fallbackFocus: () => document.getElementById("address-input") });
    return { bridge, strip, onLayoutChange };
  }

  const chipButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("#override-chips .override-chip"));
  const stripEl = () => document.getElementById("override-strip")!;

  it("stays hidden when the active tab has no overrides", async () => {
    const { strip } = setup(emptyOverrides("tab-1"));
    await strip.setActiveTab("tab-1");
    expect(stripEl().hidden).toBe(true);
    expect(chipButtons()).toHaveLength(0);
  });

  it("renders one chip per active kind and re-syncs layout", async () => {
    const { strip, onLayoutChange } = setup(withAll());
    await strip.setActiveTab("tab-1");
    expect(stripEl().hidden).toBe(false);
    expect(chipButtons().map((b) => b.dataset.kind)).toEqual([
      "viewport",
      "media",
      "resourceBudget",
      "location",
      "networkMock",
      "recording",
      "watches",
    ]);
    expect(chipButtons().at(-1)!.className).toContain("override-chip--danger");
    expect(onLayoutChange).toHaveBeenCalled();
  });

  it("each chip opens a labelled popover with details; Escape closes and returns focus", async () => {
    const { strip } = setup(withAll());
    await strip.setActiveTab("tab-1");
    const chip = chipButtons()[0];
    chip.click();
    const panel = document.getElementById(chip.getAttribute("aria-controls")!)!;
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.textContent).toContain("390 × 844 px");
    expect(panel.contains(document.activeElement)).toBe(true);

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(chip);
  });

  it("Clear in a chip popover clears just that kind", async () => {
    const { strip, bridge } = setup(withAll());
    await strip.setActiveTab("tab-1");
    chipButtons()[0].click();
    const clear = Array.from(document.querySelectorAll<HTMLButtonElement>(".popover button")).find((b) => b.textContent === "Clear")!;
    clear.click();
    await flush();
    expect(bridge.clearTabOverrides).toHaveBeenCalledWith("tab-1", "viewport");
    expect(chipButtons().map((b) => b.dataset.kind)).not.toContain("viewport");
    expect(chipButtons()).toHaveLength(6);
  });

  it("Clear all clears every override and hides the strip", async () => {
    const { strip, bridge } = setup(withAll());
    await strip.setActiveTab("tab-1");
    document.getElementById("override-clear-all")!.click();
    await flush();
    expect(bridge.clearTabOverrides).toHaveBeenCalledWith("tab-1", "all");
    expect(stripEl().hidden).toBe(true);
  });

  it("applies live updates for the active tab only, and refetches on tab switch", async () => {
    const { strip, bridge } = setup(emptyOverrides("tab-1"));
    await strip.setActiveTab("tab-1");
    strip.update({ ...emptyOverrides("tab-2"), recording: true });
    expect(stripEl().hidden).toBe(true);

    strip.update({ ...emptyOverrides("tab-1"), networkMockRuleCount: 2 });
    expect(chipButtons().map((b) => b.textContent)).toEqual(["2 mocks"]);

    await strip.setActiveTab("tab-2");
    expect(bridge.getTabOverrides).toHaveBeenLastCalledWith("tab-2");
    expect(stripEl().hidden).toBe(true);
  });

  it("keeps the same chip element (and focus) across updates", async () => {
    const { strip } = setup({ ...emptyOverrides("tab-1"), networkMockRuleCount: 1 });
    await strip.setActiveTab("tab-1");
    const before = chipButtons()[0];
    before.focus();
    strip.update({ ...emptyOverrides("tab-1"), networkMockRuleCount: 4 });
    expect(chipButtons()[0]).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(before.textContent).toBe("4 mocks");
  });
});
