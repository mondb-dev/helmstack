/**
 * Lite-vs-full benchmark harness. Offline helpers only (tested in
 * harness.test.ts); the live driver is bench.live.test.ts, which runs only when
 * HELMSTACK_LITE_BENCH=1 because it spends model tokens.
 *
 * Confinement flags and env scrubbing are reused from the in-window agent
 * runner (claudeAdapter / scrubbedEnv) so the benchmark runs the model exactly
 * as HelmStack's own chat does: MCP-only, no built-in tools, never prompting.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { createBrowserClient, type BrowserClient } from "@helmstack/agent-sdk";

import { claudeAdapter } from "../../../devtools-core/src/agent-runner/adapters/claude.js";
import { scrubbedEnv } from "../../../devtools-core/src/agent-runner/env.js";

export const REPO_ROOT = path.resolve(__dirname, "../../../..");
export const PAGES_DIR = path.join(__dirname, "pages");
export const SHARED_PAGES_DIR = path.join(REPO_ROOT, "apps/desktop/test-pages");

// ── types ────────────────────────────────────────────────────────────────────

export type Toolset = "lite" | "full";

export type ToolCall = { name: string; input: unknown; result: string; isError: boolean };

export type RunUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  turns: number;
};

export type RunOutcome = {
  finalText: string;
  toolCalls: ToolCall[];
  usage: RunUsage;
  ok: boolean;
  error?: string;
  durationMs: number;
};

export type CheckContext = {
  browser: BrowserClient;
  tabId: string;
  baseUrl: string;
  finalText: string;
  toolCalls: ToolCall[];
  evaluate<T = unknown>(expression: string): Promise<T>;
  tabUrls(): Promise<string[]>;
};

export type BenchTask = {
  id: string;
  /** Path on the fixture site the tab starts on. */
  start: string;
  prompt: string;
  /** Programmatic success check over page state, tool trace and final answer. */
  check(ctx: CheckContext): Promise<{ pass: boolean; why: string }>;
};

// ── fixture site ─────────────────────────────────────────────────────────────

export function resolvePagePath(name: string, dirs: readonly string[] = [PAGES_DIR, SHARED_PAGES_DIR]): string | null {
  const clean = name.replace(/^\/+/, "") || "home.html";
  for (const dir of dirs) {
    const file = path.resolve(dir, clean);
    if (file.startsWith(path.resolve(dir) + path.sep) && existsSync(file)) return file;
  }
  return null;
}

export async function startPageServer(port: number): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const file = resolvePagePath(new URL(req.url ?? "/", "http://x").pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ── throwaway daemon ─────────────────────────────────────────────────────────

const FORBIDDEN_PORTS = new Set([7070, 7183, 7184]);

/** Approval policy `auto` for everything but payments (what the benchmark's form tasks assume). */
export function autoApprovalPolicies(): string {
  const keys = ["share_personal_data", "create_account", "accept_legal_terms"];
  return JSON.stringify({
    version: 1,
    updatedAt: 0,
    policies: [
      ...keys.map((key) => ({ key, label: key, description: "", decision: "auto" })),
      { key: "submit_payment", label: "submit_payment", description: "", decision: "block" }
    ]
  });
}

export async function startDaemon(opts: { port: number; dataDir: string; token: string }): Promise<{ client: BrowserClient; close(): Promise<void> }> {
  if (FORBIDDEN_PORTS.has(opts.port)) throw new Error(`Port ${opts.port} is reserved for a running HelmStack; pick another.`);
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(opts.dataDir, "helmstack-approval-policies.json"), autoApprovalPolicies());
  const child: ChildProcess = spawn(process.execPath, [path.join(REPO_ROOT, "apps/daemon/dist/main.js"), "--port", String(opts.port), "--data-dir", opts.dataDir], {
    env: { ...benchEnv(process.env), HELMSTACK_AUTH_TOKEN: opts.token },
    stdio: "ignore"
  });
  const client = createBrowserClient({ port: opts.port, authToken: opts.token });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const health = await client.health();
      if (health.status === "ok" && (await client.listTabs()).length > 0) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("The throwaway daemon did not become healthy in 30s.");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    client,
    close: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      })
  };
}

// ── claude CLI driver ────────────────────────────────────────────────────────

