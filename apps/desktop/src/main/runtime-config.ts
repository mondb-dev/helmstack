/**
 * Runtime configuration toggles read from the environment.
 *
 * Stealth (anti-detection) mode is **opt-in**. By default HelmStack runs as a
 * deterministic, fast instrument: no input jitter and no fingerprint-spoofing
 * injection. This is what front-end developers and CI want. Set
 * `HELMSTACK_STEALTH=1` to re-enable the autonomous-agent stealth behaviours
 * (human-like input timing + anti-detection hardening).
 */
export function isStealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.HELMSTACK_STEALTH ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}
