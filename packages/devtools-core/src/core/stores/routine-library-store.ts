/**
 * Disk store for a routine's reference library: `<dataDir>/routines/<id>/library/<docId>.json`.
 *
 * - One owner-only (0o600) file per document, written as temp file + rename; directories 0o700.
 * - Ids are validated before they reach a path (routine ids and document ids).
 * - Limits come from `ROUTINE_LIBRARY_LIMITS` and are enforced here, not by callers.
 * - Text is normalised on the way in (control characters out, whitespace runs collapsed).
 * - A document a human adds is `active` at once. A document an agent adds is `proposed` and is
 *   never returned by {@link RoutineLibraryStore.activeDocs} until a human approves it.
 * - A document with the same title and text as an existing one is not stored twice.
 * - The whole `<id>/` directory is removed with the routine (see `RoutineDataStore.remove`).
 * - Everything stored here is untrusted text. Nothing reads it back as instructions.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  ROUTINE_LIBRARY_LIMITS,
  type AddRoutineDocInput,
  type RoutineDoc,
  type RoutineDocDetail,
  type RoutineDocOrigin
} from "../../../../shared/src/index.js";
import { RoutineError, isValidRoutineId } from "./routine-store.js";

export const DOC_ID_PATTERN = /^doc-[a-z0-9]{6,12}-[0-9a-f]{8}$/;
export const EXCERPT_CHARS = 300;

export function isValidDocId(id: unknown): id is string {
  return typeof id === "string" && DOC_ID_PATTERN.test(id);
}

export function newDocId(at: number, random: () => string = () => randomBytes(4).toString("hex")): string {
  return `doc-${Math.max(0, Math.floor(at)).toString(36).padStart(6, "0")}-${random()}`;
}

type StoredDoc = {
  version: 1;
  id: string;
  routineId: string;
  title: string;
  source?: string;
  origin: RoutineDocOrigin;
  status: "proposed" | "active";
  addedAt: number;
  hash: string;
  /** The agent that proposed it, when known. Display/diagnostics only. */
  agentId?: string;
  text: string;
};

/** A document ready for retrieval. */
export type LibraryDocText = { id: string; title: string; text: string };

/** Control characters out (newline and tab kept as whitespace), huge whitespace runs collapsed. */
export function normalizeDocText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One line of text with no control characters. */
export function normalizeLine(text: string): string {
  return normalizeDocText(text).replace(/\s+/g, " ");
}

export type RoutineLibraryOptions = { now?: () => number; random?: () => string; log?: (message: string) => void };

export class RoutineLibraryStore {
  readonly root: string;
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly log: (message: string) => void;

