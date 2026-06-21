import { describe, expect, it } from "vitest";

import { buildLayoutIssuesReport, type LayoutIssuesRaw } from "../src/main/layout-issues.js";
import type { LayoutIssue } from "../../../packages/shared/src/index.js";

function issue(kind: LayoutIssue["kind"], overflowPx: number, selector = "div"): LayoutIssue {
  return { kind, selector, detail: "", bounds: { x: 0, y: 0, width: 1, height: 1 }, overflowPx };
}

describe("buildLayoutIssuesReport", () => {
  it("orders issues by kind priority then overflow magnitude", () => {
    const raw: LayoutIssuesRaw = {
      url: "https://example.com/",
      viewport: { width: 390, height: 844 },
      hasHorizontalOverflow: true,
      documentScrollWidth: 520,
      issues: [
        issue("clipped_content", 5, "span"),
        issue("viewport_overflow", 40, "img"),
        issue("viewport_overflow", 120, "header"),
        issue("page_overflow", 130, "html")
      ]
    };
    const report = buildLayoutIssuesReport(raw, "tab-1", 999);
    expect(report.issues.map((i) => `${i.kind}:${i.overflowPx}`)).toEqual([
      "page_overflow:130",
      "viewport_overflow:120",
      "viewport_overflow:40",
      "clipped_content:5"
    ]);
  });

  it("caps the issue list to the limit", () => {
    const raw: LayoutIssuesRaw = {
      url: "u",
      viewport: { width: 390, height: 844 },
      hasHorizontalOverflow: false,
      documentScrollWidth: 390,
      issues: Array.from({ length: 80 }, (_, i) => issue("viewport_overflow", i))
    };
    expect(buildLayoutIssuesReport(raw, "t", 1, 50).issues).toHaveLength(50);
  });

  it("preserves metadata and a clean (no-issue) result", () => {
    const raw: LayoutIssuesRaw = {
      url: "https://example.com/",
      viewport: { width: 1440, height: 900 },
      hasHorizontalOverflow: false,
      documentScrollWidth: 1440,
      issues: []
    };
    const report = buildLayoutIssuesReport(raw, "tab-9", 42);
    expect(report.tabId).toBe("tab-9");
    expect(report.capturedAt).toBe(42);
    expect(report.hasHorizontalOverflow).toBe(false);
    expect(report.issues).toEqual([]);
  });
});
