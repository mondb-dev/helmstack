/**
 * The default way the engine reads a site's robots.txt: a plain, time-limited GET with no
 * cookies or credentials. Kept apart from the executor so tests inject their own fetcher.
 */
import type { RobotsFetcher } from "./executor.js";

const ROBOTS_TIMEOUT_MS = 8_000;
const ROBOTS_MAX_BYTES = 512 * 1024;

export const fetchRobotsTxt: RobotsFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", credentials: "omit", headers: { "User-Agent": "HelmStack" } });
    const text = res.ok ? (await res.text()).slice(0, ROBOTS_MAX_BYTES) : "";
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
};
