import type {
  A11yAuditReport,
  HealthCategory,
  HealthReport,
  LayoutIssuesReport,
  PerformanceReport,
  SeoAuditReport,
  TabId,
  TabLogSnapshot
} from "../../../../shared/src/index.js";

export type HealthInputs = {
  performance: PerformanceReport;
  accessibility: A11yAuditReport;
  logs: TabLogSnapshot;
  layout: LayoutIssuesReport;
  /** When present, adds the "seo" category. */
  seo?: SeoAuditReport;
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** Score a Core Web Vital against good/needs-improvement/poor thresholds. */
function vitalScore(value: number | null, good: number, poor: number): number | null {
  if (value === null || value === undefined) return null;
  if (value <= good) return 100;
  if (value >= poor) return 20;
  // Linear interpolation between good (100) and poor (20).
  return clamp(100 - ((value - good) / (poor - good)) * 80);
}

function performanceCategory(perf: PerformanceReport): HealthCategory {
  const parts = [
    vitalScore(perf.vitals.lcp, 2500, 4000),
    vitalScore(perf.vitals.cls === null ? null : perf.vitals.cls * 1000, 100, 250), // CLS scaled ×1000
    vitalScore(perf.vitals.inp, 200, 500)
  ].filter((s): s is number => s !== null);
  const score = parts.length ? clamp(parts.reduce((a, b) => a + b, 0) / parts.length) : 100;
  return {
    id: "performance",
    label: "Performance (Core Web Vitals)",
    score,
    pass: score >= 75,
    details: `LCP ${perf.vitals.lcp ?? "?"}ms, CLS ${perf.vitals.cls ?? "?"}, INP ${perf.vitals.inp ?? "?"}ms`
  };
}

function accessibilityCategory(a11y: A11yAuditReport): HealthCategory {
  return {
    id: "accessibility",
    label: "Accessibility (WCAG)",
    score: clamp(a11y.score),
    pass: a11y.score >= 90,
    details: `${a11y.violations.length} violation(s); score ${a11y.score}/100`
  };
}

/**
 * SEO category: the audit's own 0-100 score; passes when the audit has no
 * error-severity issues (warnings lower the score but do not fail the gate).
 */
function seoCategory(seo: SeoAuditReport): HealthCategory {
  return {
    id: "seo",
    label: "SEO",
    score: clamp(seo.score),
    pass: seo.pass,
    details: `${seo.counts.error} error(s), ${seo.counts.warning} warning(s); score ${seo.score}/100`
  };
}

function consoleCategory(logs: TabLogSnapshot): HealthCategory {
  const errors = logs.jsErrors.length + logs.consoleLogs.filter((l) => l.level === "error").length;
  return {
    id: "console",
    label: "Console errors",
    score: clamp(100 - errors * 10),
    pass: errors === 0,
    details: `${errors} console/JS error(s)`
  };
}

function networkCategory(logs: TabLogSnapshot): HealthCategory {
  const failed = logs.networkRequests.filter((r) => r.failed || (r.statusCode ?? 0) >= 400).length;
  return {
    id: "network",
    label: "Network requests",
    score: clamp(100 - failed * 10),
    pass: failed === 0,
    details: `${failed} failed/4xx-5xx request(s)`
  };
}

function layoutCategory(layout: LayoutIssuesReport): HealthCategory {
  const score = layout.hasHorizontalOverflow ? clamp(60 - layout.issues.length * 5) : clamp(100 - layout.issues.length * 5);
  return {
    id: "layout",
    label: "Layout / responsive",
    score,
    pass: !layout.hasHorizontalOverflow,
    details: layout.hasHorizontalOverflow
      ? `horizontal overflow + ${layout.issues.length} issue(s)`
      : `${layout.issues.length} layout issue(s)`
  };
}

/**
 * Fuse performance, accessibility, console, network, layout (and, when supplied,
 * SEO) signals into a
 * single Lighthouse-style scorecard. Pure — unit-testable from hand-built
 * inputs. `pass` is true only when every category passes (a CI gate).
 * `overallScore` is the unweighted mean of the category scores, so adding the
 * SEO category rebalances the mean from 5 to 6 equal parts.
 */
export function buildHealthReport(inputs: HealthInputs, tabId: TabId, url: string, capturedAt: number): HealthReport {
  const categories = [
    performanceCategory(inputs.performance),
    accessibilityCategory(inputs.accessibility),
    consoleCategory(inputs.logs),
    networkCategory(inputs.logs),
    layoutCategory(inputs.layout),
    ...(inputs.seo ? [seoCategory(inputs.seo)] : [])
  ];
  const overallScore = clamp(categories.reduce((a, c) => a + c.score, 0) / categories.length);
  const pass = categories.every((c) => c.pass);
  const failing = categories.filter((c) => !c.pass).map((c) => c.label);
  return {
    tabId,
    url,
    capturedAt,
    overallScore,
    pass,
    categories,
    summary: pass
      ? `All checks passed — overall ${overallScore}/100.`
      : `Overall ${overallScore}/100. Failing: ${failing.join(", ")}.`
  };
}
