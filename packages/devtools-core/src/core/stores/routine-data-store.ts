/**
 * Disk store for what a routine remembers and records: `<dataDir>/routines/<id>/`.
 *
 *   state.json        sets / logs / values declared by the spec, plus scheduling counters
 *   notes.json        notes the routine recorded (newest {@link MAX_NOTES} kept)
 *   runs/<runId>.json one file per run (newest {@link MAX_RUNS} kept, log capped)
 *
 * - Every write is temp file + rename, files are owner-only (0o600, directories 0o700).
 * - Ids are validated before they reach a path; run ids must match {@link RUN_ID_PATTERN}.
 * - A corrupt file is treated as empty (and set aside) rather than blocking the routine.
 * - Everything stored here is text the page supplied. Nothing reads it back as instructions.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { RoutineEffect, RoutineGrants, RoutineNote, RoutineRunDetail, RoutineRunSummary } from "../../../../shared/src/index.js";
import { ACT_COUNTER_EFFECTS, localDay, MAX_ACTIONS_STORED, type StoredAction } from "../routines/act.js";
import { emptyGrants, parseGrants } from "../routines/grants.js";
import { isValidRoutineId } from "./routine-store.js";

export const MAX_NOTES = 1000;
export const MAX_RUNS = 50;
export const MAX_RUN_LOG_LINES = 200;
export const MAX_SET_ITEMS = 5000;
export const MAX_LOG_ITEMS = 500;
export const MAX_VALUE_CHARS = 2000;
export const RUN_ID_PATTERN = /^run-[a-z0-9]{6,12}-[0-9a-f]{8}$/;

/** What a routine remembers between runs, plus its scheduling counters. */
export type RoutineStateData = {
  version: 1;
  sets: Record<string, string[]>;
  logs: Record<string, string[]>;
  values: Record<string, string>;
  /** When the engine first saw the routine approved (basis of `after_days`). */
  activeSince?: number;
  runCount: number;
  lastStartedAt?: number;
  lastEndedAt?: number;
  consecutiveFailures: number;
  nextRunAt?: number;
};

export type EngineData = { version: 1; killed: boolean };

export function emptyState(): RoutineStateData {
  return { version: 1, sets: {}, logs: {}, values: {}, runCount: 0, consecutiveFailures: 0 };
}

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && RUN_ID_PATTERN.test(id);
}

export function newRunId(at: number, random: () => string = () => randomBytes(4).toString("hex")): string {
  return `run-${Math.max(0, Math.floor(at)).toString(36).padStart(6, "0")}-${random()}`;
}

export type RoutineDataStoreOptions = { log?: (message: string) => void; now?: () => number };

export class RoutineDataStore {
  readonly root: string;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly states = new Map<string, RoutineStateData>();

  constructor(dataDir: string, options: RoutineDataStoreOptions = {}) {
    this.root = path.join(dataDir, "routines");
    this.log = options.log ?? ((m) => console.log(m));
    this.now = options.now ?? Date.now;
  }

  // ── engine flags ────────────────────────────────────────────────────────

  readEngine(): EngineData {
    const raw = this.readJson<Partial<EngineData>>(path.join(this.root, "engine.json"));
    return { version: 1, killed: raw?.killed === true };
  }

