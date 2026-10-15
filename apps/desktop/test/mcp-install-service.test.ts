import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpInstallService, createMcpInstallIpc, type McpInstallDeps } from "../src/main/mcp-install-service.js";

// The service is exercised with POSIX fake CLIs and macOS/Linux config paths. On Windows the
// install dialog is copy-only (.cmd shims are not spawned), so these suites skip there.
const d = process.platform === "win32" ? describe.skip : describe;

const TOKEN = "SECRET-TOKEN-VALUE-0123456789";

// A fake CLI: records argv + the env it saw, keeps state in $HOME, prints canned output.
const FAKE_CLI = (kind: "claude" | "gemini" | "codex") => `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const home = process.env.HOME; const argv = process.argv.slice(2);
fs.appendFileSync(path.join(home, "calls.log"), JSON.stringify({ cli: "${kind}", argv, env: process.env }) + "\\n");
const state = path.join(home, "${kind}.state.json");
const read = () => fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : null;
if (argv[0] === "--version") { console.log("9.9.9 (fake ${kind})"); process.exit(0); }
if (process.env.FAKE_FAIL && argv[1] === "add") { console.error("\\u001b[31mboom: nope\\u001b[0m"); process.exit(1); }
const env = {}; let i = 2; const rest = [];
for (; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
  if (a === "-e" || a === "--env") { const [k, ...v] = argv[++i].split("="); env[k] = v.join("="); }
  else if (a === "-s" || a === "-t") i++;
  else rest.push(a);
}
if (argv[1] === "add") {
  const name = ${kind === "claude" ? 'argv[2]' : kind === "gemini" ? "rest[0]" : "argv[2]"};
  const cmd = ${kind === "claude" || kind === "codex" ? "rest" : "rest.slice(1)"};
  const entry = read();
  if (entry && "${kind}" !== "gemini") { console.error("already exists"); process.exit(1); }
  fs.writeFileSync(state, JSON.stringify({ name, command: cmd[${kind === "claude" ? 1 : 0}] ?? cmd[0], args: cmd.slice(${kind === "claude" ? 2 : 1}), env }));
  console.log("added"); process.exit(0);
}
if (argv[1] === "remove") { if (!read()) { console.error("not found"); process.exit(1); } fs.rmSync(state); console.log("removed"); process.exit(0); }
const e = read();
if ("${kind}" === "claude" && argv[1] === "get") {
  if (!e) { console.log("No MCP server found with name: helmstack"); process.exit(1); }
  console.log("helmstack:\\n  Scope: User config\\n  Status: ✗ Failed to connect\\n  Type: stdio\\n  Command: " + e.command + "\\n  Args: " + e.args.join(" ") + "\\n  Environment:\\n" + Object.entries(e.env).map(([k, v]) => "    " + k + "=" + v).join("\\n"));
  process.exit(0);
}
if ("${kind}" === "gemini" && argv[1] === "list") {
  // The real CLI writes this list to stderr when it is not attached to a terminal.
  console.error(e ? "Configured MCP servers:\\n\\n✓ helmstack: " + [e.command, ...e.args].join(" ") + " (stdio) - Connected" : "No MCP servers configured.");
  process.exit(0);
}
if ("${kind}" === "codex" && argv[1] === "get") {
  console.log(e ? "helmstack\\n  command: " + e.command : "not found"); process.exit(e ? 0 : 1);
}
process.exit(2);
`;

type Setup = { home: string; bin: string; tokenFile: string; entry: string };
let setup: Setup;
let tmp: string;

function mk(over: Partial<McpInstallDeps> = {}, clis: Array<"claude" | "gemini" | "codex"> = ["claude", "gemini"]): McpInstallService {
  for (const cli of clis) {
    const file = path.join(setup.bin, cli);
    fs.writeFileSync(file, FAKE_CLI(cli), { mode: 0o755 });
  }
  return new McpInstallService({
    homedir: setup.home,
    platform: process.platform,
    env: { PATH: setup.bin, HOME: setup.home, HELMSTACK_AUTH_TOKEN: TOKEN },
    execPath: "/Applications/HelmStack.app/Contents/MacOS/HelmStack",
    electron: true,
    mcpEntry: setup.entry,
    isPackaged: true,
    getConnection: () => ({ port: 7171, tokenFile: setup.tokenFile, profile: "fe-dev" }),
    checkNpmPublished: async () => false,
    now: () => new Date("2026-03-04T05:06:07Z"),
    ...over
  });
}

