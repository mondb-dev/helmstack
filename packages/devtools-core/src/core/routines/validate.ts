/**
 * Strict, hand-written validator for routine specs.
 *
 * - Unknown keys are rejected everywhere, with a JSON path (`steps[2].steps[0].accept_at`).
 * - References are resolved statically: `$scope.start[i]`, `$<step id>`, `$item`, `state.<key>`
 *   are the only forms, and each must point at something declared earlier and in scope.
 * - Nothing in a spec is ever evaluated; strings are data.
 * - At most {@link MAX_ERRORS} errors are returned, in a fixed traversal order.
 *
 * `routine-schema.ts` describes the same shape for models to read; `routines.schema.test.ts`
 * keeps the two in agreement.
 */
import {
  ROUTINE_ACT_ACTIONS,
  ROUTINE_APPROVAL_KINDS,
  ROUTINE_AUTO_EFFECTS,
  ROUTINE_EFFECTS,
  ROUTINE_INFER_MODELS,
  ROUTINE_LIMITS,
  ROUTINE_ON_LOW,
  ROUTINE_ON_UNCERTAIN,
  ROUTINE_SPEC_VERSION,
  ROUTINE_STATE_TYPES,
  ROUTINE_STEP_KINDS,
  ROUTINE_STRATEGIES,
  type RoutineSpec,
  type RoutineSpecError,
  type RoutineSpecResult,
  type RoutineStepKind
} from "../../../../shared/src/index.js";
import { parseCron } from "./cron.js";
import {
  ACTIVE_HOURS_PATTERN,
  EVERY_PATTERN,
  FIELD_TYPE_PATTERN,
  HOST_PATTERN,
  INFER_OUTPUT_PATTERN,
  LABEL_PATTERN,
  NAME_PATTERN,
  RATE_PATTERN,
  REF_PATTERN,
  TIMEZONE_PATTERN,
  WAIT_PATTERN,
  WHEN_PATTERN,
  re
} from "./patterns.js";
import { hostInScope, parseHttpUrl } from "./scope.js";

export const MAX_ERRORS = 20;

const NAME = re(NAME_PATTERN);
const REF = re(REF_PATTERN);
const EVERY = re(EVERY_PATTERN);
const ACTIVE_HOURS = re(ACTIVE_HOURS_PATTERN);
const TIMEZONE = re(TIMEZONE_PATTERN);
const HOST = re(HOST_PATTERN);
const FIELD_TYPE = re(FIELD_TYPE_PATTERN);
const INFER_OUTPUT = re(INFER_OUTPUT_PATTERN);
const LABEL = re(LABEL_PATTERN);
const WAIT = re(WAIT_PATTERN);
const WHEN = re(WHEN_PATTERN);
const RATE = re(RATE_PATTERN);
 
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const RESERVED_IDS = new Set(["item", "scope", "state"]);
/** Key names that suggest someone is trying to change guardrails; they get a pointed message. */
const GUARDRAIL_KEY = /approv|stealth|credential|password|secret|token|cookie|captcha|bypass|auto_?submit|login|sign_?in|vault|totp|eval|script|exec|shell/i;

/** Minutes in a duration like `30m`, `6h`, `1d`. */
export function parseEveryMinutes(every: string): number | null {
  const m = /^(\d+)(m|h|d)$/.exec(every);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 1440;
}

type StateTypeName = (typeof ROUTINE_STATE_TYPES)[number];
type StepInfo = { kind: RoutineStepKind; against?: string };
type Scope = {
  visible: Map<string, StepInfo>;
  inLoop: boolean;
  /** `against` of the diff step the enclosing for_each iterates, when it iterates one. */
  loopAgainst?: string;
  depth: number;
};
type RefRules = {
  scopeStart?: boolean;
  item?: boolean;
  steps?: readonly RoutineStepKind[];
  state?: readonly StateTypeName[];
};
type Ctx = {
  errors: RoutineSpecError[];
  ids: Set<string>;
  total: number;
  tooMany: boolean;
  state: Map<string, StateTypeName>;
  startCount: number;
  spec: Partial<RoutineSpec>;
  scopeOk: boolean;
  maxDepth: number;
};

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function add(ctx: Ctx, path: string, message: string): void {
  if (ctx.errors.length < MAX_ERRORS) ctx.errors.push({ path, message });
}

