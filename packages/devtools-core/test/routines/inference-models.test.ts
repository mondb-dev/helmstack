import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GEMINI_DENY_ALL_POLICY,
  GEMINI_NO_MCP_SETTINGS,
  claudeInferenceArgs,
  createCliInferenceModel,
  createLocalInferenceModel,
  geminiInferenceInvocation,
  ollamaChatRequest,
  openAiChatRequest,
  parseClaudeResult,
  parseGeminiResult,
  type SpawnFn
} from "../../src/core/routines/inference-models.js";
import { ModelCallError, type ModelRequest } from "../../src/core/routines/inference.js";
import { CHOOSE_MODEL_MESSAGE, RoutineModelManager, parseRoutineModelChoice, parseRoutineModelEnv } from "../../src/core/routines/routine-model.js";

const SYSTEM = "SYSTEM-TEXT";
const USER = "USER-TEXT-with-page-data";
const live = () => new AbortController().signal;
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: SYSTEM, user: USER, signal: live(), timeoutMs: 5000, maxOutputChars: 4000, ...over });

/** Anything in these places would give the model a way to do something. */
const TOOL_WORDS = /\b(tools?|functions?|tool_choice|tool_calls|allowedTools|allowed-tools|yolo|bypassPermissions|dangerously|auto_edit|mcp__)/i;

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe("tool-less invariant: what each runtime is asked to do", () => {
  it("claude: no tools, no MCP, no settings, no skills, no session, nothing that enables a tool", () => {
    const args = claudeInferenceArgs({ model: "haiku", system: SYSTEM });
    expect(args).toContain("--tools=");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    const flags = args.filter((a) => a.startsWith("--"));
    // Only these flags may appear. Anything new here has to be reviewed against "no tools".
    expect(new Set(flags.map((f) => f.split("=")[0]))).toEqual(
      new Set(["--output-format", "--tools", "--disallowedTools", "--strict-mcp-config", "--mcp-config", "--setting-sources", "--disable-slash-commands", "--no-session-persistence", "--permission-mode", "--model", "--system-prompt"])
    );
    // No allow list in any spelling, and the deny list names the built-in tools.
    expect(args.some((a) => /^--allowed-?tools/i.test(a))).toBe(false);
    expect(args.find((a) => a.startsWith("--disallowedTools="))).toMatch(/Bash.*Write.*WebFetch/);
    expect(args.join(" ")).not.toMatch(/bypass|dangerously|mcp__/);
    // The prompt is not on argv; the instruction is the only free text.
    expect(args).not.toContain(USER);
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(SYSTEM);
  });

  it("claude: a model id that could be read as a flag is refused before anything is run", () => {
    for (const bad of ["--dangerously-skip-permissions", "-x", "a b", "a;b", ""]) {
      if (bad === "") continue;
      expect(() => claudeInferenceArgs({ model: bad, system: SYSTEM })).toThrow();
    }
    expect(claudeInferenceArgs({ system: SYSTEM })).not.toContain("--model");
  });

  it("gemini: a deny-all policy, no MCP server, default approval mode", () => {
    const inv = geminiInferenceInvocation({ model: "flash", policyPath: "/p/policy.toml", settingsPath: "/p/settings.json" });
    expect(inv.args).toContain("--policy");
    expect(inv.args[inv.args.indexOf("--approval-mode") + 1]).toBe("default");
    expect(inv.args).toContain("--allowed-mcp-server-names=");
    expect(inv.args.join(" ")).not.toMatch(/yolo|auto_edit|allowed-tools|plan\b/);
    expect(inv.env).toEqual({ GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/p/settings.json" });
    expect(GEMINI_DENY_ALL_POLICY).toMatch(/toolName = "\*"/);
    expect(GEMINI_DENY_ALL_POLICY).toMatch(/decision = "deny"/);
    expect(GEMINI_DENY_ALL_POLICY).not.toMatch(/allow/);
    expect(JSON.parse(GEMINI_NO_MCP_SETTINGS)).toEqual({ mcpServers: {}, mcp: { allowed: [] } });
    expect(() => geminiInferenceInvocation({ model: "--yolo", policyPath: "p", settingsPath: "s" })).toThrow();
  });

  it("ollama and openai-compatible requests are plain chat completions with no tool fields", () => {
    for (const wire of [ollamaChatRequest({ model: "llama3.2:3b", system: SYSTEM, user: USER }), openAiChatRequest({ model: "m", system: SYSTEM, user: USER })]) {
      const keys = keysDeep(wire.body);
      expect(keys.filter((k) => TOOL_WORDS.test(k))).toEqual([]);
      expect((wire.body as { stream: boolean }).stream).toBe(false);
      const messages = (wire.body as { messages: Array<{ role: string; content: string }> }).messages;
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(messages[1]!.content).toBe(USER);
    }
    expect(ollamaChatRequest({ model: "m", system: "s", user: "u" }).path).toBe("/api/chat");
    expect(openAiChatRequest({ model: "m", system: "s", user: "u" }).path).toBe("/v1/chat/completions");
  });
});

describe("reading CLI results", () => {
  it("reads Claude's result text and refuses failures with a fixed sentence", () => {
    expect(parseClaudeResult(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"value":1}' }))).toBe('{"value":1}');
    expect(parseClaudeResult(JSON.stringify([{ type: "system" }, { type: "result", subtype: "success", is_error: false, result: "x" }]))).toBe("x");
    expect(() => parseClaudeResult("not json")).toThrow(ModelCallError);
    expect(() => parseClaudeResult(JSON.stringify({ type: "result", is_error: true, result: "Please run /login" }))).toThrow(/not signed in/);
    try {
      parseClaudeResult(JSON.stringify({ type: "result", is_error: true, result: "secret prompt text sk-123" }));
    } catch (e) {
      expect((e as Error).message).not.toContain("sk-123");
    }
  });

  it("reads Gemini's JSON response or plain text", () => {
    expect(parseGeminiResult(JSON.stringify({ response: "hello" }))).toBe("hello");
    expect(parseGeminiResult("plain")).toBe("plain");
  });
});

// ── a CLI run, with a fake process ───────────────────────────────────────────

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid?: number; kill: (s?: string) => boolean; killed: string[] };

function fakeSpawn(script: (child: FakeChild, call: { command: string; args: readonly string[]; options: any; stdin: string }) => void) {
  const calls: Array<{ command: string; args: readonly string[]; options: any; stdin: string }> = [];
  const spawn: SpawnFn = (command, args, options) => {
    const child = new EventEmitter() as FakeChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = (signal) => {
      child.killed.push(signal ?? "SIGTERM");
      setImmediate(() => child.emit("close", null));
      return true;
    };
    const call = { command, args, options, stdin: "" };
    calls.push(call);
    let buf = "";
    child.stdin.on("data", (d) => (buf += d));
    child.stdin.on("end", () => {
      call.stdin = buf;
      script(child, call);
    });
    return child as never;
  };
  return { spawn, calls };
}

const succeed = (text: string) => (child: FakeChild) => {
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }));
  child.emit("close", 0);
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "helmstack-models-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("running a CLI model", () => {
  it("sends the prompt on stdin, in an empty private directory, with a scrubbed environment", async () => {
    const { spawn, calls } = fakeSpawn(succeed('{"value":true}'));
    const model = createCliInferenceModel({
      cli: "claude",
      binary: "/bin/claude",
      label: "Claude Code",
      model: "haiku",
      env: { PATH: "/usr/bin", HELMSTACK_AUTH_TOKEN: "secret-token", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require /x" },
      spawn,
      tmpRoot: tmp
    });
    expect(model.local).toBe(false);
    expect(await model.complete(req())).toBe('{"value":true}');
    const call = calls[0]!;
    expect(call.command).toBe("/bin/claude");
    expect(call.stdin).toBe(USER);
    expect(call.args).not.toContain(USER);
    expect(call.options.shell).toBe(false);
    expect(call.options.env.PATH).toBe("/usr/bin");
    for (const k of ["HELMSTACK_AUTH_TOKEN", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) expect(call.options.env[k]).toBeUndefined();
    expect(path.dirname(call.options.cwd)).toBe(tmp);
    expect(call.options.cwd).not.toBe(process.cwd());
    expect(readdirSync(tmp)).toEqual([]); // the private directory is removed afterwards
  });

  it("writes the gemini policy and settings into the private directory and passes the system text in stdin", async () => {
    let seen: { policy: string; settings: string; mode: number } | null = null;
    const { spawn, calls } = fakeSpawn((child, call) => {
      const policy = call.args[call.args.indexOf("--policy") + 1]!;
      const settings = call.options.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string;
      seen = { policy: readFileSync(policy, "utf8"), settings: readFileSync(settings, "utf8"), mode: statSync(policy).mode & 0o777 };
      child.stdout.write(JSON.stringify({ response: "ok" }));
      child.emit("close", 0);
    });
    const model = createCliInferenceModel({ cli: "gemini", binary: "/bin/gemini", label: "Gemini", env: {}, spawn, tmpRoot: tmp });
    expect(await model.complete(req())).toBe("ok");
    expect(seen!.policy).toBe(GEMINI_DENY_ALL_POLICY);
    expect(seen!.settings).toBe(GEMINI_NO_MCP_SETTINGS);
    if (process.platform !== "win32") expect(seen!.mode).toBe(0o600);
    expect(calls[0]!.stdin).toContain(SYSTEM);
    expect(calls[0]!.stdin).toContain(USER);
    expect(calls[0]!.args.join(" ")).not.toContain(USER);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("maps failures to fixed sentences without echoing stderr", async () => {
    const run = async (script: Parameters<typeof fakeSpawn>[0]) => {
      const { spawn } = fakeSpawn(script);
      return createCliInferenceModel({ cli: "claude", binary: "/bin/claude", label: "C", env: {}, spawn, tmpRoot: tmp }).complete(req());
    };
    await expect(
      run((c) => {
        c.stderr.write("Not logged in. token=sk-SECRET");
        c.emit("close", 1);
      })
    ).rejects.toMatchObject({ kind: "unavailable", message: expect.not.stringContaining("sk-SECRET") });
    await expect(
      run((c) => {
        c.stderr.write("boom");
        c.emit("close", 2);
      })
    ).rejects.toMatchObject({ kind: "failed" });
    await expect(
      run((c) => {
        c.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "rate limit exceeded" }));
        c.emit("close", 1);
      })
    ).rejects.toMatchObject({ kind: "failed", message: expect.stringMatching(/rate limited/) });
    await expect(
      run((c) => {
        c.stdout.write("garbage");
        c.emit("close", 0);
      })
    ).rejects.toBeInstanceOf(ModelCallError);
    const throwing: SpawnFn = () => {
      throw new Error("ENOENT");
    };
    await expect(createCliInferenceModel({ cli: "claude", binary: "/nope", label: "C", env: {}, spawn: throwing, tmpRoot: tmp }).complete(req())).rejects.toMatchObject({ kind: "unavailable" });
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("kills a process that is too slow or that is cancelled", async () => {
    const hang = fakeSpawn(() => undefined);
    const slow = createCliInferenceModel({ cli: "claude", binary: "/bin/claude", label: "C", env: {}, spawn: hang.spawn, tmpRoot: tmp });
    await expect(slow.complete(req({ timeoutMs: 30 }))).rejects.toMatchObject({ kind: "timeout" });
    const c = new AbortController();
    const hang2 = fakeSpawn(() => setTimeout(() => c.abort(), 5));
    const cancelled = createCliInferenceModel({ cli: "claude", binary: "/bin/claude", label: "C", env: {}, spawn: hang2.spawn, tmpRoot: tmp });
    await expect(cancelled.complete(req({ signal: c.signal }))).rejects.toMatchObject({ kind: "cancelled" });
    const pre = new AbortController();
    pre.abort();
    await expect(cancelled.complete(req({ signal: pre.signal }))).rejects.toMatchObject({ kind: "cancelled" });
  });
});

// ── local runtimes ───────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("running a local model", () => {
  it("posts a plain chat request to the loopback origin and reads the reply", async () => {
    const seen: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ message: { content: '{"value":1}' } });
    }) as unknown as typeof fetch;
    const model = createLocalInferenceModel({ kind: "ollama", origin: "http://127.0.0.1:11434", model: "llama3.2:3b", label: "Ollama", fetchImpl });
    expect(model.local).toBe(true);
    expect(await model.complete(req())).toBe('{"value":1}');
    expect(seen[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(keysDeep(seen[0]!.body).filter((k) => TOOL_WORDS.test(k))).toEqual([]);
    expect(seen[0]!.body.messages[1].content).toBe(USER);

    const oai = createLocalInferenceModel({
      kind: "openai-compat",
      origin: "http://localhost:1234",
      model: "m",
      label: "LM",
      fetchImpl: (async (url: string) => {
        expect(url).toBe("http://localhost:1234/v1/chat/completions");
        return jsonResponse({ choices: [{ message: { content: "hi" } }] });
      }) as unknown as typeof fetch
    });
    expect(await oai.complete(req())).toBe("hi");
  });

  it("never contacts a non-loopback server, follows redirects, or leaks errors", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    for (const origin of ["https://api.example.com", "http://192.168.1.5:11434", "http://127.0.0.1.evil.test", "http://user:pw@127.0.0.1:11434"]) {
      const model = createLocalInferenceModel({ kind: "ollama", origin, model: "m", label: "x", fetchImpl });
      await expect(model.complete(req())).rejects.toMatchObject({ kind: "unavailable" });
    }
    expect(called).toBe(0);
    const redirect = createLocalInferenceModel({ kind: "ollama", origin: "http://127.0.0.1:11434", model: "m", label: "x", fetchImpl: (async () => new Response(null, { status: 307, headers: { location: "https://evil.test/" } })) as unknown as typeof fetch });
    await expect(redirect.complete(req())).rejects.toMatchObject({ kind: "unavailable" });
    const missing = createLocalInferenceModel({ kind: "ollama", origin: "http://127.0.0.1:11434", model: "m", label: "x", fetchImpl: (async () => jsonResponse({ error: "secret" }, 404)) as unknown as typeof fetch });
    await expect(missing.complete(req())).rejects.toMatchObject({ kind: "unavailable", message: expect.not.stringContaining("secret") });
    const down = createLocalInferenceModel({ kind: "ollama", origin: "http://127.0.0.1:11434", model: "m", label: "x", fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    await expect(down.complete(req())).rejects.toMatchObject({ kind: "unavailable" });
    const bad = createLocalInferenceModel({ kind: "ollama", origin: "http://127.0.0.1:11434", model: "m", label: "x", fetchImpl: (async () => jsonResponse({ nothing: true })) as unknown as typeof fetch });
    await expect(bad.complete(req())).rejects.toMatchObject({ kind: "failed" });
  });

  it("times out and cancels", async () => {
    const never = ((_url: string, init: any) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const model = createLocalInferenceModel({ kind: "ollama", origin: "http://127.0.0.1:11434", model: "m", label: "x", fetchImpl: never });
    await expect(model.complete(req({ timeoutMs: 20 }))).rejects.toMatchObject({ kind: "timeout" });
    const c = new AbortController();
    setTimeout(() => c.abort(), 10);
    await expect(model.complete(req({ signal: c.signal }))).rejects.toMatchObject({ kind: "cancelled" });
  });
});

