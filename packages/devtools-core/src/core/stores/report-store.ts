/**
 * Disk store for page analysis reports: `<dataDir>/reports/<id>.html`,
 * `<id>.md` and a small `index.json`.
 *
 * - Every write is temp file + rename, so a crash never leaves a half file.
 * - Files are only ever addressed by id, and the id must match
 *   {@link REPORT_ID_PATTERN} *and* be present in the index; a caller-supplied
 *   path never reaches the filesystem.
 * - The store is capped (newest N reports and a total size); the oldest are
 *   deleted beyond that and the deletion is logged.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ReportFormat, ReportSummary } from "../../../../shared/src/index.js";
import { ReportInputError } from "../reports/report-input.js";

/** `YYYYMMDD-HHMMSS-<8 hex>`: filesystem-safe, sorts by creation time. */
export const REPORT_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

export const DEFAULT_MAX_REPORTS = 100;
export const DEFAULT_MAX_REPORT_BYTES = 200 * 1024 * 1024;

export type ReportStoreOptions = {
  maxReports?: number;
  maxBytes?: number;
  log?: (message: string) => void;
};

type PersistedIndex = { version: 1; reports: ReportSummary[] };

export function isValidReportId(id: unknown): id is string {
  return typeof id === "string" && REPORT_ID_PATTERN.test(id);
}

export function newReportId(at: number, random: () => string = () => randomBytes(4).toString("hex")): string {
  const d = new Date(Number.isFinite(at) ? at : 0);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${stamp}-${random()}`;
}

export class ReportStore {
  readonly dir: string;
  private readonly indexPath: string;
  private readonly maxReports: number;
  private readonly maxBytes: number;
  private readonly log: (message: string) => void;
  private reports: ReportSummary[] = [];

  constructor(dataDir: string, options: ReportStoreOptions = {}) {
    this.dir = path.join(dataDir, "reports");
    this.indexPath = path.join(this.dir, "index.json");
    this.maxReports = Math.max(1, options.maxReports ?? DEFAULT_MAX_REPORTS);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_REPORT_BYTES);
    this.log = options.log ?? ((m) => console.log(m));
    this.load();
  }

  /** Newest first. */
  list(): ReportSummary[] {
    return this.reports.map((r) => ({ ...r }));
  }

  get(id: string): ReportSummary | undefined {
    if (!isValidReportId(id)) return undefined;
    const found = this.reports.find((r) => r.id === id);
    return found ? { ...found } : undefined;
  }

  /** Absolute path of a stored file, or null when the id is unknown. Throws for a malformed id. */
  resolvePath(id: string, format: ReportFormat): string | null {
    if (!isValidReportId(id)) throw new ReportInputError("invalid report id");
    if (format !== "html" && format !== "md") throw new ReportInputError("format must be html or md");
    const entry = this.reports.find((r) => r.id === id);
    if (!entry) return null;
    return path.join(this.dir, `${entry.id}.${format}`);
  }

  /** Writes both files and the index; returns the ids pruned to stay within the caps. */
  add(summary: ReportSummary, files: { html: string; md: string }): string[] {
    if (!isValidReportId(summary.id)) throw new Error("refusing to store a report with an invalid id");
    mkdirSync(this.dir, { recursive: true });
    this.writeAtomic(path.join(this.dir, `${summary.id}.html`), files.html);
    this.writeAtomic(path.join(this.dir, `${summary.id}.md`), files.md);
    this.reports = [summary, ...this.reports.filter((r) => r.id !== summary.id)];
    this.sort();
    const pruned = this.prune();
    this.persist();
    return pruned;
  }

  delete(id: string): boolean {
    if (!isValidReportId(id)) throw new ReportInputError("invalid report id");
    const before = this.reports.length;
    this.reports = this.reports.filter((r) => r.id !== id);
    if (this.reports.length === before) return false;
    this.removeFiles(id);
    this.persist();
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private sort(): void {
    this.reports.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  private prune(): string[] {
    const pruned: string[] = [];
    let bytes = 0;
    const kept: ReportSummary[] = [];
    for (const r of this.reports) {
      const overCount = kept.length >= this.maxReports;
      const overSize = kept.length > 0 && bytes + r.sizeBytes > this.maxBytes;
      if (overCount || overSize) {
        pruned.push(r.id);
        this.removeFiles(r.id);
      } else {
        kept.push(r);
        bytes += r.sizeBytes;
      }
    }
    this.reports = kept;
    if (pruned.length) {
      this.log(
        `[Reports] removed ${pruned.length} oldest report(s) to stay within ${this.maxReports} reports / ` +
        `${Math.round(this.maxBytes / (1024 * 1024))} MB: ${pruned.join(", ")}`
      );
    }
    return pruned;
  }

  private removeFiles(id: string): void {
    for (const ext of ["html", "md"]) rmSync(path.join(this.dir, `${id}.${ext}`), { force: true });
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

  private persist(): void {
    const state: PersistedIndex = { version: 1, reports: this.reports };
    this.writeAtomic(this.indexPath, JSON.stringify(state));
  }

  private load(): void {
    mkdirSync(this.dir, { recursive: true });
    // Leftovers of an interrupted write.
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(".tmp")) rmSync(path.join(this.dir, name), { force: true });
    }
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as Partial<PersistedIndex>;
      const list = Array.isArray(parsed.reports) ? parsed.reports : [];
      this.reports = list.filter((r) => {
        if (!r || !isValidReportId(r.id)) return false;
        try {
          return statSync(path.join(this.dir, `${r.id}.html`)).isFile();
        } catch {
          return false;
        }
      });
      this.sort();
    } catch {
      this.reports = [];
    }
  }
}
