/**
 * The routine engine: starts runs of approved routines, schedules interval ones, and keeps
 * the bookkeeping (run history, memory, notes, failure handling) honest.
 *
 * Boundaries (docs/routines.md):
 *  - Only `approved` routines run, and only with a `manual` or `interval` trigger. `schedule`
 *    and `event` triggers are not run in this phase; they are reported with a reason.
 *  - Starting, cancelling, clearing memory and the kill switch are methods on this class that
 *    only the shell reaches (via `HelmstackCore`). Nothing here is exposed to the HTTP API.
 *  - Time and timers are injected, so nothing here needs a real clock to be tested, and
 *    {@link RoutineEngine.dispose} leaves no timer behind.
 */
import { randomBytes } from "node:crypto";

import type {
  RoutineEngineStatus,
  RoutineMemory,
  RoutineNote,
  RoutineRunDetail,
  RoutineRunLogEntry,
  RoutineRunSummary,
  RoutineSpec,
  RoutineSummary
} from "../../../../shared/src/index.js";
import {
  MAX_RUN_LOG_LINES,
  newRunId,
  type RoutineDataStore,
  type RoutineStateData
} from "../stores/routine-data-store.js";
import { RoutineError, isValidRoutineId, type RoutineAction } from "../stores/routine-store.js";
import { ActionService, newActionRandom, type ActionServiceOptions } from "./action-service.js";
import { executeRoutine, type ExecutorResult, type RobotsFetcher, type RoutineBrowser } from "./executor.js";
import type { ModelResolver } from "./routine-model.js";
import {
  DEFAULT_PAUSE_AFTER,
  computeNextRun,
  mayStartNow,
  nextActiveTime,
  parseActiveHours,
  type IntervalTrigger
} from "./scheduler.js";

export const DEFAULT_TICK_MS = 15_000;
export const DEFAULT_FIRST_RUN_DELAY_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT = 2;
/** Progress updates are sent at most this often. */
const PROGRESS_EMIT_MS = 500;
/** Lines kept free at the end of a run's log for the closing lines. */
const LOG_RESERVE = 10;
const MAX_LOG_MESSAGE = 300;
const DAY_MS = 86_400_000;

export type EngineTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** What the engine needs from the routine store. */
export interface RoutineSource {
  list(): RoutineSummary[];
  get(id: string): RoutineSummary | undefined;
  spec(id: string): RoutineSpec | undefined;
  transition(id: string, action: RoutineAction): RoutineSummary;
}

export type RoutineEngineOptions = {
  routines: RoutineSource;
  data: RoutineDataStore;
  browser: RoutineBrowser;
  fetchRobots: RobotsFetcher;
  /** Which model answers judgments. Without one, a judgment ends a run asking for a model. */
  model?: ModelResolver;
  now?: () => number;
  timers?: EngineTimers;
  /** Sleep used for rate limiting and `wait` steps; resolves early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Uniform in [0, 1). Used for jitter. */
  random?: () => number;
  log?: (message: string) => void;
  tickMs?: number;
  firstRunDelayMs?: number;
  maxConcurrent?: number;
  defaultPageDelayMs?: number;
  navTimeoutMs?: number;
  maxRuntimeMs?: number;
};

type AbortReason = "cancelled" | "kill_switch" | "routine_changed" | "deleted" | "shutdown";

type Active = {
  detail: RoutineRunDetail;
  controller: AbortController;
  reason?: AbortReason;
  finished: boolean;
  lastEmitAt: number;
  promise: Promise<void>;
};

const defaultTimers: EngineTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const oneLine = (s: string, max = MAX_LOG_MESSAGE): string => s.replace(/\s+/g, " ").trim().slice(0, max);