// ── the choice ───────────────────────────────────────────────────────────────

describe("the model choice", () => {
  it("validates the runtime and model id", () => {
    expect(parseRoutineModelChoice({ cli: "claude" })).toEqual({ cli: "claude" });
    expect(parseRoutineModelChoice({ cli: "claude", model: "" })).toEqual({ cli: "claude" });
    expect(parseRoutineModelChoice({ cli: "ollama", model: "llama3.2:3b" })).toEqual({ cli: "ollama", model: "llama3.2:3b" });
    expect(parseRoutineModelChoice({ cli: "claude", model: "x", extra: 1 })).toEqual({ cli: "claude", model: "x" });
    for (const bad of [null, undefined, "claude", [], { cli: "bash" }, { cli: 1 }, { cli: "claude", model: "-p" }, { cli: "claude", model: "a b" }, { cli: "claude", model: 7 }, { cli: "ollama" }, { cli: "openai-compat", model: "" }]) {
      expect(() => parseRoutineModelChoice(bad)).toThrow();
    }
  });

  it("reads HELMSTACK_ROUTINE_MODEL as cli[:model]", () => {
    expect(parseRoutineModelEnv("claude")).toEqual({ cli: "claude" });
    expect(parseRoutineModelEnv(" claude:haiku ")).toEqual({ cli: "claude", model: "haiku" });
    expect(parseRoutineModelEnv("ollama:llama3.2:3b")).toEqual({ cli: "ollama", model: "llama3.2:3b" });
    for (const bad of [undefined, "", "ollama", "nope:x", "claude:--x"]) expect(parseRoutineModelEnv(bad)).toBeNull();
  });
});

