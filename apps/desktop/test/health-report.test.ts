import { describe, expect, it } from "vitest";

import { buildHealthReport, type HealthInputs } from "../src/main/health-report.js";
import type {
  A11yAuditReport,
  LayoutIssuesReport,
  PerformanceReport,
  TabLogSnapshot
} from "../../../packages/shared/src/index.js";

function perf(vitals: Partial<PerformanceReport["vitals"]>): PerformanceReport {
  return {
    tabId: "t",
    capturedAt: 0,
    url: "https://example.com/",
    vitals: { lcp: null, fcp: null, cls: null, inp: null, ttfb: null, ...vitals },
    navigation: null,
    slowResources: [],
    cdpMetrics: {}
  };
}

function a11y(score: number): A11yAuditReport {
  return {
    tabId: "t", url: "u", capturedAt: 0, score,
    violations: [], violationCounts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
    byPrinciple: { perceivable: 0, operable: 0, understandable: 0, robust: 0 },
    violatedRules: [], recommendations: [], passes: 0, nodeCount: 0
  } as unknown as A11yAuditReport;
}

function logs(over: Partial<TabLogSnapshot> = {}): TabLogSnapshot {
  return { tabId: "t", consoleLogs: [], networkRequests: [], webSocketFrames: [], eventSourceEvents: [], jsErrors: [], capturedAt: 0, ...over };
}

function layout(over: Partial<LayoutIssuesReport> = {}): LayoutIssuesReport {
  return { tabId: "t", url: "u", capturedAt: 0, viewport: { width: 1440, height: 900 }, hasHorizontalOverflow: false, documentScrollWidth: 1440, issues: [], ...over };
}

const healthy: HealthInputs = {
  performance: perf({ lcp: 1800, cls: 0.02, inp: 120 }),
  accessibility: a11y(98),
  logs: logs(),
  layout: layout()
};

describe("buildHealthReport", () => {
  it("passes when every category is healthy", () => {
    const report = buildHealthReport(healthy, "t", "https://example.com/", 1);
    expect(report.pass).toBe(true);
    expect(report.overallScore).toBeGreaterThanOrEqual(90);
    expect(report.categories).toHaveLength(5);
    expect(report.categories.every((c) => c.pass)).toBe(true);
  });

  it("fails the gate when any category fails and names the failures", () => {
    const report = buildHealthReport(
      {
        performance: perf({ lcp: 6000, cls: 0.4, inp: 800 }), // poor
        accessibility: a11y(60),                               // < 90
        logs: logs({ jsErrors: ["boom"] }),                    // error
        layout: layout({ hasHorizontalOverflow: true, issues: [] })
      },
      "t",
      "u",
      1
    );
    expect(report.pass).toBe(false);
    expect(report.summary).toMatch(/Failing:/);
    expect(report.categories.find((c) => c.id === "console")!.pass).toBe(false);
    expect(report.categories.find((c) => c.id === "layout")!.pass).toBe(false);
    expect(report.categories.find((c) => c.id === "accessibility")!.score).toBe(60);
  });

  it("counts 4xx/5xx and failed requests in the network category", () => {
    const report = buildHealthReport(
      { ...healthy, logs: logs({ networkRequests: [
        { requestId: "1", url: "u", method: "GET", statusCode: 500, failed: false, timestamp: 0 },
        { requestId: "2", url: "u", method: "GET", failed: true, timestamp: 0 }
      ] }) },
      "t", "u", 1
    );
    const net = report.categories.find((c) => c.id === "network")!;
    expect(net.pass).toBe(false);
    expect(net.score).toBe(80);
  });

  it("skips missing vitals rather than penalizing them", () => {
    const report = buildHealthReport({ ...healthy, performance: perf({}) }, "t", "u", 1);
    expect(report.categories.find((c) => c.id === "performance")!.score).toBe(100);
  });
});
