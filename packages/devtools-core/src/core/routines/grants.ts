/**
 * Grants: what the HUMAN lets a routine do without asking.
 *
 * - Default is nothing: every action waits for a tap.
 * - Only {@link ROUTINE_AUTO_EFFECTS} can be `auto`; offers, answers to offers and `other` always
 *   ask, whatever is stored here.
 * - A spec's `actions.request` is a suggestion shown at review (`requestedGrantsOf`), never applied.
 * - Everything that reaches the store goes through {@link parseGrants}: the shell (untrusted
 *   renderer input) and the core share one strict parser.
 */
import {
  ROUTINE_AUTO_EFFECTS,
  ROUTINE_EFFECTS,
  ROUTINE_LIMITS,
  type RoutineEffect,
  type RoutineEffectGrant,
  type RoutineGrants,
  type RoutineSpec
} from "../../../../shared/src/index.js";

/** Used when a grant says `auto` without limits: small on purpose. */
export const DEFAULT_PER_RUN = 5;
export const DEFAULT_PER_DAY = 10;

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function emptyGrants(): RoutineGrants {
  return { effects: {}, protect: [] };
}

export type ParsedGrants = { ok: true; grants: RoutineGrants } | { ok: false; error: string };

function limit(raw: unknown, name: string, fallback: number): number | string {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > ROUTINE_LIMITS.actionsPerWindowMax) {
    return `${name} must be a whole number from 1 to ${ROUTINE_LIMITS.actionsPerWindowMax}.`;
  }
  return raw;
}

/** Strictly parse untrusted grants. Unknown keys, bad numbers and `auto` on a never-auto effect are errors. */
export function parseGrants(input: unknown): ParsedGrants {
  if (!isObject(input)) return { ok: false, error: "Grants must be an object." };
  for (const key of Object.keys(input)) {
    if (key !== "effects" && key !== "protect") return { ok: false, error: `Unknown grants field "${key.slice(0, 40)}".` };
  }
  const effects: RoutineGrants["effects"] = {};
  if (input.effects !== undefined) {
    if (!isObject(input.effects)) return { ok: false, error: "Grants.effects must be an object." };
    for (const [name, raw] of Object.entries(input.effects)) {
      if (!(ROUTINE_EFFECTS as readonly string[]).includes(name)) return { ok: false, error: `Unknown effect "${name.slice(0, 40)}".` };
      if (!isObject(raw)) return { ok: false, error: `The grant for ${name} must be an object.` };
      for (const key of Object.keys(raw)) {
        if (key !== "mode" && key !== "perDay" && key !== "perRun") return { ok: false, error: `Unknown field "${key.slice(0, 40)}" in the grant for ${name}.` };
      }
      if (raw.mode !== "ask" && raw.mode !== "auto") return { ok: false, error: `The mode for ${name} must be "ask" or "auto".` };
      if (raw.mode === "auto" && !(ROUTINE_AUTO_EFFECTS as readonly string[]).includes(name)) {
        return { ok: false, error: `${name} always asks you; it cannot be set to auto.` };
      }
      const grant: RoutineEffectGrant = { mode: raw.mode };
      if (raw.mode === "auto") {
        const perRun = limit(raw.perRun, `perRun for ${name}`, DEFAULT_PER_RUN);
        if (typeof perRun === "string") return { ok: false, error: perRun };
        const perDay = limit(raw.perDay, `perDay for ${name}`, DEFAULT_PER_DAY);
        if (typeof perDay === "string") return { ok: false, error: perDay };
        grant.perRun = perRun;
        grant.perDay = perDay;
      } else {
        for (const key of ["perDay", "perRun"] as const) {
          if (raw[key] === undefined) continue;
          const checked = limit(raw[key], `${key} for ${name}`, 0);
          if (typeof checked === "string") return { ok: false, error: checked };
          grant[key] = checked;
        }
      }
      effects[name as RoutineEffect] = grant;
    }
  }
  const protect: string[] = [];
  if (input.protect !== undefined) {
    if (!Array.isArray(input.protect)) return { ok: false, error: "Grants.protect must be a list of names." };
    if (input.protect.length > ROUTINE_LIMITS.protectNames) return { ok: false, error: `At most ${ROUTINE_LIMITS.protectNames} protected names are allowed.` };
    const seen = new Set<string>();
    for (const raw of input.protect) {
      if (typeof raw !== "string") return { ok: false, error: "Protected names must be text." };
      const name = raw.trim();
      if (name === "") return { ok: false, error: "A protected name cannot be empty." };
      if (name.length > ROUTINE_LIMITS.protectChars) return { ok: false, error: `A protected name can be at most ${ROUTINE_LIMITS.protectChars} characters.` };
      if (CONTROL_CHARS.test(name)) return { ok: false, error: "Protected names cannot contain control characters." };
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      protect.push(name);
    }
  }
  return { ok: true, grants: { effects, protect } };
}

/** What the spec asks for, in the shape of real grants. Display only. Undefined when the spec asks for nothing. */
export function requestedGrantsOf(spec: RoutineSpec): RoutineGrants | undefined {
  const a = spec.actions;
  if (!a) return undefined;
  const effects: RoutineGrants["effects"] = {};
  for (const effect of ROUTINE_EFFECTS) {
    const r = a.request?.[effect];
    if (!r) continue;
    effects[effect] = { mode: r.mode, ...(r.per_day !== undefined ? { perDay: r.per_day } : {}), ...(r.per_run !== undefined ? { perRun: r.per_run } : {}) };
  }
  return { effects, protect: [...(a.protect ?? [])] };
}
