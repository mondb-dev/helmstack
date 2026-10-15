// Pure extractors: read source files, return plain data. No file writes.
import { ENV, IGNORED } from "./env-descriptions.mjs";
import { ROOT, importTs, read, walk } from "./lib.mjs";

// ── HTTP routes ─────────────────────────────────────────────────────────────

const AGENT_SERVER = "packages/devtools-core/src/http/agent-server.ts";
const METHODS = "GET|POST|PUT|PATCH|DELETE";

/** Normalise a route path so doc-block and regex routes can be compared. */
export function normalizeRoute(p) {
  return p
    .replace(/\/:[A-Za-z]+/g, "/:p")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

export function extractRoutes(source = read(AGENT_SERVER)) {
  const start = source.indexOf("REST endpoints\n");
  const sse = source.indexOf(" * SSE stream", start);
  if (start < 0 || sse < 0) throw new Error("agent-server.ts: route doc block not found");
  const block = source
    .slice(start, sse)
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n");
  // Some entries share a line in the source comment; split on every method token.
  const entries = [];
  const re = new RegExp(`(?:^|\\s)(${METHODS})\\s+(\\/api\\/\\S+)([^\\n]*?)(?=\\s+(?:${METHODS})\\s+\\/api\\/|\\n|$)`, "g");
  for (const m of block.matchAll(re)) {
    entries.push({ method: m[1], path: m[2], notes: m[3].trim().replace(/^[→-]\s*/, "→ ").replace(/^\*\s*/, "") });
  }
  if (entries.length < 50) throw new Error(`agent-server.ts: only ${entries.length} routes parsed; the doc block format changed`);

  const sseStart = source.indexOf("GET  /api/stream", sse);
  const evLine = /Events:\s*([^\n]+)/.exec(source.slice(sseStart, sseStart + 600));
  const events = evLine ? evLine[1].split("|").map((s) => s.trim()).filter(Boolean) : [];

  // Routes the code matches, found from its regexes / literals.
  const code = new Set();
  for (const m of source.matchAll(/p === "(\/api\/[^"]+)"/g)) code.add(normalizeRoute(m[1]));
  const TOKEN = String.raw`(?:\\.|\[[^\]]*\]|[^/\\\[\n])`;
  const matchRe = new RegExp(String.raw`p\.match\(\/\^(${TOKEN}+)\$\/\)`, "g");
  for (const m of source.matchAll(matchRe)) {
    let route = m[1].replace(/\\\//g, "/");
    route = route.replace(/\(\[\^\/\]\+\)|\[\^\/\]\+|\(\.\+\)/g, ":p");
    const alt = /\(([a-z]+(?:\|[a-z]+)+)\)/.exec(route);
    if (alt) for (const word of alt[1].split("|")) code.add(normalizeRoute(route.replace(alt[0], word)));
    else code.add(normalizeRoute(route.replace(/\(([^)]*)\)/g, ":p")));
  }
  for (const m of source.matchAll(/p\.startsWith\("(\/api\/[a-z]+)\/"\)/g)) code.add(normalizeRoute(m[1]));
  const documented = new Set(entries.map((e) => normalizeRoute(e.path)));
  documented.add("/api/stream");
  // An alternation like storage/(local|session) is covered by a documented `/storage/:area`.
  const covered = (c) => documented.has(c) || documented.has(c.replace(/\/[^/]+$/, "/:p"));
  const undocumented = [...code].filter((c) => !covered(c)).sort();
  return { entries, events, undocumented };
}

// ── MCP tools ───────────────────────────────────────────────────────────────

const MCP = "packages/mcp-server/src/index.ts";

export function extractMcpTools(source = read(MCP)) {
  const tools = [];
  const LIT = '(?:"(?:[^"\\\\]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`)';
  const re = new RegExp(String.raw`\.tool\(\s*"(browser_[a-z0-9_]+)",\s*((?:${LIT}\s*(?:\+\s*)?)+)`, "g");
  for (const m of source.matchAll(re)) {
    const description = [...m[2].matchAll(new RegExp(LIT, "g"))]
      .map((s) => (s[0][0] === '"' ? JSON.parse(s[0]) : s[0].slice(1, -1).replace(/\\(.)/g, "$1")))
      .join("");
    tools.push({ name: m[1], description });
  }
  const sub = /AGENT_SUBSTRATE_TOOLS = \[([\s\S]*?)\] as const/.exec(source);
  if (!sub) throw new Error("mcp-server: AGENT_SUBSTRATE_TOOLS not found");
  const substrate = new Set([...sub[1].matchAll(/"(browser_[a-z0-9_]+)"/g)].map((s) => s[1]));
  const names = tools.map((t) => t.name);
  const missing = [...substrate].filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`mcp-server: substrate tools not registered: ${missing.join(", ")}`);
  if (new Set(names).size !== names.length) throw new Error("mcp-server: duplicate tool names");
  return {
    full: tools.filter((t) => !substrate.has(t.name)),
    substrate: tools.filter((t) => substrate.has(t.name))
  };
}

