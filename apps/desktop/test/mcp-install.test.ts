import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSpecSafe,
  buildServerSpec,
  claudeAddArgv,
  codexAddArgv,
  displayCommand,
  entryDiff,
  geminiAddArgv,
  jsonSnippet,
  mergeServer,
  parseClaudeGet,
  parseGeminiList,
  parseInstallRequest,
  readEntry,
  removeServer,
  sanitizeOutput,
  scrubbedEnv,
  writeConfigAtomic
} from "../src/main/mcp-install.js";

const SOURCE = { command: "/usr/local/bin/node", args: ["/opt/HelmStack/mcp/helmstack-mcp.mjs"], env: {} };
const TOKEN_FILE = "/Users/dev/Library/Application Support/HelmStack/agent-token";
const spec = (over: Partial<Parameters<typeof buildServerSpec>[0]> = {}) =>
  buildServerSpec({ source: SOURCE, port: 7070, tokenFile: TOKEN_FILE, toolset: "full", ...over });

describe("buildServerSpec", () => {
  it("carries the port and the token FILE path, nothing else by default", () => {
    expect(spec()).toEqual({
      command: "/usr/local/bin/node",
      args: ["/opt/HelmStack/mcp/helmstack-mcp.mjs"],
      env: { HELMSTACK_PORT: "7070", HELMSTACK_TOKEN_FILE: TOKEN_FILE }
    });
  });

  it("adds toolset and profile only when non-default, and the launcher's env", () => {
    const s = spec({ toolset: "lite", profile: "full", source: { ...SOURCE, env: { ELECTRON_RUN_AS_NODE: "1" } } });
    expect(s.env).toEqual({
      HELMSTACK_PORT: "7070",
      HELMSTACK_TOKEN_FILE: TOKEN_FILE,
      HELMSTACK_TOOLSET: "lite",
      HELMSTACK_PROFILE: "full",
      ELECTRON_RUN_AS_NODE: "1"
    });
    expect(spec({ profile: "fe-dev" }).env.HELMSTACK_PROFILE).toBeUndefined();
  });

  it("never lets a token or an unknown variable into the spec", () => {
    expect(() => assertSpecSafe({ ...spec(), env: { HELMSTACK_AUTH_TOKEN: "s3cret" } })).toThrow(/not allowed/);
    expect(() => assertSpecSafe({ ...spec(), env: { HELMSTACK_TOKEN: "s3cret" } })).toThrow(/not allowed/);
    expect(() => spec({ tokenFile: "relative/token" })).toThrow();
    expect(() => spec({ port: 0 })).toThrow();
    expect(() => spec({ profile: "root" })).toThrow();
    const all = JSON.stringify([spec(), jsonSnippet(spec()), claudeAddArgv(spec()), geminiAddArgv(spec()), codexAddArgv(spec())]);
    expect(all).not.toMatch(/AUTH_TOKEN|s3cret/);
  });
});

describe("argv builders (golden)", () => {
  const s = spec({ toolset: "lite" });
  it("claude: name first because -e is variadic, user scope, command after --", () => {
    expect(claudeAddArgv(s)).toEqual([
      "mcp", "add", "helmstack", "-s", "user",
      "-e", "HELMSTACK_PORT=7070", "-e", `HELMSTACK_TOKEN_FILE=${TOKEN_FILE}`, "-e", "HELMSTACK_TOOLSET=lite",
      "--", "/usr/local/bin/node", "/opt/HelmStack/mcp/helmstack-mcp.mjs"
    ]);
  });
  it("gemini: user scope, stdio, no -- separator", () => {
    expect(geminiAddArgv(s)).toEqual([
      "mcp", "add", "-s", "user", "-t", "stdio",
      "-e", "HELMSTACK_PORT=7070", "-e", `HELMSTACK_TOKEN_FILE=${TOKEN_FILE}`, "-e", "HELMSTACK_TOOLSET=lite",
      "helmstack", "/usr/local/bin/node", "/opt/HelmStack/mcp/helmstack-mcp.mjs"
    ]);
  });
  it("codex: --env flags then -- command", () => {
    expect(codexAddArgv(s).slice(0, 4)).toEqual(["mcp", "add", "helmstack", "--env"]);
    expect(codexAddArgv(s).slice(-3)).toEqual(["--", "/usr/local/bin/node", "/opt/HelmStack/mcp/helmstack-mcp.mjs"]);
  });
  it("displayCommand quotes for readability only", () => {
    expect(displayCommand("/bin/x", ["a b", "it's", "ok"])).toBe("/bin/x 'a b' 'it'\\''s' ok");
  });
});

