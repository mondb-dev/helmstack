/**
 * Small, DOM-free formatting helpers shared by the shell panels.
 */

/** Host of a URL for compact labels; falls back to the raw value. */
export function safeHostLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

/** Where a bare search term goes. `%s` is replaced with the URL-encoded query. */
export const DEFAULT_SEARCH_URL_TEMPLATE = "https://duckduckgo.com/?q=%s";

const HOST_PATTERN = /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}$/u;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
/** `host:port` (and `[::1]:port`) must not be mistaken for a URL scheme. */
const HOST_PORT_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[^\s/:?#]+):\d{1,5}(?:[/?#]|$)/;

/** Hosts that are served over plain http in practice (local dev). */
function prefersHttp(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".test") ||
    IPV4_PATTERN.test(h) ||
    h.startsWith("[")
  );
}

function searchUrl(query: string, template: string): string {
  return template.replace("%s", encodeURIComponent(query));
}

/**
 * Address-bar input → navigable URL.
 *
 * - Explicit schemes are kept (`https://`, `http://`, `file://`, `about:blank`),
 *   except `javascript:`, which is never navigated to from the bar (it becomes a search).
 * - `host:port` forms (`localhost:3000`, `127.0.0.1:4177`) get `http://` for
 *   local-dev hosts and `https://` otherwise.
 * - Dotted hosts (`example.com`, `example.com/path?q=1`) get `https://`
 *   (`http://` for localhost / IPs / `.local` / `.test`).
 * - Anything else — bare words, anything with spaces — searches `searchTemplate`.
 */
export function normalizeNavigationTarget(rawValue: string, searchTemplate: string = DEFAULT_SEARCH_URL_TEMPLATE): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }
  if (/\s/.test(value)) {
    return searchUrl(value, searchTemplate);
  }
  if (!HOST_PORT_PATTERN.test(value) && SCHEME_PATTERN.test(value)) {
    return /^javascript:/i.test(value) ? searchUrl(value, searchTemplate) : value;
  }
  const withoutSlashes = value.replace(/^\/\//, "");
  const hostEnd = withoutSlashes.search(/[/?#]/);
  const authority = hostEnd === -1 ? withoutSlashes : withoutSlashes.slice(0, hostEnd);
  const host = authority.replace(/^[^@]*@/, "").replace(/:\d{1,5}$/, "");
  const hasPort = /:\d{1,5}$/.test(authority) || HOST_PORT_PATTERN.test(withoutSlashes);
  const isHostLike = host.toLowerCase() === "localhost" || HOST_PATTERN.test(host) || IPV4_PATTERN.test(host) || host.startsWith("[");
  if (!isHostLike && !(hasPort && host.length > 0)) {
    return searchUrl(value, searchTemplate);
  }
  return `${prefersHttp(host) ? "http" : "https"}://${withoutSlashes}`;
}

/** "just now", "12s ago", "3m ago", "2h ago", "4d ago". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "1 client" / "3 clients". */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Shorten to at most `max` characters by replacing the middle with "…". */
export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…".slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}