export class RoutineEngine {
  private readonly routines: RoutineSource;
  private readonly data: RoutineDataStore;
  private readonly now: () => number;
  private readonly timers: EngineTimers;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private readonly active = new Map<string, Active>();
  private readonly listeners = new Set<(run: RoutineRunSummary) => void>();
  private readonly tickMs: number;
  private readonly firstRunDelayMs: number;
  private readonly maxConcurrent: number;
  private timer: unknown = null;
  private started = false;
  private disposed = false;
  private killed: boolean;
  /** Queued and finished actions, the human's grants, and carrying out an approved action. */
  readonly actions: ActionService;

  constructor(private readonly options: RoutineEngineOptions) {
    this.routines = options.routines;
    this.data = options.data;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => {});
    this.tickMs = Math.max(1, options.tickMs ?? DEFAULT_TICK_MS);
    this.firstRunDelayMs = options.firstRunDelayMs ?? DEFAULT_FIRST_RUN_DELAY_MS;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.killed = this.data.readEngine().killed;
    this.actions = new ActionService({
      data: this.data,
      routines: {
        get: (id) => this.routines.get(id),
        spec: (id) => this.routines.spec(id),
        list: () => this.routines.list(),
        transition: (id, action) => this.routines.transition(id, action)
      },
      browser: options.browser as ActionServiceOptions["browser"],
      now: this.now,
      sleep: options.sleep ?? realSleep,
      random: newActionRandom,
      isKilled: () => this.killed,
      log: this.log,
      ...(options.navTimeoutMs !== undefined ? { navTimeoutMs: options.navTimeoutMs } : {})
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** Begin scheduling. Runs left "running" by a previous process are marked failed. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const routine of this.routines.list()) {
      try {
        for (const run of this.data.failInterruptedRuns(routine.id, "Failed: the app closed while this run was in progress.")) this.emit(run);
        this.actions.recover(routine.id);
      } catch (err) {
        this.log(`[Routines] could not check earlier runs of ${routine.id}: ${(err as Error).message}`);
      }
    }
    this.schedule();
  }

