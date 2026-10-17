/**
 * Disk store for routines: `<dataDir>/routines/<id>.json` plus a small `index.json`.
 *
 * - Every write is temp file + rename, so a crash never leaves a half file.
 * - The per-routine files are authoritative; `index.json` is a convenience copy that is
 *   rebuilt on load. A corrupt file or index is renamed aside (`*.corrupt-<time>`) and the
 *   rest still load.
 * - Files are addressed only by id, and the id must match {@link ROUTINE_ID_PATTERN}.
 * - State changes follow the machine in `shared/routine.ts`; illegal ones throw
 *   {@link RoutineStateError}. Nothing here executes a routine.
 * - The store never deletes routines to make room: past {@link DEFAULT_MAX_ROUTINES} it refuses
 *   a new proposal and the human has to delete one.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  RoutineDetail,
  RoutinePreview,
  RoutineSpec,
  RoutineState,
  RoutineSummary
} from "../../../../shared/src/index.js";
import { scopeHosts } from "../routines/scope.js";

/** `rt-YYYYMMDD-HHMMSS-<8 hex>`: filesystem-safe, sorts by creation time. */
export const ROUTINE_ID_PATTERN = /^rt-\d{8}-\d{6}-[0-9a-f]{8}$/;
export const DEFAULT_MAX_ROUTINES = 50;

const STATES: readonly RoutineState[] = ["proposed", "approved", "paused", "stopped", "rejected"];

export class RoutineError extends Error {
  constructor(message: string, readonly code: "invalid_id" | "not_found" | "bad_state" | "limit" | "forbidden") {
    super(message);
    this.name = "RoutineError";
  }
}
export class RoutineStateError extends RoutineError {
  constructor(message: string) {
    super(message, "bad_state");
    this.name = "RoutineStateError";
  }
}

export type RoutineAction = "approve" | "reject" | "pause" | "resume" | "stop" | "withdraw";

/** Legal moves: action -> from-states -> new state. */
const TRANSITIONS: Record<RoutineAction, { from: readonly RoutineState[]; to: RoutineState }> = {
  approve: { from: ["proposed"], to: "approved" },
  reject: { from: ["proposed"], to: "rejected" },
  withdraw: { from: ["proposed"], to: "rejected" },
  pause: { from: ["approved"], to: "paused" },
  resume: { from: ["paused"], to: "approved" },
  stop: { from: ["approved", "paused"], to: "stopped" }
};

export type RoutineStoreEvent = { type: "proposed" | "changed" | "deleted"; routine: RoutineSummary };

export type RoutineStoreOptions = {
  maxRoutines?: number;
  log?: (message: string) => void;
  now?: () => number;
  random?: () => string;
};

type StoredFile = { version: 1; summary: RoutineSummary; spec: RoutineSpec };
type PersistedIndex = { version: 1; routines: RoutineSummary[] };

export function isValidRoutineId(id: unknown): id is string {
  return typeof id === "string" && ROUTINE_ID_PATTERN.test(id);
}

export function newRoutineId(at: number, random: () => string = () => randomBytes(4).toString("hex")): string {
  const d = new Date(Number.isFinite(at) ? at : 0);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `rt-${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${random()}`
  );
}

export class RoutineStore {
  readonly dir: string;
  private readonly indexPath: string;
  private readonly maxRoutines: number;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly files = new Map<string, StoredFile>();
  private readonly listeners = new Set<(event: RoutineStoreEvent) => void>();