/** Verify `v` is a plain object whose keys are all in `allowed`; unknown keys are reported (sorted). */
function object(ctx: Ctx, v: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | null {
  if (!isObject(v)) {
    add(ctx, path || "(root)", "must be an object");
    return null;
  }
  for (const key of Object.keys(v).sort()) {
    if (allowed.includes(key)) continue;
    if (GUARDRAIL_KEY.test(key)) {
      add(
        ctx,
        join(path, key),
        `"${key}" is not a routine field. Routines cannot change approvals or guardrails, enable stealth, or use credentials, and nothing in a spec is executed`
      );
    } else {
      add(ctx, join(path, key), `unknown field "${key}"; allowed: ${allowed.join(", ")}`);
    }
  }
  return v;
}

function str(
  ctx: Ctx,
  o: Record<string, unknown>,
  path: string,
  key: string,
  opts: { required?: boolean; max?: number; min?: number } = {}
): string | undefined {
  const p = join(path, key);
  const v = o[key];
  if (v === undefined) {
    if (opts.required) add(ctx, p, "is required");
    return undefined;
  }
  if (typeof v !== "string") {
    add(ctx, p, "must be a string");
    return undefined;
  }
  const max = opts.max ?? ROUTINE_LIMITS.stringChars;
  if (v.length > max) {
    add(ctx, p, `is ${v.length} characters; the limit is ${max}`);
    return undefined;
  }
  if (v.length < (opts.min ?? 1)) {
    add(ctx, p, "must not be empty");
    return undefined;
  }
  if (CONTROL_CHARS.test(v)) {
    add(ctx, p, "must not contain control characters");
    return undefined;
  }
  return v;
}

function patterned(
  ctx: Ctx,
  o: Record<string, unknown>,
  path: string,
  key: string,
  pattern: RegExp,
  hint: string,
  required = true
): string | undefined {
  const v = str(ctx, o, path, key, { required, max: 200 });
  if (v !== undefined && !pattern.test(v)) {
    add(ctx, join(path, key), `${hint} (got ${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}...` : v)})`);
    return undefined;
  }
  return v;
}

function num(
  ctx: Ctx,
  o: Record<string, unknown>,
  path: string,
  key: string,
  opts: { required?: boolean; min?: number; max?: number; int?: boolean }
): number | undefined {
  const p = join(path, key);
  const v = o[key];
  if (v === undefined) {
    if (opts.required) add(ctx, p, "is required");
    return undefined;
  }
  if (typeof v !== "number" || !Number.isFinite(v)) {
    add(ctx, p, "must be a number");
    return undefined;
  }
  if (opts.int && !Number.isInteger(v)) {
    add(ctx, p, "must be a whole number");
    return undefined;
  }
  if ((opts.min !== undefined && v < opts.min) || (opts.max !== undefined && v > opts.max)) {
    add(ctx, p, `must be between ${opts.min ?? "-inf"} and ${opts.max ?? "inf"} (got ${v})`);
    return undefined;
  }
  return v;
}

function bool(ctx: Ctx, o: Record<string, unknown>, path: string, key: string, required = false): boolean | undefined {
  const v = o[key];
  if (v === undefined) {
    if (required) add(ctx, join(path, key), "is required");
    return undefined;
  }
  if (typeof v !== "boolean") {
    add(ctx, join(path, key), "must be true or false");
    return undefined;
  }
  return v;
}

function oneOf<T extends string>(
  ctx: Ctx,
  o: Record<string, unknown>,
  path: string,
  key: string,
  values: readonly T[],
  required = true
): T | undefined {
  const v = o[key];
  if (v === undefined) {
    if (required) add(ctx, join(path, key), `is required; one of ${values.join(" | ")}`);
    return undefined;
  }
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    add(ctx, join(path, key), `must be one of ${values.join(" | ")}`);
    return undefined;
  }
  return v as T;
}

function array(
  ctx: Ctx,
  o: Record<string, unknown>,
  path: string,
  key: string,
  opts: { required?: boolean; min?: number; max: number }
): unknown[] | undefined {
  const p = join(path, key);
  const v = o[key];
  if (v === undefined) {
    if (opts.required) add(ctx, p, "is required");
    return undefined;
  }
  if (!Array.isArray(v)) {
    add(ctx, p, "must be an array");
    return undefined;
  }
  if (v.length > opts.max) {
    add(ctx, p, `has ${v.length} items; the limit is ${opts.max}`);
    return undefined;
  }
  if (v.length < (opts.min ?? 0)) {
    add(ctx, p, `needs at least ${opts.min} item${opts.min === 1 ? "" : "s"}`);
    return undefined;
  }
  return v;
}

function enumList<T extends string>(
  ctx: Ctx,
  o: Record<string, unknown>,
  path: string,
  key: string,
  values: readonly T[],
  opts: { required?: boolean; min?: number; max: number }
): T[] | undefined {
  const list = array(ctx, o, path, key, opts);
  if (!list) return undefined;
  const out: T[] = [];
  list.forEach((item, i) => {
    if (typeof item !== "string" || !(values as readonly string[]).includes(item)) {
      add(ctx, `${join(path, key)}[${i}]`, `must be one of ${values.join(" | ")}`);
    } else if (out.includes(item as T)) {
      add(ctx, `${join(path, key)}[${i}]`, `"${item}" is listed twice`);
    } else {
      out.push(item as T);
    }
  });
  return out;
}

// ── References ───────────────────────────────────────────────────────────────

function describeRules(rules: RefRules): string {
  const parts: string[] = [];
  if (rules.scopeStart) parts.push("$scope.start[i]");
  if (rules.item) parts.push("$item");
  if (rules.steps) parts.push(`$<id of a ${rules.steps.join(" or ")} step>`);
  if (rules.state) parts.push(`state.<${rules.state.join(" or ")} key>`);
  return parts.join(", ");
}

/** Resolve a reference statically. Returns the step it points at, when it points at one. */
function checkRef(ctx: Ctx, scope: Scope, value: unknown, path: string, rules: RefRules): StepInfo | "other" | null {
  if (typeof value !== "string") {
    add(ctx, path, `must be a reference string (${describeRules(rules)})`);
    return null;
  }
  if (!REF.test(value)) {
    add(
      ctx,
      path,
      `${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}...` : value)} is not a reference. The only forms are $scope.start[i], $<step id>, $item and state.<key>; expressions, property paths and interpolation are not supported`
    );
    return null;
  }
  if (value.startsWith("$scope.start[")) {
    const index = Number(/\[(\d+)\]/.exec(value)![1]);
    if (!rules.scopeStart) {
      add(ctx, path, `${value} is not allowed here; expected ${describeRules(rules)}`);
      return null;
    }
    if (index >= ctx.startCount) {
      add(ctx, path, `${value} does not exist; scope.start has ${ctx.startCount} URL${ctx.startCount === 1 ? "" : "s"}`);
      return null;
    }
    return "other";
  }
  if (value === "$item") {
    if (!rules.item) {
      add(ctx, path, `$item is not allowed here; expected ${describeRules(rules)}`);
      return null;
    }
    if (!scope.inLoop) {
      add(ctx, path, "$item is only valid inside a for_each");
      return null;
    }
    return "other";
  }
  if (value.startsWith("state.")) {
    const key = value.slice(6);
    const type = ctx.state.get(key);
    if (!type) {
      add(ctx, path, `state.${key} is not declared; declare it under "state" first`);
      return null;
    }
    if (!rules.state) {
      add(ctx, path, `${value} is not allowed here; expected ${describeRules(rules)}`);
      return null;
    }
    if (!rules.state.includes(type)) {
      add(ctx, path, `${value} is a ${type} but this needs a ${rules.state.join(" or ")}`);
      return null;
    }
    return "other";
  }
  const id = value.slice(1);
  const info = scope.visible.get(id);
  if (!info) {
    add(
      ctx,
      path,
      ctx.ids.has(id)
        ? `step "${id}" is not available here; it must be defined earlier in the same or an enclosing step list`
        : `no step with id "${id}" is defined before this point`
    );
    return null;
  }
  if (!rules.steps) {
    add(ctx, path, `${value} is not allowed here; expected ${describeRules(rules)}`);
    return null;
  }
  if (!rules.steps.includes(info.kind)) {
    add(ctx, path, `"${id}" is ${info.kind === "act" ? "an" : "a"} ${info.kind} step but this needs ${rules.steps.length > 1 ? "one of: " : "a "}${rules.steps.join(", ")}`);
    return null;
  }
  return info;
}

