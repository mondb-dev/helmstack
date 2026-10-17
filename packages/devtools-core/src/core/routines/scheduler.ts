/**
 * Pure scheduling maths for interval routines. No timers here: the engine owns those and
 * passes the clock and randomness in, so tests are deterministic.
 *
 * - The next run is computed from the previous *start*, so a long sleep produces one
 *   overdue run on wake, never a backlog.
 * - `jitter_pct` spreads runs by up to ±pct of the interval.
 * - `active_hours` (`HH:MM-HH:MM`, local time, may wrap midnight) pushes a run to the next
 *   moment inside the window.
 * - After a failure the retry comes sooner (fixed or exponential backoff) but never later
 *   than the regular interval.
 */
import type { RoutineTrigger } from "../../../../shared/src/index.js";
import { parseEveryMinutes } from "./validate.js";

export type IntervalTrigger = Extract<RoutineTrigger, { kind: "interval" }>;

export type ActiveWindow = { startMin: number; endMin: number };

export const MINUTE_MS = 60_000;
/** Base delay for the retry backoff after a failed run. */
export const BACKOFF_BASE_MS = 2 * MINUTE_MS;
/** Consecutive failed runs before the engine pauses a routine, unless the spec says otherwise. */
export const DEFAULT_PAUSE_AFTER = 3;

export function intervalMs(trigger: IntervalTrigger): number | null {
  const minutes = parseEveryMinutes(trigger.every);
  return minutes === null ? null : minutes * MINUTE_MS;
}

export function parseActiveHours(text: string | undefined): ActiveWindow | null {
  if (!text) return null;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  return startMin === endMin ? null : { startMin, endMin };
}

function minuteOfDay(ts: number): number {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function inActiveWindow(ts: number, window: ActiveWindow | null): boolean {
  if (!window) return true;
  const m = minuteOfDay(ts);
  return window.startMin < window.endMin ? m >= window.startMin && m < window.endMin : m >= window.startMin || m < window.endMin;
}

/** The first moment at or after `ts` that is inside the window. */
export function nextActiveTime(ts: number, window: ActiveWindow | null): number {
  if (!window || inActiveWindow(ts, window)) return ts;
  const d = new Date(ts);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(window.startMin / 60), window.startMin % 60, 0, 0);
  if (target.getTime() <= ts) target.setDate(target.getDate() + 1);
  return target.getTime();
}

export function backoffDelayMs(failures: number, kind: "fixed" | "exponential", capMs: number): number {
  const n = Math.max(1, failures);
  const delay = kind === "exponential" ? BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 10) : BACKOFF_BASE_MS;
  return Math.min(delay, capMs);
}

export type NextRunInput = {
  now: number;
  trigger: IntervalTrigger;
  /** Start time of the previous run, when there was one. */
  lastStartedAt?: number;
  /** When the engine first saw the routine approved. */
  activeSince: number;
  consecutiveFailures: number;
  backoff?: "fixed" | "exponential";
  /** Delay before the very first run. */
  firstRunDelayMs: number;
  random: () => number;
};

/** When the next run is due. Never earlier than `now` for a run that is already overdue. */
export function computeNextRun(input: NextRunInput): number {
  const every = intervalMs(input.trigger) ?? 60 * MINUTE_MS;
  const window = parseActiveHours(input.trigger.active_hours);
  let due: number;
  if (input.consecutiveFailures > 0) {
    due = input.now + backoffDelayMs(input.consecutiveFailures, input.backoff ?? "exponential", every);
  } else if (input.lastStartedAt === undefined) {
    due = input.activeSince + input.firstRunDelayMs;
  } else {
    const pct = Math.max(0, Math.min(100, input.trigger.jitter_pct ?? 0)) / 100;
    const jitter = pct > 0 ? (input.random() * 2 - 1) * pct : 0;
    due = input.lastStartedAt + Math.round(every * (1 + jitter));
  }
  // An overdue run (the machine slept) runs once, now: the next one is computed from that start.
  due = Math.max(due, input.activeSince);
  return nextActiveTime(due, window);
}

/** Whether a run starting at `ts` is allowed by the trigger's active hours. */
export function mayStartNow(ts: number, trigger: IntervalTrigger): boolean {
  return inActiveWindow(ts, parseActiveHours(trigger.active_hours));
}
