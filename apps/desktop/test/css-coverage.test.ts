import { describe, expect, it } from "vitest";

import { buildCssCoverageReport, summarizeStylesheet, type RawCssCoverage } from "../src/main/css-coverage.js";

describe("summarizeStylesheet", () => {
  it("tallies used/unused bytes and rule counts from ranges", () => {
    const s = summarizeStylesheet({
      styleSheetId: "1",
      sourceURL: "https://x/app.css",
      text: "a".repeat(100),
      ranges: [
        { startOffset: 0, endOffset: 40, used: true },
        { startOffset: 40, endOffset: 60, used: false },
        { startOffset: 60, endOffset: 70, used: true }
      ]
    });
    expect(s).toMatchObject({
      totalBytes: 100,
      ruleBytes: 70,        // 40 + 20 + 10
      usedBytes: 50,        // 40 + 10
      unusedBytes: 20,
      ruleCount: 3,
      usedRuleCount: 2,
      unusedRuleCount: 1,
      usedPercent: 71.4     // 50/70 → 71.428 → 71.4
    });
  });

  it("reports 0% and avoids divide-by-zero when no rules are tracked", () => {
    const s = summarizeStylesheet({ styleSheetId: "2", sourceURL: "", text: "", ranges: [] });
    expect(s.ruleBytes).toBe(0);
    expect(s.usedPercent).toBe(0);
    expect(s.unusedBytes).toBe(0);
  });

  it("clamps negative spans (defensive against bad offsets)", () => {
    const s = summarizeStylesheet({
      styleSheetId: "3",
      sourceURL: "",
      text: "xxxx",
      ranges: [{ startOffset: 10, endOffset: 5, used: true }]
    });
    expect(s.ruleBytes).toBe(0);
    expect(s.usedBytes).toBe(0);
  });
});

describe("buildCssCoverageReport", () => {
  const raw: RawCssCoverage = {
    url: "https://example.com",
    stylesheets: [
      {
        styleSheetId: "a",
        sourceURL: "https://x/a.css",
        text: "x".repeat(200),
        ranges: [
          { startOffset: 0, endOffset: 50, used: true },
          { startOffset: 50, endOffset: 150, used: false } // 100 unused bytes
        ]
      },
      {
        styleSheetId: "b",
        sourceURL: "https://x/b.css",
        text: "y".repeat(100),
        ranges: [
          { startOffset: 0, endOffset: 80, used: true },
          { startOffset: 80, endOffset: 90, used: false } // 10 unused bytes
        ]
      }
    ]
  };

  it("aggregates a correct summary across stylesheets", () => {
    const report = buildCssCoverageReport(raw, "tab-1", 1234);
    expect(report.tabId).toBe("tab-1");
    expect(report.url).toBe("https://example.com");
    expect(report.capturedAt).toBe(1234);
    expect(report.summary).toMatchObject({
      stylesheetCount: 2,
      totalBytes: 300,
      ruleBytes: 240,        // (50+100) + (80+10)
      usedBytes: 130,        // 50 + 80
      unusedBytes: 110,      // 100 + 10
      ruleCount: 4,
      usedRuleCount: 2,
      unusedRuleCount: 2,
      usedPercent: 54.2      // 130/240 → 54.16 → 54.2
    });
  });

  it("sorts stylesheets by unused bytes, worst first", () => {
    const report = buildCssCoverageReport(raw, "tab-1", 1234);
    expect(report.stylesheets.map((s) => s.styleSheetId)).toEqual(["a", "b"]);
    expect(report.stylesheets[0].unusedBytes).toBeGreaterThan(report.stylesheets[1].unusedBytes);
  });

  it("handles an empty stylesheet set", () => {
    const report = buildCssCoverageReport({ url: "https://x", stylesheets: [] }, "t", 1);
    expect(report.stylesheets).toEqual([]);
    expect(report.summary.stylesheetCount).toBe(0);
    expect(report.summary.usedPercent).toBe(0);
  });
});
