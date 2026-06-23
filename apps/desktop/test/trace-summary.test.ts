import { describe, expect, it } from "vitest";

import { buildTraceSummary, type RawTraceEvent } from "../src/main/trace-summary.js";

// Timestamps/durations are in microseconds (Chrome trace format).
const events: RawTraceEvent[] = [
  { name: "RunTask", cat: "toplevel", ph: "X", ts: 1_000_000, dur: 80_000 },   // 80ms long task @0ms
  { name: "Layout", cat: "blink", ph: "X", ts: 1_100_000, dur: 30_000 },        // 30ms (not long)
  { name: "RunTask", cat: "toplevel", ph: "X", ts: 1_200_000, dur: 120_000 },   // 120ms long task @200ms
  { name: "FunctionCall", cat: "v8", ph: "X", ts: 1_250_000, dur: 60_000 },     // 60ms long task @250ms
  { name: "Paint", cat: "blink", ph: "I", ts: 1_400_000 }                       // instant — ignored for duration
];

describe("buildTraceSummary", () => {
  it("flags tasks >= 50ms, sorted longest-first, with normalised start times", () => {
    const r = buildTraceSummary(events, "tab-1", "https://x", 1000, 999);
    expect(r.longTaskCount).toBe(3);
    expect(r.longTasks.map((t) => t.durationMs)).toEqual([120, 80, 60]);
    expect(r.longestTaskMs).toBe(120);
    // First event is at ts 1_000_000 → becomes startMs 0; the 120ms task at 1_200_000 → 200ms.
    expect(r.longTasks[0]).toMatchObject({ name: "RunTask", startMs: 200, durationMs: 120 });
    expect(r.longTasks[1].startMs).toBe(0);
  });

  it("computes a per-category time breakdown over complete events", () => {
    const r = buildTraceSummary(events, "tab-1", "https://x", 1000, 999);
    const toplevel = r.byCategory.find((c) => c.category === "toplevel");
    const blink = r.byCategory.find((c) => c.category === "blink");
    expect(toplevel).toMatchObject({ totalMs: 200, eventCount: 2 }); // 80 + 120
    expect(blink).toMatchObject({ totalMs: 30, eventCount: 1 });      // only Layout (Paint is instant)
    // Sorted by total time desc.
    expect(r.byCategory[0].category).toBe("toplevel");
  });

  it("reports event counts and trace span", () => {
    const r = buildTraceSummary(events, "tab-1", "https://x", 1500, 999);
    expect(r.totalEvents).toBe(5);
    expect(r.completeEvents).toBe(4);
    expect(r.requestedMs).toBe(1500);
    // span: min ts 1_000_000, max end = 1_400_000 (Paint instant) vs 1_310_000 (FunctionCall end) → 1_400_000
    expect(r.tracedMs).toBe(400);
  });

  it("ignores ts:0 metadata events when computing the span (regression)", () => {
    // Chrome emits metadata events (ph "M") with ts:0; real events use large
    // since-boot microsecond timestamps. The span must come from the real ones.
    const withMeta: RawTraceEvent[] = [
      { name: "process_name", cat: "__metadata", ph: "M", ts: 0 },
      { name: "thread_name", cat: "__metadata", ph: "M", ts: 0 },
      { name: "RunTask", cat: "toplevel", ph: "X", ts: 358_000_000_000, dur: 5_000 },
      { name: "RunTask", cat: "toplevel", ph: "X", ts: 358_000_500_000, dur: 5_000 }
    ];
    const r = buildTraceSummary(withMeta, "t", "https://x", 1000, 1);
    // span = (358_000_505_000 - 358_000_000_000)µs = 505_000µs = 505ms (NOT ~days)
    expect(r.tracedMs).toBe(505);
    // start normalised to the first real event, not ts:0
    expect(r.completeEvents).toBe(2);
  });

  it("handles an empty trace without dividing by zero", () => {
    const r = buildTraceSummary([], "t", "https://x", 1000, 1);
    expect(r).toMatchObject({ totalEvents: 0, completeEvents: 0, longTaskCount: 0, longestTaskMs: 0, tracedMs: 0 });
    expect(r.longTasks).toEqual([]);
    expect(r.byCategory).toEqual([]);
  });

  it("tolerates events missing name/cat", () => {
    const r = buildTraceSummary([{ ph: "X", ts: 0, dur: 70_000 }], "t", "https://x", 1000, 1);
    expect(r.longTasks[0]).toMatchObject({ name: "(anonymous)", category: "", durationMs: 70 });
  });
});
