/**
 * The routine spec: JSON a model compiles from the user's natural-language request.
 *
 * A spec has a deterministic skeleton (a closed vocabulary of site-agnostic steps that
 * HelmStack executes exactly) and typed inference points (`infer`) where judgment is
 * needed. Every inference point yields `{ value, confidence, evidence }` and the engine
 * routes on thresholds written in the spec. The model can only fill this schema; it cannot
 * add capabilities, reference credentials, or lower HelmStack's approval guardrails.
 *
 * Phase 1 stores, validates, previews and lets the human approve specs. Nothing executes.
 * See docs/routines.md. The validator and JSON Schema live in devtools-core
 * (`core/routines/`); this file is only the shared vocabulary.
 */

import type { RoutineSummary } from "./routine.js";

export const ROUTINE_SPEC_VERSION = 1 as const;

/** Hard limits, enforced by the validator and mirrored in the JSON Schema. */
export const ROUTINE_LIMITS = {
  specBytes: 64 * 1024,
  stringChars: 2_000,
  titleChars: 120,
  urlChars: 2_048,
  startUrls: 10,
  allowHosts: 20,
  maxPagesPerRun: 200,
  maxDepth: 3,
  maxSteps: 60,
  maxNesting: 4,
  forEachLimit: 100,
  samples: 5,
  stateKeys: 12,
  stopConditions: 8,
  noteFields: 10,
  extractFields: 20,
  labels: 10,
  relatedPerRun: 10,
  intervalMinMinutes: 1,
  intervalMaxDays: 90,
  /** Requests per second the `safety.rate` string may allow. */
  maxRequestsPerSecond: 5,
  /** Whole-request body accepted over HTTP. */
  requestBytes: 128 * 1024
} as const;

export const ROUTINE_STRATEGIES = ["structured_data", "repeating_blocks", "infer"] as const;
export type RoutineStrategy = (typeof ROUTINE_STRATEGIES)[number];

/** Things the engine always asks the human about; a spec can only add to this set. */
export const ROUTINE_APPROVAL_KINDS = [
  "submit",
  "personal_data",
  "purchase",
  "post",
  "account_creation",
  "accept_terms",
  "send_message",
  "download",
  "upload",
  "delete"
] as const;
export type RoutineApprovalKind = (typeof ROUTINE_APPROVAL_KINDS)[number];

export const ROUTINE_STEP_KINDS = [
  "open",
  "locate",
  "extract",
  "diff",
  "for_each",
  "infer",
  "branch",
  "note",
  "mark_seen",
  "open_item",
  "wait",
  "report"
] as const;
export type RoutineStepKind = (typeof ROUTINE_STEP_KINDS)[number];

export const ROUTINE_STATE_TYPES = ["set", "log", "value"] as const;
export type RoutineStateType = (typeof ROUTINE_STATE_TYPES)[number];

export const ROUTINE_ON_LOW = ["ask_human", "skip", "fail"] as const;
export const ROUTINE_ON_UNCERTAIN = ["note_as_maybe", "ask_human", "skip", "retry_more_context"] as const;
export const ROUTINE_INFER_MODELS = ["default", "cheap", "strong"] as const;

/**
 * A reference: `$scope.start[i]`, `$<step id>`, `$item` or `state.<key>`.
 * No expressions, property paths or interpolation exist.
 */
export type RoutineRef = string;

export type RoutineTrigger =
  | { kind: "manual" }
  | {
      kind: "interval";
      /** `^[1-9]\d*(m|h|d)$`, 1 minute to 90 days. */
      every: string;
      jitter_pct?: number;
      /** `HH:MM-HH:MM` local time. */
      active_hours?: string;
    }
  | { kind: "schedule"; /** 5-field cron. */ cron: string; /** IANA zone. */ timezone?: string }
  | { kind: "event"; /** Plain-language condition for an assertion watch. */ watch: string };

export type RoutineScope = {
  /** http/https URLs the routine starts from (1..10). */
  start: string[];
  follow?: {
    /** Links on the same host as a start URL (a leading `www.` is ignored). */
    same_site?: boolean;
    /** Exact hosts, or `*.example.com` for subdomains. */
    allow_hosts?: string[];
    /** Link hops from a start page (default 1). */
    max_depth?: number;
  };
  max_pages_per_run: number;
};

/** `text`, `text<=N`, `date`, `url`, `number`, `bool`; a trailing `?` makes it optional. */
export type RoutineFieldType = string;

