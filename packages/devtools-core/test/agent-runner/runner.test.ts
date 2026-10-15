import { realpathSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentChatEvent } from "../../../shared/src/index.js";
import { AgentRunner, type AgentRunnerOptions } from "../../src/agent-runner/runner.js";
import { claudeAdapter } from "../../src/agent-runner/adapters/claude.js";
import { geminiAdapter } from "../../src/agent-runner/adapters/gemini.js";
import { scrubbedEnv } from "../../src/agent-runner/env.js";

// A fake `claude`: behaviour is chosen by "MODE:<x>" in the stdin prompt.
const FAKE = `#!${process.execPath}
const fs = require("fs");
if (process.argv.includes("--version")) { console.log("9.9.9 (Fake)"); process.exit(0); }
const input = fs.readFileSync(0, "utf8");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = (/MODE:(\\w+)/.exec(input) || [])[1] || "stream";
const sid = process.argv[process.argv.indexOf("--session-id") + 1] || process.argv[process.argv.indexOf("--resume") + 1];
if (mode === "stream") {
  out({ type: "system", subtype: "init", session_id: sid });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "SECRET-ARG" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "t1", name: "mcp__helmstack__browser_navigate", input: { url: "https://secret.example/?pw=hunter2" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "RESULT-SECRET" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "Hello", session_id: sid });
} else if (mode === "echo") {
  out({ type: "system", subtype: "init", session_id: sid });
  out({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify({ argv: process.argv.slice(2), input, env: Object.keys(process.env) }) }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "" });
} else if (mode === "fail") {
  process.stderr.write("Error: not logged in /Users/secret/path sk-ant-LEAK\\n");
  process.exit(1);
} else if (mode === "hang") {
  out({ type: "system", subtype: "init", session_id: sid });
  const { spawn } = require("child_process");
  const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_PIDFILE || "/dev/null", String(g.pid));
  setInterval(() => {}, 1000);
} else if (mode === "big") {
  out({ type: "system", subtype: "init", session_id: sid });
  const chunk = "x".repeat(65536) + "\\n";
  const t = setInterval(() => process.stdout.write(chunk), 0);
  setTimeout(() => clearInterval(t), 60000);
}
`;

let root: string;
let bin: string;
let mcpEntry: string;
const runners: AgentRunner[] = [];

function makeRunner(over: Partial<AgentRunnerOptions> = {}): AgentRunner {
  const r = new AgentRunner({
    port: 7192,
    authToken: "tok-test",
    mcpEntry,
    defaultWorkingDirectory: path.join(root, "work"),
    tmpRoot: root,
    adapters: [claudeAdapter],
    env: { PATH: bin, HOME: root, HELMSTACK_AUTH_TOKEN: "LEAK-ME", ELECTRON_RUN_AS_NODE: "1" },
    detect: { wellKnownDirs: [bin], home: root },
    ...over
  });
  runners.push(r);
  return r;
}

function collect(r: AgentRunner): AgentChatEvent[] {
  const events: AgentChatEvent[] = [];
  r.onEvent((e) => events.push(e));
  return events;
}

async function until(fn: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((res) => setTimeout(res, 10));
  }
}

const finished = (events: AgentChatEvent[]) => events.find((e) => e.type === "turn_finished") as Extract<AgentChatEvent, { type: "turn_finished" }> | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "hs-runner-test-"));
  bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "work"));
  writeFileSync(path.join(bin, "claude"), FAKE);
  chmodSync(path.join(bin, "claude"), 0o755);
  mcpEntry = path.join(root, "mcp.mjs");
  writeFileSync(mcpEntry, "// fake");
});

afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function start(r: AgentRunner, over: Record<string, unknown> = {}) {
  await r.refresh();
  return r.startConversation({ tabId: "tab-1", cliId: "claude", model: "sonnet", ...over });
}

