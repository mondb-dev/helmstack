import { describe, expect, it } from "vitest";

import { buildJsCoverageReport, summarizeScript, type RawJsCoverage } from "../src/main/js-coverage.js";

describe("summarizeScript (innermost-range-wins)", () => {
  it("counts a fully-executed single range as all used", () => {
    const s = summarizeScript({
      scriptId: "1",
      url: "https://x/app.js",
      length: 100,
      ranges: [{ startOffset: 0, endOffset: 100, count: 3 }]
    });
    expect(s).toMatchObject({ totalBytes: 100, instrumentedBytes: 100, usedBytes: 100, unusedBytes: 0, usedPercent: 100 });
  });

  it("carves out a dead inner branch (inner count 0 overrides outer count > 0)", () => {
    const s = summarizeScript({
      scriptId: "1",
      url: "https://x/app.js",
      length: 100,
      ranges: [
        { startOffset: 0, endOffset: 100, count: 1 },
        { startOffset: 40, endOffset: 60, count: 0 } // 20 dead bytes
      ]
    });
    expect(s).toMatchObject({ instrumentedBytes: 100, usedBytes: 80, unusedBytes: 20, usedPercent: 80 });
  });

  it("excludes uninstrumented gaps between ranges from the denominator", () => {
    const s = summarizeScript({
      scriptId: "1",
      url: "https://x/app.js",
      length: 100,
      ranges: [
        { startOffset: 0, endOffset: 40, count: 1 },
        { startOffset: 60, endOffset: 100, count: 1 } // [40,60) is a gap
      ]
    });
    expect(s.instrumentedBytes).toBe(80);
    expect(s.usedBytes).toBe(80);
    expect(s.unusedBytes).toBe(0);
    expect(s.totalBytes).toBe(100);
  });

  it("handles a live branch nested inside a covered outer range", () => {
    const s = summarizeScript({
      scriptId: "1",
      url: "",
      length: 200,
      ranges: [
        { startOffset: 0, endOffset: 200, count: 5 },
        { startOffset: 50, endOffset: 90, count: 0 },  // 40 dead
        { startOffset: 100, endOffset: 120, count: 2 } // live (redundant, still used)
      ]
    });
    expect(s.instrumentedBytes).toBe(200);
    expect(s.usedBytes).toBe(160); // 200 - 40 dead
    expect(s.usedPercent).toBe(80);
  });

  it("returns 0% and avoids divide-by-zero with no ranges", () => {
    const s = summarizeScript({ scriptId: "2", url: "", length: 0, ranges: [] });
    expect(s.instrumentedBytes).toBe(0);
    expect(s.usedPercent).toBe(0);
  });
});

describe("buildJsCoverageReport", () => {
  const raw: RawJsCoverage = {
    url: "https://example.com",
    scripts: [
      {
        scriptId: "a",
        url: "https://x/a.js",
        length: 100,
        ranges: [
          { startOffset: 0, endOffset: 100, count: 1 },
          { startOffset: 30, endOffset: 90, count: 0 } // 60 dead
        ]
      },
      {
        scriptId: "b",
        url: "https://x/b.js",
        length: 50,
        ranges: [
          { startOffset: 0, endOffset: 50, count: 1 },
          { startOffset: 40, endOffset: 50, count: 0 } // 10 dead
        ]
      }
    ]
  };

  it("aggregates a correct summary across scripts", () => {
    const report = buildJsCoverageReport(raw, "tab-1", 777);
    expect(report).toMatchObject({ tabId: "tab-1", url: "https://example.com", capturedAt: 777 });
    expect(report.summary).toMatchObject({
      scriptCount: 2,
      totalBytes: 150,
      instrumentedBytes: 150,   // 100 + 50
      usedBytes: 80,            // 40 + 40
      unusedBytes: 70,          // 60 + 10
      usedPercent: 53.3         // 80/150 → 53.33 → 53.3
    });
  });

  it("sorts scripts by unused bytes, worst first", () => {
    const report = buildJsCoverageReport(raw, "tab-1", 1);
    expect(report.scripts.map((s) => s.scriptId)).toEqual(["a", "b"]);
  });

  it("handles an empty script set", () => {
    const report = buildJsCoverageReport({ url: "https://x", scripts: [] }, "t", 1);
    expect(report.scripts).toEqual([]);
    expect(report.summary).toMatchObject({ scriptCount: 0, usedPercent: 0 });
  });
});
