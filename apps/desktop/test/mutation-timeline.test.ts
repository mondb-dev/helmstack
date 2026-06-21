import { describe, expect, it } from "vitest";

import { buildMutationReport, mutationTimelineScript, type RawMutationTimeline } from "../src/main/mutation-timeline.js";

const raw: RawMutationTimeline = {
  url: "https://example.com/",
  durationMs: 1000,
  byKind: { childList: 5, attributes: 8, characterData: 2 },
  addedNodes: 7,
  removedNodes: 3,
  targets: {
    "div.list": { childList: 4, attributes: 1, characterData: 0 },
    "span#clock": { childList: 0, attributes: 0, characterData: 2 },
    "button.cta": { childList: 1, attributes: 7, characterData: 0 }
  }
};

describe("buildMutationReport", () => {
  it("totals per-kind mutations and preserves node counts", () => {
    const report = buildMutationReport(raw, "t", 42);
    expect(report.totalMutations).toBe(15);
    expect(report.byKind).toEqual({ childList: 5, attributes: 8, characterData: 2 });
    expect(report.addedNodes).toBe(7);
    expect(report.removedNodes).toBe(3);
    expect(report.capturedAt).toBe(42);
  });

  it("ranks hotspots by total mutation count", () => {
    const report = buildMutationReport(raw, "t", 0);
    expect(report.hotspots.map((h) => h.selector)).toEqual(["button.cta", "div.list", "span#clock"]);
    expect(report.hotspots[0].mutations).toBe(8);
  });

  it("caps hotspots to the limit", () => {
    const targets: RawMutationTimeline["targets"] = {};
    for (let i = 0; i < 30; i++) targets[`div.n${i}`] = { childList: i, attributes: 0, characterData: 0 };
    const report = buildMutationReport({ ...raw, targets }, "t", 0, 10);
    expect(report.hotspots).toHaveLength(10);
    expect(report.hotspots[0].selector).toBe("div.n29");
  });
});

describe("mutationTimelineScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return (${mutationTimelineScript(200)});`)).not.toThrow();
  });
});