describe("detection", () => {
  it("finds the allowlisted binary and its version, ignoring relative PATH entries", async () => {
    const r = makeRunner({ env: { PATH: `relative/dir:${bin}`, HOME: root } });
    const status = await r.refresh();
    const info = status.clis[0];
    expect(info.available).toBe(true);
    expect(info.path).toBe(path.join(bin, "claude"));
    expect(info.version).toBe("9.9.9");
    expect(info.models.map((m) => m.id)).toContain("sonnet");
  });

  it("reports not installed and reads only the model key of settings", async () => {
    mkdirSync(path.join(root, ".claude"));
    writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ model: "my-model.1", apiKey: "nope" }));
    const r = makeRunner({ detect: { wellKnownDirs: [], home: root }, env: { PATH: "" } });
    const info = (await r.refresh()).clis[0];
    expect(info.available).toBe(false);
    expect(info.reason).toBe("not installed");
    expect(info.models.find((m) => m.source === "configured")?.id).toBe("my-model.1");
  });

  it("tolerates an invalid settings file", () => {
    mkdirSync(path.join(root, ".claude"));
    writeFileSync(path.join(root, ".claude", "settings.json"), "{ not json");
    expect(claudeAdapter.readConfiguredModel(root)).toBeNull();
    expect(geminiAdapter.readConfiguredModel(root)).toBeNull();
  });
});

describe("validation", () => {
  it("rejects model ids with shell metacharacters", async () => {
    const r = makeRunner();
    for (const model of ["a; rm -rf ~", "$(id)", "a b", "`x`", "x".repeat(81), "a|b"]) {
      await expect(start(r, { model })).rejects.toThrow(/Invalid model/);
    }
  });

  it("validates the working directory", async () => {
    const r = makeRunner();
    await expect(start(r, { workingDirectory: path.join(root, "nope") })).rejects.toThrow(/working directory/);
    await expect(start(r, { workingDirectory: "relative" })).rejects.toThrow(/absolute/);
    await expect(start(r, { workingDirectory: path.join(bin, "claude") })).rejects.toThrow(/working directory/);
    const ok = await start(r, { workingDirectory: path.join(root, "work") });
    expect(ok.workingDirectory).toBe(readlink(path.join(root, "work")));
  });

  it("enforces the max concurrent conversations", async () => {
    const r = makeRunner({ maxConversations: 2 });
    await start(r);
    await start(r);
    await expect(start(r)).rejects.toThrow(/At most 2/);
  });

  it("is disabled when the MCP entry is missing", async () => {
    const r = makeRunner({ mcpEntry: null, disabledReason: "not packaged" });
    expect(r.getStatus()).toMatchObject({ enabled: false, reason: "not packaged" });
    await expect(start(r)).rejects.toThrow(/not packaged/);
  });
});

describe("unconfined CLIs", () => {
  it("require an explicit per-conversation acknowledgement", async () => {
    const r = makeRunner({ adapters: [{ ...claudeAdapter, confined: false, experimental: true }] });
    await expect(start(r)).rejects.toThrow(/explicit acknowledgement/);
    await expect(start(r, { allowUnconfined: false })).rejects.toThrow(/explicit acknowledgement/);
    const conv = await start(r, { allowUnconfined: true });
    expect(conv.cliId).toBe("claude");
  });

  it("gemini is reported unconfined and experimental, and always passes the restrictive policy flags", () => {
    expect(geminiAdapter.confined).toBe(false);
    expect(geminiAdapter.experimental).toBe(true);
    const built = geminiAdapter.buildTurn({
      prepared: { settingsPath: null, policyPath: "/p.toml" },
      model: "flash", sessionId: "s", resume: false, prompt: "hi", tabId: "t", context: "ctx", unconfined: true
    });
    expect(built.args).toEqual(expect.arrayContaining(["--approval-mode", "default", "--policy", "/p.toml", "--allowed-mcp-server-names=helmstack"]));
    expect(built.args.join(" ")).not.toMatch(/yolo|auto_edit/);
    expect(built.stdin).toContain("hi");
  });
});