const calls = (): Array<{ cli: string; argv: string[]; env: Record<string, string> }> => {
  const file = path.join(setup.home, "calls.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-svc-")));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin);
  // node on PATH so the bundled source can run via `node`.
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const entry = path.join(tmp, "dist", "mcp", "helmstack-mcp.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "// fake");
  const tokenFile = path.join(tmp, "agent-token");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  setup = { home, bin, entry, tokenFile };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const client = (o: { clients: Array<{ id: string }> }, id: string) => o.clients.find((c) => c.id === id) as never as import("../../../packages/shared/src/index.js").McpClientStatus;

d("detection", () => {
  it("finds CLIs on PATH with version, reports installed state and not-found for the rest", async () => {
    const service = mk();
    const overview = await service.overview();
    expect(overview.ready).toBe(true);
    expect(client(overview, "claude-code")).toMatchObject({ detected: true, installed: false, canInstall: true, version: "9.9.9 (fake claude)" });
    expect(client(overview, "gemini-cli")).toMatchObject({ detected: true, installed: false });
    expect(client(overview, "codex-cli")).toMatchObject({ detected: false, canInstall: false });
    expect(client(overview, "antigravity")).toMatchObject({ detected: false, canInstall: false });
    expect(client(overview, "cursor")).toMatchObject({ detected: false, canInstall: false });
    expect(client(overview, "generic").kind).toBe("copy-only");
    expect(client(overview, "chatgpt").kind).toBe("explainer");
  });

  it("flags an entry that points at another port or a missing file as needing attention", async () => {
    fs.writeFileSync(
      path.join(setup.home, "claude.state.json"),
      JSON.stringify({ command: process.execPath, args: ["/gone/helmstack-mcp.mjs"], env: { HELMSTACK_PORT: "7070", HELMSTACK_TOKEN_FILE: setup.tokenFile } })
    );
    const status = client(await mk().overview(), "claude-code");
    expect(status).toMatchObject({ installed: true, needsAttention: true });
    expect(status.note).toMatch(/port 7070/);
    expect(status.note).toMatch(/missing/);
  });

  it("does not claim an installed entry that is current needs attention", async () => {
    const service = mk();
    const preview = await service.handle({ clientId: "claude-code", action: "install" });
    await service.handle({ clientId: "claude-code", action: "install", options: { confirm: preview.preview?.previewId } });
    expect(client(await service.overview(), "claude-code")).toMatchObject({ installed: true, needsAttention: false });
  });

  it("is blocked, with a reason, when there is no listening port or token file", async () => {
    const noPort = await mk({ getConnection: () => ({ port: null, tokenFile: setup.tokenFile, profile: "fe-dev" }) }).overview();
    expect(noPort).toMatchObject({ ready: false });
    expect(noPort.blockedReason).toMatch(/isn't listening/);
    expect(client(noPort, "claude-code").canInstall).toBe(false);
    const envToken = await mk({ getConnection: () => ({ port: 7171, tokenFile: null, profile: "fe-dev" }) }).overview();
    expect(envToken.blockedReason).toMatch(/HELMSTACK_AUTH_TOKEN/);
    const result = await mk({ getConnection: () => ({ port: 7171, tokenFile: null, profile: "fe-dev" }) }).handle({ clientId: "claude-code", action: "install" });
    expect(result.ok).toBe(false);
  });
});

d("command source", () => {
  it("prefers node from PATH running the bundled entry; npx is gated on the registry", async () => {
    const overview = await mk().overview();
    const bundled = overview.sources.find((s) => s.id === "bundled");
    const npx = overview.sources.find((s) => s.id === "npx");
    expect(bundled?.available).toBe(true);
    expect(bundled?.commandLine).toContain(path.join(setup.bin, "node"));
    expect(bundled?.commandLine).toContain("helmstack-mcp.mjs");
    expect(npx).toMatchObject({ available: false, reason: "Package not published yet." });
  });

  it("falls back to the HelmStack binary with ELECTRON_RUN_AS_NODE when node is missing", async () => {
    fs.rmSync(path.join(setup.bin, "node"));
    const service = mk();
    const preview = await service.handle({ clientId: "claude-code", action: "preview" });
    expect(preview.preview?.copyText).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(preview.preview?.copyText).toContain("/Applications/HelmStack.app/Contents/MacOS/HelmStack");
    expect(preview.preview?.warnings.join(" ")).toMatch(/app bundle/);
  });

  it("offers npx only when published and npx exists; rejects it otherwise", async () => {
    fs.writeFileSync(path.join(setup.bin, "npx"), "#!/bin/sh\n", { mode: 0o755 });
    const published = mk({ checkNpmPublished: async () => true });
    const overview = await published.overview();
    expect(overview.sources.find((s) => s.id === "npx")).toMatchObject({ available: true });
    const preview = await published.handle({ clientId: "claude-code", action: "preview", options: { source: "npx" } });
    expect(preview.preview?.copyText).toMatch(/npx -y @helmstack\/mcp-server/);
    const refused = await mk().handle({ clientId: "claude-code", action: "preview", options: { source: "npx" } });
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/not published/i);
    const unreachable = await mk({ checkNpmPublished: async () => null }).overview();
    expect(unreachable.sources.find((s) => s.id === "npx")?.reason).toMatch(/Couldn't check/);
  });
});

d("CLI install flow (fake claude / gemini)", () => {
  it("shows the command first, runs nothing until the exact preview is confirmed", async () => {
    const service = mk();
    const first = await service.handle({ clientId: "claude-code", action: "install", options: { toolset: "lite" } });
    expect(first).toMatchObject({ ok: true, needsConfirmation: true });
    expect(first.preview?.commandLine).toContain("mcp add helmstack -s user");
    expect(first.preview?.commandLine).toContain("HELMSTACK_TOOLSET=lite");
    expect(calls().some((c) => c.argv[1] === "add")).toBe(false);

    // A confirmation for a different plan (toolset changed) is refused and runs nothing.
    const stale = await service.handle({ clientId: "claude-code", action: "install", options: { toolset: "full", confirm: first.preview?.previewId } });
    expect(stale).toMatchObject({ ok: false, needsConfirmation: true });
    expect(calls().some((c) => c.argv[1] === "add")).toBe(false);

    const done = await service.handle({ clientId: "claude-code", action: "install", options: { toolset: "lite", confirm: first.preview?.previewId } });
    expect(done.ok).toBe(true);
    expect(done.status).toMatchObject({ installed: true });
    const add = calls().find((c) => c.argv[1] === "add");
    expect(add?.argv).toEqual([
      "mcp", "add", "helmstack", "-s", "user",
      "-e", "HELMSTACK_PORT=7171", "-e", `HELMSTACK_TOKEN_FILE=${setup.tokenFile}`, "-e", "HELMSTACK_TOOLSET=lite",
      "--", path.join(setup.bin, "node"), setup.entry
    ]);
  });

  it("never exposes the token: not in argv, previews, results, nor the child environment", async () => {
    const service = mk();
    const seen: string[] = [];
    for (const id of ["claude-code", "gemini-cli", "generic"] as const) {
      const p = await service.handle({ clientId: id, action: id === "generic" ? "preview" : "install" });
      seen.push(JSON.stringify(p));
      if (id !== "generic") {
        const done = await service.handle({ clientId: id, action: "install", options: { confirm: p.preview?.previewId } });
        seen.push(JSON.stringify(done));
      }
    }
    seen.push(JSON.stringify(await service.overview()));
    expect(seen.join("\n")).not.toContain(TOKEN);
    const log = fs.readFileSync(path.join(setup.home, "calls.log"), "utf8");
    expect(log).not.toContain(TOKEN);
    expect(calls().every((c) => !("HELMSTACK_AUTH_TOKEN" in c.env))).toBe(true);
    expect(seen.join("\n")).toContain(setup.tokenFile);
  });

  it("is idempotent: reinstalling the same entry runs nothing; a changed port removes then adds", async () => {
    const service = mk();
    const p1 = await service.handle({ clientId: "claude-code", action: "install" });
    await service.handle({ clientId: "claude-code", action: "install", options: { confirm: p1.preview?.previewId } });
    const before = calls().length;
    const again = await service.handle({ clientId: "claude-code", action: "install" });
    expect(again.preview?.change).toBe("none");
    const noop = await service.handle({ clientId: "claude-code", action: "install", options: { confirm: again.preview?.previewId } });
    expect(noop.message).toMatch(/up to date/);
    expect(calls().slice(before).some((c) => c.argv[1] === "add" || c.argv[1] === "remove")).toBe(false);

    const moved = mk({ getConnection: () => ({ port: 7272, tokenFile: setup.tokenFile, profile: "fe-dev" }) });
    const p2 = await moved.handle({ clientId: "claude-code", action: "install" });
    expect(p2.preview?.change).toBe("update");
    const mark = calls().length;
    const done = await moved.handle({ clientId: "claude-code", action: "install", options: { confirm: p2.preview?.previewId } });
    expect(done.ok).toBe(true);
    expect(calls().slice(mark).filter((c) => c.argv[1] !== "get" && c.argv[0] !== "--version").map((c) => c.argv[1])).toEqual(["remove", "add"]);
    expect(JSON.parse(fs.readFileSync(path.join(setup.home, "claude.state.json"), "utf8")).env.HELMSTACK_PORT).toBe("7272");
  });

  it("gemini updates in place with a single add and removes with its own command", async () => {
    const service = mk();
    const p = await service.handle({ clientId: "gemini-cli", action: "install" });
    await service.handle({ clientId: "gemini-cli", action: "install", options: { confirm: p.preview?.previewId } });
    const moved = mk({ getConnection: () => ({ port: 7272, tokenFile: setup.tokenFile, profile: "fe-dev" }) });
    const p2 = await moved.handle({ clientId: "gemini-cli", action: "install" });
    expect(p2.preview?.change).toBe("update");
    await moved.handle({ clientId: "gemini-cli", action: "install", options: { confirm: p2.preview?.previewId } });
    expect(calls().filter((c) => c.cli === "gemini" && c.argv[1] === "add")).toHaveLength(2);
    expect(calls().filter((c) => c.cli === "gemini" && c.argv[1] === "remove")).toHaveLength(0);
    const rm = await moved.handle({ clientId: "gemini-cli", action: "remove" });
    expect(rm).toMatchObject({ ok: true, needsConfirmation: true });
    const removed = await moved.handle({ clientId: "gemini-cli", action: "remove", options: { confirm: rm.preview?.previewId } });
    expect(removed.status).toMatchObject({ installed: false });
    const last = calls().filter((c) => c.argv[1] === "remove").pop();
    expect(last?.argv).toEqual(["mcp", "remove", "-s", "user", "helmstack"]);
  });

  it("verify runs the client's own query and reports registration", async () => {
    const service = mk();
    expect(await service.handle({ clientId: "claude-code", action: "verify" })).toMatchObject({ ok: true, registered: false });
    const p = await service.handle({ clientId: "claude-code", action: "install" });
    await service.handle({ clientId: "claude-code", action: "install", options: { confirm: p.preview?.previewId } });
    expect(await service.handle({ clientId: "claude-code", action: "verify" })).toMatchObject({ ok: true, registered: true });
  });

  it("reports a CLI failure with sanitised text and keeps state consistent", async () => {
    const service = mk({ env: { PATH: setup.bin, HOME: setup.home, FAKE_FAIL: "1" } });
    // FAKE_FAIL is not in the scrub allowlist, so set it through the script file instead.
    fs.writeFileSync(path.join(setup.bin, "claude"), FAKE_CLI("claude").replace("process.env.FAKE_FAIL &&", "true &&"), { mode: 0o755 });
    const p = await service.handle({ clientId: "claude-code", action: "install" });
    const done = await service.handle({ clientId: "claude-code", action: "install", options: { confirm: p.preview?.previewId } });
    expect(done.ok).toBe(false);
    expect(done.message).toContain("boom: nope");
    expect(done.message).not.toContain("\u001b");
  });

  it("times out a hung CLI", async () => {
    fs.writeFileSync(path.join(setup.bin, "claude"), `#!${process.execPath}\nsetTimeout(()=>{}, 60000);\n`, { mode: 0o755 });
    const service = mk({ execTimeoutMs: 300 }, ["gemini"]);
    const status = client(await service.overview(), "claude-code");
    expect(status.note).toMatch(/timed out/);
  });

  it("codex: documented command, only when its CLI is on PATH (never edits TOML)", async () => {
    fs.mkdirSync(path.join(setup.home, ".codex"));
    const noCli = mk();
    const overview = await noCli.overview();
    expect(client(overview, "codex-cli")).toMatchObject({ detected: true, canInstall: false, provenance: "docs-only" });
    expect((await noCli.handle({ clientId: "codex-cli", action: "install" })).ok).toBe(false);
    expect(fs.existsSync(path.join(setup.home, ".codex", "config.toml"))).toBe(false);

    const service = mk({}, ["claude", "gemini", "codex"]);
    const p = await service.handle({ clientId: "codex-cli", action: "install" });
    await service.handle({ clientId: "codex-cli", action: "install", options: { confirm: p.preview?.previewId } });
    const add = calls().find((c) => c.cli === "codex" && c.argv[1] === "add");
    expect(add?.argv.slice(0, 3)).toEqual(["mcp", "add", "helmstack"]);
    expect(add?.argv).toContain("--env");
    expect(fs.existsSync(path.join(setup.home, ".codex", "config.toml"))).toBe(false);
  });
});

d("JSON clients", () => {
  const desktopDir = () =>
    process.platform === "darwin"
      ? path.join(setup.home, "Library", "Application Support", "Claude")
      : path.join(setup.home, ".config", "Claude");

  it("merges into an existing Claude Desktop config, backs it up, and leaves other servers alone", async () => {
    fs.mkdirSync(desktopDir(), { recursive: true });
    const file = path.join(desktopDir(), "claude_desktop_config.json");
    const original = JSON.stringify({ mcpServers: { filesystem: { command: "npx", args: ["fs"] } }, preferences: { a: 1 } }, null, 2) + "\n";
    fs.writeFileSync(file, original, { mode: 0o640 });
    fs.chmodSync(file, 0o640);
    const service = mk();
    const p = await service.handle({ clientId: "claude-desktop", action: "install", options: { toolset: "lite" } });
    expect(p).toMatchObject({ ok: true, needsConfirmation: true });
    expect(p.preview).toMatchObject({ kind: "file", change: "add", filePath: file });
    expect(p.preview?.diff).toContain("+ ");
    expect(fs.readFileSync(file, "utf8")).toBe(original); // nothing written yet
    const done = await service.handle({ clientId: "claude-desktop", action: "install", options: { toolset: "lite", confirm: p.preview?.previewId } });
    expect(done.ok).toBe(true);
    expect(done.backupPath).toBe(`${file}.20260304T050607Z.bak`);
    expect(fs.readFileSync(done.backupPath as string, "utf8")).toBe(original);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.mcpServers.filesystem).toEqual({ command: "npx", args: ["fs"] });
    expect(written.preferences).toEqual({ a: 1 });
    expect(written.mcpServers.helmstack.env).toEqual({
      HELMSTACK_PORT: "7171",
      HELMSTACK_TOKEN_FILE: setup.tokenFile,
      HELMSTACK_TOOLSET: "lite",
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readFileSync(file, "utf8")).not.toContain(TOKEN);

    // remove only ours
    const r = await service.handle({ clientId: "claude-desktop", action: "remove" });
    const removed = await service.handle({ clientId: "claude-desktop", action: "remove", options: { confirm: r.preview?.previewId } });
    expect(removed).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { filesystem: { command: "npx", args: ["fs"] } }, preferences: { a: 1 } });
  });

  it("refuses to overwrite a file that is not valid JSON", async () => {
    fs.mkdirSync(desktopDir(), { recursive: true });
    const file = path.join(desktopDir(), "claude_desktop_config.json");
    fs.writeFileSync(file, '{ "mcpServers": { // my notes\n } }');
    const service = mk();
    const result = await service.handle({ clientId: "claude-desktop", action: "install" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not valid JSON/);
    expect(fs.readFileSync(file, "utf8")).toContain("// my notes");
    expect(fs.readdirSync(desktopDir())).toEqual(["claude_desktop_config.json"]);
    expect(client(await service.overview(), "claude-desktop").note).toMatch(/isn't valid JSON/);
  });

  it("refuses a confirmation that no longer matches the file", async () => {
    fs.mkdirSync(path.join(setup.home, ".cursor"));
    const file = path.join(setup.home, ".cursor", "mcp.json");
    fs.writeFileSync(file, "{}");
    const service = mk();
    const p = await service.handle({ clientId: "cursor", action: "install" });
    fs.writeFileSync(file, '{"mcpServers":{"x":{"command":"y"}}}'); // changed after review
    const done = await service.handle({ clientId: "cursor", action: "install", options: { confirm: p.preview?.previewId } });
    expect(done).toMatchObject({ ok: false, needsConfirmation: true });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.helmstack).toBeUndefined();
  });

  it("creates Cursor's mcp.json only when ~/.cursor exists", async () => {
    const service = mk();
    expect((await service.handle({ clientId: "cursor", action: "install" })).ok).toBe(false);
    fs.mkdirSync(path.join(setup.home, ".cursor"));
    const p = await service.handle({ clientId: "cursor", action: "install" });
    expect(p.ok).toBe(true);
    const done = await service.handle({ clientId: "cursor", action: "install", options: { confirm: p.preview?.previewId } });
    expect(done.backupPath).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(setup.home, ".cursor", "mcp.json"), "utf8")).mcpServers.helmstack.command).toBe(path.join(setup.bin, "node"));
  });

  it("antigravity: offers copy only until one of its config files exists, then uses that one", async () => {
    const service = mk();
    expect(client(await service.overview(), "antigravity")).toMatchObject({ detected: false, installed: false, canInstall: false });
    expect((await service.handle({ clientId: "antigravity", action: "install" })).ok).toBe(false);
    const copy = await service.handle({ clientId: "antigravity", action: "preview" });
    expect(JSON.parse(copy.preview?.copyText ?? "{}").mcpServers.helmstack.env.HELMSTACK_PORT).toBe("7171");

    const alt = path.join(setup.home, ".gemini", "config", "mcp_config.json");
    fs.mkdirSync(path.dirname(alt), { recursive: true });
    fs.writeFileSync(alt, "{}");
    const status = client(await service.overview(), "antigravity");
    expect(status).toMatchObject({ detected: true, canInstall: true, configPath: alt });
  });
});