describe("JSON merge", () => {
  const s = spec();

  it("adds only mcpServers.helmstack and preserves everything else, including indentation and key order", () => {
    const before = `{\n    "theme": "dark",\n    "mcpServers": {\n        "other": { "command": "x", "args": ["1"] }\n    },\n    "zeta": [1, 2]\n}\n`;
    const result = mergeServer(before, s);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toBe("add");
    const parsed = JSON.parse(result.text);
    expect(parsed.theme).toBe("dark");
    expect(parsed.zeta).toEqual([1, 2]);
    expect(parsed.mcpServers.other).toEqual({ command: "x", args: ["1"] });
    expect(parsed.mcpServers.helmstack.env.HELMSTACK_PORT).toBe("7070");
    expect(Object.keys(parsed)).toEqual(["theme", "mcpServers", "zeta"]);
    expect(result.text.startsWith('{\n    "theme"')).toBe(true); // 4-space indent kept
    expect(result.text.endsWith("}\n")).toBe(true);
  });

  it("keeps a BOM, CRLF line endings and tab indentation", () => {
    const before = `\uFEFF{\r\n\t"a": 1\r\n}`;
    const result = mergeServer(before, s);
    if (!result.ok) throw new Error(result.error);
    expect(result.text.charCodeAt(0)).toBe(0xfeff);
    expect(result.text).toContain('\r\n\t"a": 1');
    expect(result.text).not.toMatch(/[^\r]\n/);
    expect(result.text.endsWith("}")).toBe(true);
  });

  it("is idempotent and updates the same entry in place", () => {
    const first = mergeServer(null, s);
    if (!first.ok) throw new Error(first.error);
    expect(first.change).toBe("add");
    const again = mergeServer(first.text, s);
    expect(again.ok && again.change).toBe("none");
    const moved = mergeServer(first.text, spec({ port: 7171 }));
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.change).toBe("update");
    expect(Object.keys(JSON.parse(moved.text).mcpServers)).toEqual(["helmstack"]);
    expect((readEntry(moved.text) as { env: Record<string, string> }).env.HELMSTACK_PORT).toBe("7171");
  });

  it("refuses invalid JSON, non-object roots and a non-object mcpServers", () => {
    for (const bad of ["{ // comment\n}", "{ \"a\": 1, }", "[]", "42", '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      const result = mergeServer(bad, s);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("removes only our key", () => {
    const text = JSON.stringify({ mcpServers: { helmstack: { command: "x" }, keep: { command: "y" } }, other: true }, null, 2);
    const result = removeServer(text);
    if (!result.ok) throw new Error(result.error);
    expect(result.change).toBe("remove");
    expect(JSON.parse(result.text)).toEqual({ mcpServers: { keep: { command: "y" } }, other: true });
    expect(removeServer(result.text)).toMatchObject({ ok: true, change: "none" });
    expect(removeServer("{ nope")).toMatchObject({ ok: false });
  });

  it("renders a diff of just the entry", () => {
    const diff = entryDiff({ command: "old", env: { HELMSTACK_PORT: "1" } }, { command: "new", env: { HELMSTACK_PORT: "1" } }, "/x/mcp.json");
    expect(diff).toContain("--- /x/mcp.json");
    expect(diff).toContain('- "command": "old"');
    expect(diff).toContain('+ "command": "new"');
    expect(diff).toContain('    "HELMSTACK_PORT": "1"');
  });
});

describe("writeConfigAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-write-")));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes via temp+rename, keeps a timestamped .bak and the file mode", () => {
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, '{"old":true}', { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    const { backupPath } = writeConfigAtomic(file, '{"new":true}', new Date("2026-01-02T03:04:05.678Z"));
    expect(fs.readFileSync(file, "utf8")).toBe('{"new":true}');
    expect(backupPath).toBe(`${file}.20260102T030405Z.bak`);
    expect(fs.readFileSync(backupPath as string, "utf8")).toBe('{"old":true}');
    // Windows has no POSIX file modes.
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("creates a new file 0600 with no backup, and follows a symlink to its target", () => {
    const file = path.join(dir, "sub", "mcp.json");
    expect(writeConfigAtomic(file, "{}")).toEqual({});
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const real = path.join(dir, "real.json");
    fs.writeFileSync(real, "{}");
    const link = path.join(dir, "link.json");
    fs.symlinkSync(real, link);
    writeConfigAtomic(link, '{"x":1}');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe('{"x":1}');
  });
});

