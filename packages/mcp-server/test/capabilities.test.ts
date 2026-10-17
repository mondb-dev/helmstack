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

  it("report tools are part of the default FE-dev surface and not in lite", async () => {
    for (const name of ["browser_create_report", "browser_list_reports"]) {
      expect(AGENT_SUBSTRATE_TOOLS).not.toContain(name);
      expect(await registeredTools(undefined)).toContain(name);
      expect(LITE_TOOLS).not.toContain(name);
    }
    expect(await registeredToolsWith({ HELMSTACK_TOOLSET: "lite" })).not.toContain("browser_create_report");
  });

  it("audit-style tools tell the model to offer a report, and the create tool says what to pass", async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    const tools = (mod.server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    for (const name of ["browser_a11y_audit", "browser_seo_audit", "browser_health_report", "browser_layout_issues", "browser_performance", "browser_focus_order", "browser_network_audit"]) {
      expect(tools[name]?.description, name).toContain("offer to prepare a report (browser_create_report)");
    }
    const create = tools.browser_create_report!.description!;
    expect(create).toMatch(/user asked for a report/);
    expect(create).toMatch(/YOUR OWN/);
    expect(create).toMatch(/not verified by HelmStack/);
    expect(create).toMatch(/Returns:/);
  });

  it("routine tools are part of the default FE-dev surface, not substrate, not lite", async () => {
    const names = ["browser_routine_schema", "browser_propose_routine", "browser_list_routines", "browser_get_routine", "browser_withdraw_routine"];
    for (const name of names) {
      expect(AGENT_SUBSTRATE_TOOLS).not.toContain(name);
      expect(await registeredTools(undefined)).toContain(name);
      expect(LITE_TOOLS).not.toContain(name);
    }
    const lite = await registeredToolsWith({ HELMSTACK_TOOLSET: "lite" });
    for (const name of names) expect(lite).not.toContain(name);
  });

  it("there is no tool that approves, runs, stops or deletes a routine", async () => {
    const all = await registeredTools("1");
    const routineTools = all.filter((n) => /routine/.test(n)).sort();
    expect(routineTools).toEqual(["browser_get_routine", "browser_list_routines", "browser_propose_routine", "browser_routine_schema", "browser_withdraw_routine"]);
  });

  it("browser_propose_routine is a translation guide for the model", async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    const tools = (mod.server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    const d = tools.browser_propose_routine!.description!;
    expect(d).toMatch(/Nothing runs when you call this/);
    expect(d).toMatch(/When to use it: the user asks you to watch, monitor/);
    expect(d).toMatch(/call browser_routine_schema/);
    expect(d).toMatch(/intent: the user's own words, verbatim/);
    expect(d).toMatch(/narrow/);
    expect(d).toMatch(/allow_hosts/);
    expect(d).toMatch(/accept_at and reject_below/);
    expect(d).toMatch(/on_uncertain "note_as_maybe"/);
    expect(d).toMatch(/Always set stop conditions/);
    expect(d).toMatch(/budgets/);
    expect(d).toMatch(/Never try to use credentials/);
    expect(d).toMatch(/needs their approval in the HelmStack window|needs the user's approval|approve it in the HelmStack window/);
    expect(d).toMatch(/runs manual and interval routines while HelmStack is open/);
    expect(d).toMatch(/model the user chooses in the Routines tab/);
    expect(d).toMatch(/Returns:/);
    expect(tools.browser_routine_schema!.description).toMatch(/Call this before browser_propose_routine/);
    expect(tools.browser_withdraw_routine!.description).toMatch(/only withdraw your own/);
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
