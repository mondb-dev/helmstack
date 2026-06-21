import { describe, expect, it } from "vitest";

import { isStealthEnabled } from "../src/main/runtime-config.js";

describe("isStealthEnabled", () => {
  it("defaults to off (deterministic actuation)", () => {
    expect(isStealthEnabled({})).toBe(false);
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "" })).toBe(false);
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "0" })).toBe(false);
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "off" })).toBe(false);
  });

  it("enables on truthy values, case/whitespace-insensitive", () => {
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "1" })).toBe(true);
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "true" })).toBe(true);
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "  YES " })).toBe(true);
    expect(isStealthEnabled({ HELMSTACK_STEALTH: "On" })).toBe(true);
  });
});
