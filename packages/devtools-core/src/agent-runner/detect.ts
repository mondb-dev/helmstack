/**
 * Detection of installed agent CLIs. Only allowlisted binary names (from the
 * adapters) are looked up, by scanning PATH plus well-known install dirs for an
 * executable regular file. The only thing ever executed is `<found> --version`
 * (no shell, short timeout, scrubbed env).
 */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentCliInfo, AgentModelOption } from "../../../shared/src/index.js";
import { scrubbedEnv } from "./env.js";
import type { AgentCliAdapter } from "./types.js";

export type DetectOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Extra directories searched after PATH (tests inject fixtures here). */
  extraDirs?: string[];
  versionTimeoutMs?: number;
  /** Replace the well-known dirs entirely (tests). */
  wellKnownDirs?: string[];
};

export function wellKnownDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin")
  ];
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable named one of `names` in PATH, then the well-known dirs. */
export function findExecutable(names: readonly string[], opts: DetectOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const dirs = [...pathDirs, ...(opts.wellKnownDirs ?? wellKnownDirs(home)), ...(opts.extraDirs ?? [])];
  const seen = new Set<string>();
  for (const dir of dirs) {
    // Relative PATH entries would resolve against the cwd: never trusted.
    if (!path.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function readVersion(binary: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        binary,
        ["--version"],
        { timeout: timeoutMs, shell: false, env, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) return resolve(null);
          const match = /\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?/.exec(String(stdout));
          resolve(match ? match[0] : null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

export async function detectCli(adapter: AgentCliAdapter, opts: DetectOptions = {}): Promise<AgentCliInfo> {
  const home = opts.home ?? os.homedir();
  const configured = adapter.readConfiguredModel(home);
  const models: AgentModelOption[] = [...adapter.models];
  if (configured && !models.some((m) => m.id === configured)) {
    models.push({ id: configured, label: `${configured} (configured)`, source: "configured" });
  }
  const base = {
    id: adapter.id,
    label: adapter.label,
    models,
    confined: adapter.confined,
    experimental: adapter.experimental,
    supportsResume: adapter.supportsResume
  };
  const found = findExecutable(adapter.binaryNames, opts);
  if (!found) {
    return { ...base, path: null, version: null, available: false, reason: "not installed" };
  }
  const version = await readVersion(found, opts.versionTimeoutMs ?? 5000, scrubbedEnv(opts.env ?? process.env));
  if (!version) {
    return { ...base, path: found, version: null, available: false, reason: "could not read its version" };
  }
  return { ...base, path: found, version, available: true };
}