// ── Steps ────────────────────────────────────────────────────────────────────

const COMMON = ["do", "id"] as const;
const STEP_KEYS: Record<RoutineStepKind, readonly string[]> = {
  open: [...COMMON, "url"],
  locate: [...COMMON, "target", "strategies", "min_confidence", "on_low"],
  extract: [...COMMON, "fields", "strategies", "from"],
  diff: [...COMMON, "items", "against", "key"],
  for_each: [...COMMON, "items", "limit", "steps"],
  infer: [...COMMON, "question", "output", "labels", "accept_at", "reject_below", "on_uncertain", "evidence", "samples", "uses", "model", "recall"],
  act: [...COMMON, "action", "effect", "target", "strategies", "min_confidence", "on_low", "subject", "value", "verify"],
  remember: [...COMMON, "key", "from"],
  branch: [...COMMON, "on", "accept", "maybe", "reject"],
  note: [...COMMON, "tag", "fields"],
  mark_seen: [...COMMON, "into"],
  open_item: [...COMMON],
  wait: [...COMMON, "for"],
  report: [...COMMON, "when"]
};

function stepList(ctx: Ctx, value: unknown, path: string, scope: Scope, opts: { nonEmpty: boolean }): void {
  if (!Array.isArray(value)) {
    add(ctx, path, "must be an array of steps");
    return;
  }
  if (opts.nonEmpty && value.length === 0) {
    add(ctx, path, "needs at least one step");
    return;
  }
  if (scope.depth > ROUTINE_LIMITS.maxNesting) {
    add(ctx, path, `is nested too deeply; at most ${ROUTINE_LIMITS.maxNesting} levels of for_each / branch are allowed`);
    return;
  }
  value.forEach((step, i) => step_(ctx, step, `${path}[${i}]`, scope));
}

function step_(ctx: Ctx, raw: unknown, path: string, scope: Scope): void {
  ctx.total += 1;
  if (ctx.total > ROUTINE_LIMITS.maxSteps) {
    if (!ctx.tooMany) {
      ctx.tooMany = true;
      add(ctx, path, `the spec has more than ${ROUTINE_LIMITS.maxSteps} steps in total (nested steps count)`);
    }
    return;
  }
  if (!isObject(raw)) {
    add(ctx, path, "must be an object");
    return;
  }
  const kindValue = raw.do;
  if (typeof kindValue !== "string" || !(ROUTINE_STEP_KINDS as readonly string[]).includes(kindValue)) {
    add(ctx, join(path, "do"), `must be one of ${ROUTINE_STEP_KINDS.join(" | ")}`);
    return;
  }
  const kind = kindValue as RoutineStepKind;
  const o = object(ctx, raw, path, STEP_KEYS[kind])!;

  let id: string | undefined;
  if (o.id !== undefined) {
    id = patterned(ctx, o, path, "id", NAME, "must be lower-case letters, digits and underscores, starting with a letter, up to 32 characters", false);
    if (id !== undefined) {
      if (RESERVED_IDS.has(id)) {
        add(ctx, join(path, "id"), `"${id}" is reserved`);
        id = undefined;
      } else if (ctx.ids.has(id)) {
        add(ctx, join(path, "id"), `id "${id}" is used twice; ids must be unique across the whole spec`);
        id = undefined;
      } else {
        ctx.ids.add(id);
      }
    }
  }

  const info: StepInfo = { kind };
  const needsFollow = () => {
    if (ctx.maxDepth < 1) {
      add(ctx, path, "needs links to be followed, but scope.follow.max_depth is 0");
    }
  };

  switch (kind) {
    case "open": {
      const v = str(ctx, o, path, "url", { required: true, max: ROUTINE_LIMITS.urlChars });
      if (v === undefined) break;
      if (v.startsWith("$")) {
        const ref = checkRef(ctx, scope, v, join(path, "url"), { scopeStart: true, item: true });
        if (ref && v === "$item") needsFollow();
      } else {
        const parsed = parseHttpUrl(v);
        if (!parsed.ok) add(ctx, join(path, "url"), `${parsed.reason}; use $scope.start[i] or an http(s) URL inside the scope`);
        else if (ctx.scopeOk && !hostInScope(parsed.url.hostname, ctx.spec.scope!)) {
          add(ctx, join(path, "url"), `host ${parsed.url.hostname} is outside the scope; add it to scope.start or scope.follow.allow_hosts`);
        }
      }
      break;
    }
    case "locate": {
      str(ctx, o, path, "target", { required: true });
      enumList(ctx, o, path, "strategies", ROUTINE_STRATEGIES, { required: true, min: 1, max: ROUTINE_STRATEGIES.length });
      num(ctx, o, path, "min_confidence", { required: true, min: 0, max: 1 });
      oneOf(ctx, o, path, "on_low", ROUTINE_ON_LOW);
      break;
    }
    case "extract": {
      fieldMap(ctx, o, path);
      enumList(ctx, o, path, "strategies", ROUTINE_STRATEGIES, { required: true, min: 1, max: ROUTINE_STRATEGIES.length });
      if (o.from !== undefined) checkRef(ctx, scope, o.from, join(path, "from"), { item: true, steps: ["locate"] });
      break;
    }
    case "diff": {
      checkRefRequired(ctx, scope, o, path, "items", { steps: ["locate"] });
      const against = checkRefRequired(ctx, scope, o, path, "against", { state: ["set"] });
      if (against && typeof o.against === "string") info.against = o.against;
      const key = array(ctx, o, path, "key", { required: true, min: 1, max: 5 });
      key?.forEach((k, i) => {
        if (typeof k !== "string" || !NAME.test(k)) add(ctx, `${join(path, "key")}[${i}]`, "must be a field name (lower-case letters, digits, underscores)");
      });
      break;
    }
    case "for_each": {
      const itemsInfo = checkRefRequired(ctx, scope, o, path, "items", { steps: ["locate", "diff"], state: ["set"] });
      num(ctx, o, path, "limit", { required: true, min: 1, max: ROUTINE_LIMITS.forEachLimit, int: true });
      if (scope.depth >= ROUTINE_LIMITS.maxNesting) {
        add(ctx, path, `for_each cannot be nested this deeply; at most ${ROUTINE_LIMITS.maxNesting} levels are allowed`);
        break;
      }
      if (o.steps === undefined) {
        add(ctx, join(path, "steps"), "is required");
        break;
      }
      const against = itemsInfo && itemsInfo !== "other" ? itemsInfo.against : undefined;
      stepList(
        ctx,
        o.steps,
        join(path, "steps"),
        { visible: new Map(scope.visible), inLoop: true, ...(against ? { loopAgainst: against } : {}), depth: scope.depth + 1 },
        { nonEmpty: true }
      );
      break;
    }
    case "infer": {
      inferStep(ctx, scope, o, path);
      break;
    }
    case "branch": {
      branchStep(ctx, scope, o, path);
      break;
    }
    case "act": {
      actStep(ctx, scope, o, path);
      break;
    }
    case "remember": {
      rememberStep(ctx, scope, o, path);
      break;
    }
    case "note": {
      patterned(ctx, o, path, "tag", NAME, "must be a short lower-case tag such as maybe", false);
      const fields = array(ctx, o, path, "fields", { max: ROUTINE_LIMITS.noteFields });
      fields?.forEach((f, i) =>
        checkRef(ctx, scope, f, `${join(path, "fields")}[${i}]`, {
          item: true,
          steps: ["locate", "extract", "diff", "infer"],
          state: ROUTINE_STATE_TYPES
        })
      );
      break;
    }
    case "mark_seen": {
      if (o.into !== undefined) {
        checkRef(ctx, scope, o.into, join(path, "into"), { state: ["set"] });
      } else if (!scope.loopAgainst) {
        add(ctx, path, 'needs "into": it is not inside a for_each over a diff step, so there is no set to add to');
      }
      break;
    }
    case "open_item": {
      if (!scope.inLoop) add(ctx, path, "open_item is only valid inside a for_each");
      else needsFollow();
      break;
    }
    case "wait": {
      const v = patterned(ctx, o, path, "for", WAIT, 'must be a duration like "30s", "5m" or "1h"');
      if (v !== undefined) {
        const seconds = Number(v.slice(0, -1)) * (v.endsWith("s") ? 1 : v.endsWith("m") ? 60 : 3600);
        if (seconds > 3600) add(ctx, join(path, "for"), "must be at most 1h");
      }
      break;
    }
    case "report": {
      patterned(ctx, o, path, "when", WHEN, 'must be "always" or "new_notes>N"', false);
      break;
    }
  }

  if (id !== undefined) scope.visible.set(id, info);
}

