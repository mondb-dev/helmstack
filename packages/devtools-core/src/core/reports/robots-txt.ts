/**
 * Small robots.txt parser + matcher following RFC 9309 / Google's documented
 * behaviour: groups are keyed by user-agent token, the most specific (longest)
 * matching rule wins, `Allow` wins ties, `*` matches any run of characters and
 * a trailing `$` anchors the end of the path. Pure and dependency-free.
 */

export type RobotsRule = { allow: boolean; pattern: string };
export type RobotsGroup = { agents: string[]; rules: RobotsRule[] };
export type ParsedRobots = { groups: RobotsGroup[]; sitemaps: string[] };

export type RobotsDecision = {
  allowed: boolean;
  /** The winning rule, or null when no rule matched (allowed by default). */
  rule: RobotsRule | null;
  /** The user-agent token whose group was used ("*" when falling back). */
  group: string;
};

/** Percent-encode non-ASCII only, so patterns and paths compare consistently. */
function normalizePath(value: string): string {
  let out = "";
  for (const ch of value) {
    out += ch.charCodeAt(0) > 127 ? encodeURIComponent(ch) : ch;
  }
  return out;
}

export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let collectingAgents = false;

  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (const raw of lines) {
    const noComment = raw.replace(/#.*$/, "").trim();
    if (!noComment) continue;
    const colon = noComment.indexOf(":");
    if (colon < 0) continue;
    const field = noComment.slice(0, colon).trim().toLowerCase();
    const value = noComment.slice(colon + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      collectingAgents = true;
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field === "allow" || field === "disallow") {
      collectingAgents = false;
      if (!current) continue; // rule before any user-agent: ignored
      // An empty `Disallow:` means "allow everything" and carries no restriction.
      if (value === "") continue;
      current.rules.push({ allow: field === "allow", pattern: normalizePath(value) });
      continue;
    }
    // Other fields (crawl-delay, host, …) end an agent run but are not evaluated.
    collectingAgents = false;
  }
  return { groups, sitemaps };
}

/** True when `pattern` (with `*` and optional trailing `$`) matches the start of `path`. */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  let anchored = false;
  let p = pattern;
  if (p.endsWith("$")) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const parts = p.split("*");
  if (!path.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return anchored ? path.length === pos : true;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    if (last && anchored) return path.length - part.length >= pos && path.endsWith(part);
    const idx = path.indexOf(part, pos);
    if (idx < 0) return false;
    pos = idx + part.length;
  }
  return true;
}

/**
 * Decide whether `userAgentToken` (e.g. "googlebot", "*") may fetch `path`
 * (pathname + search). Falls back to the `*` group when no group names the
 * token; with no matching group at all everything is allowed.
 */
export function evaluateRobots(parsed: ParsedRobots, userAgentToken: string, path: string): RobotsDecision {
  const token = userAgentToken.toLowerCase();
  const named = token === "*" ? [] : parsed.groups.filter((g) => g.agents.includes(token));
  const matching = named.length > 0 ? named : parsed.groups.filter((g) => g.agents.includes("*"));
  const group = named.length > 0 ? token : "*";
  const target = normalizePath(path || "/");

  let best: RobotsRule | null = null;
  for (const g of matching) {
    for (const rule of g.rules) {
      if (!robotsPatternMatches(rule.pattern, target)) continue;
      if (
        !best ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
  }
  return { allowed: best ? best.allow : true, rule: best, group };
}
