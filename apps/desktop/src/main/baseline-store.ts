import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PageGraph, PageScreenshot, TabId } from "../../../../packages/shared/src/index.js";

/** Stored perception baseline (a captured PageGraph + page metadata). */
export type PerceptionBaselineEntry = {
  graph: PageGraph;
  tabId: TabId;
  url: string;
  title: string;
  capturedAt: number;
};

/** Deterministic, filesystem-safe filename for an arbitrary snapshot id. */
function fileNameFor(id: string): string {
  return createHash("sha1").update(id).digest("hex");
}

/**
 * Disk-backed store for named visual baselines. Each screenshot's PNG bytes
 * are written to `<dir>/<hash>.png` and an `index.json` records the id → file
 * mapping plus metadata, so baselines survive an app restart and can be used
 * as visual-regression references across runs.
 */
export class ScreenshotBaselineStore {
  private readonly dir: string;
  private readonly indexPath: string;
  /** id → on-disk metadata. */
  private readonly index = new Map<string, { file: string; tabId: TabId; width: number; height: number; capturedAt: number }>();

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, "helmstack-screenshots");
    this.indexPath = path.join(this.dir, "index.json");
    mkdirSync(this.dir, { recursive: true });
    this.loadIndex();
  }

  /** Rehydrate every persisted screenshot as a PageScreenshot (id → screenshot). */
  all(): Array<{ id: string; shot: PageScreenshot }> {
    const out: Array<{ id: string; shot: PageScreenshot }> = [];
    for (const [id, meta] of this.index) {
      const filePath = path.join(this.dir, meta.file);
      if (!existsSync(filePath)) continue;
      const data = readFileSync(filePath).toString("base64");
      out.push({
        id,
        shot: { tabId: meta.tabId, capturedAt: meta.capturedAt, data, mimeType: "image/png", width: meta.width, height: meta.height }
      });
    }
    return out;
  }

  put(id: string, shot: PageScreenshot): void {
    const file = `${fileNameFor(id)}.png`;
    writeFileSync(path.join(this.dir, file), Buffer.from(shot.data, "base64"));
    this.index.set(id, { file, tabId: shot.tabId, width: shot.width, height: shot.height, capturedAt: shot.capturedAt });
    this.saveIndex();
  }

  remove(id: string): void {
    const meta = this.index.get(id);
    if (!meta) return;
    rmSync(path.join(this.dir, meta.file), { force: true });
    this.index.delete(id);
    this.saveIndex();
  }

  private loadIndex(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as {
        entries?: Array<{ id: string; file: string; tabId: TabId; width: number; height: number; capturedAt: number }>;
      };
      for (const e of parsed.entries ?? []) {
        this.index.set(e.id, { file: e.file, tabId: e.tabId, width: e.width, height: e.height, capturedAt: e.capturedAt });
      }
    } catch {
      // Corrupt index — start clean rather than crash on boot.
    }
  }

  private saveIndex(): void {
    const entries = [...this.index.entries()].map(([id, meta]) => ({ id, ...meta }));
    writeFileSync(this.indexPath, JSON.stringify({ version: 1, entries }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

/**
 * Disk-backed store for named perception baselines. Each captured PageGraph is
 * written to `<dir>/<hash>.json`; an `index.json` records the id list and
 * metadata so "what broke since the last deploy" diffs work across restarts.
 */
export class PerceptionBaselineStore {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly index = new Map<string, { file: string; tabId: TabId; url: string; title: string; capturedAt: number }>();

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, "helmstack-perception");
    this.indexPath = path.join(this.dir, "index.json");
    mkdirSync(this.dir, { recursive: true });
    this.loadIndex();
  }

  all(): Array<{ id: string; entry: PerceptionBaselineEntry }> {
    const out: Array<{ id: string; entry: PerceptionBaselineEntry }> = [];
    for (const [id, meta] of this.index) {
      const filePath = path.join(this.dir, meta.file);
      if (!existsSync(filePath)) continue;
      try {
        const graph = JSON.parse(readFileSync(filePath, "utf8")) as PageGraph;
        out.push({ id, entry: { graph, tabId: meta.tabId, url: meta.url, title: meta.title, capturedAt: meta.capturedAt } });
      } catch {
        // Skip an unreadable snapshot rather than fail the whole load.
      }
    }
    return out;
  }

  put(id: string, entry: PerceptionBaselineEntry): void {
    const file = `${fileNameFor(id)}.json`;
    writeFileSync(path.join(this.dir, file), JSON.stringify(entry.graph), { encoding: "utf8", mode: 0o600 });
    this.index.set(id, { file, tabId: entry.tabId, url: entry.url, title: entry.title, capturedAt: entry.capturedAt });
    this.saveIndex();
  }

  remove(id: string): void {
    const meta = this.index.get(id);
    if (!meta) return;
    rmSync(path.join(this.dir, meta.file), { force: true });
    this.index.delete(id);
    this.saveIndex();
  }

  private loadIndex(): void {
    if (!existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as {
        entries?: Array<{ id: string; file: string; tabId: TabId; url: string; title: string; capturedAt: number }>;
      };
      for (const e of parsed.entries ?? []) {
        this.index.set(e.id, { file: e.file, tabId: e.tabId, url: e.url, title: e.title, capturedAt: e.capturedAt });
      }
    } catch {
      // Corrupt index — start clean.
    }
  }

  private saveIndex(): void {
    const entries = [...this.index.entries()].map(([id, meta]) => ({ id, ...meta }));
    writeFileSync(this.indexPath, JSON.stringify({ version: 1, entries }, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}