function checkRefRequired(ctx: Ctx, scope: Scope, o: Record<string, unknown>, path: string, key: string, rules: RefRules): StepInfo | "other" | null {
  if (o[key] === undefined) {
    add(ctx, join(path, key), "is required");
    return null;
  }
  return checkRef(ctx, scope, o[key], join(path, key), rules);
}

function fieldMap(ctx: Ctx, o: Record<string, unknown>, path: string): void {
  const p = join(path, "fields");
  const v = o.fields;
  if (v === undefined) {
    add(ctx, p, "is required");
    return;
  }
  if (!isObject(v)) {
    add(ctx, p, "must be an object mapping field names to types");
    return;
  }
  const names = Object.keys(v).sort();
  if (names.length === 0) add(ctx, p, "needs at least one field");
  if (names.length > ROUTINE_LIMITS.extractFields) {
    add(ctx, p, `has ${names.length} fields; the limit is ${ROUTINE_LIMITS.extractFields}`);
    return;
  }
  for (const name of names) {
    if (!NAME.test(name)) {
      add(ctx, `${p}.${name}`, "field names must be lower-case letters, digits and underscores, starting with a letter");
      continue;
    }
    const t = v[name];
    if (typeof t !== "string" || !FIELD_TYPE.test(t)) {
      add(ctx, `${p}.${name}`, 'type must be text, text<=N (N up to 2000), date, url, number or bool, optionally followed by "?"');
    }
  }
}