  writeEngine(data: EngineData): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.writeAtomic(path.join(this.root, "engine.json"), JSON.stringify(data));
  }

  // ── state ───────────────────────────────────────────────────────────────

  readState(id: string): RoutineStateData {
    const cached = this.states.get(this.checkId(id));
    if (cached) return cached;
    const raw = this.readJson<Partial<RoutineStateData>>(this.fileOf(id, "state.json"));
    const state = emptyState();
    if (raw && raw.version === 1) {
      for (const [k, v] of Object.entries(raw.sets ?? {})) if (Array.isArray(v)) state.sets[k] = v.filter((x) => typeof x === "string").slice(-MAX_SET_ITEMS);
      for (const [k, v] of Object.entries(raw.logs ?? {})) if (Array.isArray(v)) state.logs[k] = v.filter((x) => typeof x === "string").slice(-MAX_LOG_ITEMS);
      for (const [k, v] of Object.entries(raw.values ?? {})) if (typeof v === "string") state.values[k] = v.slice(0, MAX_VALUE_CHARS);
      const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      state.runCount = Math.max(0, Math.floor(num(raw.runCount) ?? 0));
      state.consecutiveFailures = Math.max(0, Math.floor(num(raw.consecutiveFailures) ?? 0));
      const a = num(raw.activeSince);
      const b = num(raw.lastStartedAt);
      const c = num(raw.lastEndedAt);
      const d = num(raw.nextRunAt);
      if (a !== undefined) state.activeSince = a;
      if (b !== undefined) state.lastStartedAt = b;
      if (c !== undefined) state.lastEndedAt = c;
      if (d !== undefined) state.nextRunAt = d;
    }
    this.states.set(id, state);
    return state;
  }

  /** Persist `state` (caps applied) and make it the cached copy. */
  writeState(id: string, state: RoutineStateData): void {
    this.checkId(id);
    for (const k of Object.keys(state.sets)) state.sets[k] = (state.sets[k] ?? []).slice(-MAX_SET_ITEMS);
    for (const k of Object.keys(state.logs)) state.logs[k] = (state.logs[k] ?? []).slice(-MAX_LOG_ITEMS);
    this.ensureDir(id);
    this.writeAtomic(this.fileOf(id, "state.json"), JSON.stringify(state));
    this.states.set(id, state);
  }

  /** Forget what the routine has seen. Counters, notes and run history stay. */
  clearMemory(id: string): void {
    const state = this.readState(id);
    state.sets = {};
    state.logs = {};
    state.values = {};
    this.writeState(id, state);
  }

  // ── notes ───────────────────────────────────────────────────────────────

  appendNotes(id: string, notes: RoutineNote[]): void {
    if (notes.length === 0) return;
    const all = [...this.readNotesFile(id), ...notes].slice(-MAX_NOTES);
    this.ensureDir(id);
    this.writeAtomic(this.fileOf(id, "notes.json"), JSON.stringify({ version: 1, notes: all }));
  }

  /** Newest first. */
  listNotes(id: string, limit = MAX_NOTES): RoutineNote[] {
    const n = Math.max(1, Math.min(MAX_NOTES, Math.floor(limit)));
    return this.readNotesFile(id).slice(-n).reverse();
  }

  noteCount(id: string): number {
    return this.readNotesFile(id).length;
  }

  private readNotesFile(id: string): RoutineNote[] {
    const raw = this.readJson<{ version?: number; notes?: unknown }>(this.fileOf(id, "notes.json"));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.notes)) return [];
    return raw.notes.filter(isNote);
  }

  // ── runs ────────────────────────────────────────────────────────────────

  saveRun(run: RoutineRunDetail): void {
    if (!isValidRunId(run.id)) throw new Error("invalid run id");
    const dir = this.runsDir(run.routineId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const trimmed: RoutineRunDetail = { ...run, log: run.log.slice(0, MAX_RUN_LOG_LINES) };
    this.writeAtomic(path.join(dir, `${run.id}.json`), JSON.stringify(trimmed));
    this.pruneRuns(run.routineId);
  }

  /** Newest first. */
  listRuns(id: string): RoutineRunSummary[] {
    return this.readRuns(id).map(summaryOf);
  }

  getRun(id: string, runId: string): RoutineRunDetail | null {
    if (!isValidRunId(runId)) return null;
    const run = this.readJson<RoutineRunDetail>(path.join(this.runsDir(id), `${runId}.json`));
    return run && isRun(run, id) ? run : null;
  }

  private readRuns(id: string): RoutineRunDetail[] {
    const dir = this.runsDir(id);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const runs: RoutineRunDetail[] = [];
    for (const name of names) {
      const m = /^(run-[a-z0-9]{6,12}-[0-9a-f]{8})\.json$/.exec(name);
      if (!m) {
        if (name.endsWith(".tmp")) rmSync(path.join(dir, name), { force: true });
        continue;
      }
      const run = this.readJson<RoutineRunDetail>(path.join(dir, name));
      if (run && isRun(run, id) && run.id === m[1]) runs.push(run);
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
  }

  private pruneRuns(id: string): void {
    const runs = this.readRuns(id);
    for (const old of runs.slice(MAX_RUNS)) rmSync(path.join(this.runsDir(id), `${old.id}.json`), { force: true });
  }

  /**
   * A run still marked `running` after a restart can never finish: mark it failed so the
   * history is honest. Returns the runs it changed.
   */
  failInterruptedRuns(id: string, message: string): RoutineRunSummary[] {
    const changed: RoutineRunSummary[] = [];
    for (const run of this.readRuns(id)) {
      if (run.status !== "running") continue;
      const fixed: RoutineRunDetail = {
        ...run,
        status: "failed",
        endedAt: this.now(),
        summary: message,
        log: [...run.log, { at: this.now(), level: "error" as const, message }].slice(0, MAX_RUN_LOG_LINES)
      };
      this.writeAtomic(path.join(this.runsDir(id), `${run.id}.json`), JSON.stringify(fixed));
      changed.push(summaryOf(fixed));
    }
    return changed;
  }

  // ── grants (what the human lets the routine do unasked) ──────────────────

  /** Read from disk every time: a change by the human must apply to the very next action. No grants file = nothing granted. */
  readGrants(id: string): RoutineGrants {
    const raw = this.readJson<{ version?: number; grants?: unknown }>(this.fileOf(id, "grants.json"));
    if (!raw || raw.version !== 1) return emptyGrants();
    const parsed = parseGrants(raw.grants);
    return parsed.ok ? parsed.grants : emptyGrants();
  }

  /** `grants` must already have passed {@link parseGrants}; it is parsed again so nothing unchecked is ever stored. */
  writeGrants(id: string, grants: RoutineGrants): RoutineGrants {
    const parsed = parseGrants(grants);
    if (!parsed.ok) throw new Error(parsed.error);
    this.ensureDir(id);
    this.writeAtomic(this.fileOf(id, "grants.json"), JSON.stringify({ version: 1, grants: parsed.grants }));
    return parsed.grants;
  }

  // ── actions (pending and finished; newest kept) ───────────────────────────

  /** Newest first. */
  readActions(id: string): StoredAction[] {
    const raw = this.readJson<{ version?: number; actions?: unknown }>(this.fileOf(id, "actions.json"));
    if (!raw || raw.version !== 1 || !Array.isArray(raw.actions)) return [];
    return raw.actions.filter((a): a is StoredAction => isAction(a, id)).slice(0, MAX_ACTIONS_STORED);
  }

  writeActions(id: string, actions: StoredAction[]): void {
    this.ensureDir(id);
    this.writeAtomic(this.fileOf(id, "actions.json"), JSON.stringify({ version: 1, actions: actions.slice(0, MAX_ACTIONS_STORED) }));
  }

  /**
   * Count one automatic attempt of `effect` against today's limit (calendar day, local time).
   * Returns false, changing nothing, when `limit` attempts were already made today. Persisted, so a
   * restart does not give the routine a fresh allowance.
   */
  reserveDaily(id: string, effect: RoutineEffect, limit: number, now: number): boolean {
    if (!ACT_COUNTER_EFFECTS.includes(effect)) return false;
    const day = localDay(now);
    const raw = this.readJson<{ version?: number; day?: unknown; counts?: unknown }>(this.fileOf(id, "action-counters.json"));
    const counts: Record<string, number> = {};
    if (raw && raw.version === 1 && raw.day === day && typeof raw.counts === "object" && raw.counts !== null) {
      for (const [k, v] of Object.entries(raw.counts)) if (typeof v === "number" && Number.isFinite(v) && v >= 0) counts[k] = Math.floor(v);
    }
    if ((counts[effect] ?? 0) >= limit) return false;
    counts[effect] = (counts[effect] ?? 0) + 1;
    this.ensureDir(id);
    this.writeAtomic(this.fileOf(id, "action-counters.json"), JSON.stringify({ version: 1, day, counts }));
    return true;
  }

  // ── removal ─────────────────────────────────────────────────────────────

  remove(id: string): void {
    this.states.delete(this.checkId(id));
    rmSync(path.join(this.root, id), { recursive: true, force: true });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private checkId(id: string): string {
    if (!isValidRoutineId(id)) throw new Error("invalid routine id");
    return id;
  }

  private dirOf(id: string): string {
    return path.join(this.root, this.checkId(id));
  }

  private runsDir(id: string): string {
    return path.join(this.dirOf(id), "runs");
  }

  private fileOf(id: string, name: string): string {
    return path.join(this.dirOf(id), name);
  }

  private ensureDir(id: string): void {
    mkdirSync(this.dirOf(id), { recursive: true, mode: 0o700 });
  }

  private readJson<T>(file: string): T | null {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      const target = `${file}.corrupt-${this.now()}`;
      try {
        renameSync(file, target);
        this.log(`[Routines] ${path.basename(file)} was unreadable; moved aside as ${path.basename(target)}`);
      } catch {
        /* leave it */
      }
      return null;
    }
  }

  private writeAtomic(finalPath: string, data: string): void {
    const tmp = `${finalPath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, finalPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}

function summaryOf(run: RoutineRunDetail): RoutineRunSummary {
  const { log: _log, ...summary } = run;
  return summary;
}

function isNote(v: unknown): v is RoutineNote {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Partial<RoutineNote>;
  return typeof n.id === "string" && typeof n.at === "number" && typeof n.url === "string" && typeof n.fields === "object" && n.fields !== null;
}

function isAction(v: unknown, routineId: string): v is StoredAction {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Partial<StoredAction>;
  return (
    typeof a.id === "string" &&
    a.routineId === routineId &&
    typeof a.runId === "string" &&
    typeof a.createdAt === "number" &&
    typeof a.expiresAt === "number" &&
    typeof a.effect === "string" &&
    typeof a.action === "string" &&
    typeof a.description === "string" &&
    typeof a.host === "string" &&
    typeof a.url === "string" &&
    typeof a.status === "string"
  );
}

function isRun(v: unknown, routineId: string): v is RoutineRunDetail {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<RoutineRunDetail>;
  return (
    isValidRunId(r.id) &&
    r.routineId === routineId &&
    typeof r.startedAt === "number" &&
    typeof r.status === "string" &&
    typeof r.summary === "string" &&
    Array.isArray(r.log)
  );
}