export const BENCH_CONTEXT =
  "You control a web browser through the helmstack tools. The page for the task is already open in the current tab. " +
  "Do the task, then reply with one short sentence giving the answer or confirming it is done.";

export type TurnPlan = { args: string[]; stdin: string; env: NodeJS.ProcessEnv; mcpConfigPath: string };

/** Build the confined `claude -p` invocation for one task (no process is started). */
export function planClaudeTurn(opts: {
  dir: string;
  toolset: Toolset;
  model: string;
  prompt: string;
  daemonPort: number;
  tokenFile: string;
  serverEntry?: string;
  sessionId?: string;
}): TurnPlan {
  const entry = opts.serverEntry ?? path.join(REPO_ROOT, "packages/mcp-server/dist/index.js");
  const prepared = claudeAdapter.prepare({
    dir: opts.dir,
    mcp: {
      name: "helmstack",
      command: process.execPath,
      args: [entry],
      // Token by file path, never by value. HELMSTACK_TOOLSET picks the surface.
      env: { HELMSTACK_PORT: String(opts.daemonPort), HELMSTACK_TOKEN_FILE: opts.tokenFile, HELMSTACK_TOOLSET: opts.toolset }
    }
  }) as { mcpConfigPath: string };
  const built = claudeAdapter.buildTurn({
    prepared,
    model: opts.model,
    sessionId: opts.sessionId ?? randomUUID(),
    resume: false,
    prompt: opts.prompt,
    tabId: "",
    context: BENCH_CONTEXT,
    unconfined: false
  });
  const args = [...built.args, "--no-session-persistence"];
  return { args, stdin: built.stdin, env: { ...benchEnv(process.env), ...built.env }, mcpConfigPath: prepared.mcpConfigPath };
}

/**
 * Environment for the agent CLI and the MCP servers it spawns: HelmStack's
 * runner scrub, plus the test runner's own variables. `VITEST` must not leak:
 * the MCP server deliberately does not connect stdio under it.
 */
export function benchEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = scrubbedEnv(source);
  for (const key of Object.keys(out)) if (key.startsWith("VITEST")) delete out[key];
  return out;
}

/** Names (never values) of variables removed from the child's environment. */
export function scrubbedNames(source: NodeJS.ProcessEnv): string[] {
  const kept = benchEnv(source);
  return Object.keys(source).filter((k) => source[k] !== undefined && !(k in kept)).sort();
}

const EMPTY_USAGE: RunUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: null, turns: 0 };

/** Parse `claude -p --output-format stream-json --verbose` output into a trace and usage totals. */
export function parseClaudeStream(raw: string): Omit<RunOutcome, "durationMs"> {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  let finalText = "";
  let usage: RunUsage = { ...EMPTY_USAGE };
  let ok = false;
  let error: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === "tool_use" && typeof block.id === "string") {
          const name = String(block.name ?? "").replace(/^mcp__helmstack__/, "");
          calls.set(block.id, { name, input: block.input, result: "", isError: false });
          order.push(block.id);
        } else if (block?.type === "text" && typeof block.text === "string") {
          finalText = block.text;
        }
      }
    } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === "tool_result") {
          const call = calls.get(block.tool_use_id);
          if (!call) continue;
          const content = block.content;
          call.result = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === "string" ? c.text : `[${c?.type ?? "part"}]`)).join("\n") : "";
          call.isError = block.is_error === true;
        }
      }
    } else if (msg.type === "result") {
      ok = msg.is_error !== true && msg.subtype === "success";
      if (typeof msg.result === "string" && msg.result) finalText = msg.result;
      if (!ok) error = String(msg.subtype ?? "error");
      const u = msg.usage ?? {};
      usage = {
        inputTokens: Number(u.input_tokens ?? 0),
        outputTokens: Number(u.output_tokens ?? 0),
        cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
        cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        turns: Number(msg.num_turns ?? 0)
      };
    }
  }
  return { finalText, toolCalls: order.map((id) => calls.get(id)!), usage, ok, ...(error ? { error } : {}) };
}

