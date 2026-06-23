import { describe, expect, it } from "vitest";

import { isSocialPerceptionEnabled, isStealthEnabled } from "../src/main/runtime-config.js";

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

describe("isSocialPerceptionEnabled", () => {
  it("defaults to off (lean front-end perception)", () => {
    expect(isSocialPerceptionEnabled({})).toBe(false);
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "" })).toBe(false);
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "0" })).toBe(false);
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "off" })).toBe(false);
  });

  it("enables on truthy values, case/whitespace-insensitive", () => {
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "1" })).toBe(true);
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "true" })).toBe(true);
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "  YES " })).toBe(true);
    expect(isSocialPerceptionEnabled({ HELMSTACK_SOCIAL: "On" })).toBe(true);
  });
});

describe("HELMSTACK_PROFILE presets", () => {
  it("fe-dev (and unset) leaves all agent surfaces off", () => {
    expect(isStealthEnabled({ HELMSTACK_PROFILE: "fe-dev" })).toBe(false);
    expect(isSocialPerceptionEnabled({ HELMSTACK_PROFILE: "fe-dev" })).toBe(false);
    expect(isStealthEnabled({})).toBe(false);
  });

  it("agent-substrate / full turn all agent surfaces on", () => {
    expect(isStealthEnabled({ HELMSTACK_PROFILE: "agent-substrate" })).toBe(true);
    expect(isSocialPerceptionEnabled({ HELMSTACK_PROFILE: "agent-substrate" })).toBe(true);
    expect(isStealthEnabled({ HELMSTACK_PROFILE: "full" })).toBe(true);
    expect(isSocialPerceptionEnabled({ HELMSTACK_PROFILE: "FULL" })).toBe(true); // case-insensitive
  });

  it("an explicit per-flag env var overrides the profile (both directions)", () => {
    // profile on, flag forced off
    expect(isStealthEnabled({ HELMSTACK_PROFILE: "full", HELMSTACK_STEALTH: "0" })).toBe(false);
    // profile off, flag forced on
    expect(isSocialPerceptionEnabled({ HELMSTACK_PROFILE: "fe-dev", HELMSTACK_SOCIAL: "1" })).toBe(true);
  });

  it("ignores an unknown profile (falls back to off)", () => {
    expect(isStealthEnabled({ HELMSTACK_PROFILE: "banana" })).toBe(false);
  });
});
