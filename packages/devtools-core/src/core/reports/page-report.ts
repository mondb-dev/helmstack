/**
 * Page analysis report builder (pure; no I/O, no clock, no randomness).
 *
 * Output is one self-contained HTML document plus a Markdown twin. Two kinds of
 * content are kept visibly apart and never merged:
 *
 *  - "Written by <author>; not verified by HelmStack": the agent's summary,
 *    findings and recommendations;
 *  - "Measured by HelmStack": scores and issues HelmStack collected itself.
 *
 * SAFETY \u2014 every agent-supplied and page-derived string is untrusted plain
 * text. It is stripped of control characters, length-limited, and HTML- or
 * Markdown-escaped at the point of output; nothing is ever interpreted as
 * markup. The HTML has no scripts and no external resources (inline CSS, a
 * restrictive CSP meta tag, the screenshot as a data: URI). Field values,
 * cookies, headers and request bodies are never read: console/network sections
 * carry counts plus a few messages/URLs with query strings stripped.
 *
 * Deterministic: the same inputs yield byte-identical output.
 */
import type {
  A11yAuditReport,
  CreateReportInput,
  HealthReport,
  LayoutIssuesReport,
  PerformanceReport,
  ReportEvidenceKind,
  ReportFinding,
  ReportSeverity,
  ReportSummary,
  SeoAuditReport,
  TabId,
  TabLogSnapshot
} from "../../../../shared/src/index.js";
import { REPORT_LIMITS } from "../../../../shared/src/index.js";

/** Per-field limits the contract documents in comments rather than in `REPORT_LIMITS`. */
export const REPORT_FIELD_LIMITS = {
  findingTitleChars: 160,
  findingAreaChars: 40,
  findingEvidenceChars: 1_200,
  findingRecommendationChars: 1_200
} as const;

/** How many items of each measured list a report shows. */
const TOP_ISSUES = 15;
const TOP_LOG_LINES = 10;
const MAX_SELECTOR_CHARS = 200;
const MAX_PAGE_TEXT_CHARS = 300;

export const SEVERITY_ORDER: readonly ReportSeverity[] = ["critical", "high", "medium", "low", "info"];

export type ReportPageInfo = {
  tabId: TabId;
  url: string;
  title: string;
  /** Epoch ms; the only clock the builder uses. */
  capturedAt: number;
  viewport?: { width: number; height: number };
  /** Human-readable descriptions of active overrides, e.g. "Viewport 375×812 (mobile)". */
  overrides?: string[];
  helmstackVersion: string;
};

export type ReportEvidence = {
  accessibility?: A11yAuditReport;
  seo?: SeoAuditReport;
  layout?: LayoutIssuesReport;
  performance?: PerformanceReport;
  health?: HealthReport;
  /** Source for the console and network sections. Only counts and trimmed messages/URLs are used. */
  logs?: { console?: TabLogSnapshot; network?: TabLogSnapshot };
  /** Raw PNG bytes of the page. */
  screenshotPng?: Uint8Array;
};

export type BuildReportOptions = {
  id: string;
  page: ReportPageInfo;
  input: CreateReportInput;
  evidence: ReportEvidence;
  /** Collectors that failed or timed out, recorded in the report and the summary. */
  skipped?: Array<{ kind: ReportEvidenceKind; reason: string }>;
  /** Used when `input.author` is absent (the agent id header). */
  fallbackAuthor?: string;
};

export type BuiltReport = {
  html: string;
  markdown: string;
  summary: ReportSummary;
  /** Short text rendering for the agent to show in chat. */
  preview: string;
};

// \u2500\u2500 Sanitising \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// C0/C1 controls (except \n and \t), DEL, bidi overrides/isolates, zero-width and BOM.
const STRIP_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Plain text with control characters removed; keeps \n and \t. */
export function stripControl(value: unknown): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(STRIP_RE, "");
}

type Notices = string[];

