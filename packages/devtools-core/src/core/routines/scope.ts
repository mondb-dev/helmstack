/**
 * Pure helpers about where a routine may go. Shared by the validator (a literal
 * `open` URL must be in scope) and the preview.
 */
import type { RoutineScope } from "../../../../shared/src/index.js";

export type ParsedUrl = { ok: true; url: URL } | { ok: false; reason: string };

/** An absolute http(s) URL without embedded credentials. */
export function parseHttpUrl(value: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "is not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `must use http or https (got ${url.protocol.replace(/:$/, "")}:)` };
  }
  if (url.username || url.password) return { ok: false, reason: "must not contain a username or password; routines never use credentials" };
  if (!url.hostname) return { ok: false, reason: "has no host" };
  return { ok: true, url };
}

/** Lower-case host with a leading `www.` removed. */
export function normalizeHost(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** `*.example.com` matches subdomains and the apex; anything else must match exactly (ignoring `www.`). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  if (pattern.startsWith("*.")) {
    const apex = normalizeHost(pattern.slice(2));
    return h === apex || h.endsWith(`.${apex}`);
  }
  return h === normalizeHost(pattern);
}

export function maxDepthOf(scope: Pick<RoutineScope, "follow">): number {
  return scope.follow?.max_depth ?? 1;
}

/** True when the routine can follow links to any site: depth allowed, same_site off, no allow-list. */
export function isScopeOpen(scope: Pick<RoutineScope, "follow">): boolean {
  const f = scope.follow ?? {};
  return maxDepthOf(scope) >= 1 && !f.same_site && !(f.allow_hosts && f.allow_hosts.length > 0);
}

export function startHostnames(scope: Pick<RoutineScope, "start">): string[] {
  const out: string[] = [];
  for (const u of scope.start) {
    const parsed = parseHttpUrl(u);
    if (parsed.ok && !out.includes(parsed.url.hostname)) out.push(parsed.url.hostname);
  }
  return out;
}

/** Whether `host` is inside the scope's declared hosts (start hosts plus the allow-list). Open scopes allow anything. */
export function hostInScope(host: string, scope: RoutineScope): boolean {
  if (isScopeOpen(scope)) return true;
  if (startHostnames(scope).some((s) => normalizeHost(s) === normalizeHost(host))) return true;
  return (scope.follow?.allow_hosts ?? []).some((p) => hostMatches(host, p));
}

/** Hosts shown in `RoutineSummary.hosts`: empty when the scope is open. */
export function scopeHosts(scope: RoutineScope): string[] {
  if (isScopeOpen(scope)) return [];
  const out = startHostnames(scope);
  for (const h of scope.follow?.allow_hosts ?? []) if (!out.includes(h)) out.push(h);
  return out;
}
