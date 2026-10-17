/**
 * Routines: a procedure an agent compiles from the user's request and the user approves.
 * The spec itself (`RoutineSpec`, in `routine-spec.ts`) is JSON made of a closed set of
 * deterministic steps and typed inference points. This file is what the shell and the
 * agent API share about a routine's life cycle, not its internals.
 *
 * Phase 1 stores, validates, previews and approves routines. Phase 2 runs approved `manual`
 * and `interval` routines with deterministic steps only (no model calls); `infer` steps end a
 * run as `needs_human`. `RoutineEngineStatus` says what the engine can do, and the UI shows it.
 */

/**
 * proposed  – written by an agent, waiting for the human to review
 * approved  – confirmed by the human; runs once the engine is enabled
 * paused    – approved earlier, currently held by the human
 * stopped   – ended (a stop condition fired, superseded by an edit, or the human stopped it)
 * rejected  – the human declined the proposal, or the agent withdrew it
 */
export type RoutineState = "proposed" | "approved" | "paused" | "stopped" | "rejected";

export type RoutineRiskLevel = "info" | "warning" | "high";

export type RoutineRisk = {
  level: RoutineRiskLevel;
  /** Stable machine code, e.g. "no_stop_condition", "any_site", "fast_interval". */
  code: string;
  /** One plain sentence for the human. */
  message: string;
};

/** Deterministic, model-free description of what a routine will do. */
export type RoutinePreview = {
  /** One sentence, e.g. "Check example.com every 6 hours and note new updates about <topic>." */
  headline: string;
  /** Short plain-language bullets: when, where, what it notes, how it decides, when it stops. */
  lines: string[];
  risks: RoutineRisk[];
};

export type RoutineSummary = {
  id: string;
  title: string;
  /** The user's original request, verbatim as the agent recorded it. */
  intent: string;
  state: RoutineState;
  createdAt: number;
  updatedAt: number;
  /** Agent id (header) that proposed it, when known. */
  proposedBy?: string;
  /** When this proposal edits an earlier routine, its id. */
  replaces?: string;
  /** Plain-text trigger, e.g. "every 6 hours", "when a watch fires", "manual". */
  trigger: string;
  /** Hosts the routine may visit (empty when the spec leaves scope open, which is flagged as a risk). */
  hosts: string[];
  preview: RoutinePreview;
  specVersion: number;
};

export type RoutineDetail = RoutineSummary & {
  /** The validated spec, pretty-printed. Display only: the shell never edits it. */
  specJson: string;
};

export type RoutineEngineStatus = {
  /** True when the engine can run approved routines on this backend. */
  enabled: boolean;
  /** Shown to the human when not enabled. */
  reason?: string;
  /** Human kill switch: while true nothing starts, whatever the triggers say. */
  killed?: boolean;
  /** Ids of routines that are running right now. */
  running?: string[];
};

/** How a run ended. */
export type RoutineRunOutcome =
  | "completed" //   every step ran
  | "stopped" //     a stop condition fired or the human stopped it
  | "budget" //      a page/time/note budget ran out
  | "needs_human" // an inference point or approval needs the human (phase 3 uses this for infer)
  | "failed" //      a step failed
  | "cancelled"; //  the human cancelled this run or used the kill switch

export type RoutineRunStatus = "running" | RoutineRunOutcome;

/** One line of a run's log. Plain text, never page HTML. */
export type RoutineRunLogEntry = {
  at: number;
  level: "info" | "warn" | "error";
  /** Step id or kind, when the line belongs to a step. */
  step?: string;
  message: string;
};

export type RoutineRunSummary = {
  id: string;
  routineId: string;
  trigger: "manual" | "interval";
  startedAt: number;
  endedAt?: number;
  status: RoutineRunStatus;
  pagesVisited: number;
  notesAdded: number;
  /** One sentence: what happened, or why it ended. */
  summary: string;
};

export type RoutineRunDetail = RoutineRunSummary & {
  log: RoutineRunLogEntry[];
};

/** A note a routine recorded. Fields are text the page supplied; render as text only. */
export type RoutineNote = {
  id: string;
  routineId: string;
  runId: string;
  at: number;
  /** Page the note came from. */
  url: string;
  fields: Record<string, string>;
  /** True when it was recorded as uncertain ("maybe"). */
  maybe?: boolean;
};

/** What the routine remembers between runs, for display. */
export type RoutineMemory = {
  routineId: string;
  /** Number of items in each `set` state key, e.g. { seen: 41 }. */
  sets: Record<string, number>;
  /** Current value of each `value` state key. */
  values: Record<string, string>;
  /** Next scheduled run for an interval routine, when approved and not paused. */
  nextRunAt?: number;
  /** Why this routine is never started on its own (schedule/event triggers do not run yet). */
  notScheduledReason?: string;
  lastRun?: RoutineRunSummary;
};
