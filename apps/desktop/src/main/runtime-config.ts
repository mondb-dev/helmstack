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
 * Stealth (anti-detection) mode — **opt-in**. By default HelmStack runs with no
 * input jitter and no fingerprint-spoofing injection (what front-end devs and CI
 * want). Set `HELMSTACK_STEALTH=1` to re-enable the autonomous-agent stealth
 * behaviours (human-like input timing + anti-detection hardening).
 */
export function isStealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFlagOn(env.HELMSTACK_STEALTH);
}

/**
 * Social-surface perception — **opt-in**. By default HelmStack does not run the
 * social-feed/profile/thread classification (`collectSocialSurface`), so a plain
 * web app is never mislabelled `social-feed` and pays nothing for feed-scraping
 * heuristics. Set `HELMSTACK_SOCIAL=1` to enable it for autonomous-agent use on
 * social platforms. See docs/positioning.md.
 */
export function isSocialPerceptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isFlagOn(env.HELMSTACK_SOCIAL);
}
