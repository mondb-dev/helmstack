/**
 * "Connect an agent" — pure core. Electron-free and side-effect free except
 * for `writeConfigAtomic`, so it is unit-testable.
 *
 * Safety invariants (asserted by tests):
 *  - the entry we write is always named `helmstack` and nothing else is touched;
 *  - the spec only ever contains the token FILE path, never the token;
 *  - JSON configs are parsed, one key is set, and the file is written
 *    atomically with a timestamped `.bak`; a file that is not valid JSON is
 *    never overwritten;
 *  - argv arrays only — nothing is ever passed through a shell.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MCP_CLIENT_IDS,
  MCP_INSTALL_ACTIONS,
  type McpClientId,
  type McpInstallRequest,
  type McpToolset
} from "../../../../packages/shared/src/mcp-install.js";

export const SERVER_NAME = "helmstack";
export const NPM_PACKAGE = "@helmstack/mcp-server";

// ── Server spec ──────────────────────────────────────────────────────────────

export type ServerSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** A resolved way of launching the MCP server (before port/token are added). */
export type LaunchSource = {
  command: string;
  args: string[];
  /** Extra env the launcher needs, e.g. ELECTRON_RUN_AS_NODE=1. */
  env: Record<string, string>;
};

export type SpecInput = {
  source: LaunchSource;
  port: number;
  tokenFile: string;
  toolset: McpToolset;
  /** Omit (or `fe-dev`) for the default profile. */
  profile?: string;
};

const ALLOWED_ENV_KEYS = new Set([
  "HELMSTACK_PORT",
  "HELMSTACK_TOKEN_FILE",
  "HELMSTACK_TOOLSET",
  "HELMSTACK_PROFILE",
  "ELECTRON_RUN_AS_NODE"
]);
const PROFILES = new Set(["agent-substrate", "full"]);

export function buildServerSpec(input: SpecInput): ServerSpec {
  const { port, tokenFile } = input;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  if (typeof tokenFile !== "string" || !path.isAbsolute(tokenFile) || tokenFile.includes("\0")) {
    throw new Error("The token file path must be absolute.");
  }
  if (input.toolset !== "full" && input.toolset !== "lite") throw new Error("Invalid toolset.");
  const env: Record<string, string> = {
    HELMSTACK_PORT: String(port),
    HELMSTACK_TOKEN_FILE: tokenFile
  };
  if (input.toolset === "lite") env.HELMSTACK_TOOLSET = "lite";
  if (input.profile && input.profile !== "fe-dev") {
    if (!PROFILES.has(input.profile)) throw new Error("Invalid profile.");
    env.HELMSTACK_PROFILE = input.profile;
  }
  for (const [key, value] of Object.entries(input.source.env)) env[key] = value;
  const spec: ServerSpec = { command: input.source.command, args: [...input.source.args], env };
  assertSpecSafe(spec);
  return spec;
}

/** Throws if the spec could carry a secret or a malformed value. */
export function assertSpecSafe(spec: ServerSpec): void {
  for (const [key, value] of Object.entries(spec.env)) {
    if (!ALLOWED_ENV_KEYS.has(key)) throw new Error(`Environment variable ${key} is not allowed in a client config.`);
    if (typeof value !== "string" || value.includes("\0") || value.includes("\n")) throw new Error(`Invalid value for ${key}.`);
  }
  for (const part of [spec.command, ...spec.args]) {
    if (typeof part !== "string" || part.length === 0 || part.includes("\0")) throw new Error("Invalid command.");
  }
}

/** The JSON entry for `mcpServers.helmstack`. */
export function jsonEntry(spec: ServerSpec): { command: string; args: string[]; env: Record<string, string> } {
  return { command: spec.command, args: [...spec.args], env: { ...spec.env } };
}

/** A paste-ready `{ "mcpServers": { "helmstack": … } }` snippet. */
export function jsonSnippet(spec: ServerSpec): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: jsonEntry(spec) } }, null, 2);
}

// ── argv builders (one golden per CLI) ───────────────────────────────────────

const envFlags = (spec: ServerSpec, flag: string): string[] =>
  Object.entries(spec.env).flatMap(([key, value]) => [flag, `${key}=${value}`]);

/** `claude mcp add helmstack -s user -e K=V … -- <command> <args…>` (name first: `-e` is variadic). */
export function claudeAddArgv(spec: ServerSpec): string[] {
  return ["mcp", "add", SERVER_NAME, "-s", "user", ...envFlags(spec, "-e"), "--", spec.command, ...spec.args];
}
export const claudeRemoveArgv = (): string[] => ["mcp", "remove", SERVER_NAME, "-s", "user"];
export const claudeGetArgv = (): string[] => ["mcp", "get", SERVER_NAME];

