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

/** Whether the autonomous-agent tool surface should be registered. Opt-in, default off. */
export function isAgentSubstrateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFlagOn(env.HELMSTACK_AGENT_SUBSTRATE);
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