/** Strip, collapse (single line) and limit a string. Records a notice when it cut anything. */
function clean(value: unknown, max: number, label: string, notices: Notices, multiline = false): string {
  let text = stripControl(value);
  if (!multiline) text = text.replace(/\s+/g, " ");
  else text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  notices.push(`${label} was cut to ${max} characters (${chars.length} supplied).`);
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** Page-derived string: stripped, single line, silently limited (not agent input, so no notice). */
function pageText(value: unknown, max = MAX_PAGE_TEXT_CHARS): string {
  const chars = Array.from(stripControl(value).replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** A selector hint without attribute values that could echo field contents. */
function selectorText(value: unknown): string {
  return pageText(String(value ?? "").replace(/\[(value|placeholder|title|alt|aria-label|data-[\w-]+)\s*[~|^$*]?=[^\]]*\]/gi, "[$1]"), MAX_SELECTOR_CHARS);
}

/** http(s) URL without credentials, query or fragment; null for anything else. */
export function safeHttpUrl(raw: unknown): string | null {
  try {
    const u = new URL(String(raw ?? ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Display form of a URL: stripped as above, or a placeholder for non-http(s) / invalid ones. */
function displayUrl(raw: unknown): string {
  const safe = safeHttpUrl(raw);
  if (safe) return pageText(safe, 400);
  try {
    const u = new URL(String(raw ?? ""));
    return pageText(`${u.protocol}//${u.host}${u.pathname}`, 400);
  } catch {
    return "(unknown URL)";
  }
}

/** Remove `?query` and `#fragment` from any http(s) URLs embedded in free text (console messages). */
function stripUrlQueries(text: string): string {
  return text.replace(/(https?:\/\/[^\s"'<>)\]]*?)[?#][^\s"'<>)\]]*/gi, "$1");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape Markdown control characters so text renders literally. Newlines are kept as hard breaks. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/[\\`*_{}[\]<>#|~&$]/g, "\\$&")
    // Block-level markers that only matter at the start of a line.
    .replace(/^([ \t]*)([-+=])/gm, "$1\\$2")
    .replace(/^([ \t]*\d+)([.)])/gm, "$1\\$2")
    .replace(/\n/g, "  \n");
}

// \u2500\u2500 Model \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

type CleanFinding = { title: string; severity: ReportSeverity; area: string; evidence: string; recommendation: string };

type Row = { label: string; value: string };

type MeasuredIssue = { head: string; detail?: string; fix?: string; selectors?: string[] };

type MeasuredSection = {
  kind: ReportEvidenceKind;
  title: string;
  /** One-line headline, e.g. "Score 82 / 100". */
  headline: string;
  rows: Row[];
  issuesTitle?: string;
  issues: MeasuredIssue[];
  /** "Showing 15 of 42" style note when the list was cut. */
  more?: string;
};

const isSeverity = (v: unknown): v is ReportSeverity => SEVERITY_ORDER.includes(v as ReportSeverity);

function cleanFindings(findings: ReportFinding[] | undefined, notices: Notices): CleanFinding[] {
  const list = Array.isArray(findings) ? findings : [];
  const kept = list.slice(0, REPORT_LIMITS.findings);
  if (list.length > kept.length) notices.push(`Only the first ${REPORT_LIMITS.findings} of ${list.length} findings are shown.`);
  return kept.map((f, i): CleanFinding => {
    const n = i + 1;
    return {
      title: clean(f?.title, REPORT_FIELD_LIMITS.findingTitleChars, `Finding ${n} title`, notices) || `Finding ${n}`,
      severity: isSeverity(f?.severity) ? f.severity : "info",
      area: clean(f?.area, REPORT_FIELD_LIMITS.findingAreaChars, `Finding ${n} area`, notices),
      evidence: clean(f?.evidence, REPORT_FIELD_LIMITS.findingEvidenceChars, `Finding ${n} evidence`, notices, true),
      recommendation: clean(
        f?.recommendation, REPORT_FIELD_LIMITS.findingRecommendationChars, `Finding ${n} recommendation`, notices, true
      )
    };
  });
}

function cleanRecommendations(items: string[] | undefined, notices: Notices): string[] {
  const list = Array.isArray(items) ? items : [];
  const kept = list.slice(0, REPORT_LIMITS.recommendations);
  if (list.length > kept.length) notices.push(`Only the first ${REPORT_LIMITS.recommendations} of ${list.length} recommendations are shown.`);
  return kept
    .map((r, i) => clean(r, REPORT_LIMITS.recommendationChars, `Recommendation ${i + 1}`, notices, true))
    .filter((r) => r.length > 0);
}

const num = (n: unknown, digits = 0): string => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "n/a";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
};
const ms = (n: unknown): string => (typeof n === "number" && Number.isFinite(n) ? `${num(n)} ms` : "not measured");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const A11Y_IMPACT_ORDER = ["critical", "serious", "moderate", "minor"];
const SEO_SEVERITY_ORDER = ["error", "warning", "info"];

function measuredSections(evidence: ReportEvidence): MeasuredSection[] {
  const out: MeasuredSection[] = [];

  const health = evidence.health;
  if (health) {
    out.push({
      kind: "health",
      title: "Health scorecard",
      headline: `Overall ${num(health.overallScore)} / 100 · ${health.pass ? "pass" : "fail"}`,
      rows: [...health.categories]
        .sort((a, b) => cmp(a.id, b.id))
        .map((c) => ({ label: pageText(c.label, 60), value: `${num(c.score)} / 100 · ${c.pass ? "pass" : "fail"} · ${pageText(c.details, 200)}` })),
      issues: []
    });
  }

  const a11y = evidence.accessibility;
  if (a11y) {
    const ordered = [...a11y.violations].sort(
      (x, y) =>
        A11Y_IMPACT_ORDER.indexOf(x.impact) - A11Y_IMPACT_ORDER.indexOf(y.impact) ||
        cmp(x.rule, y.rule) ||
        cmp(x.selector, y.selector)
    );
    const c = a11y.violationCounts;
    out.push({
      kind: "accessibility",
      title: "Accessibility (WCAG)",
      headline: `Score ${num(a11y.score)} / 100 · ${num(a11y.violations.length)} violation${a11y.violations.length === 1 ? "" : "s"}`,
      rows: [
        { label: "Critical", value: num(c.critical) },
        { label: "Serious", value: num(c.serious) },
        { label: "Moderate", value: num(c.moderate) },
        { label: "Minor", value: num(c.minor) },
        { label: "Rules passed on nodes", value: num(a11y.passes) },
        { label: "Nodes inspected", value: num(a11y.nodeCount) }
      ],
      issuesTitle: "Top violations",
      issues: ordered.slice(0, TOP_ISSUES).map((v) => ({
        head: `${pageText(v.impact, 20)} · WCAG ${pageText(v.wcagCriteria, 20)} ${pageText(v.wcagLevel, 5)} · ${pageText(v.rule, 80)}`,
        detail: pageText(v.description, 400),
        fix: pageText(v.remediation, 400),
        selectors: [selectorText(v.selector)]
      })),
      ...(ordered.length > TOP_ISSUES ? { more: `Showing ${TOP_ISSUES} of ${ordered.length} violations.` } : {})
    });
  }

  const seo = evidence.seo;
  if (seo) {
    const ordered = [...seo.issues].sort(
      (x, y) => SEO_SEVERITY_ORDER.indexOf(x.severity) - SEO_SEVERITY_ORDER.indexOf(y.severity) || cmp(x.id, y.id)
    );
    out.push({
      kind: "seo",
      title: "SEO",
      headline: `Score ${num(seo.score)} / 100 · ${num(seo.counts.error)} error${seo.counts.error === 1 ? "" : "s"}, ${num(seo.counts.warning)} warning${seo.counts.warning === 1 ? "" : "s"}, ${num(seo.counts.info)} info`,
      rows: [
        { label: "Result", value: seo.pass ? "pass (no error-severity issues)" : "fail" },
        ...(seo.skipped.length ? [{ label: "Checks that could not run", value: seo.skipped.map((s) => pageText(s.check, 60)).join(", ") }] : [])
      ],
      issuesTitle: "Top issues",
      issues: ordered.slice(0, TOP_ISSUES).map((i) => ({
        head: `${pageText(i.severity, 10)} · ${pageText(i.section, 30)} · ${pageText(i.message, 300)}`,
        ...(i.evidence ? { detail: pageText(i.evidence, 300) } : {}),
        fix: pageText(i.fix, 300),
        ...(i.selectors?.length ? { selectors: i.selectors.slice(0, 5).map(selectorText) } : {})
      })),
      ...(ordered.length > TOP_ISSUES ? { more: `Showing ${TOP_ISSUES} of ${ordered.length} issues.` } : {})
    });
  }

  const layout = evidence.layout;
  if (layout) {
    const ordered = [...layout.issues].sort(
      (x, y) => cmp(x.kind, y.kind) || (y.overflowPx ?? 0) - (x.overflowPx ?? 0) || cmp(x.selector, y.selector)
    );
    out.push({
      kind: "layout",
      title: "Layout",
      headline: `${num(layout.issues.length)} issue${layout.issues.length === 1 ? "" : "s"} at ${num(layout.viewport.width)}×${num(layout.viewport.height)}`,
      rows: [
        { label: "Horizontal overflow", value: layout.hasHorizontalOverflow ? `yes (document is ${num(layout.documentScrollWidth)} px wide)` : "no" }
      ],
      issuesTitle: "Top layout issues",
      issues: ordered.slice(0, TOP_ISSUES).map((i) => ({
        head: `${pageText(i.kind, 40)}${typeof i.overflowPx === "number" ? ` · ${num(i.overflowPx)} px over` : ""}`,
        detail: pageText(i.detail, 300),
        selectors: [selectorText(i.selector)]
      })),
      ...(ordered.length > TOP_ISSUES ? { more: `Showing ${TOP_ISSUES} of ${ordered.length} issues.` } : {})
    });
  }

  const perf = evidence.performance;
  if (perf) {
    const v = perf.vitals;
    out.push({
      kind: "performance",
      title: "Performance",
      headline: `LCP ${ms(v.lcp)} · CLS ${typeof v.cls === "number" ? num(v.cls, 3) : "not measured"} · INP ${ms(v.inp)}`,
      rows: [
        { label: "Largest Contentful Paint", value: ms(v.lcp) },
        { label: "First Contentful Paint", value: ms(v.fcp) },
        { label: "Cumulative Layout Shift", value: typeof v.cls === "number" ? num(v.cls, 3) : "not measured" },
        { label: "Interaction to Next Paint", value: ms(v.inp) },
        { label: "Time to First Byte", value: ms(v.ttfb) },
        ...(perf.navigation
          ? [
              { label: "DOM content loaded", value: ms(perf.navigation.domContentLoaded) },
              { label: "Load event", value: ms(perf.navigation.loadEvent) }
            ]
          : [])
      ],
      issuesTitle: "Slowest resources",
      issues: [...perf.slowResources]
        .sort((a, b) => b.duration - a.duration || cmp(a.name, b.name))
        .slice(0, TOP_LOG_LINES)
        .map((r) => ({
          head: `${displayUrl(r.name)}`,
          detail: `${pageText(r.initiatorType, 30)} · ${ms(r.duration)} · ${r.transferSize > 0 ? `${num(r.transferSize / 1024, 1)} KB` : "cached or unknown size"}`
        }))
    });
  }

  const consoleLogs = evidence.logs?.console;
  if (consoleLogs) {
    const byLevel = new Map<string, number>();
    for (const e of consoleLogs.consoleLogs) byLevel.set(e.level, (byLevel.get(e.level) ?? 0) + 1);
    const notable = consoleLogs.consoleLogs.filter((e) => e.level === "error" || e.level === "warn");
    const top = notable.slice(0, TOP_LOG_LINES);
    out.push({
      kind: "console",
      title: "Console",
      headline: `${num(byLevel.get("error") ?? 0)} error${(byLevel.get("error") ?? 0) === 1 ? "" : "s"}, ${num(byLevel.get("warn") ?? 0)} warning${(byLevel.get("warn") ?? 0) === 1 ? "" : "s"}, ${num(consoleLogs.jsErrors.length)} uncaught`,
      rows: [
        { label: "Messages captured", value: num(consoleLogs.consoleLogs.length) },
        ...["error", "warn", "info", "log", "debug"].map((l) => ({ label: l, value: num(byLevel.get(l) ?? 0) }))
      ],
      issuesTitle: "First errors and warnings",
      issues: top.map((e) => ({ head: `${pageText(e.level, 10)} · ${pageText(stripUrlQueries(e.text), 300)}` })),
      ...(notable.length > top.length ? { more: `Showing ${top.length} of ${notable.length} errors and warnings.` } : {})
    });
  }

  const net = evidence.logs?.network;
  if (net) {
    const reqs = net.networkRequests;
    const failed = reqs.filter((r) => r.failed || (typeof r.statusCode === "number" && r.statusCode >= 400));
    const classes = new Map<string, number>();
    for (const r of reqs) {
      const k = typeof r.statusCode === "number" ? `${Math.floor(r.statusCode / 100)}xx` : r.failed ? "failed" : "pending";
      classes.set(k, (classes.get(k) ?? 0) + 1);
    }
    const top = failed.slice(0, TOP_LOG_LINES);
    out.push({
      kind: "network",
      title: "Network",
      headline: `${num(reqs.length)} request${reqs.length === 1 ? "" : "s"}, ${num(failed.length)} failed or errored`,
      rows: [...classes.keys()].sort().map((k) => ({ label: k, value: num(classes.get(k)) })),
      issuesTitle: "First failed requests",
      issues: top.map((r) => ({
        head: `${pageText(r.method, 10)} ${displayUrl(r.url)}`,
        detail: typeof r.statusCode === "number" ? `status ${num(r.statusCode)}` : pageText(r.errorText ?? "failed", 100)
      })),
      ...(failed.length > top.length ? { more: `Showing ${top.length} of ${failed.length} failed requests.` } : {})
    });
  }

  return out;
}

// \u2500\u2500 Build \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length > sig.length && sig.every((b, i) => bytes[i] === b);
}

function isoDate(ms_: number): string {
  const d = new Date(Number.isFinite(ms_) ? ms_ : 0);
  return d.toISOString();
}

export function buildReport(options: BuildReportOptions): BuiltReport {
  const { page, input, evidence } = options;
  const notices: Notices = [];

  const pageTitle = pageText(page.title, 200) || "(untitled page)";
  const title = clean(input.title, REPORT_LIMITS.titleChars, "Title", notices) || `Page analysis: ${pageTitle}`.slice(0, REPORT_LIMITS.titleChars);
  const author = clean(input.author ?? options.fallbackAuthor, REPORT_LIMITS.authorChars, "Author", notices) || "an AI agent";
  const summaryText = clean(input.summary, REPORT_LIMITS.summaryChars, "Summary", notices, true);
  const findings = cleanFindings(input.findings, notices);
  const recommendations = cleanRecommendations(input.recommendations, notices);
  const sections = measuredSections(evidence);
  const skipped = [...(options.skipped ?? [])]
    .sort((a, b) => cmp(a.kind, b.kind))
    .map((s) => ({ kind: s.kind, reason: pageText(s.reason, 160) }));

  const shot = evidence.screenshotPng && isPng(evidence.screenshotPng) ? Buffer.from(evidence.screenshotPng).toString("base64") : null;

  const severityCounts: Record<ReportSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) severityCounts[f.severity]++;

  const url = displayUrl(page.url);
  const linkUrl = safeHttpUrl(page.url);
  const generated = isoDate(page.capturedAt);
  const version = pageText(page.helmstackVersion, 40) || "unknown";
  const overrides = (page.overrides ?? []).map((o) => pageText(o, 120)).filter(Boolean);
  const viewport = page.viewport ? `${num(page.viewport.width)}×${num(page.viewport.height)}` : "unknown";
  const agentLabel = `Written by ${author}; not verified by HelmStack`;
  const measuredLabel = "Measured by HelmStack";

  const evidenceKinds = sections.map((s) => s.kind);

  const summary: ReportSummary = {
    id: options.id,
    title,
    createdAt: page.capturedAt,
    tabId: page.tabId,
    url,
    pageTitle,
    author,
    findingCount: findings.length,
    severityCounts,
    evidence: evidenceKinds,
    skipped,
    screenshot: shot !== null,
    formats: ["html", "md"],
    sizeBytes: 0
  };

  const ctx: RenderContext = {
    title, author, summaryText, findings, recommendations, sections, skipped, notices, shot, url, linkUrl, generated,
    version, overrides, viewport, agentLabel, measuredLabel, pageTitle, severityCounts,
    screenshotRequested: input.screenshot !== false
  };
  const html = renderHtml(ctx);
  const markdown = renderMarkdown(ctx);
  summary.sizeBytes = Buffer.byteLength(html, "utf8") + Buffer.byteLength(markdown, "utf8");

  return { html, markdown, summary, preview: renderPreview(ctx) };
}

type RenderContext = {
  title: string;
  author: string;
  summaryText: string;
  findings: CleanFinding[];
  recommendations: string[];
  sections: MeasuredSection[];
  skipped: Array<{ kind: ReportEvidenceKind; reason: string }>;
  notices: Notices;
  shot: string | null;
  screenshotRequested: boolean;
  url: string;
  linkUrl: string | null;
  generated: string;
  version: string;
  overrides: string[];
  viewport: string;
  agentLabel: string;
  measuredLabel: string;
  pageTitle: string;
  severityCounts: Record<ReportSeverity, number>;
};

function sevCountsLine(c: Record<ReportSeverity, number>): string {
  const parts = SEVERITY_ORDER.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}

function renderPreview(c: RenderContext): string {
  const lines = [
    `Report: ${c.title}`,
    `Page: ${c.url}`,
    `Findings written by ${c.author} (not verified by HelmStack): ${c.findings.length} (${sevCountsLine(c.severityCounts)})`,
    `Recommendations: ${c.recommendations.length}`,
    ...c.sections.map((s) => `Measured by HelmStack · ${s.title}: ${s.headline}`)
  ];
  for (const s of c.skipped) lines.push(`Not measured · ${s.kind}: ${s.reason}`);
  if (c.notices.length) lines.push(`Truncated: ${c.notices.length} field(s) were shortened to fit limits.`);
  return lines.join("\n");
}

const CSS = `
:root{color-scheme:light dark;--fg:#1b1f24;--muted:#57606a;--bg:#ffffff;--card:#f6f8fa;--line:#d0d7de;--agent:#8250df;--measured:#0969da;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9da7b3;--bg:#0d1117;--card:#161b22;--line:#30363d;--agent:#b392f0;--measured:#58a6ff;--warn:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:26px;line-height:1.25;margin:0 0 8px}
h2{font-size:19px;margin:36px 0 8px}
h3{font-size:15px;margin:20px 0 6px}
p{margin:8px 0}
.meta{color:var(--muted);font-size:13px}
.meta dt{font-weight:600;display:inline}
.meta dd{display:inline;margin:0 14px 0 4px}
.legend{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
.tag{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600}
.tag.agent{color:var(--agent)}
.tag.measured{color:var(--measured)}
section.agent{border-left:4px solid var(--agent);padding-left:16px}
section.measured{border-left:4px solid var(--measured);padding-left:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.sev{font-weight:700;text-transform:uppercase;font-size:12px;letter-spacing:.04em}
.sev-critical,.sev-high{color:#cf222e}
.sev-medium{color:var(--warn)}
.sev-low,.sev-info{color:var(--muted)}
.label{color:var(--muted);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.pre{white-space:pre-wrap;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top;overflow-wrap:anywhere}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:var(--card);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
.notice{border:1px solid var(--warn);border-radius:8px;padding:8px 12px;margin:12px 0;font-size:13px}
img.shot{max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
footer{margin-top:48px;color:var(--muted);font-size:12px}
@media print{main{max-width:none;padding:0}.card{break-inside:avoid}}
`.trim();

function h(text: string): string {
  return escapeHtml(text);
}

/** Escaped text with newlines preserved by CSS (`white-space: pre-wrap`). */
function p(text: string): string {
  return `<p class="pre">${escapeHtml(text)}</p>`;
}

function renderHtml(c: RenderContext): string {
  const out: string[] = [];
  out.push(
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="generator" content="HelmStack">',
    `<title>${h(c.title)}</title>`,
    `<style>${CSS}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${h(c.title)}</h1>`
  );

  const urlHtml = c.linkUrl ? `<a href="${h(c.linkUrl)}" rel="noopener noreferrer">${h(c.url)}</a>` : h(c.url);
  out.push(
    '<dl class="meta">',
    `<dt>Page</dt><dd>${h(c.pageTitle)}</dd>`,
    `<dt>URL</dt><dd>${urlHtml}</dd>`,
    `<dt>Captured</dt><dd>${h(c.generated)}</dd>`,
    `<dt>Findings by</dt><dd>${h(c.author)}</dd>`,
    `<dt>Viewport</dt><dd>${h(c.viewport)}</dd>`,
    `<dt>HelmStack</dt><dd>${h(c.version)}</dd>`,
    ...(c.overrides.length ? [`<dt>Active overrides</dt><dd>${c.overrides.map(h).join("; ")}</dd>`] : []),
    "</dl>"
  );

  out.push(
    '<div class="legend">',
    `<span class="tag agent">${h(c.agentLabel)}</span>`,
    `<span class="tag measured">${h(c.measuredLabel)}</span>`,
    "</div>",
    '<p class="meta">Purple sections are an AI agent\'s interpretation and have not been checked by HelmStack. Blue sections are measurements HelmStack took from the page itself. The two are never combined. Query strings and fragments are removed from URLs, and form values, cookies and request contents are never included.</p>'
  );

  if (c.notices.length) {
    out.push('<div class="notice"><strong>Content was shortened to fit limits.</strong><ul>');
    for (const n of c.notices) out.push(`<li>${h(n)}</li>`);
    out.push("</ul></div>");
  }

  // Summary
  out.push('<section class="agent">', "<h2>Summary</h2>", `<p><span class="tag agent">${h(c.agentLabel)}</span></p>`);
  out.push(c.summaryText ? p(c.summaryText) : '<p class="meta">No summary was provided.</p>', "</section>");

  // Findings
  out.push('<section class="agent">', `<h2>Findings (${c.findings.length})</h2>`, `<p><span class="tag agent">${h(c.agentLabel)}</span></p>`);
  if (!c.findings.length) out.push('<p class="meta">No findings were provided.</p>');
  for (const sev of SEVERITY_ORDER) {
    const group = c.findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    out.push(`<h3><span class="sev sev-${sev}">${sev}</span> (${group.length})</h3>`);
    for (const f of group) {
      out.push('<div class="card">', `<strong>${h(f.title)}</strong>`);
      if (f.area) out.push(` <span class="meta">· ${h(f.area)}</span>`);
      if (f.evidence) out.push('<div class="label">Evidence</div>', p(f.evidence));
      out.push('<div class="label">Recommendation</div>', p(f.recommendation), "</div>");
    }
  }
  out.push("</section>");

  // Recommendations
  out.push('<section class="agent">', "<h2>Recommendations</h2>", `<p><span class="tag agent">${h(c.agentLabel)}</span></p>`);
  if (!c.recommendations.length) out.push('<p class="meta">No separate recommendations were provided.</p>');
  else {
    out.push("<ol>");
    for (const r of c.recommendations) out.push(`<li class="pre">${h(r)}</li>`);
    out.push("</ol>");
  }
  out.push("</section>");

  // Measured
  out.push('<section class="measured">', "<h2>Measured by HelmStack</h2>", `<p><span class="tag measured">${h(c.measuredLabel)}</span></p>`);
  if (!c.sections.length) out.push('<p class="meta">No measurements were collected for this report.</p>');
  for (const s of c.sections) {
    out.push(`<h3>${h(s.title)}</h3>`, `<p><strong>${h(s.headline)}</strong></p>`);
    if (s.rows.length) {
      out.push("<table>");
      for (const r of s.rows) out.push(`<tr><th scope="row">${h(r.label)}</th><td>${h(r.value)}</td></tr>`);
      out.push("</table>");
    }
    if (s.issues.length) {
      out.push(`<div class="label">${h(s.issuesTitle ?? "Top issues")}</div>`);
      for (const i of s.issues) {
        out.push('<div class="card">', `<div>${h(i.head)}</div>`);
        if (i.detail) out.push(`<div class="meta">${h(i.detail)}</div>`);
        if (i.fix) out.push(`<div><span class="label">Fix</span> ${h(i.fix)}</div>`);
        if (i.selectors?.length) out.push(`<div>${i.selectors.map((x) => `<code>${h(x)}</code>`).join(" ")}</div>`);
        out.push("</div>");
      }
    }
    if (s.more) out.push(`<p class="meta">${h(s.more)}</p>`);
  }
  if (c.skipped.length) {
    out.push('<div class="notice"><strong>Not measured</strong><ul>');
    for (const s of c.skipped) out.push(`<li>${h(s.kind)}: ${h(s.reason)}</li>`);
    out.push("</ul></div>");
  }
  out.push("</section>");

  // Screenshot
  out.push("<section>", "<h2>Screenshot</h2>");
  if (c.shot) {
    out.push(`<p class="meta">${h(c.measuredLabel)}: the page as HelmStack saw it when the report was created.</p>`);
    out.push(`<img class="shot" alt="Screenshot of the analysed page" src="data:image/png;base64,${c.shot}">`);
  } else {
    out.push(`<p class="meta">${c.screenshotRequested ? "No screenshot could be captured." : "A screenshot was not requested."}</p>`);
  }
  out.push("</section>");

  // Appendix
  out.push(
    "<section>",
    "<h2>Appendix</h2>",
    "<table>",
    `<tr><th scope="row">Measurements included</th><td>${h(c.sections.map((s) => s.kind).join(", ") || "none")}</td></tr>`,
    `<tr><th scope="row">Measurements not collected</th><td>${h(c.skipped.map((s) => s.kind).join(", ") || "none")}</td></tr>`,
    `<tr><th scope="row">Report generated</th><td>${h(c.generated)}</td></tr>`,
    `<tr><th scope="row">Generated by</th><td>HelmStack ${h(c.version)}</td></tr>`,
    "</table>",
    '<p class="meta">To make a PDF, open this file in a browser and use Print, then Save as PDF.</p>',
    "</section>",
    `<footer>Generated by HelmStack ${h(c.version)}. Findings and recommendations above are the author's own and are not verified by HelmStack.</footer>`,
    "</main>",
    "</body>",
    "</html>"
  );
  return `${out.join("\n")}\n`;
}

function md(text: string): string {
  return escapeMarkdown(text);
}

function renderMarkdown(c: RenderContext): string {
  const out: string[] = [];
  out.push(`# ${md(c.title)}`, "");
  out.push(`- **Page:** ${md(c.pageTitle)}`);
  out.push(`- **URL:** ${md(c.url)}`);
  out.push(`- **Captured:** ${md(c.generated)}`);
  out.push(`- **Findings by:** ${md(c.author)}`);
  out.push(`- **Viewport:** ${md(c.viewport)}`);
  out.push(`- **HelmStack:** ${md(c.version)}`);
  if (c.overrides.length) out.push(`- **Active overrides:** ${c.overrides.map(md).join("; ")}`);
  out.push("");
  out.push(`> **${md(c.agentLabel)}** applies to Summary, Findings and Recommendations.`);
  out.push(`> **${md(c.measuredLabel)}** applies to the measurement sections. The two are never combined.`);
  out.push("");
  if (c.notices.length) {
    out.push("**Content was shortened to fit limits:**", "");
    for (const n of c.notices) out.push(`- ${md(n)}`);
    out.push("");
  }

  out.push("## Summary", "", `*${md(c.agentLabel)}*`, "");
  out.push(c.summaryText ? md(c.summaryText) : "_No summary was provided._", "");

  out.push(`## Findings (${c.findings.length})`, "", `*${md(c.agentLabel)}*`, "");
  if (!c.findings.length) out.push("_No findings were provided._", "");
  for (const sev of SEVERITY_ORDER) {
    const group = c.findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    out.push(`### ${sev[0]!.toUpperCase()}${sev.slice(1)} (${group.length})`, "");
    for (const f of group) {
      out.push(`#### ${md(f.title)}${f.area ? ` (${md(f.area)})` : ""}`, "");
      if (f.evidence) out.push(`**Evidence:** ${md(f.evidence)}`, "");
      out.push(`**Recommendation:** ${md(f.recommendation)}`, "");
    }
  }

  out.push("## Recommendations", "", `*${md(c.agentLabel)}*`, "");
  if (!c.recommendations.length) out.push("_No separate recommendations were provided._", "");
  c.recommendations.forEach((r, i) => out.push(`${i + 1}. ${md(r).replace(/\n/g, "\n   ")}`));
  if (c.recommendations.length) out.push("");

  out.push(`## ${md(c.measuredLabel)}`, "");
  if (!c.sections.length) out.push("_No measurements were collected for this report._", "");
  for (const s of c.sections) {
    out.push(`### ${md(s.title)}`, "", `**${md(s.headline)}**`, "");
    for (const r of s.rows) out.push(`- ${md(r.label)}: ${md(r.value)}`);
    if (s.rows.length) out.push("");
    if (s.issues.length) {
      out.push(`**${md(s.issuesTitle ?? "Top issues")}**`, "");
      for (const i of s.issues) {
        out.push(`- ${md(i.head)}`);
        if (i.detail) out.push(`  - ${md(i.detail)}`);
        if (i.fix) out.push(`  - Fix: ${md(i.fix)}`);
        if (i.selectors?.length) out.push(`  - Selector: ${i.selectors.map(md).join(", ")}`);
      }
      out.push("");
    }
    if (s.more) out.push(`_${md(s.more)}_`, "");
  }
  if (c.skipped.length) {
    out.push("**Not measured**", "");
    for (const s of c.skipped) out.push(`- ${md(s.kind)}: ${md(s.reason)}`);
    out.push("");
  }

  out.push("## Screenshot", "");
  out.push(c.shot ? "A screenshot is embedded in the HTML version of this report." : c.screenshotRequested ? "No screenshot could be captured." : "A screenshot was not requested.", "");

  out.push("## Appendix", "");
  out.push(`- Measurements included: ${md(c.sections.map((s) => s.kind).join(", ") || "none")}`);
  out.push(`- Measurements not collected: ${md(c.skipped.map((s) => s.kind).join(", ") || "none")}`);
  out.push(`- Generated by HelmStack ${md(c.version)}`);
  out.push("");
  return out.join("\n");
}
