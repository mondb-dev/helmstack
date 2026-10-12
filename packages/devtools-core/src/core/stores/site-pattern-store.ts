import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type PersistedSitePatternState = {
  version: 1;
  updatedAt: number;
  patternsByOrigin: Record<string, string[]>;
};

export class SitePatternStore {
  private readonly filePath: string;
  private readonly patternsByOrigin = new Map<string, string[]>();

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, "helmstack-site-patterns.json");
    this.load();
  }

  get(origin: string): string[] {
    return [...(this.patternsByOrigin.get(origin) ?? [])];
  }

  set(origin: string, patterns: string[]): string[] {
    const normalized = dedupe(patterns);
    this.patternsByOrigin.set(origin, normalized);
    this.persist();
    return normalized;
  }

  add(origin: string, patterns: string[]): string[] {
    const next = dedupe([...(this.patternsByOrigin.get(origin) ?? []), ...patterns]);
    this.patternsByOrigin.set(origin, next);
    this.persist();
    return next;
  }

  clear(origin: string): void {
    this.patternsByOrigin.delete(origin);
    this.persist();
  }

  private load() {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      this.persist();
      return;
    }

    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedSitePatternState;
    this.patternsByOrigin.clear();
    for (const [origin, patterns] of Object.entries(parsed.patternsByOrigin ?? {})) {
      this.patternsByOrigin.set(origin, dedupe(patterns));
    }
  }

  private persist() {
    const state: PersistedSitePatternState = {
      version: 1,
      updatedAt: Date.now(),
      patternsByOrigin: Object.fromEntries(this.patternsByOrigin)
    };

    writeFileSync(this.filePath, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

function dedupe(patterns: string[]): string[] {
  return [...new Set(patterns.map((pattern) => pattern.trim()).filter(Boolean))];
}