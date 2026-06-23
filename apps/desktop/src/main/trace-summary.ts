import type { TraceCategorySummary, TraceLongTask, TraceReport, TabId } from "../../../../packages/shared/src/index.js";

/** A raw Chrome trace event (subset of the fields we use), from `Tracing.dataCollected`. */
export type RawTraceEvent = {
  name?: string;
  cat?: string;
  /** Phase: "X" = complete (has dur), "B"/"E" = begin/end, "I" = instant, etc. */
  ph?: string;
  /** Timestamp in microseconds. */
  ts?: number;
  /** Duration in microseconds (complete events only). */
  dur?: number;
  pid?: number;
  tid?: number;
};

/** Tasks at or above this duration (ms) are flagged as jank-risk long tasks. */
export const LONG_TASK_MS = 50;

const MAX_LONG_TASKS = 50;
const MAX_CATEGORIES = 25;

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Summarize raw Chrome trace events into long main-thread tasks + a per-category
 * time breakdown. Pure — no CDP access — so it is unit-tested directly.
 * Timestamps are normalised so `startMs` is relative to the first event.
 */
export function buildTraceSummary(events: RawTraceEvent[], tabId: TabId, url: string, requestedMs: number, capturedAt: number): TraceReport {
  // Complete events carry a duration; they're what we measure.
  const complete = events.filter((e) => e.ph === "X" && typeof e.ts === "number" && typeof e.dur === "number");

  // Trace span: earliest start to latest end across all timestamped events.
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const e of events) {
    // Skip non-positive timestamps: metadata events (`ph: "M"`) carry `ts: 0`,
    // which would otherwise collapse `minTs` to 0 against real since-boot
    // microsecond timestamps and blow up the span to ~days.
    if (typeof e.ts !== "number" || e.ts <= 0) continue;
    if (e.ts < minTs) minTs = e.ts;
    const end = e.ts + (typeof e.dur === "number" ? e.dur : 0);
    if (end > maxTs) maxTs = end;
  }
  const traceStart = Number.isFinite(minTs) ? minTs : 0;
  const tracedMs = Number.isFinite(maxTs) && Number.isFinite(minTs) ? round1((maxTs - minTs) / 1000) : 0;

  // Long tasks: complete events ≥ 50 ms, longest first.
  const longTasks: TraceLongTask[] = complete
    .map((e): TraceLongTask => ({
      name: e.name ?? "(anonymous)",
      category: e.cat ?? "",
      startMs: round1(((e.ts as number) - traceStart) / 1000),
      durationMs: round1((e.dur as number) / 1000)
    }))
    .filter((t) => t.durationMs >= LONG_TASK_MS)
    .sort((a, b) => b.durationMs - a.durationMs || a.startMs - b.startMs);

  // Per-category time breakdown over complete events.
  const catTotals = new Map<string, { totalUs: number; count: number }>();
  for (const e of complete) {
    const cat = e.cat ?? "";
    const entry = catTotals.get(cat) ?? { totalUs: 0, count: 0 };
    entry.totalUs += e.dur as number;
    entry.count += 1;
    catTotals.set(cat, entry);
  }
  const byCategory: TraceCategorySummary[] = Array.from(catTotals.entries())
    .map(([category, { totalUs, count }]): TraceCategorySummary => ({
      category,
      totalMs: round1(totalUs / 1000),
      eventCount: count
    }))
    .sort((a, b) => b.totalMs - a.totalMs || a.category.localeCompare(b.category))
    .slice(0, MAX_CATEGORIES);

  return {
    tabId,
    url,
    capturedAt,
    requestedMs,
    tracedMs,
    totalEvents: events.length,
    completeEvents: complete.length,
    longTasks: longTasks.slice(0, MAX_LONG_TASKS),
    longTaskCount: longTasks.length,
    longestTaskMs: longTasks.length > 0 ? longTasks[0].durationMs : 0,
    byCategory
  };
}
