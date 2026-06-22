import type { CssCoverageReport, CssStylesheetCoverage, TabId } from "../../../../packages/shared/src/index.js";

/** A single tracked rule range within a stylesheet (from CDP `CSS.stopRuleUsageTracking`). */
export type RawRuleRange = {
  startOffset: number;
  endOffset: number;
  used: boolean;
};

/** One stylesheet's text + the rule ranges tracked against it. */
export type RawStylesheetCoverage = {
  styleSheetId: string;
  sourceURL: string;
  /** Full stylesheet text; its `.length` is the totalBytes baseline. */
  text: string;
  ranges: RawRuleRange[];
};

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
 * Collapse a stylesheet's tracked rule ranges into used/unused byte and rule
 * tallies. A range counts toward `usedBytes` only when `used` is true; overlap
 * is not deduplicated because CDP emits one range per rule (non-overlapping).
 */
export function summarizeStylesheet(sheet: RawStylesheetCoverage): CssStylesheetCoverage {
  let ruleBytes = 0;
  let usedBytes = 0;
  let usedRuleCount = 0;

  for (const range of sheet.ranges) {
    const span = Math.max(0, range.endOffset - range.startOffset);
    ruleBytes += span;
    if (range.used) {
      usedBytes += span;
      usedRuleCount += 1;
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
    usedPercent: ruleBytes > 0 ? round1((usedBytes / ruleBytes) * 100) : 0
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
      unusedRuleCount: 0
    }
  );
  summary.usedPercent = summary.ruleBytes > 0 ? round1((summary.usedBytes / summary.ruleBytes) * 100) : 0;

  return { tabId, url: raw.url, capturedAt, stylesheets, summary };
}