describe("turns", () => {
  it("streams events, hides tool arguments and results, and emits before sendMessage resolves", async () => {
    const r = makeRunner();
    const events = collect(r);
    const conv = await start(r);
    let resolved = false;
    const p = r.sendMessage(conv.id, "MODE:stream hi").then((v) => {
      resolved = true;
      return v;
    });
    // Synchronous part of sendMessage already delivered these to subscribers.
    expect(events.map((e) => e.type)).toEqual(["user_message", "turn_started"]);
    expect(resolved).toBe(false);
    await p;
    await until(() => !!finished(events));
    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_call");
    expect(finished(events)?.outcome).toBe("completed");
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const tool = events.filter((e) => e.type === "tool_call") as Extract<AgentChatEvent, { type: "tool_call" }>[];
    expect(tool.map((t) => [t.name, t.status])).toEqual([["browser_navigate", "running"], ["browser_navigate", "ok"]]);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain("SECRET-ARG");
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("RESULT-SECRET");
  });

  it("rejects a second send while busy", async () => {
    const r = makeRunner();
    const events = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:hang");
    await expect(r.sendMessage(conv.id, "again")).rejects.toThrow(/still working/);
    await r.stopTurn(conv.id);
    await until(() => !!finished(events));
  });

  it("passes the malicious prompt only on stdin, with a fixed argv and a scrubbed env", async () => {
    const r = makeRunner();
    const events = collect(r);
    const conv = await start(r);
    const evil = '"; rm -rf ~ # $(touch /tmp/pwned) MODE:echo';
    await r.sendMessage(conv.id, evil);
    await until(() => !!finished(events));
    const text = events.find((e) => e.type === "text") as Extract<AgentChatEvent, { type: "text" }>;
    const seen = JSON.parse(text.text);
    expect(seen.input).toBe(evil);
    expect(seen.argv.join(" ")).not.toContain("rm -rf");
    expect(seen.argv).toContain("--allowedTools=mcp__helmstack");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.argv).toContain("dontAsk");
    expect(seen.argv.join(" ")).not.toMatch(/dangerously|yolo|bypassPermissions/);
    expect(seen.env.some((k: string) => k.startsWith("HELMSTACK_") || k.startsWith("ELECTRON_"))).toBe(false);
  });

  it("uses --session-id first and --resume afterwards", async () => {
    const r = makeRunner();
    const events = collect(r);
    const conv = await start(r);
    const argvOf = () => {
      const t = events.filter((e) => e.type === "text").at(-1) as Extract<AgentChatEvent, { type: "text" }>;
      return JSON.parse(t.text).argv as string[];
    };
    await r.sendMessage(conv.id, "MODE:echo");
    await until(() => events.filter((e) => e.type === "turn_finished").length === 1);
    expect(argvOf()).toContain("--session-id");
    await r.sendMessage(conv.id, "MODE:echo");
    await until(() => events.filter((e) => e.type === "turn_finished").length === 2);
    expect(argvOf()).toContain("--resume");
  });

  it("sanitises a failing exit (no raw stderr)", async () => {
    const r = makeRunner();
    const events = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:fail");
    await until(() => !!finished(events));
    const f = finished(events)!;
    expect(f.outcome).toBe("error");
    expect(f.error).toMatch(/not signed in/);
    expect(JSON.stringify(events)).not.toMatch(/sk-ant|\/Users\/secret/);
  });

  it("times out a hanging turn and kills grandchildren", async () => {
    const pidFile = path.join(root, "gc.pid");
    process.env.FAKE_PIDFILE = pidFile;
    const r = makeRunner({ turnTimeoutMs: 400, killGraceMs: 200, env: { PATH: bin, HOME: root, FAKE_PIDFILE: pidFile } });
    const events = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:hang");
    await until(() => !!finished(events));
    expect(finished(events)).toMatchObject({ outcome: "error" });
    expect(finished(events)?.error).toMatch(/too long/);
    await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
    delete process.env.FAKE_PIDFILE;
  });

  it("stops a turn (SIGTERM, then group kill)", async () => {
    const pidFile = path.join(root, "gc2.pid");
    const r = makeRunner({ env: { PATH: bin, HOME: root, FAKE_PIDFILE: pidFile } });
    const events = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:hang");
    await until(() => existsSync(pidFile));
    await r.stopTurn(conv.id);
    await r.stopTurn(conv.id); // idempotent
    await until(() => !!finished(events));
    expect(finished(events)?.outcome).toBe("stopped");
    await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
  });

  it("caps runaway output", async () => {
    const r = makeRunner({ maxOutputBytes: 512 * 1024, killGraceMs: 200 });
    const events = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:big");
    await until(() => !!finished(events), 15000);
    expect(finished(events)?.error).toMatch(/too much output/);
  });

  it("closing a conversation kills its process and removes temp files", async () => {
    const pidFile = path.join(root, "gc3.pid");
    const r = makeRunner({ env: { PATH: bin, HOME: root, FAKE_PIDFILE: pidFile } });
    const conv = await start(r);
    const dirs = () => readdirSync(root).filter((n) => n.startsWith("helmstack-agent-"));
    expect(dirs().length).toBe(1);
    await r.sendMessage(conv.id, "MODE:hang");
    await until(() => existsSync(pidFile));
    await r.closeTab("tab-1");
    await until(() => !alive(Number(readFileSync(pidFile, "utf8"))));
    expect(r.listConversations()).toEqual([]);
    await r.dispose();
    expect(dirs()).toEqual([]);
  });

  it("writes the MCP config with a token file path, never the token, at 0600", async () => {
    const r = makeRunner({ authToken: "super-secret-token" });
    await start(r);
    const base = readdirSync(root).find((n) => n.startsWith("helmstack-agent-"))!;
    const convDir = path.join(root, base, readdirSync(path.join(root, base))[0]);
    const cfg = readFileSync(path.join(convDir, "claude-mcp.json"), "utf8");
    expect(cfg).not.toContain("super-secret-token");
    const parsed = JSON.parse(cfg).mcpServers.helmstack;
    expect(parsed.env.HELMSTACK_TOKEN_FILE).toBe(path.join(convDir, "agent-token"));
    expect(parsed.env.HELMSTACK_AGENT_ID).toBe("chat:claude");
    expect(parsed.env.HELMSTACK_PORT).toBe("7192");
    expect(readFileSync(parsed.env.HELMSTACK_TOKEN_FILE, "utf8")).toBe("super-secret-token");
  });
});