function inferStep(ctx: Ctx, scope: Scope, o: Record<string, unknown>, path: string): void {
  str(ctx, o, path, "question", { required: true });
  const output = patterned(ctx, o, path, "output", INFER_OUTPUT, 'must be "score", "label", "bool" or "text<=N"');
  const labels = array(ctx, o, path, "labels", { max: ROUTINE_LIMITS.labels });
  if (output === "label") {
    if (!labels) add(ctx, join(path, "labels"), 'is required when output is "label" (2 to 10 labels)');
    else if (labels.length < 2) add(ctx, join(path, "labels"), "needs at least 2 labels");
  } else if (labels && output !== undefined) {
    add(ctx, join(path, "labels"), 'is only allowed when output is "label"');
  }
  const seen = new Set<string>();
  labels?.forEach((l, i) => {
    if (typeof l !== "string" || !LABEL.test(l)) add(ctx, `${join(path, "labels")}[${i}]`, "must be a short label of letters, digits, spaces, underscores or hyphens");
    else if (seen.has(l)) add(ctx, `${join(path, "labels")}[${i}]`, `"${l}" is listed twice`);
    else seen.add(l);
  });
  const accept = num(ctx, o, path, "accept_at", { required: true, min: 0, max: 1 });
  const reject = num(ctx, o, path, "reject_below", { required: true, min: 0, max: 1 });
  if (accept !== undefined && reject !== undefined && reject > accept) {
    add(ctx, join(path, "reject_below"), `must not be above accept_at (${reject} > ${accept}); thresholds need 0 <= reject_below <= accept_at <= 1`);
  }
  oneOf(ctx, o, path, "on_uncertain", ROUTINE_ON_UNCERTAIN);
  oneOf(ctx, o, path, "evidence", ["quote", "none"] as const, false);
  num(ctx, o, path, "samples", { min: 1, max: ROUTINE_LIMITS.samples, int: true });
  if (o.uses !== undefined) {
    checkRef(ctx, scope, o.uses, join(path, "uses"), {
      item: true,
      steps: ["locate", "extract", "diff", "infer"],
      state: ROUTINE_STATE_TYPES
    });
  }
  oneOf(ctx, o, path, "model", ROUTINE_INFER_MODELS, false);
  if (o.recall !== undefined) {
    const rp = join(path, "recall");
    const r = object(ctx, o.recall, rp, ["library"]);
    if (r) {
      if (r.library === undefined) add(ctx, join(rp, "library"), "is required");
      else {
        const lp = join(rp, "library");
        const lib = object(ctx, r.library, lp, ["top_k"]);
        if (lib) num(ctx, lib, lp, "top_k", { required: true, min: 1, max: ROUTINE_LIMITS.recallTopK, int: true });
      }
    }
  }
}

/** `remember`: save a value under a declared `value` state key, from a reference or short literal text. */
function rememberStep(ctx: Ctx, scope: Scope, o: Record<string, unknown>, path: string): void {
  const key = patterned(ctx, o, path, "key", NAME, "must be a state key (lower-case letters, digits and underscores)");
  if (key !== undefined) {
    const type = ctx.state.get(key);
    if (!type) add(ctx, join(path, "key"), `state.${key} is not declared; declare it under "state" as "value" first`);
    else if (type !== "value") add(ctx, join(path, "key"), `state.${key} is a ${type}; remember can only save into a "value" key`);
  }
  if (o.from === undefined) {
    add(ctx, join(path, "from"), "is required: a reference or short literal text");
    return;
  }
  const from = str(ctx, o, path, "from", { max: ROUTINE_LIMITS.rememberChars });
  if (from !== undefined && looksLikeRef(from)) {
    checkRef(ctx, scope, from, join(path, "from"), { item: true, steps: ["extract", "infer"], state: ["value"] });
  }
}

/** Text that is a reference (and so must resolve) rather than literal text. */
const looksLikeRef = (v: string): boolean => v.startsWith("$") || v.startsWith("state.");
/** What a subject, a value or a verify entry may point at. Never an `act` step: nothing an act does feeds another step. */
const ACT_TEXT_REFS: RefRules = { item: true, steps: ["extract", "infer"], state: ["value"] };

/** Text for an `act` that is literal or a reference; bounded either way. */
function actText(ctx: Ctx, scope: Scope, v: unknown, path: string, max: number): void {
  if (typeof v !== "string") {
    add(ctx, path, "must be a string: literal text or a reference");
    return;
  }
  if (v.length === 0) {
    add(ctx, path, "must not be empty");
    return;
  }
  if (v.length > max) {
    add(ctx, path, `is ${v.length} characters; the limit is ${max}`);
    return;
  }
  if (CONTROL_CHARS.test(v)) {
    add(ctx, path, "must not contain control characters");
    return;
  }
  if (looksLikeRef(v)) checkRef(ctx, scope, v, path, ACT_TEXT_REFS);
}

function actStep(ctx: Ctx, scope: Scope, o: Record<string, unknown>, path: string): void {
  const action = oneOf(ctx, o, path, "action", ROUTINE_ACT_ACTIONS);
  oneOf(ctx, o, path, "effect", ROUTINE_EFFECTS);
  str(ctx, o, path, "target", { required: true, max: ROUTINE_LIMITS.actTargetChars });
  enumList(ctx, o, path, "strategies", ROUTINE_STRATEGIES, { required: true, min: 1, max: ROUTINE_STRATEGIES.length });
  num(ctx, o, path, "min_confidence", { required: true, min: 0, max: 1 });
  oneOf(ctx, o, path, "on_low", ROUTINE_ON_LOW);
  if (o.subject !== undefined) {
    const p = join(path, "subject");
    if (typeof o.subject === "string") checkRef(ctx, scope, o.subject, p, ACT_TEXT_REFS);
    else add(ctx, p, `must be a reference string (${describeRules(ACT_TEXT_REFS)})`);
  }
  if (action === "click") {
    if (o.value !== undefined) add(ctx, join(path, "value"), "is only for fill and select; a click has no value");
  } else if (action !== undefined) {
    if (o.value === undefined) add(ctx, join(path, "value"), `is required for ${action}`);
    else actText(ctx, scope, o.value, join(path, "value"), ROUTINE_LIMITS.actValueChars);
  }
  if (o.verify === undefined) {
    add(ctx, join(path, "verify"), "is required: say what must be true on the page afterwards (present and/or absent)");
    return;
  }
  const vp = join(path, "verify");
  const v = object(ctx, o.verify, vp, ["present", "absent"]);
  if (!v) return;
  if (v.present === undefined && v.absent === undefined) {
    add(ctx, vp, "needs at least one of present or absent: an action without a check afterwards is not allowed");
    return;
  }
  for (const key of ["present", "absent"] as const) {
    const list = array(ctx, v, vp, key, { min: 1, max: ROUTINE_LIMITS.verifyEntries });
    list?.forEach((entry, i) => actText(ctx, scope, entry, `${join(vp, key)}[${i}]`, ROUTINE_LIMITS.verifyChars));
  }
}

