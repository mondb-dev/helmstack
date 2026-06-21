import { describe, expect, it } from "vitest";

import { buildMediaStateReport, type MediaStateRaw } from "../src/main/media-state.js";

describe("buildMediaStateReport", () => {
  const raw: MediaStateRaw = {
    url: "https://example.com/",
    features: { "prefers-color-scheme": "dark", pointer: "fine" },
    viewport: { width: 390, height: 844 },
    mediaQueries: [
      { query: "(min-width: 1024px)", matches: false },
      { query: "(max-width: 600px)", matches: true },
      { query: "(prefers-color-scheme: dark)", matches: true }
    ]
  };

  it("orders media queries by matching first, then alphabetically", () => {
    const report = buildMediaStateReport(raw, "tab-1", 555);
    expect(report.mediaQueries.map((q) => q.query)).toEqual([
      "(max-width: 600px)",
      "(prefers-color-scheme: dark)",
      "(min-width: 1024px)"
    ]);
    expect(report.mediaQueries[0].matches).toBe(true);
    expect(report.mediaQueries[2].matches).toBe(false);
  });

  it("preserves features, viewport, and metadata", () => {
    const report = buildMediaStateReport(raw, "tab-1", 555);
    expect(report.tabId).toBe("tab-1");
    expect(report.capturedAt).toBe(555);
    expect(report.features["prefers-color-scheme"]).toBe("dark");
    expect(report.viewport).toEqual({ width: 390, height: 844 });
  });

  it("handles an empty media-query set", () => {
    const report = buildMediaStateReport({ ...raw, mediaQueries: [] }, "t", 1);
    expect(report.mediaQueries).toEqual([]);
  });
});