export async function extractLiteTools() {
  const mod = await importTs("packages/agent-sdk/src/lite/schemas.ts");
  return mod.LITE_TOOL_SCHEMAS.map((t) => ({
    name: t.name,
    description: t.description,
    params: t.params.map((p) => ({
      name: p.name,
      type: p.type === "enum" ? p.enum.join("/") : p.type,
      required: p.required,
      description: p.description
    }))
  }));
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

export async function extractShortcuts() {
  const mod = await importTs("packages/shared/src/shortcuts.ts");
  return { mac: mod.shortcutSections("mac"), win: mod.shortcutSections("win"), linux: mod.shortcutSections("linux") };
}

// ── Environment variables ───────────────────────────────────────────────────

/** Scan sources for env reads. Returns Map name → sorted unique files. */
export function scanEnv() {
  const found = new Map();
  const add = (name, file) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(file);
  };
  const srcFiles = [
    ...walk("apps", /\.(ts|mjs)$/).filter((f) => !/[\\/]test[\\/]/.test(f)),
    ...walk("packages", /\.(ts|mjs)$/).filter((f) => !/[\\/]test[\\/]/.test(f)),
    ...walk("scripts", /\.mjs$/).filter((f) => !f.startsWith("scripts/docs"))
  ];
  for (const file of srcFiles) {
    const text = read(file);
    for (const m of text.matchAll(/\b(HELMSTACK_[A-Z0-9_]+)\b/g)) add(m[1], file);
    for (const m of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]{3,})\b/g)) add(m[1], file);
    for (const m of text.matchAll(/\benv\["([A-Z][A-Z0-9_]{3,})"\]/g)) add(m[1], file);
  }
  const testFiles = [...walk("apps", /\.ts$/), ...walk("packages", /\.ts$/)].filter((f) => /[\\/]test[\\/]/.test(f));
  for (const file of testFiles) {
    const text = read(file);
    for (const m of text.matchAll(/\b(HELMSTACK_CONTRACT_[A-Z]+|CI_REQUIRE_CHROME)\b/g)) add(m[1], file);
  }
  return found;
}

export function envRows() {
  const found = scanEnv();
  const unknown = [];
  const rows = [];
  for (const [name, files] of [...found].sort(([a], [b]) => a.localeCompare(b))) {
    if (IGNORED.has(name)) continue;
    const meta = ENV[name];
    if (!meta) {
      unknown.push(`${name} (${[...files][0]})`);
      continue;
    }
    rows.push({ name, ...meta, files: [...files].sort() });
  }
  if (unknown.length) {
    throw new Error(
      `Environment variables read in code but not described in scripts/docs/env-descriptions.mjs:\n  ${unknown.join("\n  ")}`
    );
  }
  const stale = Object.keys(ENV).filter((k) => !found.has(k));
  return { rows, stale };
}

export { ROOT };

// ── Design tokens ───────────────────────────────────────────────────────────

const TOKENS = "apps/desktop/src/renderer/styles/tokens.css";

/** Custom properties of tokens.css: `scale` (theme-independent), `dark`, `light`. */
export function extractTokens(source = read(TOKENS)) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = { scale: new Map(), dark: new Map(), light: new Map() };
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const target = /data-theme="light"/.test(selector)
      ? out.light
      : /data-theme="dark"/.test(selector)
        ? out.dark
        : selector === ":root"
          ? out.scale
          : null;
    if (!target) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) target.set(d[1], d[2].trim().replace(/\s+/g, " "));
  }
  if (out.dark.size === 0 || out.light.size === 0) throw new Error("tokens.css: theme blocks not found");
  return out;
}
