/**
 * Capability gating for the MCP tool surface.
 *
 * The autonomous-agent tools (accounts/TOTP, approvals, handoffs, intent) are a
 * distinct surface a front-end developer never needs. They are registered only
 * when the `agent-substrate` capability is enabled, so the default tool list
 * stays lean and unconfusing. See docs/positioning.md.
 */

/** Parse a boolean-ish env flag (mirrors apps/desktop runtime-config). */
export function isFlagOn(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * `HELMSTACK_PROFILE` presets the opt-in surfaces: `agent-substrate` / `full`
 * enable them; `fe-dev` (or unset) leave them off. An explicit per-flag env var
 * always overrides. Mirrors apps/desktop runtime-config (separate process).
 */
function profileEnablesAgentSurfaces(env: NodeJS.ProcessEnv): boolean {
  const profile = (env.HELMSTACK_PROFILE ?? "").trim().toLowerCase();
  return profile === "agent-substrate" || profile === "full";
}

/**
 * Whether the autonomous-agent tool surface should be registered. Opt-in:
 * enabled by `HELMSTACK_AGENT_SUBSTRATE` or `HELMSTACK_PROFILE=agent-substrate`
 * (an explicit `HELMSTACK_AGENT_SUBSTRATE` always wins). Default off.
 */
export function isAgentSubstrateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = (env.HELMSTACK_AGENT_SUBSTRATE ?? "").trim();
  if (explicit !== "") return isFlagOn(explicit);
  return profileEnablesAgentSurfaces(env);
}

/**
 * Canonical list of tool names gated behind the `agent-substrate` capability.
 * Kept in sync with `registerAgentSubstrateTools()` in index.ts and asserted by
 * the gating test, so the list and the registration can't silently drift.
 */
export const AGENT_SUBSTRATE_TOOLS = [
  "browser_list_approvals",
  "browser_approve",
  "browser_reject",
  "browser_list_handoffs",
  "browser_resolve_handoff",
  "browser_list_accounts",
  "browser_lookup_accounts",
  "browser_generate_totp",
  "browser_get_intent",
  "browser_set_intent"
] as const;
