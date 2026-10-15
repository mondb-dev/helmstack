/**
 * Audit digests: severity-first, a handful of one-line items, a counts line
 * and a footer pointing at `details N`. Deterministic: same report in, same
 * text out (all sorts break ties on stable keys). Pure; no model, no network.
 */

import type {
  A11yAuditReport,
  HealthReport,
  LayoutIssuesReport,
  PerformanceReport,
  SeoAuditReport
} from "../../../shared/src/index.js";
import { clip } from "./text.js";
import {
  DEFAULT_DIGEST_ITEMS,
  type LiteAuditKind,
  type LiteAuditReports,
  type LiteDigest,
  type LiteDigestItem,
  type LiteSeverity
} from "./types.js";

export type DigestOptions = {
  /** Max items printed. Default {@link DEFAULT_DIGEST_ITEMS}. */
  maxItems?: number;
  /** Approximate character budget for the printed digest. Default 1800. */
  budget?: number;
};

type RawItem = Omit<LiteDigestItem, "n">;

const SEVERITY_RANK: Record<LiteSeverity, number> = { error: 0, warning: 1, note: 2 };

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countsLine(items: readonly { severity: LiteSeverity }[], extra?: string): string {
  const n = (s: LiteSeverity) => items.filter((item) => item.severity === s).length;
  const parts: string[] = [];
  if (n("error") > 0) parts.push(plural(n("error"), "error"));
  if (n("warning") > 0) parts.push(plural(n("warning"), "warning"));
  if (n("note") > 0) parts.push(plural(n("note"), "note"));
  const core = parts.length ? parts.join(", ") : "no issues";
  return extra ? `${core}; ${extra}` : core;
}