describe("parsers", () => {
  it("parses `claude mcp get` output defensively", () => {
    const out = [
      "helmstack:", "  Scope: User config (available in all your projects)", "  Status: ✗ Failed to connect", "  Type: stdio",
      "  Command: /usr/local/bin/node", "  Args: /tmp/helmstack-mcp.mjs", "  Environment:", "    HELMSTACK_PORT=7999", "    ELECTRON_RUN_AS_NODE=1", ""
    ].join("\n");
    expect(parseClaudeGet(out, 0)).toMatchObject({
      registered: true,
      command: "/usr/local/bin/node",
      argsText: "/tmp/helmstack-mcp.mjs",
      env: { HELMSTACK_PORT: "7999", ELECTRON_RUN_AS_NODE: "1" }
    });
    expect(parseClaudeGet("No MCP server found with name: helmstack", 1).registered).toBe(false);
    expect(parseClaudeGet("surprise output", 0).registered).toBe(false);
  });

  it("parses `gemini mcp list`, including disabled and ANSI-coloured lines", () => {
    const out = "Warning: MCP servers are configured but disabled.\n\nConfigured MCP servers:\n\n\u001b[32m○\u001b[0m helmstack: /usr/local/bin/node /tmp/helmstack-mcp.mjs (stdio) - Disabled\n";
    expect(parseGeminiList(out)).toMatchObject({ registered: true, command: "/usr/local/bin/node", argsText: "/tmp/helmstack-mcp.mjs", status: "Disabled" });
    expect(parseGeminiList("No MCP servers configured.").registered).toBe(false);
    expect(parseGeminiList("✓ other: node x.js (stdio) - Connected").registered).toBe(false);
  });
});

describe("request validation", () => {
  it("accepts a well-formed request and strips nothing it shouldn't", () => {
    expect(parseInstallRequest({ clientId: "cursor", action: "preview", options: { toolset: "lite", source: "bundled" } })).toEqual({
      clientId: "cursor",
      action: "preview",
      options: { toolset: "lite", source: "bundled" }
    });
  });
  it("rejects unknown clients, actions, option keys and values", () => {
    const bad: unknown[] = [
      null, "x", [],
      { clientId: "vim", action: "install" },
      { clientId: "cursor", action: "exec" },
      { clientId: "cursor", action: "install", command: "rm -rf /" },
      { clientId: "cursor", action: "install", options: { path: "/etc/passwd" } },
      { clientId: "cursor", action: "install", options: { toolset: "huge" } },
      { clientId: "cursor", action: "install", options: { scope: "project" } },
      { clientId: "cursor", action: "install", options: { source: "curl" } },
      { clientId: "cursor", action: "install", options: { confirm: "../../x" } }
    ];
    for (const raw of bad) expect(() => parseInstallRequest(raw), JSON.stringify(raw)).toThrow();
  });
});

describe("child hygiene", () => {
  it("scrubs the environment down to an allowlist", () => {
    const env = scrubbedEnv({ PATH: "/bin", HOME: "/h", HELMSTACK_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", HTTPS_PROXY: "p" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
  it("sanitises and bounds CLI output", () => {
    expect(sanitizeOutput("\u001b[31mboom\u001b[0m\n\u0007line2")).toBe("boom line2");
    expect(sanitizeOutput("x".repeat(1000)).length).toBe(400);
  });
});
