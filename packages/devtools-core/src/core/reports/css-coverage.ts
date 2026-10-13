import type { CssCoverageReport, CssStylesheetCoverage, CssUnusedRule, TabId } from "../../../../shared/src/index.js";
import { enumerateCssRules, lineColumnAt, matchRuleUsage, type RuleUsageRange } from "../css-rules.js";

/** Cap on `unusedRules` entries per stylesheet, to bound report size. */
export const MAX_UNUSED_RULES_PER_SHEET = 200;
const MAX_SELECTOR_CHARS = 200;

/** One rule within a stylesheet and whether it was used. */
export type RawRuleRange = {
  startOffset: number;
  endOffset: number;
  used: boolean;
  /** Bytes attributed to this rule; defaults to `endOffset - startOffset` (nested rules use own bytes). */
  bytes?: number;
  /** Selector text, when known — enables the `unusedRules` listing. */
  selector?: string;
};

/** One stylesheet's text + every rule in it, used or not. */
export type RawStylesheetCoverage = {
  styleSheetId: string;
  sourceURL: string;
  /** Full stylesheet text; its `.length` is the totalBytes baseline. */
  text: string;
  ranges: RawRuleRange[];
  /** True when the sheet text could not be fetched: the sheet is reported with status "unknown". */
  textUnavailable?: boolean;
  isInline?: boolean;
};

/**
 * Build a stylesheet's complete rule list from its text and the (used-only, in
 * current Chrome) CDP rule-usage entries. Rules are enumerated from the text;
 * usage ranges mark them used by offset containment. Used ranges that match no
 * enumerated rule are kept as extra used rules so coverage is never understated.
 * `text === null` means the text could not be fetched.
 */
export function rawStylesheetFromUsage(input: {
  styleSheetId: string;
  sourceURL: string;
  text: string | null;
  usage: readonly RuleUsageRange[];
  isInline?: boolean;
}): RawStylesheetCoverage {
  const base = { styleSheetId: input.styleSheetId, sourceURL: input.sourceURL, isInline: input.isInline };
  if (input.text === null) return { ...base, text: "", ranges: [], textUnavailable: true };

  const enumeration = enumerateCssRules(input.text);
  const { used, unmatched } = matchRuleUsage(enumeration, input.usage);
  const ranges: RawRuleRange[] = enumeration.rules.map((r, idx) => ({
    startOffset: r.startOffset,
    endOffset: r.endOffset,
    used: used[idx],
    bytes: r.ownBytes,
    selector: r.selector
  }));
  for (const u of unmatched) {
    ranges.push({ startOffset: u.startOffset, endOffset: u.endOffset, used: true });
  }
  ranges.sort((a, b) => a.startOffset - b.startOffset);
  return { ...base, text: input.text, ranges };
}

/** Raw CSS coverage gathered over CDP, before aggregation. */
export type RawCssCoverage = {
  url: string;
  stylesheets: RawStylesheetCoverage[];
};

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Collapse a stylesheet's rule ranges into used/unused byte and rule tallies.
 * A range counts toward `usedBytes` only when `used` is true. Each range
 * contributes `bytes` (own bytes, so nested rules are not double counted) or
 * its span. Sheets whose text was unavailable report status "unknown", all 0.
 */
export function summarizeStylesheet(sheet: RawStylesheetCoverage): CssStylesheetCoverage {
  if (sheet.textUnavailable) {
    return {
      styleSheetId: sheet.styleSheetId,
      sourceURL: sheet.sourceURL,
      totalBytes: 0,
      ruleBytes: 0,
      usedBytes: 0,
      unusedBytes: 0,
      ruleCount: 0,
      usedRuleCount: 0,
      unusedRuleCount: 0,
      usedPercent: 0,
      status: "unknown",
      ...(sheet.isInline !== undefined ? { isInline: sheet.isInline } : {})
    };
  }

  let ruleBytes = 0;
  let usedBytes = 0;
  let usedRuleCount = 0;
  const unusedRules: CssUnusedRule[] = [];
  let unusedListed = 0;
  let hasSelectors = false;

  for (const range of sheet.ranges) {
    const span = Math.max(0, range.bytes ?? range.endOffset - range.startOffset);
    ruleBytes += span;
    if (range.selector !== undefined) hasSelectors = true;
    if (range.used) {
      usedBytes += span;
      usedRuleCount += 1;
    } else if (range.selector !== undefined) {
      unusedListed += 1;
      if (unusedRules.length < MAX_UNUSED_RULES_PER_SHEET) {
        unusedRules.push({
          selector: range.selector.length > MAX_SELECTOR_CHARS ? `${range.selector.slice(0, MAX_SELECTOR_CHARS - 1)}…` : range.selector,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          ...lineColumnAt(sheet.text, range.startOffset)
        });
      }
    }
  }

  const ruleCount = sheet.ranges.length;
  return {
    styleSheetId: sheet.styleSheetId,
    sourceURL: sheet.sourceURL,
    totalBytes: sheet.text.length,
    ruleBytes,
    usedBytes,
    unusedBytes: ruleBytes - usedBytes,
    ruleCount,
    usedRuleCount,
    unusedRuleCount: ruleCount - usedRuleCount,
    usedPercent: ruleBytes > 0 ? round1((usedBytes / ruleBytes) * 100) : 0,
    status: "measured",
    ...(sheet.isInline !== undefined ? { isInline: sheet.isInline } : {}),
    ...(hasSelectors ? { unusedRules, unusedRulesTruncated: unusedListed > unusedRules.length } : {})
  };
}

/**
 * Turn raw CDP rule-usage coverage into an aggregated, sorted report. Pure — no
 * CDP or DOM access — so it can be unit-tested directly. Stylesheets are sorted
 * by unused bytes (worst offenders first), then by id for stable ordering.
 */
export function buildCssCoverageReport(raw: RawCssCoverage, tabId: TabId, capturedAt: number): CssCoverageReport {
  const stylesheets = raw.stylesheets
    .map(summarizeStylesheet)
    .sort((a, b) => b.unusedBytes - a.unusedBytes || a.styleSheetId.localeCompare(b.styleSheetId));

  const summary = stylesheets.reduce(
    (acc, s) => {
      acc.totalBytes += s.totalBytes;
      acc.ruleBytes += s.ruleBytes;
      acc.usedBytes += s.usedBytes;
      acc.unusedBytes += s.unusedBytes;
      acc.ruleCount += s.ruleCount;
      acc.usedRuleCount += s.usedRuleCount;
      acc.unusedRuleCount += s.unusedRuleCount;
      if (s.status === "unknown") acc.unknownStylesheetCount += 1;
      return acc;
    },
    {
      stylesheetCount: stylesheets.length,
      totalBytes: 0,
      ruleBytes: 0,
      usedBytes: 0,
      unusedBytes: 0,
      usedPercent: 0,
      ruleCount: 0,
      usedRuleCount: 0,
      unusedRuleCount: 0,
      unknownStylesheetCount: 0
    }
  );
  summary.usedPercent = summary.ruleBytes > 0 ? round1((summary.usedBytes / summary.ruleBytes) * 100) : 0;

  return { tabId, url: raw.url, capturedAt, stylesheets, summary };
}