/** `gemini mcp add -s user -t stdio -e K=V … helmstack <command> <args…>` (verified: no `--`; `-y` style args pass through). */
export function geminiAddArgv(spec: ServerSpec): string[] {
  return ["mcp", "add", "-s", "user", "-t", "stdio", ...envFlags(spec, "-e"), SERVER_NAME, spec.command, ...spec.args];
}
export const geminiRemoveArgv = (): string[] => ["mcp", "remove", "-s", "user", SERVER_NAME];
export const geminiListArgv = (): string[] => ["mcp", "list"];

/** `codex mcp add helmstack --env K=V … -- <command> <args…>` (documented, not run locally). */
export function codexAddArgv(spec: ServerSpec): string[] {
  return ["mcp", "add", SERVER_NAME, ...envFlags(spec, "--env"), "--", spec.command, ...spec.args];
}
export const codexRemoveArgv = (): string[] => ["mcp", "remove", SERVER_NAME];
export const codexGetArgv = (): string[] => ["mcp", "get", SERVER_NAME];

/** Display-only shell rendering of an argv (POSIX quoting; never executed). */
export function displayCommand(binary: string, argv: readonly string[]): string {
  const q = (part: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`);
  return [binary, ...argv].map(q).join(" ");
}

// ── Reading registered entries from CLI output (defensive) ───────────────────

export type FoundEntry = {
  registered: boolean;
  command?: string;
  /** Space-joined; the CLIs print args as one string. */
  argsText?: string;
  env: Record<string, string>;
  /** Status text such as "Connected" / "Disabled", when printed. */
  status?: string;
};

const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** `claude mcp get helmstack`. */
export function parseClaudeGet(stdout: string, exitCode: number): FoundEntry {
  const text = stripAnsi(stdout);
  const none: FoundEntry = { registered: false, env: {} };
  if (exitCode !== 0 || /no mcp server found/i.test(text)) return none;
  if (!new RegExp(`^\\s*${SERVER_NAME}:\\s*$`, "m").test(text)) return none;
  const entry: FoundEntry = { registered: true, env: {} };
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    const field = /^\s{2}([A-Za-z ]+):\s*(.*)$/.exec(line);
    if (field) {
      inEnv = field[1] === "Environment";
      const value = field[2].trim();
      if (field[1] === "Command") entry.command = value;
      else if (field[1] === "Args") entry.argsText = value;
      else if (field[1] === "Status") entry.status = value;
      continue;
    }
    const kv = inEnv ? /^\s{4}([A-Z0-9_]+)=(.*)$/.exec(line) : null;
    if (kv) entry.env[kv[1]] = kv[2];
  }
  return entry;
}

/** `gemini mcp list`: "✓ helmstack: /usr/bin/node /x.mjs (stdio) - Connected". */
export function parseGeminiList(stdout: string): FoundEntry {
  const text = stripAnsi(stdout);
  const line = new RegExp(`^\\s*\\S?\\s*${SERVER_NAME}:\\s+(.*?)\\s+\\((?:stdio|sse|http)\\)(?:\\s+-\\s+(.*))?\\s*$`, "m").exec(text);
  if (!line) return { registered: false, env: {} };
  const rest = line[1];
  const space = rest.indexOf(" ");
  return {
    registered: true,
    command: space === -1 ? rest : rest.slice(0, space),
    argsText: space === -1 ? "" : rest.slice(space + 1),
    env: {},
    status: line[2]?.trim()
  };
}

/** `codex mcp get helmstack` — format is unverified, so only registration + obvious fields. */
export function parseCodexGet(stdout: string, exitCode: number): FoundEntry {
  const text = stripAnsi(stdout);
  if (exitCode !== 0 || !text.includes(SERVER_NAME) || /not found|no mcp server/i.test(text)) return { registered: false, env: {} };
  const env: Record<string, string> = {};
  for (const match of text.matchAll(/\b(HELMSTACK_PORT|HELMSTACK_TOKEN_FILE|HELMSTACK_TOOLSET|HELMSTACK_PROFILE)\s*[=:]\s*"?([^\s",}\]]+)/g)) {
    env[match[1]] = match[2];
  }
  return { registered: true, env };
}

export type EntryAssessment = { matches: boolean; issues: string[] };

/**
 * Compares a registered entry with what we would install now. `exists` checks
 * absolute paths (entry file, executable, token file). Non-strict only reports
 * a broken entry (port, missing files); strict also reports any difference.
 */
export function assessEntry(found: FoundEntry, expected: ServerSpec, exists: (p: string) => boolean, strict = false): EntryAssessment {
  const issues: string[] = [];
  const foundPort = found.env.HELMSTACK_PORT;
  if (foundPort !== undefined && foundPort !== expected.env.HELMSTACK_PORT) {
    issues.push(`It points at port ${foundPort}; this HelmStack is on ${expected.env.HELMSTACK_PORT}.`);
  }
  const foundToken = found.env.HELMSTACK_TOKEN_FILE;
  if (foundToken !== undefined) {
    if (foundToken !== expected.env.HELMSTACK_TOKEN_FILE) issues.push("It uses a different token file.");
    else if (!exists(foundToken)) issues.push("Its token file is missing.");
  }
  if (found.command && path.isAbsolute(found.command) && !exists(found.command)) {
    issues.push("Its command no longer exists.");
  }
  const argsText = found.argsText ?? "";
  const entryFile = argsText.split(" ").find((part) => /helmstack-mcp\.mjs$/.test(part) && path.isAbsolute(part));
  if (entryFile && !exists(entryFile)) issues.push("The HelmStack MCP server file it points at is missing.");
  if (strict) {
    const sameCommand = found.command === undefined || found.command === expected.command;
    const sameArgs = found.argsText === undefined || found.argsText === expected.args.join(" ");
    if (!sameCommand || !sameArgs) issues.push("It launches a different command than the one selected.");
    const sameEnv = Object.entries(expected.env).every(([k, v]) => found.env[k] === v) && Object.keys(found.env).every((k) => k in expected.env);
    if (!sameEnv) issues.push("Its settings differ from the current ones.");
  }
  return { matches: issues.length === 0, issues };
}

// ── JSON config merge ────────────────────────────────────────────────────────

type Layout = { bom: boolean; eol: "\n" | "\r\n"; indent: string; finalNewline: boolean };

function detectLayout(text: string): Layout {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = /\n([ \t]+)\S/.exec(body.replace(/\r\n/g, "\n"));
  return { bom, eol, indent: indentMatch ? indentMatch[1] : "  ", finalNewline: /\n$/.test(body) };
}

function serialize(value: unknown, layout: Layout): string {
  let out = JSON.stringify(value, null, layout.indent);
  if (layout.eol === "\r\n") out = out.replace(/\n/g, "\r\n");
  if (layout.finalNewline) out += layout.eol;
  return (layout.bom ? "﻿" : "") + out;
}

export type JsonConfigResult =
  | { ok: true; text: string; change: "add" | "update" | "remove" | "none"; before: unknown; after: unknown }
  | { ok: false; error: string };

type Parsed = { ok: true; value: Record<string, unknown>; layout: Layout; empty: boolean } | { ok: false; error: string };

function parseConfig(text: string | null): Parsed {
  if (text === null || text.trim() === "") {
    return { ok: true, value: {}, layout: { bom: false, eol: "\n", indent: "  ", finalNewline: true }, empty: true };
  }
  const layout = detectLayout(text);
  let value: unknown;
  try {
    value = JSON.parse(layout.bom ? text.slice(1) : text);
  } catch {
    return { ok: false, error: "The config file is not valid JSON (comments and trailing commas are not supported), so it was left untouched." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "The config file's top level is not a JSON object, so it was left untouched." };
  }
  return { ok: true, value: value as Record<string, unknown>, layout, empty: false };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]));
  }
  return value;
}

/** Current `mcpServers.helmstack` value of a config text (undefined when absent or unparsable). */
export function readEntry(text: string | null): unknown {
  const parsed = parseConfig(text);
  if (!parsed.ok) return undefined;
  const servers = parsed.value.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>)[SERVER_NAME] : undefined;
}

/** Sets only `mcpServers.helmstack`; preserves every other key, server, BOM, EOL and indentation. */
export function mergeServer(text: string | null, spec: ServerSpec): JsonConfigResult {
  const parsed = parseConfig(text);
  if (!parsed.ok) return parsed;
  const root = parsed.value;
  if (root.mcpServers !== undefined && (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers))) {
    return { ok: false, error: "`mcpServers` in the config file is not an object, so it was left untouched." };
  }
  const servers = (root.mcpServers ?? {}) as Record<string, unknown>;
  const before = servers[SERVER_NAME];
  const after = jsonEntry(spec);
  if (before !== undefined && sameJson(before, after)) {
    return { ok: true, text: text ?? "", change: "none", before, after };
  }
  servers[SERVER_NAME] = after;
  root.mcpServers = servers;
  return { ok: true, text: serialize(root, parsed.layout), change: before === undefined ? "add" : "update", before, after };
}

/** Removes only `mcpServers.helmstack`. */
export function removeServer(text: string | null): JsonConfigResult {
  const parsed = parseConfig(text);
  if (!parsed.ok) return parsed;
  const servers = parsed.value.mcpServers;
  if (parsed.empty || !servers || typeof servers !== "object" || Array.isArray(servers) || !(SERVER_NAME in (servers as object))) {
    return { ok: true, text: text ?? "", change: "none", before: undefined, after: undefined };
  }
  const before = (servers as Record<string, unknown>)[SERVER_NAME];
  delete (servers as Record<string, unknown>)[SERVER_NAME];
  return { ok: true, text: serialize(parsed.value, parsed.layout), change: "remove", before, after: undefined };
}

/** Line diff of the `mcpServers.helmstack` entry (before → after). */
export function entryDiff(before: unknown, after: unknown, filePath?: string): string {
  const render = (value: unknown): string[] =>
    value === undefined ? [] : JSON.stringify(value, null, 2).split("\n").slice(1, -1).map((l) => l.slice(2).replace(/,$/, ""));
  const a = render(before);
  const b = render(after);
  const lines: string[] = [];
  if (filePath) lines.push(`--- ${filePath}`, `+++ ${filePath}`);
  lines.push('@@ mcpServers.helmstack @@');
  const inB = new Set(b);
  const inA = new Set(a);
  for (const line of a) lines.push(inB.has(line) ? `  ${line}` : `- ${line}`);
  for (const line of b) if (!inA.has(line)) lines.push(`+ ${line}`);
  if (a.length === 0 && b.length === 0) lines.push("  (no change)");
  return lines.join("\n");
}

// ── Atomic write ─────────────────────────────────────────────────────────────

export function timestampForBackup(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Writes `text` to `file` atomically (temp + rename in the same directory),
 * after copying an existing file to `<file>.<timestamp>.bak`. Preserves the
 * file mode; new files are created 0600. Follows a symlink to its target.
 * Returns the backup path, if one was made.
 */
export function writeConfigAtomic(file: string, text: string, now: Date = new Date()): { backupPath?: string } {
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {
    // does not exist yet
  }
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  let backupPath: string | undefined;
  if (fs.existsSync(target)) {
    mode = fs.statSync(target).mode & 0o777;
    // Two writes in the same second must not clobber or fail on each other's backup.
    const stem = `${target}.${timestampForBackup(now)}`;
    backupPath = `${stem}.bak`;
    for (let n = 1; fs.existsSync(backupPath); n += 1) backupPath = `${stem}-${n}.bak`;
    fs.copyFileSync(target, backupPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backupPath, mode);
  }
  const temp = path.join(dir, `.${path.basename(target)}.helmstack-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return backupPath ? { backupPath } : {};
}

// ── Request validation ───────────────────────────────────────────────────────

/** Validates an untrusted IPC payload into a clean request; throws on anything unexpected. */
export function parseInstallRequest(raw: unknown): McpInstallRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid request.");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!["clientId", "action", "options"].includes(key)) throw new Error("Invalid request.");
  const clientId = input.clientId;
  if (typeof clientId !== "string" || !(MCP_CLIENT_IDS as readonly string[]).includes(clientId)) throw new Error("Unknown client.");
  const action = input.action;
  if (typeof action !== "string" || !(MCP_INSTALL_ACTIONS as readonly string[]).includes(action)) throw new Error("Unknown action.");
  const options: McpInstallRequest["options"] = {};
  if (input.options !== undefined) {
    if (!input.options || typeof input.options !== "object" || Array.isArray(input.options)) throw new Error("Invalid options.");
    const o = input.options as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!["toolset", "scope", "source", "confirm"].includes(key)) throw new Error("Invalid options.");
    if (o.toolset !== undefined) {
      if (o.toolset !== "full" && o.toolset !== "lite") throw new Error("Invalid toolset.");
      options.toolset = o.toolset;
    }
    if (o.scope !== undefined) {
      if (o.scope !== "user") throw new Error("Invalid scope.");
      options.scope = "user";
    }
    if (o.source !== undefined) {
      if (o.source !== "bundled" && o.source !== "npx") throw new Error("Invalid command source.");
      options.source = o.source;
    }
    if (o.confirm !== undefined) {
      if (typeof o.confirm !== "string" || !/^[0-9a-f]{32}$/.test(o.confirm)) throw new Error("Invalid confirmation.");
      options.confirm = o.confirm;
    }
  }
  return { clientId: clientId as McpClientId, action: action as McpInstallRequest["action"], options };
}

/** Stable id of a plan; install/remove must echo the id of the preview the human confirmed. */
export function planId(plan: unknown): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 32);
}

// ── Child process hygiene ────────────────────────────────────────────────────

const CHILD_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "CODEX_HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT", "USER", "LOGNAME", "SHELL"
];

/** Minimal environment for CLI children: no tokens, no proxies, no inherited secrets. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Strips ANSI/control characters, collapses whitespace and bounds the length. */
export function sanitizeOutput(text: string, max = 400): string {
  const clean = stripAnsi(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