describe("replay semantics", () => {
  it("replays the in-progress turn and joins live events without gaps or duplicates", async () => {
    const r = makeRunner({ replayLimit: 500 });
    const live = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:hang");
    await until(() => live.some((e) => e.type === "turn_started"));
    // Mid-turn replay (a tab switch) already includes the events so far.
    const first = r.getEvents(conv.id);
    expect(first.map((e) => e.type)).toEqual(["user_message", "turn_started"]);
    const last = first[first.length - 1].seq;
    await r.stopTurn(conv.id);
    await until(() => !!finished(live));
    const rest = r.getEvents(conv.id, last);
    const merged = [...first, ...rest];
    expect(merged.map((e) => e.seq)).toEqual(live.map((e) => e.seq));
    expect(r.getEvents(conv.id, live[live.length - 1].seq)).toEqual([]);
  });

  it("bounds the replay buffer while keeping seq monotonic", async () => {
    const r = makeRunner({ replayLimit: 3 });
    const events = collect(r);
    const conv = await start(r);
    await r.sendMessage(conv.id, "MODE:stream");
    await until(() => !!finished(events));
    const buf = r.getEvents(conv.id);
    expect(buf.length).toBeLessThanOrEqual(3);
    expect(buf.at(-1)?.seq).toBe(events.at(-1)?.seq);
  });
});

describe("env scrubbing", () => {
  it("removes HelmStack and Electron variables", () => {
    const env = scrubbedEnv({ PATH: "/bin", HELMSTACK_AUTH_TOKEN: "x", HELMSTACK_PORT: "1", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--r", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function readlink(p: string): string {
  return realpathSync(p);
}
