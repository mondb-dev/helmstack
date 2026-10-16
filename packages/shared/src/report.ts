/**
 * Page analysis reports: a self-contained document that captures what HelmStack
 * measured on a page together with the findings and recommendations an AI agent
 * drew from it. Measured data and the agent's interpretation are always kept
 * apart, so a reader can tell which is which.
 */
import type { TabId } from "./browser.js";

export type ReportSeverity = "critical" | "high" | "medium" | "low" | "info";

/** One finding written by the agent. HelmStack does not verify it; the report says so. */
export type ReportFinding = {
  /** Short headline. Plain text, max 160 characters. */
  title: string;
  severity: ReportSeverity;
  /** Free label such as "accessibility", "seo", "performance", "content". Max 40 characters. */
  area?: string;
  /** What was observed. Plain text, max 1,200 characters. */
  evidence?: string;
  /** What to do about it. Plain text, max 1,200 characters. */
  recommendation: string;
};

/** Measurements HelmStack can collect itself when the report is created. */
export type ReportEvidenceKind =
  | "accessibility"
  | "seo"
  | "layout"
  | "performance"
  | "health"
  | "console"
  | "network";

export const REPORT_EVIDENCE_KINDS: readonly ReportEvidenceKind[] = [
  "accessibility",
  "seo",
  "layout",
  "performance",
  "health",
  "console",
  "network"
];

export const REPORT_LIMITS = {
  titleChars: 120,
  summaryChars: 4_000,
  findings: 50,
  recommendations: 30,
  recommendationChars: 600,
  authorChars: 80
} as const;

export type CreateReportInput = {
  /** Defaults to "Page analysis: <page title>". */
  title?: string;
  /** The agent's overall assessment, 1–3 short paragraphs. Plain text. */
  summary?: string;
  findings?: ReportFinding[];
  /** Prioritised next steps, most important first. Plain text. */
  recommendations?: string[];
  /** Which measurements to collect now. Default: accessibility, seo, layout, performance, health. */
  include?: ReportEvidenceKind[];
  /** Embed a screenshot of the page. Default true. */
  screenshot?: boolean;
  /** Who wrote the findings, e.g. "Claude Code". Shown on the report. Defaults to the agent id header. */
  author?: string;
};

export type ReportFormat = "html" | "md";

export type ReportSummary = {
  id: string;
  title: string;
  createdAt: number;
  tabId: TabId;
  url: string;
  pageTitle: string;
  author?: string;
  findingCount: number;
  severityCounts: Record<ReportSeverity, number>;
  /** Measurements that were included, and any that could not be collected. */
  evidence: ReportEvidenceKind[];
  skipped: Array<{ kind: ReportEvidenceKind; reason: string }>;
  screenshot: boolean;
  formats: ReportFormat[];
  sizeBytes: number;
};

/** Returned to the agent. `path` is where the HTML file was written on this machine. */
export type CreateReportResult = {
  report: ReportSummary;
  path: string;
  /** A short text rendering the agent can show the user in chat. */
  preview: string;
};

/**
 * Appended to audit-style tool descriptions and digests so a model offers a report
 * after presenting findings instead of waiting to be asked.
 */
export const REPORT_OFFER_HINT =
  "After you present these findings, offer to prepare a report (browser_create_report) and, if the user agrees, pass your findings and recommendations to it.";
