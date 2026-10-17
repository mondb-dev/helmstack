/**
 * Routines: a procedure an agent compiles from the user's request and the user approves.
 * The spec itself (`RoutineSpec`, in `routine-spec.ts`) is JSON made of a closed set of
 * deterministic steps and typed inference points. This file is what the shell and the
 * agent API share about a routine's life cycle, not its internals.
 *
 * Phase 1 stores, validates, previews and approves routines. Nothing executes them yet;
 * `RoutineEngineStatus` says so, and the UI must show it.
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
  /** False in phase 1: routines can be reviewed and approved but nothing runs them. */
  enabled: boolean;
  /** Shown to the human when not enabled. */
  reason?: string;
};
