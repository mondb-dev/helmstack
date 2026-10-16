/**
 * Validation of `CreateReportInput` for the agent API and the core.
 *
 * Over-limit or malformed input is rejected with a message naming the field,
 * never silently shortened (the builder additionally truncates as a backstop).
 * Control characters are not an error: the builder strips them.
 */
import type { CreateReportInput, ReportEvidenceKind, ReportFinding, ReportSeverity } from "../../../../shared/src/index.js";
import { REPORT_EVIDENCE_KINDS, REPORT_LIMITS } from "../../../../shared/src/index.js";
import { REPORT_FIELD_LIMITS, SEVERITY_ORDER } from "./page-report.js";

/** Thrown for invalid caller input; the HTTP layer maps it to 400. */
export class ReportInputError extends Error {
  readonly code = "invalid_report_input";
  constructor(message: string) {
    super(message);
    this.name = "ReportInputError";
  }
}

export const DEFAULT_REPORT_EVIDENCE: readonly ReportEvidenceKind[] = [
  "accessibility",
  "seo",
  "layout",
  "performance",
  "health"
];

const TOP_KEYS = new Set(["title", "summary", "findings", "recommendations", "include", "screenshot", "author"]);
const FINDING_KEYS = new Set(["title", "severity", "area", "evidence", "recommendation"]);

export type ParsedReportInput = CreateReportInput & { include: ReportEvidenceKind[]; screenshot: boolean };

type Result = { ok: true; value: ParsedReportInput } | { ok: false; error: string };

const len = (s: string): number => Array.from(s).length;

function fail(error: string): Result {
  return { ok: false, error };
}

function optString(v: unknown, field: string, max: number): string | undefined | Error {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return new Error(`${field} must be a string`);
  if (len(v) > max) return new Error(`${field} is ${len(v)} characters; the limit is ${max}`);
  return v;
}

export function parseCreateReportInput(raw: unknown): Result {
  if (raw === undefined || raw === null) return { ok: true, value: { include: [...DEFAULT_REPORT_EVIDENCE], screenshot: true } };
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("report body must be a JSON object");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!TOP_KEYS.has(key)) return fail(`unknown field "${key}"; allowed: ${[...TOP_KEYS].join(", ")}`);
  }

  const out: ParsedReportInput = { include: [...DEFAULT_REPORT_EVIDENCE], screenshot: true };

  for (const [field, max] of [
    ["title", REPORT_LIMITS.titleChars],
    ["summary", REPORT_LIMITS.summaryChars],
    ["author", REPORT_LIMITS.authorChars]
  ] as const) {
    const v = optString(body[field], field, max);
    if (v instanceof Error) return fail(v.message);
    if (v !== undefined) out[field] = v;
  }

  if (body.findings !== undefined) {
    if (!Array.isArray(body.findings)) return fail("findings must be an array");
    if (body.findings.length > REPORT_LIMITS.findings) {
      return fail(`findings has ${body.findings.length} items; the limit is ${REPORT_LIMITS.findings}`);
    }
    const findings: ReportFinding[] = [];
    for (let i = 0; i < body.findings.length; i++) {
      const f = body.findings[i] as unknown;
      const at = `findings[${i}]`;
      if (!f || typeof f !== "object" || Array.isArray(f)) return fail(`${at} must be an object`);
      const rec = f as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (!FINDING_KEYS.has(key)) return fail(`${at}: unknown field "${key}"; allowed: ${[...FINDING_KEYS].join(", ")}`);
      }
      const title = optString(rec.title, `${at}.title`, REPORT_FIELD_LIMITS.findingTitleChars);
      if (title instanceof Error) return fail(title.message);
      if (!title?.trim()) return fail(`${at}.title is required`);
      if (!SEVERITY_ORDER.includes(rec.severity as ReportSeverity)) {
        return fail(`${at}.severity must be one of ${SEVERITY_ORDER.join(", ")}`);
      }
      const area = optString(rec.area, `${at}.area`, REPORT_FIELD_LIMITS.findingAreaChars);
      if (area instanceof Error) return fail(area.message);
      const evidence = optString(rec.evidence, `${at}.evidence`, REPORT_FIELD_LIMITS.findingEvidenceChars);
      if (evidence instanceof Error) return fail(evidence.message);
      const recommendation = optString(rec.recommendation, `${at}.recommendation`, REPORT_FIELD_LIMITS.findingRecommendationChars);
      if (recommendation instanceof Error) return fail(recommendation.message);
      if (!recommendation?.trim()) return fail(`${at}.recommendation is required`);
      findings.push({
        title,
        severity: rec.severity as ReportSeverity,
        ...(area !== undefined ? { area } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
        recommendation
      });
    }
    out.findings = findings;
  }

  if (body.recommendations !== undefined) {
    if (!Array.isArray(body.recommendations)) return fail("recommendations must be an array of strings");
    if (body.recommendations.length > REPORT_LIMITS.recommendations) {
      return fail(`recommendations has ${body.recommendations.length} items; the limit is ${REPORT_LIMITS.recommendations}`);
    }
    const list: string[] = [];
    for (let i = 0; i < body.recommendations.length; i++) {
      const r = optString(body.recommendations[i], `recommendations[${i}]`, REPORT_LIMITS.recommendationChars);
      if (r instanceof Error) return fail(r.message);
      if (!r?.trim()) return fail(`recommendations[${i}] must be a non-empty string`);
      list.push(r);
    }
    out.recommendations = list;
  }

  if (body.include !== undefined) {
    if (!Array.isArray(body.include)) return fail("include must be an array");
    const kinds: ReportEvidenceKind[] = [];
    for (const k of body.include) {
      if (!REPORT_EVIDENCE_KINDS.includes(k as ReportEvidenceKind)) {
        return fail(`include has unknown kind ${JSON.stringify(String(k)).slice(0, 40)}; allowed: ${REPORT_EVIDENCE_KINDS.join(", ")}`);
      }
      if (!kinds.includes(k as ReportEvidenceKind)) kinds.push(k as ReportEvidenceKind);
    }
    out.include = kinds;
  }

  if (body.screenshot !== undefined) {
    if (typeof body.screenshot !== "boolean") return fail("screenshot must be a boolean");
    out.screenshot = body.screenshot;
  }

  return { ok: true, value: out };
}