d("explainer / copy-only clients and IPC", () => {
  it("chatgpt is an explainer with no actions; generic is copy-only", async () => {
    const service = mk();
    for (const action of ["install", "remove", "verify", "preview"] as const) {
      const r = await service.handle({ clientId: "chatgpt", action });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/public HTTPS/);
    }
    expect((await service.handle({ clientId: "generic", action: "install" })).ok).toBe(false);
    const copy = await service.handle({ clientId: "generic", action: "preview" });
    expect(copy.ok).toBe(true);
    expect(JSON.parse(copy.preview?.copyText ?? "").mcpServers.helmstack.command).toBe(path.join(setup.bin, "node"));
  });

  it("rejects non-shell senders and invalid requests before anything runs", async () => {
    const service = mk();
    const shell = {};
    const ipc = createMcpInstallIpc(service, (sender) => sender === shell);
    expect(() => ipc.run({}, { clientId: "claude-code", action: "install" })).toThrow(/only available from the HelmStack window/);
    expect(() => ipc.overview({})).toThrow(/only available/);
    await expect(ipc.run(shell, { clientId: "rm", action: "install" })).rejects.toThrow(/Unknown client/);
    await expect(ipc.run(shell, { clientId: "claude-code", action: "install", options: { command: "x" } })).rejects.toThrow(/Invalid options/);
    await expect(ipc.run(shell, "claude-code")).rejects.toThrow();
    expect(calls().filter((c) => c.argv[1] === "add")).toHaveLength(0);
    expect((await ipc.overview(shell)).ready).toBe(true);
  });
});
