import { describe, expect, it } from "vitest";

import { digestAudit } from "../../src/lite/index.js";
import type { A11yAuditReport, HealthReport, LayoutIssuesReport, PerformanceReport, SeoAuditReport } from "../../../shared/src/index.js";

const a11y = {
  tabId: "t",
  url: "http://x/a",
  capturedAt: 0,
  score: 72,
  violations: [
    { rule: "1.3.1-label", impact: "serious", wcagCriteria: "1.3.1", wcagLevel: "A", principle: "perceivable", selector: "#q", description: "Input has no label", remediation: "Add a label.", role: "textbox" },
    { rule: "1.1.1-image-alt", impact: "critical", wcagCriteria: "1.1.1", wcagLevel: "A", principle: "perceivable", selector: "#hero", description: "Image has no alt text", remediation: "Add alt text.", role: "img" },
    { rule: "1.1.1-image-alt", impact: "critical", wcagCriteria: "1.1.1", wcagLevel: "A", principle: "perceivable", selector: ".logo", description: "Image has no alt text", remediation: "Add alt text.", role: "img" },
    { rule: "2.4.3-heading-order", impact: "minor", wcagCriteria: "2.4.3", wcagLevel: "A", principle: "operable", selector: "h4", description: "Heading skips a level", remediation: "Use h3.", role: "heading" }
  ],
  violationCounts: { critical: 2, serious: 1, moderate: 0, minor: 1 },
  byPrinciple: { perceivable: 3, operable: 1, understandable: 0, robust: 0 },
  violatedRules: [
    { ruleId: "1.3.1-label", wcagCriteria: "1.3.1", wcagLevel: "A", principle: "perceivable", impact: "serious", description: "Form fields need a label", count: 1 },
    { ruleId: "2.4.3-heading-order", wcagCriteria: "2.4.3", wcagLevel: "A", principle: "operable", impact: "minor", description: "Headings should not skip levels", count: 1 },
    { ruleId: "1.1.1-image-alt", wcagCriteria: "1.1.1", wcagLevel: "A", principle: "perceivable", impact: "critical", description: "Images need alt text", count: 2 }
  ],
  recommendations: [],
  passes: 10,
  nodeCount: 50
} as unknown as A11yAuditReport;