function branchStep(ctx: Ctx, scope: Scope, o: Record<string, unknown>, path: string): void {
  const on = o.on;
  if (on === undefined) {
    add(ctx, join(path, "on"), "is required: the id of an earlier infer step");
  } else if (typeof on !== "string" || !NAME.test(on)) {
    add(ctx, join(path, "on"), 'must be the bare id of an earlier infer step (for example "relevance", without "$")');
  } else {
    const target = scope.visible.get(on);
    if (!target) {
      add(ctx, join(path, "on"), ctx.ids.has(on) ? `"${on}" is not available here; it must be defined earlier in the same or an enclosing step list` : `no step with id "${on}" is defined before this branch`);
    } else if (target.kind !== "infer") {
      add(ctx, join(path, "on"), `"${on}" is a ${target.kind} step; branch.on must name an infer step`);
    }
  }
  if (scope.depth >= ROUTINE_LIMITS.maxNesting) {
    add(ctx, path, `branch cannot be nested this deeply; at most ${ROUTINE_LIMITS.maxNesting} levels are allowed`);
    return;
  }
  let present = false;
  let nonEmpty = false;
  for (const arm of ["accept", "maybe", "reject"] as const) {
    const v = o[arm];
    if (v === undefined) continue;
    present = true;
    if (Array.isArray(v) && v.length > 0) nonEmpty = true;
    stepList(
      ctx,
      v,
      join(path, arm),
      { visible: new Map(scope.visible), inLoop: scope.inLoop, ...(scope.loopAgainst ? { loopAgainst: scope.loopAgainst } : {}), depth: scope.depth + 1 },
      { nonEmpty: false }
    );
  }
  if (!present) add(ctx, path, "needs at least one of accept, maybe or reject");
  else if (!nonEmpty) add(ctx, path, "has no steps in any arm");
}

// ── Sections ─────────────────────────────────────────────────────────────────

function scopeSection(ctx: Ctx, v: unknown): void {
  const before = ctx.errors.length;
  const o = object(ctx, v, "scope", ["start", "follow", "max_pages_per_run"]);
  if (!o) return;
  const start = array(ctx, o, "scope", "start", { required: true, min: 1, max: ROUTINE_LIMITS.startUrls });
  let good = start !== undefined;
  start?.forEach((u, i) => {
    const p = `scope.start[${i}]`;
    if (typeof u !== "string") {
      add(ctx, p, "must be a URL string");
      good = false;
      return;
    }
    if (u.length > ROUTINE_LIMITS.urlChars) {
      add(ctx, p, `is ${u.length} characters; the limit is ${ROUTINE_LIMITS.urlChars}`);
      good = false;
      return;
    }
    const parsed = parseHttpUrl(u);
    if (!parsed.ok) {
      add(ctx, p, `${parsed.reason} (only http and https URLs are allowed)`);
      good = false;
    }
  });
  if (start) ctx.startCount = start.length;
  const f = o.follow;
  let followOk = true;
  if (f !== undefined) {
    const fo = object(ctx, f, "scope.follow", ["same_site", "allow_hosts", "max_depth"]);
    if (fo) {
      bool(ctx, fo, "scope.follow", "same_site");
      const hosts = array(ctx, fo, "scope.follow", "allow_hosts", { max: ROUTINE_LIMITS.allowHosts });
      hosts?.forEach((h, i) => {
        const p = `scope.follow.allow_hosts[${i}]`;
        if (typeof h !== "string" || h.length > 253 || !HOST.test(h)) {
          add(ctx, p, 'must be a lower-case host name such as "example.com" or "*.example.com" (no scheme, path or port)');
          followOk = false;
        } else if (h.startsWith("*.") && !h.slice(2).includes(".")) {
          add(ctx, p, `"${h}" is too broad; a wildcard must cover a specific domain such as *.example.com`);
          followOk = false;
        }
      });
      const depth = num(ctx, fo, "scope.follow", "max_depth", { min: 0, max: ROUTINE_LIMITS.maxDepth, int: true });
      if (fo.max_depth !== undefined && depth === undefined) followOk = false;
      if (fo.allow_hosts !== undefined && hosts === undefined) followOk = false;
      if (fo.same_site !== undefined && typeof fo.same_site !== "boolean") followOk = false;
      ctx.maxDepth = depth ?? 1;
    } else {
      followOk = false;
    }
  }
  num(ctx, o, "scope", "max_pages_per_run", { required: true, min: 1, max: ROUTINE_LIMITS.maxPagesPerRun, int: true });
  ctx.scopeOk = good && followOk && ctx.errors.length === before;
  if (ctx.scopeOk) {
    ctx.spec.scope = JSON.parse(JSON.stringify(o)) as RoutineSpec["scope"];
  }
}

function triggerSection(ctx: Ctx, v: unknown): void {
  if (!isObject(v)) {
    add(ctx, "trigger", "must be an object");
    return;
  }
  const kind = oneOf(ctx, v, "trigger", "kind", ["manual", "interval", "schedule", "event"] as const);
  if (!kind) {
    object(ctx, v, "trigger", ["kind"]);
    return;
  }
  switch (kind) {
    case "manual":
      object(ctx, v, "trigger", ["kind"]);
      break;
    case "interval": {
      object(ctx, v, "trigger", ["kind", "every", "jitter_pct", "active_hours"]);
      const every = patterned(ctx, v, "trigger", "every", EVERY, 'must be a duration like "30m", "6h" or "1d" (minutes, hours or days; at least 1m)');
      if (every !== undefined) {
        const minutes = parseEveryMinutes(every)!;
        if (minutes > ROUTINE_LIMITS.intervalMaxDays * 1440) add(ctx, "trigger.every", `must be at most ${ROUTINE_LIMITS.intervalMaxDays}d`);
      }
      num(ctx, v, "trigger", "jitter_pct", { min: 0, max: 50 });
      const hours = patterned(ctx, v, "trigger", "active_hours", ACTIVE_HOURS, 'must look like "08:00-22:00"', false);
      if (hours !== undefined && hours.slice(0, 5) === hours.slice(6)) add(ctx, "trigger.active_hours", "start and end must differ");
      break;
    }
    case "schedule": {
      object(ctx, v, "trigger", ["kind", "cron", "timezone"]);
      const cron = str(ctx, v, "trigger", "cron", { required: true, max: 100 });
      if (cron !== undefined) {
        const parsed = parseCron(cron);
        if (!parsed.ok) add(ctx, "trigger.cron", parsed.error);
      }
      const tz = patterned(ctx, v, "trigger", "timezone", TIMEZONE, 'must be an IANA time zone such as "Europe/Berlin" or "UTC"', false);
      if (tz !== undefined) {
        try {
          new Intl.DateTimeFormat("en", { timeZone: tz });
        } catch {
          add(ctx, "trigger.timezone", `"${tz}" is not a known time zone`);
        }
      }
      break;
    }
    case "event": {
      object(ctx, v, "trigger", ["kind", "watch"]);
      str(ctx, v, "trigger", "watch", { required: true });
      break;
    }
  }
}

