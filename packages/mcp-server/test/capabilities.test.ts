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
});

/** Import the server module under a given env and return its registered tool names. */
async function registeredTools(flag: string | undefined): Promise<string[]> {
  vi.resetModules();
  const prev = process.env.HELMSTACK_AGENT_SUBSTRATE;
  if (flag === undefined) delete process.env.HELMSTACK_AGENT_SUBSTRATE;
  else process.env.HELMSTACK_AGENT_SUBSTRATE = flag;
  try {
    const mod = await import("../src/index.js");
    const server = mod.server as unknown as { _registeredTools?: Record<string, unknown> };
    return Object.keys(server._registeredTools ?? {});
  } finally {
    if (prev === undefined) delete process.env.HELMSTACK_AGENT_SUBSTRATE;
    else process.env.HELMSTACK_AGENT_SUBSTRATE = prev;
  }
}

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
});
