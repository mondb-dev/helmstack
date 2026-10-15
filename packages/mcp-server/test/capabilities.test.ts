import { describe, expect, it, vi } from "vitest";

import { AGENT_SUBSTRATE_TOOLS, LITE_TOOLS, isAgentSubstrateEnabled, isFlagOn, resolveToolset } from "../src/index.js";

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

const GATE_KEYS = ["HELMSTACK_AGENT_SUBSTRATE", "HELMSTACK_PROFILE", "HELMSTACK_TOOLSET"] as const;

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
    expect(tools).toContain("browser_seo_audit");
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

  it("browser_get_selected_element is part of the default FE-dev surface", async () => {
    expect(AGENT_SUBSTRATE_TOOLS).not.toContain("browser_get_selected_element");
    const tools = await registeredTools(undefined);
    expect(tools).toContain("browser_get_selected_element");
    expect(tools).toContain("browser_pick_element");
  });

  it("history tools (reload / back / forward) are part of the default FE-dev surface", async () => {
    const tools = await registeredTools(undefined);
    for (const name of ["browser_reload", "browser_go_back", "browser_go_forward"]) {
      expect(AGENT_SUBSTRATE_TOOLS).not.toContain(name);
      expect(tools).toContain(name);
    }
  });

  it("HELMSTACK_PROFILE=fe-dev keeps them off", async () => {
    const tools = await registeredToolsWith({ HELMSTACK_PROFILE: "fe-dev" });
    for (const name of AGENT_SUBSTRATE_TOOLS) expect(tools).not.toContain(name);
  });
});

describe("toolset selector (HELMSTACK_TOOLSET / --toolset)", () => {
  it("defaults to full; env and flag select lite; the flag wins", () => {
    expect(resolveToolset({}, [])).toBe("full");
    expect(resolveToolset({ HELMSTACK_TOOLSET: "full" }, [])).toBe("full");
    expect(resolveToolset({ HELMSTACK_TOOLSET: "LITE" }, [])).toBe("lite");
    expect(resolveToolset({}, ["--toolset", "lite"])).toBe("lite");
    expect(resolveToolset({}, ["--toolset=lite"])).toBe("lite");
    expect(resolveToolset({ HELMSTACK_TOOLSET: "lite" }, ["--toolset", "full"])).toBe("full");
    expect(resolveToolset({ HELMSTACK_TOOLSET: "banana" }, [])).toBe("full");
  });

  it("is orthogonal to HELMSTACK_PROFILE", () => {
    expect(resolveToolset({ HELMSTACK_PROFILE: "full" }, [])).toBe("full");
    expect(resolveToolset({ HELMSTACK_PROFILE: "fe-dev", HELMSTACK_TOOLSET: "lite" }, [])).toBe("lite");
  });

  it("lite registers exactly the lite tools and none of the full ones", async () => {
    const tools = await registeredToolsWith({ HELMSTACK_TOOLSET: "lite" });
    expect([...tools].sort()).toEqual(
      ["look", "click", "type", "select", "go", "back", "forward", "reload", "scroll", "tabs", "audit", "details", "viewport", "screenshot"].sort()
    );
    expect([...LITE_TOOLS].sort()).toEqual([...tools].sort());
    expect(tools.filter((t) => t.startsWith("browser_"))).toEqual([]);
  });

  it("lite ignores the agent-substrate profile (no approve tool, ever)", async () => {
    const tools = await registeredToolsWith({ HELMSTACK_TOOLSET: "lite", HELMSTACK_PROFILE: "full", HELMSTACK_AGENT_SUBSTRATE: "1" });
    expect(tools).toHaveLength(14);
    for (const name of AGENT_SUBSTRATE_TOOLS) expect(tools).not.toContain(name);
    expect(tools.some((t) => /approv/i.test(t))).toBe(false);
  });

  it("full (the default) still registers none of the lite verbs", async () => {
    const tools = await registeredToolsWith({});
    expect(tools.length).toBeGreaterThan(60);
    for (const name of LITE_TOOLS) expect(tools).not.toContain(name);
    expect(await registeredToolsWith({ HELMSTACK_TOOLSET: "full" })).toEqual(tools);
  });
});
