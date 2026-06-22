import type { JsCoverageReport, JsScriptCoverage, TabId } from "../../../../packages/shared/src/index.js";

/** A V8 precise-coverage range within a script (from `Profiler.takePreciseCoverage`). */
export type RawCoverageRange = {
  startOffset: number;
  endOffset: number;
  count: number;
};

/** One script's source length + the flattened coverage ranges across its functions. */
export type RawScriptCoverage = {
  scriptId: string;
  url: string;
  /** Script source length (totalBytes baseline). */
  length: number;
  ranges: RawCoverageRange[];
};

/** Raw JS coverage gathered over CDP, before aggregation. */
export type RawJsCoverage = {
  url: string;
  scripts: RawScriptCoverage[];
};

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Compute instrumented vs. executed bytes for one script using V8's
 * "innermost range wins" rule: a byte's execution count is decided by the
 * *smallest* range that contains it. We sweep the sorted offset boundaries,
 * and for each elementary segment pick the narrowest containing range — the
 * segment is `used` when that range's count is > 0, and `instrumented` whenever
 * any range covers it. Pure and deterministic, so it is unit-tested directly.
 */
export function summarizeScript(script: RawScriptCoverage): JsScriptCoverage {
  const ranges = script.ranges.filter((r) => r.endOffset > r.startOffset);

  // Unique sorted boundaries delimit elementary segments.
  const bounds = new Set<number>();
  for (const r of ranges) {
    bounds.add(r.startOffset);
    bounds.add(r.endOffset);
  }
  const points = Array.from(bounds).sort((a, b) => a - b);

  let instrumented = 0;
  let used = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const span = b - a;
    if (span <= 0) continue;

    // Narrowest range covering [a, b) decides the count for this segment.
    let innermost: RawCoverageRange | null = null;
    for (const r of ranges) {
      if (r.startOffset <= a && r.endOffset >= b) {
        if (!innermost || r.endOffset - r.startOffset < innermost.endOffset - innermost.startOffset) {
          innermost = r;
        }
      }
    }
    if (!innermost) continue; // uninstrumented gap (between functions, comments)
    instrumented += span;
    if (innermost.count > 0) used += span;
  }

  return {
    scriptId: script.scriptId,
    url: script.url,
    totalBytes: script.length,
    instrumentedBytes: instrumented,
    usedBytes: used,
    unusedBytes: instrumented - used,
    usedPercent: instrumented > 0 ? round1((used / instrumented) * 100) : 0
  };
}

/**
 * Turn raw CDP precise coverage into an aggregated, sorted report. Pure — no
 * CDP or DOM access. Scripts are sorted by unused bytes (worst offenders
 * first), then by id for stable ordering.
 */
export function buildJsCoverageReport(raw: RawJsCoverage, tabId: TabId, capturedAt: number): JsCoverageReport {
  const scripts = raw.scripts
    .map(summarizeScript)
    .sort((a, b) => b.unusedBytes - a.unusedBytes || a.scriptId.localeCompare(b.scriptId));

  const summary = scripts.reduce(
    (acc, s) => {
      acc.totalBytes += s.totalBytes;
      acc.instrumentedBytes += s.instrumentedBytes;
      acc.usedBytes += s.usedBytes;
      acc.unusedBytes += s.unusedBytes;
      return acc;
    },
    { scriptCount: scripts.length, totalBytes: 0, instrumentedBytes: 0, usedBytes: 0, unusedBytes: 0, usedPercent: 0 }
  );
  summary.usedPercent = summary.instrumentedBytes > 0 ? round1((summary.usedBytes / summary.instrumentedBytes) * 100) : 0;

  return { tabId, url: raw.url, capturedAt, scripts, summary };
}
