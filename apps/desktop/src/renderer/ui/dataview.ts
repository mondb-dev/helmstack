/**
 * Pure helpers for the data-display components (styleguide §3.8–3.12):
 * the score → semantic meter level thresholds. Kept DOM-free so they unit-test directly.
 */

export type MeterLevel = "good" | "warn" | "bad";

export interface MeterThresholds {
  good?: number;
  warn?: number;
  /** When false, lower values are better (e.g. error rates) and thresholds are upper bounds. */
  higherIsBetter?: boolean;
}

/**
 * Map a score to a semantic meter level → `good` (success), `warn` (warning),
 * `bad` (danger). Defaults suit a 0–100 quality score (≥90 good, ≥70 warn).
 */
export function meterLevel(value: number, thresholds: MeterThresholds = {}): MeterLevel {
  const { good = 90, warn = 70, higherIsBetter = true } = thresholds;
  if (higherIsBetter) {
    if (value >= good) return "good";
    if (value >= warn) return "warn";
    return "bad";
  }
  if (value <= good) return "good";
  if (value <= warn) return "warn";
  return "bad";
}
