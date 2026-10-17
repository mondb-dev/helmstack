/**
 * Routines: a procedure an agent compiles from the user's request and the user approves.
 * The spec itself (`RoutineSpec`, in `routine-spec.ts`) is JSON made of a closed set of
 * deterministic steps and typed inference points. This file is what the shell and the
 * agent API share about a routine's life cycle, not its internals.
 *
 * Phase 1 stores, validates, previews and approves routines. Phase 2 runs approved `manual`
 * and `interval` routines. Phase 3 answers `infer` steps with a tool-less model call (the model
 * the human chose); with no usable model a run ends as `needs_human`. `RoutineEngineStatus` says what the engine can do, and the UI shows it.
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
  /** What the spec asked to be allowed (display only). */
  requestedGrants?: RoutineGrants;
  /** What the human actually allowed. */
  grants?: RoutineGrants;
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
  | "needs_human" // an inference point or approval needs the human (used when an infer step cannot continue without a person)
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

/**
 * The model that answers a routine's inference points. Chosen by the human; routines
 * and agents cannot change it. The model gets page text and a question and answers
 * with JSON only: it is given no tools, no browser and no files.
 */
export type RoutineModelChoice = {
  /** An AgentCliId from agent-chat (claude, gemini, or a local runtime). */
  cli: string;
  /** Model id for that runtime; omitted = the runtime's default. */
  model?: string;
};

export type RoutineModelStatus = {
  choice: RoutineModelChoice | null;
  /** True when the chosen runtime is installed/reachable right now. */
  available: boolean;
  /** Plain-language reason when choice is null or not available. */
  reason?: string;
};

/**
 * What the human lets a routine do without asking. Set at approval (and changeable later);
 * the routine can request grants but never raise them. No grant means every action asks.
 */
export type RoutineGrantMode = "ask" | "auto";
export type RoutineEffectGrant = { mode: RoutineGrantMode; perDay?: number; perRun?: number };
export type RoutineGrants = {
  /** Only rearrange, add_item and remove_item may be "auto"; the rest always ask. */
  effects: Partial<Record<RoutineEffectName, RoutineEffectGrant>>;
  /** Names the routine must never remove or give away. */
  protect: string[];
};
export type RoutineEffectName = "rearrange" | "add_item" | "remove_item" | "offer" | "respond" | "other";

export type RoutineActionStatus = "pending" | "approved" | "declined" | "expired" | "done" | "failed" | "blocked";

/** An action the routine wants to take and is waiting on the human for, or has taken. */
export type RoutineAction = {
  id: string;
  routineId: string;
  runId: string;
  createdAt: number;
  /** Pending actions lapse after this (12 hours); an expired action is never run. */
  expiresAt: number;
  effect: RoutineEffectName;
  action: "click" | "fill" | "select";
  /** One plain sentence, e.g. 'Click "Add" for Jalen Smith on basketball.example.com.' Page text as text only. */
  description: string;
  host: string;
  url: string;
  subject?: string;
  status: RoutineActionStatus;
  /** Why it asked, was blocked, or failed, in plain words. */
  note?: string;
  /** How it was allowed: the human tapped it, or the grant covered it. */
  allowedBy?: "human" | "grant";
  decidedAt?: number;
};

/** What the `routine_action` event (SSE) and the shell carry about an action: ids and words, never page text. */
export type RoutineActionEvent = {
  routineId: string;
  actionId: string;
  effect: RoutineEffectName;
  status: RoutineActionStatus;
};
