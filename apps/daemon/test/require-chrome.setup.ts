/**
 * Vitest setup for the real-Chrome projects. Real-Chrome tests skip when no
 * Chrome is found; with CI_REQUIRE_CHROME=1 (the CI `daemon-headless` job)
 * a missing Chrome is a hard failure instead, so the suite can't silently
 * skip its way to green.
 */
import { findChrome } from "../src/chrome.js";

if (process.env.CI_REQUIRE_CHROME === "1") {
  // Throws ChromeNotFoundError (with the install hint) when Chrome is missing.
  findChrome();
}
