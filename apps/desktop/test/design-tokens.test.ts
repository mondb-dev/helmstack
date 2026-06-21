import { describe, expect, it } from "vitest";

import { buildDesignTokensReport, rankTokens, type RawDesignTokens } from "../src/main/design-tokens.js";

describe("rankTokens", () => {
  it("sorts by count descending, then value ascending, and caps to the limit", () => {
    const ranked = rankTokens({ "#fff": 2, "#000": 5, "#abc": 2 }, 2);
    expect(ranked).toEqual([
      { value: "#000", count: 5 },
      { value: "#abc", count: 2 }
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(rankTokens({})).toEqual([]);
  });
});

describe("buildDesignTokensReport", () => {
  const raw: RawDesignTokens = {
    url: "https://example.com/",
    cssVariables: { "--brand": "#2563eb", "--space-2": "8px" },
    counts: {
      colors: { "rgb(0, 0, 0)": 10, "rgb(37, 99, 235)": 3 },
      fontFamilies: { "Inter, sans-serif": 12 },
      fontSizes: { "16px": 20, "14px": 5 },
      fontWeights: { "400": 18, "600": 4 },
      spacing: { "8px": 9, "16px": 6 },
      radii: { "6px": 4 },
      shadows: { "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px": 2 },
      zIndices: { "10": 1, "9999": 1 }
    },
    sampledElements: 42
  };

  it("ranks every category and preserves metadata", () => {
    const report = buildDesignTokensReport(raw, "tab-1", 12345);
    expect(report.tabId).toBe("tab-1");
    expect(report.url).toBe("https://example.com/");
    expect(report.capturedAt).toBe(12345);
    expect(report.sampledElements).toBe(42);
    expect(report.cssVariables).toEqual({ "--brand": "#2563eb", "--space-2": "8px" });
    expect(report.colors[0]).toEqual({ value: "rgb(0, 0, 0)", count: 10 });
    expect(report.fontSizes.map((s) => s.value)).toEqual(["16px", "14px"]);
    expect(report.fontWeights[0]).toEqual({ value: "400", count: 18 });
  });

  it("tolerates missing cssVariables", () => {
    const report = buildDesignTokensReport({ ...raw, cssVariables: undefined as unknown as Record<string, string> }, "t", 1);
    expect(report.cssVariables).toEqual({});
  });
});