describe("digestAudit", () => {
  it("accessibility: severity-first, one line each, counts and footer", () => {
    const d = digestAudit("accessibility", a11y);
    expect(d.text.split("\n")).toEqual([
      "Accessibility audit of http://x/a",
      "2 errors, 1 note; score 72",
      "1) [error] Images need alt text — 2 elements (#hero, .logo)",
      "2) [error] Form fields need a label — 1 element (#q)",
      "3) [note] Headings should not skip levels — 1 element (h4)",
      "Say details N (1-3) for more."
    ]);
    expect(d.items[0]!.detail).toContain("WCAG 1.1.1");
    expect(d.items[0]!.detail).toContain("Fix: Add alt text.");
  });

  it("describes opaque AX-node selectors by role and name", () => {
    const opaque = {
      ...a11y,
      violations: [{ ...a11y.violations[0]!, selector: '[data-ax-node="12"]', role: "button", name: "" }],
      violatedRules: [a11y.violatedRules[0]!]
    } as unknown as A11yAuditReport;
    const d = digestAudit("accessibility", opaque);
    expect(d.text).toContain("1 element (unnamed button)");
    expect(d.text).not.toContain("data-ax-node");
  });

  it("caps to maxItems and keeps every item reachable via details", () => {
    const d = digestAudit("accessibility", a11y, { maxItems: 1 });
    expect(d.text).toContain("1) [error]");
    expect(d.text).not.toContain("2) [error]");
    expect(d.text).toContain("… 2 more not shown. Say details N (1-3) for more.");
    expect(d.items).toHaveLength(3);
  });

  it("is stable regardless of input order", () => {
    const shuffled = { ...a11y, violatedRules: [...a11y.violatedRules].reverse(), violations: [...a11y.violations].reverse() };
    expect(digestAudit("accessibility", shuffled).text).toBe(digestAudit("accessibility", a11y).text);
  });

  it("seo: errors before warnings, names the problem and fix", () => {
    const seo = {
      url: "http://x/",
      score: 64,
      pass: false,
      counts: { error: 1, warning: 1, info: 0 },
      issues: [
        { id: "og-missing", section: "social", severity: "warning", message: "Open Graph tags are missing", fix: "Add og:title." },
        { id: "description-missing", section: "metadata", severity: "error", message: "Missing meta description", fix: "Add a meta description (120-160 chars)." }
      ]
    } as unknown as SeoAuditReport;
    const d = digestAudit("seo", seo);
    expect(d.text.split("\n").slice(0, 4)).toEqual([
      "SEO audit of http://x/",
      "1 error, 1 warning; score 64",
      "1) [error] Missing meta description",
      "2) [warning] Open Graph tags are missing"
    ]);
    expect(d.items[0]!.detail).toContain("Fix: Add a meta description");
  });

  it("layout: groups by kind", () => {
    const layout = {
      url: "http://x/",
      viewport: { width: 390, height: 844 },
      hasHorizontalOverflow: true,
      documentScrollWidth: 600,
      issues: [
        { kind: "viewport_overflow", selector: ".wide", detail: "wider", bounds: { x: 0, y: 0, width: 1, height: 1 }, overflowPx: 120 },
        { kind: "page_overflow", selector: "html", detail: "scrolls", bounds: { x: 0, y: 0, width: 1, height: 1 }, overflowPx: 210 },
        { kind: "viewport_overflow", selector: ".table", detail: "wider", bounds: { x: 0, y: 0, width: 1, height: 1 }, overflowPx: 40 }
      ]
    } as unknown as LayoutIssuesReport;
    const d = digestAudit("layout", layout);
    expect(d.text).toContain("Layout check at 390px width of http://x/");
    expect(d.text).toContain("1 error, 1 warning; page scrolls sideways: yes");
    expect(d.text).toContain("1) [error] Page scrolls sideways by up to 210px — 1 element (html)");
    expect(d.text).toContain("2) [warning] Elements stick out past the screen edge by up to 120px — 2 elements (.table, .wide)");
  });

  it("performance: plain words, thresholds, unmeasured vitals", () => {
    const perf = {
      url: "http://x/",
      navigation: null,
      vitals: { lcp: 3100, fcp: 900, cls: 0.31, inp: null, ttfb: 120 },
      slowResources: [{ name: "http://x/big.js?v=2", initiatorType: "script", transferSize: 2048, duration: 1800 }],
      cdpMetrics: {}
    } as unknown as PerformanceReport;
    const d = digestAudit("performance", perf);
    expect(d.text).toContain("1) [error] Layout shifts while loading, score 0.31 (CLS) — target under 0.1");
    expect(d.text).toContain("2) [warning] Main content appears after 3.1s (LCP) — target under 2.5s");
    expect(d.text).toContain("Slow script: x/big.js took 1.8s");
    expect(d.text).toContain("Good: FCP, TTFB.");
    expect(d.text).toContain("Not measured yet: INP.");
  });

  it("health: failing categories first, passing listed", () => {
    const health = {
      url: "http://x/",
      overallScore: 81.4,
      pass: false,
      summary: "",
      categories: [
        { id: "performance", label: "Performance", score: 95, pass: true, details: "ok" },
        { id: "accessibility", label: "Accessibility", score: 58, pass: false, details: "5 violations" },
        { id: "console", label: "Console", score: 20, pass: false, details: "3 errors logged" }
      ]
    } as unknown as HealthReport;
    const d = digestAudit("health", health);
    expect(d.text.split("\n")).toEqual([
      "Page health of http://x/: FAIL",
      "1 error, 1 warning; overall score 81",
      "1) [error] Console 20/100 — 3 errors logged",
      "2) [warning] Accessibility 58/100 — 5 violations",
      "Passing: Performance 95.",
      "Say details N (1-2) for more."
    ]);
  });

  it("says so when nothing is wrong", () => {
    const d = digestAudit("seo", { url: "http://x/", score: 100, issues: [], counts: { error: 0, warning: 0, info: 0 } } as unknown as SeoAuditReport);
    expect(d.text).toContain("no issues; score 100");
    expect(d.text).toContain("Nothing to fix.");
    expect(d.items).toEqual([]);
  });
});
