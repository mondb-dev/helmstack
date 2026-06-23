import { describe, expect, it, vi } from "vitest";

import { AGENT_SUBSTRATE_TOOLS, isAgentSubstrateEnabled, isFlagOn } from "../src/capabilities.js";

describe("capabilities helpers", () => {
  it("isFlagOn parses boolean-ish values", () => {
    expect(isFlagOn(undefined)).toBe(false);
    expect(isFlagOn("")).toBe(false);
    expect(isFlagOn("0")).toBe(false);
    expect(isFlagOn("off")).toBe(false);
    expect(isFlagOn("1")).toBe(true);
    expect(isFlagOn("true")).toBe(true);
    expect(isFlagOn("  YES ")).toBe(true);
    expect(isFlagOn("On")).toBe(true);
  });

  it("isAgentSubstrateEnabled defaults off, opt-in via HELMSTACK_AGENT_SUBSTRATE", () => {
    expect(isAgentSubstrateEnabled({})).toBe(false);
    expect(isAgentSubstrateEnabled({ HELMSTACK_AGENT_SUBSTRATE: "1" })).toBe(true);
  });

  it("HELMSTACK_PROFILE presets the capability; explicit flag overrides", () => {
    expect(isAgentSubstrateEnabled({ HELMSTACK_PROFILE: "fe-dev" })).toBe(false);
    expect(isAgentSubstrateEnabled({ HELMSTACK_PROFILE: "agent-substrate" })).toBe(true);
    expect(isAgentSubstrateEnabled({ HELMSTACK_PROFILE: "full" })).toBe(true);
    expect(isAgentSubstrateEnabled({ HELMSTACK_PROFILE: "banana" })).toBe(false);
    // explicit override, both directions
    expect(isAgentSubstrateEnabled({ HELMSTACK_PROFILE: "full", HELMSTACK_AGENT_SUBSTRATE: "0" })).toBe(false);
    expect(isAgentSubstrateEnabled({ HELMSTACK_PROFILE: "fe-dev", HELMSTACK_AGENT_SUBSTRATE: "1" })).toBe(true);
  });
});

const GATE_KEYS = ["HELMSTACK_AGENT_SUBSTRATE", "HELMSTACK_PROFILE"] as const;

/** Import the server module under a given env patch and return its registered tool names. */
async function registeredToolsWith(patch: Partial<Record<(typeof GATE_KEYS)[number], string>>): Promise<string[]> {
  vi.resetModules();
  const saved = Object.fromEntries(GATE_KEYS.map((k) => [k, process.env[k]]));
  for (const k of GATE_KEYS) delete process.env[k];
  Object.assign(process.env, patch);
  try {
    const mod = await import("../src/index.js");
    const server = mod.server as unknown as { _registeredTools?: Record<string, unknown> };
    return Object.keys(server._registeredTools ?? {});
  } finally {
    for (const k of GATE_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

const registeredTools = (flag: string | undefined): Promise<string[]> =>
  registeredToolsWith(flag === undefined ? {} : { HELMSTACK_AGENT_SUBSTRATE: flag });

describe("MCP tool gating", () => {
  it("omits the agent-substrate tools by default (lean FE-dev surface)", async () => {
    const tools = await registeredTools(undefined);
    for (const name of AGENT_SUBSTRATE_TOOLS) {
      expect(tools, `${name} should NOT be registered by default`).not.toContain(name);
    }
    // Core front-end-dev tools remain available without the capability.
    expect(tools).toContain("browser_screenshot");
    expect(tools).toContain("browser_a11y_audit");
    expect(tools).toContain("browser_css_coverage");
  });

  it("registers all agent-substrate tools when HELMSTACK_AGENT_SUBSTRATE is on", async () => {
    const tools = await registeredTools("1");
    for (const name of AGENT_SUBSTRATE_TOOLS) {
      expect(tools, `${name} should be registered when enabled`).toContain(name);
    }
  });

  it("the capability adds exactly the gated tools, nothing else", async () => {
    const off = new Set(await registeredTools(undefined));
    const on = await registeredTools("1");
    const added = on.filter((t) => !off.has(t)).sort();
    expect(added).toEqual([...AGENT_SUBSTRATE_TOOLS].sort());
  });

  it("HELMSTACK_PROFILE=full registers the substrate tools (no explicit flag)", async () => {
    const tools = await registeredToolsWith({ HELMSTACK_PROFILE: "full" });
    for (const name of AGENT_SUBSTRATE_TOOLS) expect(tools).toContain(name);
  });

  it("HELMSTACK_PROFILE=fe-dev keeps them off", async () => {
    const tools = await registeredToolsWith({ HELMSTACK_PROFILE: "fe-dev" });
    for (const name of AGENT_SUBSTRATE_TOOLS) expect(tools).not.toContain(name);
  });
});
