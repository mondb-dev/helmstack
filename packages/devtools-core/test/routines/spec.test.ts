import { describe, expect, it } from "vitest";

import { ROUTINE_LIMITS } from "../../../shared/src/index.js";
import { validateRoutineSpec, MAX_ERRORS } from "../../src/core/routines/validate.js";
import { INVALID, VALID } from "./corpus.js";
import { canonical, minimal } from "./fixtures.js";

describe("validateRoutineSpec", () => {
  it("accepts the canonical example and returns a detached copy", () => {
    const input = canonical();
    const result = validateRoutineSpec(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec).toEqual(input);
    expect(result.spec).not.toBe(input);
    expect(result.spec.scope).not.toBe(input.scope);
  });

  it.each(VALID.map((v) => [v.name, v] as const))("accepts %s", (_name, v) => {
    const result = validateRoutineSpec(v.spec());
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it(`rejects ${INVALID.length} kinds of bad spec with the right path`, () => {
    expect(INVALID.length).toBeGreaterThanOrEqual(25);
    const problems: string[] = [];
    for (const bad of INVALID) {
      const result = validateRoutineSpec(bad.make());
      if (result.ok) {
        problems.push(`${bad.name}: accepted`);
        continue;
      }
      const first = result.errors[0]!;
      if (result.errors.length > MAX_ERRORS) problems.push(`${bad.name}: ${result.errors.length} errors`);
      if (first.path !== bad.path) problems.push(`${bad.name}: first error at ${first.path} (${first.message}), wanted ${bad.path}`);
      else if (bad.says && !first.message.includes(bad.says)) problems.push(`${bad.name}: message "${first.message}" lacks "${bad.says}"`);
    }
    expect(problems).toEqual([]);
  });

  it("is deterministic: the same bad input yields the same errors in the same order", () => {
    const bad = canonical() as any;  
    bad.zzz = 1;
    bad.aaa = 2;
    bad.steps[1].min_confidence = 7;
    bad.trigger.every = "1s";
    const a = validateRoutineSpec(bad);
    const b = validateRoutineSpec(structuredClone(bad));
    expect(a).toEqual(b);
    if (a.ok) throw new Error("expected errors");
    // Unknown keys are reported in sorted order.
    expect(a.errors.slice(0, 2).map((e) => e.path)).toEqual(["aaa", "zzz"]);
  });

  it("caps the error list at 20", () => {
    const bad = minimal() as any;  
    for (let i = 0; i < 50; i += 1) bad[`unknown_${String(i).padStart(2, "0")}`] = i;
    const result = validateRoutineSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(20);
  });

  it("does not mutate its input and survives hostile shapes", () => {
    const input = canonical();
    const before = JSON.stringify(input);
    validateRoutineSpec(input);
    expect(JSON.stringify(input)).toBe(before);

    const cyclic: Record<string, unknown> = { version: 1 };
    cyclic.self = cyclic;
    expect(validateRoutineSpec(cyclic).ok).toBe(false);
    expect(validateRoutineSpec(JSON.parse('{"__proto__": {"polluted": true}}')).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(validateRoutineSpec(undefined).ok).toBe(false);
    expect(validateRoutineSpec("a string").ok).toBe(false);
  });

  it("rejects a pathologically deep step tree without recursing without bound", () => {
    let step: any = { do: "wait", for: "1s" };  
    for (let i = 0; i < 300; i += 1) step = { do: "for_each", items: "state.w", limit: 1, steps: [step] };
    const spec = minimal() as any;  
    spec.state = { w: "set" };
    spec.steps = [step];
    const result = validateRoutineSpec(spec);
    expect(result.ok).toBe(false);
  });

  it("states the limits it enforces", () => {
    expect(ROUTINE_LIMITS.specBytes).toBe(64 * 1024);
    expect(ROUTINE_LIMITS.maxSteps).toBe(60);
    expect(ROUTINE_LIMITS.maxNesting).toBe(4);
  });
});