export async function runClaude(plan: TurnPlan, opts: { binary?: string; cwd: string; timeoutMs?: number }): Promise<RunOutcome> {
  const started = Date.now();
  const child = spawn(opts.binary ?? "claude", plan.args, { cwd: opts.cwd, env: plan.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", () => undefined); // never surfaced: may contain paths or prompts
  child.stdin.end(plan.stdin);
  const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 240_000);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  const parsed = parseClaudeStream(stdout);
  return { ...parsed, ok: parsed.ok && code === 0, durationMs: Date.now() - started, ...(parsed.ok || parsed.error ? {} : { error: `exit ${code}` }) };
}

// ── OpenAI-compatible driver (Ollama / LM Studio) ────────────────────────────

type OpenAiTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };

export function toOpenAiTools(tools: Array<{ name: string; description?: string; inputSchema: unknown }>): OpenAiTool[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
}

/**
 * Minimal tool-calling loop against an OpenAI-compatible `/chat/completions`
 * endpoint (Ollama: http://127.0.0.1:11434/v1). Spawns the HelmStack MCP server
 * over stdio and bridges its tools. Not run by default; nothing is pulled.
 */
export async function runOpenAiCompatible(opts: {
  baseUrl: string;
  model: string;
  prompt: string;
  toolset: Toolset;
  daemonPort: number;
  tokenFile: string;
  maxSteps?: number;
  serverEntry?: string;
}): Promise<RunOutcome> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const started = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [opts.serverEntry ?? path.join(REPO_ROOT, "packages/mcp-server/dist/index.js")],
    env: { ...(benchEnv(process.env) as Record<string, string>), HELMSTACK_PORT: String(opts.daemonPort), HELMSTACK_TOKEN_FILE: opts.tokenFile, HELMSTACK_TOOLSET: opts.toolset }
  });
  const mcp = new Client({ name: "lite-bench", version: "0.0.0" });
  await mcp.connect(transport);
  const toolCalls: ToolCall[] = [];
  const usage: RunUsage = { ...EMPTY_USAGE };
  let finalText = "";
  let error: string | undefined;
  try {
    const listed = await mcp.listTools();
    const tools = toOpenAiTools(listed.tools as never);
    const messages: any[] = [
      { role: "system", content: BENCH_CONTEXT },
      { role: "user", content: opts.prompt }
    ];
    for (let step = 0; step < (opts.maxSteps ?? 20); step += 1) {
      const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: opts.model, messages, tools, temperature: 0 })
      });
      if (!response.ok) throw new Error(`model endpoint answered ${response.status}`);
      const body = (await response.json()) as any;
      usage.inputTokens += Number(body.usage?.prompt_tokens ?? 0);
      usage.outputTokens += Number(body.usage?.completion_tokens ?? 0);
      usage.turns += 1;
      const message = body.choices?.[0]?.message ?? {};
      messages.push(message);
      const calls: any[] = message.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = String(message.content ?? "");
        break;
      }
      for (const call of calls) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(call.function?.arguments || "{}");
        } catch {
          /* malformed arguments are passed through as empty */
        }
        const result = (await mcp.callTool({ name: call.function.name, arguments: input })) as { content?: Array<{ text?: string }>; isError?: boolean };
        const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        toolCalls.push({ name: call.function.name, input, result: text, isError: result.isError === true });
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    await mcp.close().catch(() => undefined);
  }
  return { finalText, toolCalls, usage, ok: !error && finalText !== "", ...(error ? { error } : {}), durationMs: Date.now() - started };
}

// ── aggregation ──────────────────────────────────────────────────────────────

export type TaskResult = { taskId: string; toolset: Toolset; pass: boolean; why: string; outcome: RunOutcome };

export function summarize(results: readonly TaskResult[]): Record<Toolset, { runs: number; passed: number; toolCalls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }> {
  const blank = () => ({ runs: 0, passed: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
  const out = { lite: blank(), full: blank() };
  for (const r of results) {
    const s = out[r.toolset];
    s.runs += 1;
    s.passed += r.pass ? 1 : 0;
    s.toolCalls += r.outcome.toolCalls.length;
    s.inputTokens += r.outcome.usage.inputTokens;
    s.outputTokens += r.outcome.usage.outputTokens;
    s.cacheReadTokens += r.outcome.usage.cacheReadTokens;
    s.cacheCreationTokens += r.outcome.usage.cacheCreationTokens;
    s.costUsd += r.outcome.usage.costUsd ?? 0;
  }
  return out;
}