  /** Stop scheduling, end running runs, leave no timer behind. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    for (const active of [...this.active.values()]) {
      active.reason = "shutdown";
      active.controller.abort();
      this.finish(active, { outcome: "cancelled", summary: "Cancelled: the app was closing.", pagesVisited: active.detail.pagesVisited, notes: [] }, null);
    }
    this.active.clear();
    this.listeners.clear();
    for (const routine of this.routines.list()) this.actions.cancelRoutine(routine.id, "The app was closing.");
  }

  /** Resolves when no run is in flight (used by tests and shutdown paths). */
  async whenIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    }
  }

  status(): RoutineEngineStatus {
    return { enabled: true, killed: this.killed, running: [...this.active.keys()] };
  }

  // ── human controls ─────────────────────────────────────────────────────

  /** Start a run now. Resolves with the run as it begins; it keeps running in the background. */
  runNow(id: string): RoutineRunSummary {
    return this.startRun(id, "manual");
  }

  cancel(id: string): void {
    this.abort(id, "cancelled");
  }

  setKillSwitch(on: boolean): RoutineEngineStatus {
    if (this.killed !== on) {
      this.killed = on;
      this.data.writeEngine({ version: 1, killed: on });
    }
    if (on) {
      for (const id of [...this.active.keys()]) this.abort(id, "kill_switch");
      this.actions.cancelAll("The kill switch was turned on, so everything waiting was dropped.");
    }
    return this.status();
  }

  clearMemory(id: string): void {
    this.mustExist(id);
    if (this.active.has(id)) throw new RoutineError("This routine is running. Cancel the run first, then clear its memory.", "bad_state");
    this.data.clearMemory(id);
  }

  // ── reads ──────────────────────────────────────────────────────────────

  listRuns(id: string): RoutineRunSummary[] {
    this.mustExist(id);
    const stored = this.data.listRuns(id);
    const live = this.active.get(id);
    // The in-memory copy of a running run is newer than its file.
    return live ? stored.map((r) => (r.id === live.detail.id ? summaryOf(live.detail) : r)) : stored;
  }

  getRun(id: string, runId: string): RoutineRunDetail | null {
    this.mustExist(id);
    const live = this.active.get(id);
    if (live && live.detail.id === runId) return { ...live.detail, log: [...live.detail.log] };
    return this.data.getRun(id, runId);
  }

  listNotes(id: string, limit?: number): RoutineNote[] {
    this.mustExist(id);
    return this.data.listNotes(id, limit ?? 100);
  }

  getMemory(id: string): RoutineMemory {
    const routine = this.mustExist(id);
    const state = this.data.readState(id);
    const memory: RoutineMemory = {
      routineId: id,
      sets: Object.fromEntries(Object.entries(state.sets).map(([k, v]) => [k, v.length])),
      values: { ...state.values }
    };
    const spec = this.routines.spec(id);
    const kind = spec?.trigger.kind;
    if (kind === "schedule" || kind === "event") {
      memory.notScheduledReason = `${kind === "schedule" ? "Schedule" : "Event"} triggers don't run yet. Only manual and interval routines run in this version.`;
    } else if (routine.state === "approved" && kind === "interval" && state.nextRunAt !== undefined) {
      memory.nextRunAt = state.nextRunAt;
    }
    const last = this.data.listRuns(id)[0];
    if (last) memory.lastRun = last;
    return memory;
  }

  onRunUpdated(listener: (run: RoutineRunSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── store events ───────────────────────────────────────────────────────

  /** Call when a routine's state changed (the store's "changed" event). */
  handleRoutineChanged(routine: RoutineSummary): void {
    if (this.disposed) return;
    if (routine.state !== "approved") {
      this.abort(routine.id, "routine_changed");
      this.clearSchedule(routine.id);
      this.actions.cancelRoutine(routine.id, `The routine was ${routine.state}, so what was waiting for you was dropped.`);
      return;
    }
    // Approved, or resumed by the human: start counting from now, with a clean failure record.
    try {
      const state = this.copyState(routine.id);
      state.consecutiveFailures = 0;
      delete state.nextRunAt;
      state.activeSince ??= this.now();
      this.data.writeState(routine.id, state);
    } catch (err) {
      this.log(`[Routines] could not prepare ${routine.id}: ${(err as Error).message}`);
    }
  }

  /** Call when a routine was deleted: ends its run and removes what it remembered. */
  handleRoutineDeleted(routine: RoutineSummary): void {
    this.abort(routine.id, "deleted");
    this.actions.cancelRoutine(routine.id, "The routine was deleted.");
    try {
      this.data.remove(routine.id);
    } catch (err) {
      this.log(`[Routines] could not remove data of ${routine.id}: ${(err as Error).message}`);
    }
  }

  // ── scheduling ─────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.disposed || !this.started) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      try {
        this.tick();
      } catch (err) {
        this.log(`[Routines] scheduler error: ${(err as Error).message}`);
      }
      this.schedule();
    }, this.tickMs);
  }

  /** One scheduler pass. Public so tests can drive it without a clock. */
  tick(): void {
    if (this.disposed) return;
    const now = this.now();
    for (const routine of this.routines.list()) {
      if (routine.state !== "approved") continue;
      const spec = this.routines.spec(routine.id);
      if (!spec) continue;
      try {
        this.tickRoutine(routine, spec, now);
      } catch (err) {
        this.log(`[Routines] ${routine.id}: ${(err as Error).message}`);
      }
    }
  }

  private tickRoutine(routine: RoutineSummary, spec: RoutineSpec, now: number): void {
    const state = this.copyState(routine.id);
    let dirty = false;
    if (state.activeSince === undefined) {
      state.activeSince = now;
      dirty = true;
    }
    const running = this.active.has(routine.id);
    const stopReason = running ? null : this.stopReason(routine.id, spec, state, now);
    if (stopReason) {
      this.log(`[Routines] ${routine.id} stopped: ${stopReason}`);
      this.routines.transition(routine.id, "stop");
      return;
    }
    if (spec.trigger.kind !== "interval") {
      if (dirty) this.data.writeState(routine.id, state);
      return;
    }
    const trigger = spec.trigger;
    if (state.nextRunAt === undefined) {
      state.nextRunAt = this.nextRun(spec, trigger, state, now);
      dirty = true;
    }
    if (dirty) this.data.writeState(routine.id, state);
    if (this.killed || running || state.nextRunAt > now || this.active.size >= this.maxConcurrent) return;
    if (!mayStartNow(now, trigger)) {
      state.nextRunAt = nextActiveTime(now, parseActiveHours(trigger.active_hours));
      this.data.writeState(routine.id, state);
      return;
    }
    this.startRun(routine.id, "interval");
  }

  private clearSchedule(id: string): void {
    try {
      const state = this.copyState(id);
      if (state.nextRunAt !== undefined) {
        delete state.nextRunAt;
        this.data.writeState(id, state);
      }
    } catch {
      /* the routine may be gone */
    }
  }

  private nextRun(spec: RoutineSpec, trigger: IntervalTrigger, state: RoutineStateData, now: number): number {
    return computeNextRun({
      now,
      trigger,
      ...(state.lastStartedAt !== undefined ? { lastStartedAt: state.lastStartedAt } : {}),
      activeSince: state.activeSince ?? now,
      consecutiveFailures: state.consecutiveFailures,
      ...(spec.on_failure ? { backoff: spec.on_failure.backoff } : {}),
      firstRunDelayMs: this.firstRunDelayMs,
      random: this.random
    });
  }

  /** The reason a deterministic stop condition has fired, or null. */
  private stopReason(id: string, spec: RoutineSpec, state: RoutineStateData, now: number): string | null {
    for (const cond of spec.stop?.any ?? []) {
      if ("after_runs" in cond && state.runCount >= cond.after_runs) return `after ${cond.after_runs} runs`;
      if ("after_days" in cond && state.activeSince !== undefined && now - state.activeSince >= cond.after_days * DAY_MS) return `after ${cond.after_days} days`;
      if ("when_count" in cond) {
        const { key, at_least } = cond.when_count;
        const count = key === "notes" ? this.data.noteCount(id) : (state.sets[key]?.length ?? state.logs[key]?.length ?? 0);
        if (count >= at_least) return `${key} reached ${at_least}`;
      }
      // when_inferred needs a model: the executor judges it at the end of a run (see `ExecutorResult.stopReason`).
    }
    return null;
  }

  // ── running ────────────────────────────────────────────────────────────

  private startRun(id: string, trigger: "manual" | "interval"): RoutineRunSummary {
    if (this.disposed) throw new RoutineError("The routine engine is shut down.", "bad_state");
    if (!isValidRoutineId(id)) throw new RoutineError("invalid routine id", "invalid_id");
    const routine = this.routines.get(id);
    if (!routine) throw new RoutineError("That routine no longer exists.", "not_found");
    if (routine.state !== "approved") throw new RoutineError(`A routine runs only while it is approved; this one is ${routine.state}.`, "bad_state");
    if (this.killed) throw new RoutineError("The routine kill switch is on. Turn it off to run routines.", "bad_state");
    const spec = this.routines.spec(id);
    if (!spec) throw new RoutineError("That routine no longer exists.", "not_found");
    if (spec.trigger.kind !== "manual" && spec.trigger.kind !== "interval") {
      throw new RoutineError(`${spec.trigger.kind === "schedule" ? "Schedule" : "Event"} triggers don't run yet. Only manual and interval routines run in this version.`, "bad_state");
    }
    if (this.active.has(id)) throw new RoutineError("This routine is already running.", "bad_state");
    if (this.active.size >= this.maxConcurrent) {
      throw new RoutineError(`${this.maxConcurrent} routines are already running. Try again when one finishes.`, "limit");
    }

    const startedAt = this.now();
    const detail: RoutineRunDetail = {
      id: newRunId(startedAt, () => randomBytes(4).toString("hex")),
      routineId: id,
      trigger,
      startedAt,
      status: "running",
      pagesVisited: 0,
      notesAdded: 0,
      summary: "Running.",
      log: []
    };
    const state = this.copyState(id);
    state.activeSince ??= startedAt;
    const controller = new AbortController();
    const active: Active = { detail, controller, finished: false, lastEmitAt: startedAt, promise: Promise.resolve() };
    this.active.set(id, active);
    try {
      this.data.saveRun(detail);
    } catch (err) {
      this.active.delete(id);
      throw new RoutineError(`Could not record the run: ${(err as Error).message}`, "bad_state");
    }

    const result = Promise.resolve().then(() =>
      executeRoutine(
        {
          browser: this.options.browser,
          fetchRobots: this.options.fetchRobots,
          now: this.now,
          sleep: this.options.sleep ?? realSleep,
          random: () => randomBytes(3).toString("hex"),
          ...(this.options.model ? { resolveModel: () => this.options.model!.resolve() } : {}),
          acts: this.actions.gateFor(id),
          ...(this.options.defaultPageDelayMs !== undefined ? { defaultPageDelayMs: this.options.defaultPageDelayMs } : {}),
          ...(this.options.navTimeoutMs !== undefined ? { navTimeoutMs: this.options.navTimeoutMs } : {}),
          ...(this.options.maxRuntimeMs !== undefined ? { maxRuntimeMs: this.options.maxRuntimeMs } : {})
        },
        {
          routineId: id,
          runId: detail.id,
          spec,
          state,
          signal: controller.signal,
          recentNotes: this.recentNotes(id),
          log: (level, message, step) => this.addLog(active, level, message, step),
          onProgress: (counts) => {
            active.detail.pagesVisited = counts.pages;
            active.detail.notesAdded = counts.notes;
            this.progress(active);
          }
        }
      )
    );
    active.promise = result.then(
      (res) => this.finish(active, res, state),
      (err) =>
        this.finish(active, { outcome: "failed", summary: "Failed: a step did not work.", pagesVisited: active.detail.pagesVisited, notes: [] }, state, oneLine(String(err instanceof Error ? err.message : err), 200))
    );
    this.emit(summaryOf(detail));
    return summaryOf(detail);
  }

  private abort(id: string, reason: AbortReason): void {
    const active = this.active.get(id);
    if (!active || active.finished) return;
    active.reason ??= reason;
    active.controller.abort();
  }

  private addLog(active: Active, level: RoutineRunLogEntry["level"], message: string, step?: string, force = false): void {
    const log = active.detail.log;
    const room = force ? MAX_RUN_LOG_LINES : MAX_RUN_LOG_LINES - LOG_RESERVE;
    if (log.length >= room) {
      if (!force && log.length === MAX_RUN_LOG_LINES - LOG_RESERVE) log.push({ at: this.now(), level: "warn", message: "Log truncated: further lines were dropped." });
      return;
    }
    log.push({ at: this.now(), level, ...(step ? { step } : {}), message: oneLine(message) });
  }

  private progress(active: Active): void {
    const now = this.now();
    if (now - active.lastEmitAt < PROGRESS_EMIT_MS) return;
    active.lastEmitAt = now;
    this.emit(summaryOf(active.detail));
  }

  /**
   * Close out a run: record its outcome, update memory and scheduling, apply auto-pause and
   * stop conditions, then tell listeners. Safe to call twice for the same run.
   */
  private finish(active: Active, result: ExecutorResult, work: RoutineStateData | null, extraLog?: string): void {
    if (active.finished) return;
    active.finished = true;
    const detail = active.detail;
    const id = detail.routineId;
    const endedAt = this.now();
    const exists = this.routines.get(id) !== undefined;
    const outcome = result.outcome;
    let summary = result.summary;
    if (outcome === "cancelled") {
      summary =
        active.reason === "kill_switch"
          ? "Stopped by the kill switch."
          : active.reason === "routine_changed"
            ? "Cancelled because the routine was paused, stopped or replaced."
            : active.reason === "deleted"
              ? "Cancelled because the routine was deleted."
              : active.reason === "shutdown"
                ? result.summary
                : active.reason === "cancelled"
                  ? "Cancelled by you."
                  : result.summary;
    }
    if (extraLog) this.addLog(active, "error", extraLog, undefined, true);
    // The closing line always fits: ordinary lines leave room for it.
    this.addLog(active, outcome === "failed" ? "error" : "info", summary, undefined, true);
    detail.pagesVisited = result.pagesVisited;
    detail.notesAdded = result.notes.length;

    let toTransition: { action: RoutineAction; why: string } | null = null;
    if (exists) {
      try {
        const state = work ?? this.copyState(id);
        this.data.appendNotes(id, result.notes);
        if (outcome !== "cancelled") {
          state.runCount += 1;
          state.lastStartedAt = detail.startedAt;
          state.lastEndedAt = endedAt;
        }
        if (outcome === "failed") state.consecutiveFailures += 1;
        else if (outcome !== "cancelled") state.consecutiveFailures = 0;
        const spec = this.routines.spec(id);
        const current = this.routines.get(id);
        if (spec && current && current.state === "approved" && outcome !== "cancelled") {
          const pauseAfter = spec.on_failure?.pause_after ?? DEFAULT_PAUSE_AFTER;
          const stop = this.stopReason(id, spec, state, endedAt) ?? result.stopReason ?? null;
          if (stop) {
            toTransition = { action: "stop", why: `Stop condition met (${stop}); the routine was stopped.` };
          } else if (outcome === "failed" && result.pauseNow) {
            toTransition = { action: "pause", why: "Paused at once: an action did not do what it should. Check the site and the run log before resuming." };
          } else if (outcome === "failed" && state.consecutiveFailures >= pauseAfter) {
            toTransition = { action: "pause", why: `Paused automatically after ${state.consecutiveFailures} failed runs in a row.` };
          } else if (outcome === "needs_human" && detail.trigger === "interval" && !result.waitingOnActions) {
            toTransition = { action: "pause", why: "Paused: this routine needs a person to decide something, so it will not keep retrying on its own." };
          }
        }
        if (toTransition) {
          this.addLog(active, toTransition.action === "pause" && outcome === "failed" ? "error" : "warn", toTransition.why, undefined, true);
          delete state.nextRunAt;
        } else if (spec?.trigger.kind === "interval" && current?.state === "approved") {
          state.nextRunAt = this.nextRun(spec, spec.trigger, state, endedAt);
        } else {
          delete state.nextRunAt;
        }
        this.data.writeState(id, state);
      } catch (err) {
        this.log(`[Routines] could not save the result of a run of ${id}: ${(err as Error).message}`);
      }
    }

    detail.status = outcome;
    detail.endedAt = endedAt;
    detail.summary = summary;
    if (exists) {
      try {
        this.data.saveRun(detail);
      } catch (err) {
        this.log(`[Routines] could not save run ${detail.id}: ${(err as Error).message}`);
      }
    }
    if (this.active.get(id) === active) this.active.delete(id);
    if (toTransition && !this.disposed) {
      try {
        this.routines.transition(id, toTransition.action);
      } catch (err) {
        this.log(`[Routines] could not ${toTransition.action} ${id}: ${(err as Error).message}`);
      }
    }
    this.emit(summaryOf(detail));
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private emit(run: RoutineRunSummary): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(run);
      } catch {
        /* a listener must not break a run */
      }
    }
  }

  private recentNotes(id: string): RoutineNote[] {
    try {
      return this.data.listNotes(id, 30);
    } catch {
      return [];
    }
  }

  private mustExist(id: string): RoutineSummary {
    if (!isValidRoutineId(id)) throw new RoutineError("invalid routine id", "invalid_id");
    const routine = this.routines.get(id);
    if (!routine) throw new RoutineError("That routine no longer exists.", "not_found");
    return routine;
  }

  private copyState(id: string): RoutineStateData {
    return structuredClone(this.data.readState(id));
  }
}

function summaryOf(run: RoutineRunDetail): RoutineRunSummary {
  const { log: _log, ...summary } = run;
  return summary;
}