function stateSection(ctx: Ctx, v: unknown): void {
  ctx.state.set("notes", "log");
  if (v === undefined) return;
  if (!isObject(v)) {
    add(ctx, "state", 'must be an object mapping keys to "set", "log" or "value"');
    return;
  }
  const keys = Object.keys(v).sort();
  if (keys.length > ROUTINE_LIMITS.stateKeys) {
    add(ctx, "state", `declares ${keys.length} keys; the limit is ${ROUTINE_LIMITS.stateKeys}`);
    return;
  }
  for (const key of keys) {
    const p = `state.${key}`;
    if (!NAME.test(key)) {
      add(ctx, p, "state keys must be lower-case letters, digits and underscores, starting with a letter");
      continue;
    }
    const t = v[key];
    if (typeof t !== "string" || !(ROUTINE_STATE_TYPES as readonly string[]).includes(t)) {
      add(ctx, p, `must be one of ${ROUTINE_STATE_TYPES.join(" | ")}`);
      continue;
    }
    if (key === "notes" && t !== "log") {
      add(ctx, p, '"notes" is reserved for the notes log and must be "log"');
      continue;
    }
    ctx.state.set(key, t as StateTypeName);
  }
}

function relatedSection(ctx: Ctx, v: unknown): void {
  const o = object(ctx, v, "related", ["discover", "accept_at", "limit_per_run", "needs"]);
  if (!o) return;
  str(ctx, o, "related", "discover", { required: true });
  num(ctx, o, "related", "accept_at", { required: true, min: 0, max: 1 });
  num(ctx, o, "related", "limit_per_run", { required: true, min: 1, max: ROUTINE_LIMITS.relatedPerRun, int: true });
  if (o.needs === undefined) add(ctx, "related.needs", 'is required and must be "human_approval"');
  else if (o.needs !== "human_approval") {
    add(ctx, "related.needs", 'must be "human_approval": widening a routine\'s scope always needs a human');
  }
}

function stopSection(ctx: Ctx, v: unknown): void {
  const o = object(ctx, v, "stop", ["any", "budgets"]);
  if (!o) return;
  const any = array(ctx, o, "stop", "any", { max: ROUTINE_LIMITS.stopConditions });
  any?.forEach((c, i) => {
    const p = `stop.any[${i}]`;
    if (!isObject(c)) {
      add(ctx, p, "must be an object");
      return;
    }
    const kind = ["after_runs", "after_days", "when_inferred", "when_count"].find((k) => has(c, k));
    if (!kind) {
      object(ctx, c, p, ["after_runs", "after_days", "when_inferred", "when_count"]);
      add(ctx, p, "must be one of after_runs, after_days, when_inferred (with confidence) or when_count");
      return;
    }
    switch (kind) {
      case "after_runs":
        object(ctx, c, p, ["after_runs"]);
        num(ctx, c, p, "after_runs", { required: true, min: 1, max: 100_000, int: true });
        break;
      case "after_days":
        object(ctx, c, p, ["after_days"]);
        num(ctx, c, p, "after_days", { required: true, min: 1, max: 3650, int: true });
        break;
      case "when_inferred":
        object(ctx, c, p, ["when_inferred", "confidence"]);
        str(ctx, c, p, "when_inferred", { required: true });
        num(ctx, c, p, "confidence", { required: true, min: 0, max: 1 });
        break;
      case "when_count": {
        object(ctx, c, p, ["when_count"]);
        const wc = object(ctx, c.when_count, `${p}.when_count`, ["key", "at_least"]);
        if (wc) {
          const key = patterned(ctx, wc, `${p}.when_count`, "key", NAME, "must be a declared state key");
          if (key !== undefined) {
            const type = ctx.state.get(key);
            if (!type) add(ctx, `${p}.when_count.key`, `state.${key} is not declared; declare it under "state" first`);
            else if (type === "value") add(ctx, `${p}.when_count.key`, `state.${key} is a value; only a set or log can be counted`);
          }
          num(ctx, wc, `${p}.when_count`, "at_least", { required: true, min: 1, max: 1_000_000, int: true });
        }
        break;
      }
    }
  });
  if (o.budgets !== undefined) {
    const b = object(ctx, o.budgets, "stop.budgets", ["tokens_per_run", "pages_per_run", "cost_usd_total", "runtime_minutes_per_run"]);
    if (b) {
      num(ctx, b, "stop.budgets", "tokens_per_run", { min: 1, max: 50_000_000, int: true });
      num(ctx, b, "stop.budgets", "pages_per_run", { min: 1, max: ROUTINE_LIMITS.maxPagesPerRun, int: true });
      num(ctx, b, "stop.budgets", "cost_usd_total", { min: 0.01, max: 10_000 });
      num(ctx, b, "stop.budgets", "runtime_minutes_per_run", { min: 1, max: 1440, int: true });
    }
  }
}

function onFailureSection(ctx: Ctx, v: unknown): void {
  const o = object(ctx, v, "on_failure", ["retries", "backoff", "pause_after", "notify"]);
  if (!o) return;
  num(ctx, o, "on_failure", "retries", { required: true, min: 0, max: 5, int: true });
  oneOf(ctx, o, "on_failure", "backoff", ["fixed", "exponential"] as const);
  num(ctx, o, "on_failure", "pause_after", { required: true, min: 1, max: 10, int: true });
  bool(ctx, o, "on_failure", "notify", true);
}