/** Opaque `[data-ax-node="12"]` selectors are useless to a model; say what the element is instead. */
function describeViolationTarget(v: { selector: string; role?: string; name?: string }): string {
  if (/^\[data-ax-node=/.test(v.selector)) {
    const role = v.role || "element";
    return v.name ? `${role} "${clip(v.name, 30)}"` : `unnamed ${role}`;
  }
  return v.selector;
}

function selectorList(selectors: readonly string[], max: number): string {
  const unique = [...new Set(selectors.filter(Boolean))].sort();
  if (unique.length === 0) return "";
  const shown = unique.slice(0, max).map((s) => clip(s, 40));
  return unique.length > max ? `${shown.join(", ")}, +${unique.length - max} more` : shown.join(", ");
}

function assemble(
  kind: LiteAuditKind,
  heading: string,
  counts: string,
  raw: RawItem[],
  options: DigestOptions,
  trailer: string[] = []
): LiteDigest {
  const items: LiteDigestItem[] = raw.map((item, index) => ({ ...item, n: index + 1 }));
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_DIGEST_ITEMS);
  const budget = Math.max(300, options.budget ?? 1800);
  const lines: string[] = [heading, counts];
  let used = lines.join("\n").length;
  let shown = 0;
  for (const item of items) {
    const line = `${item.n}) [${item.severity}] ${item.summary}`;
    if (shown >= maxItems || (shown > 0 && used + line.length + 80 > budget)) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (items.length === 0) lines.push("Nothing to fix.");
  lines.push(...trailer);
  if (items.length > shown) lines.push(`… ${items.length - shown} more not shown. Say details N (1-${items.length}) for more.`);
  else if (items.length > 0) lines.push(`Say details N (1-${items.length}) for more.`);
  return { kind, text: lines.join("\n"), items };
}

// ── accessibility ────────────────────────────────────────────────────────────

const A11Y_SEVERITY: Record<string, LiteSeverity> = { critical: "error", serious: "error", moderate: "warning", minor: "note" };
const A11Y_IMPACT_RANK: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

function digestA11y(report: A11yAuditReport, options: DigestOptions): LiteDigest {
  const violations = report.violations ?? [];
  const rules = new Map<string, A11yAuditReport["violations"]>();
  for (const violation of violations) {
    const group = rules.get(violation.rule) ?? [];
    group.push(violation);
    rules.set(violation.rule, group);
  }
  const summaries = new Map((report.violatedRules ?? []).map((rule) => [rule.ruleId, rule]));
  const raw: Array<RawItem & { impact: number; count: number; key: string }> = [];
  for (const [ruleId, group] of rules) {
    const summary = summaries.get(ruleId);
    const first = group[0]!;
    const impact = summary?.impact ?? first.impact;
    const count = summary?.count ?? group.length;
    const what = clip(summary?.description || first.description, 90);
    const where = selectorList(group.map(describeViolationTarget), 2);
    const fix = group.map((v) => v.remediation).find(Boolean) ?? "";
    raw.push({
      severity: A11Y_SEVERITY[impact] ?? "warning",
      summary: `${what} — ${plural(count, "element")}${where ? ` (${where})` : ""}`,
      detail: [
        `${what}. WCAG ${summary?.wcagCriteria ?? first.wcagCriteria} (level ${summary?.wcagLevel ?? first.wcagLevel}), impact ${impact}.`,
        `Affects ${plural(count, "element")}: ${selectorList(group.map(describeViolationTarget), 8) || "n/a"}.`,
        fix ? `Fix: ${clip(fix, 300)}` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      impact: A11Y_IMPACT_RANK[impact] ?? 4,
      count,
      key: ruleId
    });
  }
  raw.sort((a, b) => a.impact - b.impact || b.count - a.count || a.key.localeCompare(b.key));
  return assemble("accessibility", `Accessibility audit of ${clip(report.url, 80)}`, countsLine(raw, `score ${report.score}`), raw, options);
}

// ── SEO ──────────────────────────────────────────────────────────────────────

const SEO_SECTION_ORDER = ["metadata", "indexability", "content", "social", "structuredData", "links"];

function digestSeo(report: SeoAuditReport, options: DigestOptions): LiteDigest {
  const sev = (s: string): LiteSeverity => (s === "error" ? "error" : s === "warning" ? "warning" : "note");
  const raw = [...(report.issues ?? [])]
    .sort(
      (a, b) =>
        SEVERITY_RANK[sev(a.severity)] - SEVERITY_RANK[sev(b.severity)] ||
        SEO_SECTION_ORDER.indexOf(a.section) - SEO_SECTION_ORDER.indexOf(b.section) ||
        a.id.localeCompare(b.id)
    )
    .map((issue): RawItem => {
      const elements = issue.count ?? issue.selectors?.length ?? 0;
      const where = selectorList(issue.selectors ?? [], 2);
      const tail = elements > 0 ? ` — ${plural(elements, "element")}${where ? ` (${where})` : ""}` : "";
      return {
        severity: sev(issue.severity),
        summary: `${clip(issue.message, 100).replace(/\.$/, "")}${tail}`,
        detail: [
          `${issue.message} [${issue.id}, ${issue.section}]`,
          issue.evidence ? `Found: ${clip(issue.evidence, 200)}` : "",
          issue.selectors?.length ? `Where: ${selectorList(issue.selectors, 8)}` : "",
          `Fix: ${clip(issue.fix, 300)}`
        ]
          .filter(Boolean)
          .join("\n")
      };
    });
  return assemble("seo", `SEO audit of ${clip(report.url, 80)}`, countsLine(raw, `score ${report.score}`), raw, options);
}

// ── layout ───────────────────────────────────────────────────────────────────

const LAYOUT_KIND: Record<string, { severity: LiteSeverity; text: string; rank: number }> = {
  page_overflow: { severity: "error", text: "Page scrolls sideways", rank: 0 },
  viewport_overflow: { severity: "warning", text: "Elements stick out past the screen edge", rank: 1 },
  container_escape: { severity: "warning", text: "Elements spill out of their container", rank: 2 },
  clipped_content: { severity: "note", text: "Content is cut off", rank: 3 }
};

function digestLayout(report: LayoutIssuesReport, options: DigestOptions): LiteDigest {
  const groups = new Map<string, LayoutIssuesReport["issues"]>();
  for (const issue of report.issues ?? []) {
    const group = groups.get(issue.kind) ?? [];
    group.push(issue);
    groups.set(issue.kind, group);
  }
  const raw: Array<RawItem & { rank: number; key: string }> = [];
  for (const [kind, group] of groups) {
    const meta = LAYOUT_KIND[kind] ?? { severity: "warning" as const, text: kind, rank: 9 };
    const worst = Math.max(0, ...group.map((issue) => issue.overflowPx ?? 0));
    const where = selectorList(group.map((issue) => issue.selector), 2);
    raw.push({
      severity: meta.severity,
      summary: `${meta.text}${worst > 0 ? ` by up to ${Math.round(worst)}px` : ""} — ${plural(group.length, "element")}${where ? ` (${where})` : ""}`,
      detail: [
        `${meta.text} at ${report.viewport?.width ?? "?"}px wide.`,
        ...group.slice(0, 6).map((issue) => `- ${clip(issue.selector, 60)}: ${clip(issue.detail, 140)}`),
        group.length > 6 ? `- +${group.length - 6} more` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      rank: meta.rank,
      key: kind
    });
  }
  raw.sort((a, b) => a.rank - b.rank || a.key.localeCompare(b.key));
  const width = report.viewport?.width ?? 0;
  const heading = `Layout check at ${width > 0 ? `${width}px` : "current"} width of ${clip(report.url, 80)}`;
  const sideways = report.hasHorizontalOverflow ? "page scrolls sideways: yes" : "page scrolls sideways: no";
  return assemble("layout", heading, countsLine(raw, sideways), raw, options);
}

// ── performance ──────────────────────────────────────────────────────────────

type Threshold = { good: number; poor: number };
const VITALS: Array<{ key: "lcp" | "fcp" | "cls" | "inp" | "ttfb"; thresholds: Threshold; say: (v: number) => string; target: string }> = [
  { key: "lcp", thresholds: { good: 2500, poor: 4000 }, say: (v) => `Main content appears after ${seconds(v)} (LCP)`, target: "under 2.5s" },
  { key: "fcp", thresholds: { good: 1800, poor: 3000 }, say: (v) => `First content appears after ${seconds(v)} (FCP)`, target: "under 1.8s" },
  { key: "cls", thresholds: { good: 0.1, poor: 0.25 }, say: (v) => `Layout shifts while loading, score ${v.toFixed(2)} (CLS)`, target: "under 0.1" },
  { key: "inp", thresholds: { good: 200, poor: 500 }, say: (v) => `Clicks take ${Math.round(v)}ms to respond (INP)`, target: "under 200ms" },
  { key: "ttfb", thresholds: { good: 800, poor: 1800 }, say: (v) => `Server takes ${seconds(v)} to start responding (TTFB)`, target: "under 0.8s" }
];

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function digestPerformance(report: PerformanceReport, options: DigestOptions): LiteDigest {
  const raw: Array<RawItem & { rank: number; order: number }> = [];
  const goodNames: string[] = [];
  const unmeasured: string[] = [];
  VITALS.forEach((vital, order) => {
    const value = report.vitals?.[vital.key];
    if (value === null || value === undefined) {
      unmeasured.push(vital.key.toUpperCase());
      return;
    }
    if (value <= vital.thresholds.good) {
      goodNames.push(vital.key.toUpperCase());
      return;
    }
    const poor = value > vital.thresholds.poor;
    raw.push({
      severity: poor ? "error" : "warning",
      summary: `${vital.say(value)} — target ${vital.target}`,
      detail: `${vital.say(value)}. Good is ${vital.target}; ${poor ? "poor" : "needs work"} above ${vital.thresholds.poor}${vital.key === "cls" ? "" : "ms"}.`,
      rank: poor ? 0 : 1,
      order
    });
  });
  const slow = [...(report.slowResources ?? [])]
    .filter((r) => r.duration >= 500)
    .sort((a, b) => b.duration - a.duration || a.name.localeCompare(b.name))
    .slice(0, 3);
  for (const [i, resource] of slow.entries()) {
    raw.push({
      severity: resource.duration >= 1500 ? "warning" : "note",
      summary: `Slow ${resource.initiatorType || "resource"}: ${clip(resource.name.split("?")[0]!.split("/").slice(-2).join("/"), 50)} took ${seconds(resource.duration)}`,
      detail: `${clip(resource.name, 200)} took ${Math.round(resource.duration)}ms (${resource.transferSize > 0 ? `${Math.round(resource.transferSize / 1024)}KB` : "cached"}).`,
      rank: 2,
      order: 10 + i
    });
  }
  raw.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rank - b.rank || a.order - b.order);
  const trailer: string[] = [];
  if (goodNames.length) trailer.push(`Good: ${goodNames.join(", ")}.`);
  if (unmeasured.length) trailer.push(`Not measured yet: ${unmeasured.join(", ")}.`);
  return assemble("performance", `Performance of ${clip(report.url, 80)}`, countsLine(raw), raw, options, trailer);
}

// ── health ───────────────────────────────────────────────────────────────────

function digestHealth(report: HealthReport, options: DigestOptions): LiteDigest {
  const cats = [...(report.categories ?? [])].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  const failing = cats.filter((c) => !c.pass);
  const passing = cats.filter((c) => c.pass);
  const raw: RawItem[] = failing.map((c) => ({
    severity: c.score < 50 ? "error" : "warning",
    summary: `${c.label} ${Math.round(c.score)}/100 — ${clip(c.details, 100)}`,
    detail: `${c.label}: ${Math.round(c.score)}/100, failing. ${clip(c.details, 400)}`
  }));
  const trailer = passing.length
    ? [`Passing: ${passing.map((c) => `${c.label} ${Math.round(c.score)}`).join(", ")}.`]
    : [];
  const verdict = report.pass ? "PASS" : "FAIL";
  return assemble(
    "health",
    `Page health of ${clip(report.url, 80)}: ${verdict}`,
    countsLine(raw, `overall score ${Math.round(report.overallScore)}`),
    raw,
    options,
    trailer
  );
}

/** Turn a full audit report into a short, numbered, severity-first digest. */
export function digestAudit<K extends LiteAuditKind>(kind: K, report: LiteAuditReports[K], options: DigestOptions = {}): LiteDigest {
  switch (kind) {
    case "accessibility":
      return digestA11y(report as A11yAuditReport, options);
    case "seo":
      return digestSeo(report as SeoAuditReport, options);
    case "layout":
      return digestLayout(report as LayoutIssuesReport, options);
    case "performance":
      return digestPerformance(report as PerformanceReport, options);
    case "health":
      return digestHealth(report as HealthReport, options);
    default:
      throw new Error(`Unknown audit kind: ${String(kind)}`);
  }
}