  constructor(dataDir: string, options: RoutineLibraryOptions = {}) {
    this.root = path.join(dataDir, "routines");
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(4).toString("hex"));
    this.log = options.log ?? ((m) => console.log(m));
  }

  /** Newest first. Proposed and active documents; metadata and a short excerpt only. */
  list(routineId: string): RoutineDoc[] {
    return this.readAll(routineId)
      .sort((a, b) => b.addedAt - a.addedAt || (a.id < b.id ? 1 : -1))
      .map(toDoc);
  }

  get(routineId: string, docId: string): RoutineDocDetail | null {
    if (!isValidDocId(docId)) return null;
    const stored = this.readOne(routineId, docId);
    return stored ? { ...toDoc(stored), text: stored.text } : null;
  }

  /**
   * Add a document. `origin: "human"` makes it active; `"agent"` makes it proposed. Throws
   * `RoutineError` ("invalid" or "limit") when the input or a limit is wrong. An exact duplicate
   * (same title and text) returns the existing document instead of storing a second one.
   */
  add(routineId: string, input: AddRoutineDocInput, origin: RoutineDocOrigin, ctx: { agentId?: string } = {}): RoutineDoc {
    this.checkRoutine(routineId);
    const L = ROUTINE_LIBRARY_LIMITS;
    if (typeof input !== "object" || input === null) throw new RoutineError("The document must be an object.", "invalid");
    if (typeof input.title !== "string" || typeof input.text !== "string") throw new RoutineError("A document needs a title and text.", "invalid");
    if (input.source !== undefined && typeof input.source !== "string") throw new RoutineError("source must be text.", "invalid");
    const title = normalizeLine(input.title);
    if (title === "") throw new RoutineError("The title must not be empty.", "invalid");
    if (title.length > L.titleChars) throw new RoutineError(`The title is ${title.length} characters; the limit is ${L.titleChars}.`, "invalid");
    const text = normalizeDocText(input.text);
    if (text === "") throw new RoutineError("The text must not be empty.", "invalid");
    if (text.length > L.docChars) throw new RoutineError(`The text is ${text.length} characters; the limit is ${L.docChars}.`, "limit");
    const source = input.source === undefined ? "" : normalizeLine(input.source);
    if (source.length > L.sourceChars) throw new RoutineError(`The source is ${source.length} characters; the limit is ${L.sourceChars}.`, "invalid");

    const existing = this.readAll(routineId);
    const hash = createHash("sha256").update(text).digest("hex");
    const dupe = existing.find((d) => d.hash === hash && d.title.toLowerCase() === title.toLowerCase());
    if (dupe) return toDoc(dupe);
    if (existing.length >= L.docsPerRoutine) throw new RoutineError(`This routine's library is full (${L.docsPerRoutine} documents). Delete one first.`, "limit");
    const total = existing.reduce((n, d) => n + d.text.length, 0);
    if (total + text.length > L.totalChars) throw new RoutineError(`This routine's library would pass ${L.totalChars} characters in total. Delete a document first.`, "limit");
    if (origin === "agent" && existing.filter((d) => d.status === "proposed").length >= L.pendingPerRoutine) {
      throw new RoutineError(`${L.pendingPerRoutine} proposed documents are already waiting for the user's review.`, "limit");
    }

    const addedAt = this.now();
    const stored: StoredDoc = {
      version: 1,
      id: newDocId(addedAt, this.random),
      routineId,
      title,
      ...(source ? { source } : {}),
      origin,
      status: origin === "human" ? "active" : "proposed",
      addedAt,
      hash,
      ...(ctx.agentId ? { agentId: ctx.agentId.slice(0, 64) } : {}),
      text
    };
    mkdirSync(this.dirOf(routineId), { recursive: true, mode: 0o700 });
    this.writeAtomic(this.fileOf(routineId, stored.id), JSON.stringify(stored));
    return toDoc(stored);
  }

  /** proposed -> active. Throws `RoutineError` (not_found, bad_state). */
  approve(routineId: string, docId: string): RoutineDoc {
    const stored = this.mustGet(routineId, docId);
    if (stored.status !== "proposed") throw new RoutineError("That document is not waiting for review.", "bad_state");
    stored.status = "active";
    this.writeAtomic(this.fileOf(routineId, docId), JSON.stringify(stored));
    return toDoc(stored);
  }

  /** Remove a document, proposed or active. Throws `RoutineError` (not_found). */
  delete(routineId: string, docId: string): void {
    this.mustGet(routineId, docId);
    rmSync(this.fileOf(routineId, docId), { force: true });
  }

  /** Active documents only, oldest first (a stable order for ranking). Proposed ones are never returned. */
  activeDocs(routineId: string): LibraryDocText[] {
    if (!isValidRoutineId(routineId)) return [];
    return this.readAll(routineId)
      .filter((d) => d.status === "active")
      .sort((a, b) => a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1))
      .map((d) => ({ id: d.id, title: d.title, text: d.text }));
  }

  activeCount(routineId: string): number {
    return isValidRoutineId(routineId) ? this.readAll(routineId).filter((d) => d.status === "active").length : 0;
  }

  pendingCount(routineId: string): number {
    return isValidRoutineId(routineId) ? this.readAll(routineId).filter((d) => d.status === "proposed").length : 0;
  }

  // ── internals ───────────────────────────────────────────────────────────

  private checkRoutine(routineId: string): void {
    if (!isValidRoutineId(routineId)) throw new RoutineError("invalid routine id", "invalid_id");
  }

  private dirOf(routineId: string): string {
    this.checkRoutine(routineId);
    return path.join(this.root, routineId, "library");
  }

  private fileOf(routineId: string, docId: string): string {
    if (!isValidDocId(docId)) throw new RoutineError("invalid document id", "invalid_id");
    return path.join(this.dirOf(routineId), `${docId}.json`);
  }

  private mustGet(routineId: string, docId: string): StoredDoc {
    this.checkRoutine(routineId);
    const stored = isValidDocId(docId) ? this.readOne(routineId, docId) : null;
    if (!stored) throw new RoutineError("That document no longer exists.", "not_found");
    return stored;
  }

  private readOne(routineId: string, docId: string): StoredDoc | null {
    let text: string;
    try {
      text = readFileSync(this.fileOf(routineId, docId), "utf8");
    } catch {
      return null;
    }
    try {
      const v: unknown = JSON.parse(text);
      return isStored(v, routineId) && v.id === docId ? v : null;
    } catch {
      this.log(`[Routines] a library file of ${routineId} was unreadable and is ignored`);
      return null;
    }
  }

  private readAll(routineId: string): StoredDoc[] {
    const dir = this.dirOf(routineId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: StoredDoc[] = [];
    for (const name of names) {
      const m = /^(doc-[a-z0-9]{6,12}-[0-9a-f]{8})\.json$/.exec(name);
      if (!m) {
        if (name.endsWith(".tmp")) rmSync(path.join(dir, name), { force: true });
        continue;
      }
      const doc = this.readOne(routineId, m[1]!);
      if (doc) out.push(doc);
    }
    return out;
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

function toDoc(d: StoredDoc): RoutineDoc {
  return {
    id: d.id,
    routineId: d.routineId,
    title: d.title,
    ...(d.source ? { source: d.source } : {}),
    origin: d.origin,
    status: d.status,
    addedAt: d.addedAt,
    chars: d.text.length,
    excerpt: d.text.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS)
  };
}

function isStored(v: unknown, routineId: string): v is StoredDoc {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Partial<StoredDoc>;
  return (
    d.version === 1 &&
    isValidDocId(d.id) &&
    d.routineId === routineId &&
    typeof d.title === "string" &&
    typeof d.text === "string" &&
    typeof d.hash === "string" &&
    typeof d.addedAt === "number" &&
    (d.origin === "human" || d.origin === "agent") &&
    (d.status === "proposed" || d.status === "active")
  );
}