function outputSection(ctx: Ctx, v: unknown): void {
  const o = object(ctx, v, "output", ["notes", "report"]);
  if (!o) return;
  oneOf(ctx, o, "output", "notes", ["append"] as const);
  if (o.report !== undefined) {
    const r = object(ctx, o.report, "output.report", ["every", "when"]);
    if (r) {
      patterned(ctx, r, "output.report", "every", EVERY, 'must be a duration like "7d"');
      patterned(ctx, r, "output.report", "when", WHEN, 'must be "always" or "new_notes>N"', false);
    }
  }
}

function safetySection(ctx: Ctx, v: unknown): void {
  const o = object(ctx, v, "safety", ["approval_for", "rate"]);
  if (!o) return;
  enumList(ctx, o, "safety", "approval_for", ROUTINE_APPROVAL_KINDS, { max: ROUTINE_APPROVAL_KINDS.length });
  const rate = patterned(ctx, o, "safety", "rate", RATE, 'must look like "1 request / 2s" or "2 requests / 1s"', false);
  if (rate !== undefined) {
    const m = /^(\d+) requests? \/ (\d+)s$/.exec(rate)!;
    if (Number(m[1]) / Number(m[2]) > ROUTINE_LIMITS.maxRequestsPerSecond) {
      add(ctx, "safety.rate", `allows more than ${ROUTINE_LIMITS.maxRequestsPerSecond} requests per second`);
    }
  }
}

function actionsSection(ctx: Ctx, v: unknown): void {
  const o = object(ctx, v, "actions", ["request", "protect"]);
  if (!o) return;
  if (o.request !== undefined) {
    const r = object(ctx, o.request, "actions.request", ROUTINE_EFFECTS);
    if (r) {
      for (const effect of ROUTINE_EFFECTS) {
        if (r[effect] === undefined) continue;
        const p = `actions.request.${effect}`;
        const e = object(ctx, r[effect], p, ["mode", "per_day", "per_run"]);
        if (!e) continue;
        const mode = oneOf(ctx, e, p, "mode", ["ask", "auto"] as const);
        if (mode === "auto" && !(ROUTINE_AUTO_EFFECTS as readonly string[]).includes(effect)) {
          add(ctx, join(p, "mode"), `${effect} always waits for you; only ${ROUTINE_AUTO_EFFECTS.join(", ")} can be requested as "auto"`);
        }
        num(ctx, e, p, "per_day", { min: 1, max: ROUTINE_LIMITS.actionsPerWindowMax, int: true });
        num(ctx, e, p, "per_run", { min: 1, max: ROUTINE_LIMITS.actionsPerWindowMax, int: true });
      }
    }
  }
  const protect = array(ctx, o, "actions", "protect", { max: ROUTINE_LIMITS.protectNames });
  const seen = new Set<string>();
  protect?.forEach((name, i) => {
    const p = `actions.protect[${i}]`;
    if (typeof name !== "string" || name.trim() === "") {
      add(ctx, p, "must be a non-empty name");
    } else if (name.length > ROUTINE_LIMITS.protectChars) {
      add(ctx, p, `is ${name.length} characters; the limit is ${ROUTINE_LIMITS.protectChars}`);
    } else if (CONTROL_CHARS.test(name)) {
      add(ctx, p, "must not contain control characters");
    } else if (seen.has(name.trim().toLowerCase())) {
      add(ctx, p, `"${name}" is listed twice`);
    } else {
      seen.add(name.trim().toLowerCase());
    }
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────

const TOP_KEYS = ["version", "title", "intent", "scope", "trigger", "steps", "related", "state", "stop", "on_failure", "output", "safety", "actions"] as const;

/** Validate untrusted input. On success the returned spec is a detached deep copy. */
export function validateRoutineSpec(input: unknown): RoutineSpecResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    return { ok: false, errors: [{ path: "(root)", message: "must be plain JSON" }] };
  }
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > ROUTINE_LIMITS.specBytes) {
    return { ok: false, errors: [{ path: "(root)", message: `the spec is ${bytes} bytes; the limit is ${ROUTINE_LIMITS.specBytes}` }] };
  }
  const ctx: Ctx = {
    errors: [],
    ids: new Set(),
    total: 0,
    tooMany: false,
    state: new Map(),
    startCount: 0,
    spec: {},
    scopeOk: false,
    maxDepth: 1
  };
  const root = object(ctx, input, "", TOP_KEYS);
  if (!root) return { ok: false, errors: ctx.errors };

  if (root.version === undefined) add(ctx, "version", `is required and must be ${ROUTINE_SPEC_VERSION}`);
  else if (root.version !== ROUTINE_SPEC_VERSION) add(ctx, "version", `must be ${ROUTINE_SPEC_VERSION}`);
  str(ctx, root, "", "title", { required: true, max: ROUTINE_LIMITS.titleChars });
  str(ctx, root, "", "intent", { required: true, max: ROUTINE_LIMITS.stringChars });
  if (root.scope === undefined) add(ctx, "scope", "is required");
  else scopeSection(ctx, root.scope);
  if (root.trigger === undefined) add(ctx, "trigger", "is required");
  else triggerSection(ctx, root.trigger);
  stateSection(ctx, root.state);
  if (root.steps === undefined) add(ctx, "steps", "is required");
  else stepList(ctx, root.steps, "steps", { visible: new Map(), inLoop: false, depth: 1 }, { nonEmpty: true });
  if (root.related !== undefined) relatedSection(ctx, root.related);
  if (root.stop !== undefined) stopSection(ctx, root.stop);
  if (root.on_failure !== undefined) onFailureSection(ctx, root.on_failure);
  if (root.output !== undefined) outputSection(ctx, root.output);
  if (root.safety !== undefined) safetySection(ctx, root.safety);
  if (root.actions !== undefined) actionsSection(ctx, root.actions);

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors };
  return { ok: true, spec: JSON.parse(serialized) as RoutineSpec };
}
