/**
 * Runtime configuration toggles read from the environment.
 *
 * The defaults make HelmStack a lean, deterministic front-end instrument; the
 * autonomous-agent surfaces are **opt-in** so a developer pointing it at
 * `localhost:3000` doesn't pay for machinery they never asked for.
 */

/** Parse a boolean-ish env flag: on for `1` / `true` / `on` / `yes` (case/space-insensitive). */
function isFlagOn(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * Convenience profile that presets the opt-in agent flags. `HELMSTACK_PROFILE`:
 *  - `fe-dev` (or unset) — lean front-end instrument; all agent surfaces off.
 *  - `agent-substrate` / `full` — autonomous-agent use; all agent surfaces on.
 *
 * An explicit per-flag env var (e.g. `HELMSTACK_STEALTH`) always overrides the
 * profile. Mirrored in `@helmstack/mcp-server`'s `capabilities.ts` (the MCP
 * server is a separate process). See docs/positioning.md.
 */
export type HelmstackProfile = "fe-dev" | "agent-substrate" | "full";

function profileEnablesAgentSurfaces(env: NodeJS.ProcessEnv): boolean {
  const profile = (env.HELMSTACK_PROFILE ?? "").trim().toLowerCase();
  return profile === "agent-substrate" || profile === "full";
}

/** Resolve an opt-in flag: explicit env var wins; otherwise the profile default; otherwise off. */
function resolveAgentFlag(env: NodeJS.ProcessEnv, explicitName: string): boolean {
  const explicit = (env[explicitName] ?? "").trim();
  if (explicit !== "") return isFlagOn(explicit);
  return profileEnablesAgentSurfaces(env);
}

/**
 * Stealth (anti-detection) mode — **opt-in**. By default HelmStack runs with no
 * input jitter and no fingerprint-spoofing injection (what front-end devs and CI
 * want). Enable with `HELMSTACK_STEALTH=1` or `HELMSTACK_PROFILE=agent-substrate`
 * (human-like input timing + anti-detection hardening).
 */
export function isStealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAgentFlag(env, "HELMSTACK_STEALTH");
}

/**
 * Social-surface perception — **opt-in**. By default HelmStack does not run the
 * social-feed/profile/thread classification (`collectSocialSurface`), so a plain
 * web app is never mislabelled `social-feed` and pays nothing for feed-scraping
 * heuristics. Enable with `HELMSTACK_SOCIAL=1` or
 * `HELMSTACK_PROFILE=agent-substrate`. See docs/positioning.md.
 */
export function isSocialPerceptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAgentFlag(env, "HELMSTACK_SOCIAL");
}