describe("RoutineModelManager", () => {
  const noCli = { env: { PATH: "" }, detect: { wellKnownDirs: [] as string[] } };

  it("starts with no choice and asks for one", async () => {
    const m = new RoutineModelManager({ dataDir: tmp, ...noCli });
    expect(await m.getStatus()).toEqual({ choice: null, available: false, reason: `${CHOOSE_MODEL_MESSAGE}.` });
    expect(await m.resolve()).toEqual({ ok: false, reason: CHOOSE_MODEL_MESSAGE, chosen: false });
  });

  it("saves the choice atomically with owner-only permissions, and clears it", async () => {
    const m = new RoutineModelManager({ dataDir: path.join(tmp, "data"), ...noCli, platform: "linux" });
    const status = await m.setChoice({ cli: "claude", model: "haiku" });
    expect(status.choice).toEqual({ cli: "claude", model: "haiku" });
    expect(status.available).toBe(false); // claude is not on this fake PATH
    expect(status.reason).toMatch(/not available/);
    const file = path.join(tmp, "data", "routine-model.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, cli: "claude", model: "haiku" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.join(tmp, "data")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // A new manager (a restart) sees it.
    expect(new RoutineModelManager({ dataDir: path.join(tmp, "data"), ...noCli }).choice()).toEqual({ cli: "claude", model: "haiku" });
    expect((await m.setChoice(null)).choice).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("rejects an invalid choice without changing what is saved", async () => {
    const m = new RoutineModelManager({ dataDir: tmp, ...noCli });
    await m.setChoice({ cli: "claude" });
    await expect(m.setChoice({ cli: "claude", model: "--bad" })).rejects.toThrow();
    await expect(m.setChoice({ cli: "rm" })).rejects.toThrow();
    expect(m.choice()).toEqual({ cli: "claude" });
  });

  it("ignores a corrupt or hostile saved file", async () => {
    writeJson(path.join(tmp, "routine-model.json"), "{not json");
    const logs: string[] = [];
    const m = new RoutineModelManager({ dataDir: tmp, log: (s) => logs.push(s), ...noCli });
    expect(m.choice()).toBeNull();
    expect(logs).toHaveLength(1);
    writeJson(path.join(tmp, "routine-model.json"), JSON.stringify({ cli: "claude", model: "--dangerously-skip-permissions" }));
    expect(m.choice()).toBeNull();
  });

  it("falls back to the environment only while nothing is saved", async () => {
    const env = { HELMSTACK_ROUTINE_MODEL: "ollama:llama3.2:3b" };
    const m = new RoutineModelManager({ dataDir: tmp, ...noCli, env });
    expect(m.choice()).toEqual({ cli: "ollama", model: "llama3.2:3b" });
    await m.setChoice({ cli: "claude" });
    expect(m.choice()).toEqual({ cli: "claude" });
    await m.setChoice(null);
    expect(m.choice()).toEqual({ cli: "ollama", model: "llama3.2:3b" });
  });

  it("finds a local model through detection and builds a loopback model for it", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === "/api/version") return jsonResponse({ version: "0.5.0" });
      if (u.pathname === "/api/tags") return jsonResponse({ models: [{ name: "llama3.2:3b", digest: "d1", size: 2e9 }] });
      if (u.pathname === "/api/show") return jsonResponse({ capabilities: ["completion"] }); // no tool support: fine for judging
      if (u.pathname === "/api/chat") return jsonResponse({ message: { content: JSON.parse(init.body).model } });
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;
    const m = new RoutineModelManager({ dataDir: tmp, ...noCli, fetchImpl, local: { appPaths: { ollama: [tmp], openai: [] } } });
    const status = await m.setChoice({ cli: "ollama", model: "llama3.2:3b" });
    expect(status).toEqual({ choice: { cli: "ollama", model: "llama3.2:3b" }, available: true });
    const res = await m.resolve();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.model.local).toBe(true);
      expect(await res.model.complete(req())).toBe("llama3.2:3b");
    }
    expect((await m.setChoice({ cli: "ollama", model: "other:1b" })).available).toBe(false);
    expect((await m.setChoice({ cli: "ollama", model: "other:1b" })).reason).toMatch(/not found on Ollama/);
    for (const url of calls) expect(new URL(url).hostname).toBe("127.0.0.1");
  });

  it("reports a local server that is not running", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const m = new RoutineModelManager({ dataDir: tmp, ...noCli, fetchImpl, local: { appPaths: { ollama: [tmp], openai: [] } } });
    const status = await m.setChoice({ cli: "ollama", model: "llama3.2:3b" });
    expect(status.available).toBe(false);
    expect(status.reason).toBeTruthy();
  });

  it("does not run model CLIs on Windows", async () => {
    const m = new RoutineModelManager({ dataDir: tmp, platform: "win32", ...noCli });
    const status = await m.setChoice({ cli: "claude" });
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/Windows/);
  });
});

import { writeFileSync } from "node:fs";
function writeJson(file: string, text: string): void {
  writeFileSync(file, text, "utf8");
}
