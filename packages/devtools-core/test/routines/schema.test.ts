import { describe, expect, it } from "vitest";

import { ROUTINE_SPEC_JSON_SCHEMA } from "../../src/core/routines/schema.js";
import { routineExample } from "../../src/core/routines/example.js";
import { validateRoutineSpec } from "../../src/core/routines/validate.js";
import { INVALID, VALID } from "./corpus.js";
import { schemaAccepts } from "./jsonschema-lite.js";

describe("routine JSON Schema", () => {
  it("is a draft 2020-12 schema that fits comfortably in a model's context", () => {
    expect(ROUTINE_SPEC_JSON_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(JSON.stringify(ROUTINE_SPEC_JSON_SCHEMA).length).toBeLessThan(60_000);
    expect(Object.keys(ROUTINE_SPEC_JSON_SCHEMA.$defs as object)).toEqual(["step_1", "step_2", "step_3", "step_4"]);
  });

  it("accepts every valid case, as the validator does", () => {
    for (const v of VALID) {
      const spec = v.spec();
      expect(validateRoutineSpec(spec).ok, `validator: ${v.name}`).toBe(true);
      expect(schemaAccepts(ROUTINE_SPEC_JSON_SCHEMA, spec), `schema: ${v.name}`).toBe(true);
    }
  });

  it("accepts the example served to models", () => {
    const example = routineExample();
    expect(validateRoutineSpec(example).ok).toBe(true);
    expect(schemaAccepts(ROUTINE_SPEC_JSON_SCHEMA, example)).toBe(true);
  });

  it(`agrees with the validator on ${VALID.length + INVALID.length} specs: the validator rejects every bad one, and the schema rejects exactly those marked as structural`, () => {
    const disagreements: string[] = [];
    for (const bad of INVALID) {
      const input = bad.make();
      if (validateRoutineSpec(input).ok) disagreements.push(`validator accepted: ${bad.name}`);
      const schemaOk = schemaAccepts(ROUTINE_SPEC_JSON_SCHEMA, input);
      if (schemaOk === bad.schemaCatches) disagreements.push(`schema ${schemaOk ? "accepted" : "rejected"} but the corpus says schemaCatches=${bad.schemaCatches}: ${bad.name}`);
    }
    expect(disagreements).toEqual([]);
    // A meaningful share of the corpus is caught by the schema alone.
    expect(INVALID.filter((b) => b.schemaCatches).length).toBeGreaterThanOrEqual(25);
    expect(INVALID.filter((b) => !b.schemaCatches).length).toBeGreaterThanOrEqual(15);
  });
});