  constructor(dataDir: string, options: RoutineStoreOptions = {}) {
    this.dir = path.join(dataDir, "routines");
    this.indexPath = path.join(this.dir, "index.json");
    this.maxRoutines = Math.max(1, options.maxRoutines ?? DEFAULT_MAX_ROUTINES);
    this.log = options.log ?? ((m) => console.log(m));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(4).toString("hex"));
    this.load();
  }

  onEvent(listener: (event: RoutineStoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Newest first. */
  list(): RoutineSummary[] {
    return [...this.files.values()]
      .map((f) => f.summary)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .map(copySummary);
  }

  get(id: string): RoutineSummary | undefined {
    const f = isValidRoutineId(id) ? this.files.get(id) : undefined;
    return f ? copySummary(f.summary) : undefined;
  }

  detail(id: string): RoutineDetail | undefined {
    const f = isValidRoutineId(id) ? this.files.get(id) : undefined;
    return f ? { ...copySummary(f.summary), specJson: JSON.stringify(f.spec, null, 2) } : undefined;
  }

  /** The stored spec, for the engine in a later phase. */
  spec(id: string): RoutineSpec | undefined {
    const f = isValidRoutineId(id) ? this.files.get(id) : undefined;
    return f ? (JSON.parse(JSON.stringify(f.spec)) as RoutineSpec) : undefined;
  }

  get size(): number {
    return this.files.size;
  }

  /** Store a validated spec as `proposed`. Throws `RoutineError` (limit, unknown `replaces`). */
  propose(input: { spec: RoutineSpec; preview: RoutinePreview; trigger: string; proposedBy?: string; replaces?: string }): RoutineSummary {
    if (this.files.size >= this.maxRoutines) {
      throw new RoutineError(
        `There are already ${this.maxRoutines} routines stored. Ask the user to delete some in the HelmStack window (Routines) before proposing another.`,
        "limit"
      );
    }
    if (input.replaces !== undefined) {
      if (!isValidRoutineId(input.replaces)) throw new RoutineError("replaces is not a valid routine id", "invalid_id");
      if (!this.files.has(input.replaces)) throw new RoutineError(`replaces: no routine ${input.replaces}`, "not_found");
    }
    const at = this.now();
    let id = newRoutineId(at, this.random);
    while (this.files.has(id)) id = newRoutineId(at, this.random);
    const summary: RoutineSummary = {
      id,
      title: input.spec.title,
      intent: input.spec.intent,
      state: "proposed",
      createdAt: at,
      updatedAt: at,
      ...(input.proposedBy ? { proposedBy: input.proposedBy } : {}),
      ...(input.replaces ? { replaces: input.replaces } : {}),
      trigger: input.trigger,
      hosts: scopeHosts(input.spec.scope),
      preview: input.preview,
      specVersion: input.spec.version
    };
    const file: StoredFile = { version: 1, summary, spec: input.spec };
    mkdirSync(this.dir, { recursive: true });
    this.writeAtomic(this.fileOf(id), JSON.stringify(file));
    this.files.set(id, file);
    this.persistIndex();
    this.emit({ type: "proposed", routine: copySummary(summary) });
    return copySummary(summary);
  }

  /**
   * Apply a human (or, for `withdraw`, agent) transition. Approving a routine that replaces
   * another ends the old one: approved/paused becomes stopped, a still-proposed one becomes rejected.
   */
  transition(id: string, action: RoutineAction): RoutineSummary {
    const file = this.mustGet(id);
    const rule = TRANSITIONS[action];
    if (!rule.from.includes(file.summary.state)) {
      throw new RoutineStateError(
        `Can't ${action} a routine that is ${file.summary.state}. ${action} needs it to be ${rule.from.join(" or ")}.`
      );
    }
    const changed: RoutineSummary[] = [];
    changed.push(this.setState(file, rule.to));
    if (action === "approve" && file.summary.replaces) {
      const old = this.files.get(file.summary.replaces);
      if (old && (old.summary.state === "approved" || old.summary.state === "paused")) changed.push(this.setState(old, "stopped"));
      else if (old && old.summary.state === "proposed") changed.push(this.setState(old, "rejected"));
    }
    this.persistIndex();
    for (const routine of changed) this.emit({ type: "changed", routine: copySummary(routine) });
    return copySummary(file.summary);
  }

  /** Remove a routine of any state. Returns whether it existed. */
  delete(id: string): boolean {
    if (!isValidRoutineId(id)) throw new RoutineError("invalid routine id", "invalid_id");
    const file = this.files.get(id);
    if (!file) return false;
    this.files.delete(id);
    rmSync(this.fileOf(id), { force: true });
    this.persistIndex();
    this.emit({ type: "deleted", routine: copySummary(file.summary) });
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private mustGet(id: string): StoredFile {
    if (!isValidRoutineId(id)) throw new RoutineError("invalid routine id", "invalid_id");
    const file = this.files.get(id);
    if (!file) throw new RoutineError("That routine no longer exists.", "not_found");
    return file;
  }

  private setState(file: StoredFile, state: RoutineState): RoutineSummary {
    file.summary = { ...file.summary, state, updatedAt: Math.max(this.now(), file.summary.updatedAt) };
    this.writeAtomic(this.fileOf(file.summary.id), JSON.stringify(file));
    return file.summary;
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private emit(event: RoutineStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a listener must not break routine handling */
      }
    }
  }

  private writeAtomic(finalPath: string, data: string): void {
    const tmp = `${finalPath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, data, "utf8");
      renameSync(tmp, finalPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  private persistIndex(): void {
    const state: PersistedIndex = { version: 1, routines: this.list() };
    this.writeAtomic(this.indexPath, JSON.stringify(state));
  }

  private quarantine(file: string, why: string): void {
    const target = `${file}.corrupt-${this.now()}`;
    try {
      renameSync(file, target);
      this.log(`[Routines] ${why}; moved ${path.basename(file)} aside as ${path.basename(target)}`);
    } catch {
      this.log(`[Routines] ${why}; could not move ${path.basename(file)} aside`);
    }
  }

  private load(): void {
    mkdirSync(this.dir, { recursive: true });
    for (const name of readdirSync(this.dir)) {
      const full = path.join(this.dir, name);
      if (name.endsWith(".tmp")) {
        rmSync(full, { force: true });
        continue;
      }
      const m = /^(rt-\d{8}-\d{6}-[0-9a-f]{8})\.json$/.exec(name);
      if (!m) continue;
      const parsed = this.readFile(full, m[1]!);
      if (parsed) this.files.set(m[1]!, parsed);
      else this.quarantine(full, "a routine file was unreadable");
    }
    // The index is rebuilt from the files; a corrupt one is set aside and replaced.
    try {
      JSON.parse(readFileSync(this.indexPath, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.quarantine(this.indexPath, "the routines index was unreadable");
    }
    try {
      this.persistIndex();
    } catch (err) {
      this.log(`[Routines] could not write the routines index: ${(err as Error).message}`);
    }
  }

  private readFile(full: string, id: string): StoredFile | null {
    try {
      const raw = JSON.parse(readFileSync(full, "utf8")) as Partial<StoredFile>;
      const s = raw.summary;
      if (raw.version !== 1 || !s || s.id !== id || !raw.spec || typeof raw.spec !== "object") return null;
      if (!STATES.includes(s.state) || typeof s.title !== "string" || typeof s.intent !== "string") return null;
      if (typeof s.createdAt !== "number" || typeof s.updatedAt !== "number" || typeof s.trigger !== "string") return null;
      if (!Array.isArray(s.hosts) || !s.preview || !Array.isArray(s.preview.lines) || !Array.isArray(s.preview.risks)) return null;
      return raw as StoredFile;
    } catch {
      return null;
    }
  }
}

function copySummary(s: RoutineSummary): RoutineSummary {
  return { ...s, hosts: [...s.hosts], preview: { headline: s.preview.headline, lines: [...s.preview.lines], risks: s.preview.risks.map((r) => ({ ...r })) } };
}
