/**
 * Per-origin page zoom, persisted in userData (`helmstack-zoom.json`).
 *
 * Tolerant by design: a missing directory/file, unparseable JSON or nonsense
 * values yield an empty store (zoom is a convenience, never a reason to fail
 * startup), and writes are atomic (temp file + rename) so a crash can't leave
 * a half-written file. 100% is never stored.
 */
import fs from "node:fs";
import path from "node:path";

/** Chrome's zoom steps: 25% … 500%. */
export const ZOOM_STEPS: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export const ZOOM_MIN = ZOOM_STEPS[0]!;
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

const EPSILON = 0.005;

/** The next (or previous) standard step relative to `current`; clamped at the ends. */
export function nextZoomFactor(current: number, direction: "in" | "out"): number {
  if (direction === "in") {
    return ZOOM_STEPS.find((step) => step > current + EPSILON) ?? ZOOM_MAX;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i]! < current - EPSILON) return ZOOM_STEPS[i]!;
  }
  return ZOOM_MIN;
}

/** Storage key for a page URL, or null for pages that have no zoom identity (about:blank, data:). */
export function zoomOriginOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "file:") return "file://";
    return null;
  } catch {
    return null;
  }
}

function sanitize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < ZOOM_MIN - EPSILON || value > ZOOM_MAX + EPSILON) return null;
  return Math.abs(value - 1) < EPSILON ? null : value;
}

export class ZoomStore {
  private readonly file: string;
  private origins = new Map<string, number>();

  constructor(directory: string, fileName = "helmstack-zoom.json") {
    this.file = path.join(directory, fileName);
    this.load();
  }

  /** The stored factor for an origin (1 when none). */
  get(origin: string | null): number {
    return origin ? (this.origins.get(origin) ?? 1) : 1;
  }

  /** Stores (or, at 100%, forgets) a factor and writes the file. Returns whether the write succeeded. */
  set(origin: string | null, factor: number): boolean {
    if (!origin) return true;
    const clean = sanitize(factor);
    if (clean === null) this.origins.delete(origin);
    else this.origins.set(origin, clean);
    return this.save();
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const origins = (parsed as { origins?: unknown } | null)?.origins;
      if (!origins || typeof origins !== "object" || Array.isArray(origins)) return;
      for (const [origin, value] of Object.entries(origins)) {
        const clean = sanitize(value);
        if (clean !== null && zoomOriginOf(origin === "file://" ? "file:///" : origin) !== null) this.origins.set(origin, clean);
      }
    } catch {
      // Missing or corrupt: start empty; the next successful save replaces it.
      this.origins = new Map();
    }
  }

  private save(): boolean {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, origins: Object.fromEntries(this.origins) }, null, 2));
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // ignore
      }
      return false;
    }
  }
}