export type RoutineOpenStep = { do: "open"; id?: string; url: string };
export type RoutineLocateStep = {
  do: "locate";
  id?: string;
  /** What to find, in plain language. */
  target: string;
  strategies: RoutineStrategy[];
  min_confidence: number;
  on_low: "ask_human" | "skip" | "fail";
};
export type RoutineExtractStep = {
  do: "extract";
  id?: string;
  fields: Record<string, RoutineFieldType>;
  strategies: RoutineStrategy[];
  /** `$item` or a `locate` step. Defaults to the current item, or the page outside a loop. */
  from?: RoutineRef;
};
export type RoutineDiffStep = {
  do: "diff";
  id?: string;
  /** A `locate` step whose items are compared. */
  items: RoutineRef;
  against: RoutineRef;
  /** Field names identifying an item. */
  key: string[];
};
export type RoutineForEachStep = {
  do: "for_each";
  id?: string;
  items: RoutineRef;
  limit: number;
  steps: RoutineStep[];
};
export type RoutineInferStep = {
  do: "infer";
  id?: string;
  question: string;
  output: string;
  labels?: string[];
  accept_at: number;
  reject_below: number;
  on_uncertain: "note_as_maybe" | "ask_human" | "skip" | "retry_more_context";
  evidence?: "quote" | "none";
  samples?: number;
  uses?: RoutineRef;
  model?: "default" | "cheap" | "strong";
};
export type RoutineBranchStep = {
  do: "branch";
  id?: string;
  /** Bare id of an earlier `infer` step. */
  on: string;
  accept?: RoutineStep[];
  maybe?: RoutineStep[];
  reject?: RoutineStep[];
};
export type RoutineNoteStep = { do: "note"; id?: string; tag?: string; fields?: RoutineRef[] };
export type RoutineMarkSeenStep = { do: "mark_seen"; id?: string; into?: RoutineRef };
export type RoutineOpenItemStep = { do: "open_item"; id?: string };
export type RoutineWaitStep = { do: "wait"; id?: string; for: string };
export type RoutineReportStep = { do: "report"; id?: string; when?: string };

export type RoutineStep =
  | RoutineOpenStep
  | RoutineLocateStep
  | RoutineExtractStep
  | RoutineDiffStep
  | RoutineForEachStep
  | RoutineInferStep
  | RoutineBranchStep
  | RoutineNoteStep
  | RoutineMarkSeenStep
  | RoutineOpenItemStep
  | RoutineWaitStep
  | RoutineReportStep;

export type RoutineRelated = {
  /** Plain-language description of where to look for related pages. */
  discover: string;
  accept_at: number;
  limit_per_run: number;
  /** Always "human_approval" in v1: widening scope needs a human. */
  needs: "human_approval";
};

export type RoutineStopCondition =
  | { after_runs: number }
  | { after_days: number }
  | { when_inferred: string; confidence: number }
  | { when_count: { key: string; at_least: number } };

export type RoutineBudgets = {
  tokens_per_run?: number;
  pages_per_run?: number;
  cost_usd_total?: number;
  runtime_minutes_per_run?: number;
};

export type RoutineStop = {
  any?: RoutineStopCondition[];
  budgets?: RoutineBudgets;
};

export type RoutineOnFailure = {
  retries: number;
  backoff: "fixed" | "exponential";
  pause_after: number;
  notify: boolean;
};

export type RoutineOutput = {
  notes: "append";
  report?: { every: string; when?: string };
};

export type RoutineSafety = {
  /** Added to HelmStack's own always-ask list; can never remove from it. */
  approval_for?: RoutineApprovalKind[];
  /** "<n> request(s) / <n>s". */
  rate?: string;
};

export type RoutineSpec = {
  version: 1;
  title: string;
  /** The user's request, verbatim. */
  intent: string;
  scope: RoutineScope;
  trigger: RoutineTrigger;
  steps: RoutineStep[];
  related?: RoutineRelated;
  /** Declared state keys the steps use. `notes` (a log) always exists. */
  state?: Record<string, RoutineStateType>;
  stop?: RoutineStop;
  on_failure?: RoutineOnFailure;
  output?: RoutineOutput;
  safety?: RoutineSafety;
};

export type RoutineSpecError = { path: string; message: string };

export type RoutineSpecResult =
  | { ok: true; spec: RoutineSpec }
  | { ok: false; errors: RoutineSpecError[] };

/** Body of `POST /api/routines` response. */
export type ProposeRoutineResult = {
  routine: RoutineSummary;
  /** Plain sentences for risks of level warning or high. */
  warnings: string[];
  /** Steps in the spec, nested ones included. */
  stepCount: number;
};
