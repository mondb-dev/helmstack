/**
 * Argument validation for the shell IPC (the renderer is not trusted beyond the
 * bridge): every value is type- and length-checked in the main process.
 */
import type { FindInPageOptions, ZoomAction } from "../../../../packages/shared/src/index.js";

export function requireString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}

export function parseReloadMode(hard: unknown): boolean {
  if (hard !== undefined && typeof hard !== "boolean") throw new Error("Invalid reload mode.");
  return hard === true;
}

/** Search text may be empty (clears the highlight) but is bounded. */
export function parseFindText(text: unknown): string {
  if (typeof text !== "string" || text.length > 500) throw new Error("Invalid search text.");
  return text;
}

export function parseFindOptions(raw: unknown): FindInPageOptions {
  const options: FindInPageOptions = {};
  if (raw === undefined) return options;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid find options.");
  const input = raw as Record<string, unknown>;
  for (const key of ["forward", "findNext", "matchCase"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new Error("Invalid find options.");
    options[key] = value;
  }
  return options;
}

export function parseZoomAction(action: unknown): ZoomAction {
  if (action !== "in" && action !== "out" && action !== "reset") throw new Error("Invalid zoom action.");
  return action;
}
