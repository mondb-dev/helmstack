/**
 * The runtimes that answer routine judgments, each started in a way that gives the model nothing
 * to call. This is separate from the agent chat runner on purpose: chat is confined to HelmStack's
 * browser tools, a judgment is confined to nothing at all.
 *
 *  - Claude Code: `--tools=` (no built-in tools), `--strict-mcp-config` with an empty MCP config
 *    (no MCP servers), no settings sources, no slash commands/skills, no session saved, every
 *    built-in tool also explicitly denied, `dontAsk` permission mode. The reply is read from the
 *    CLI's JSON result. Verified with `claude --help` and a real call: the init event lists
 *    `tools: []` and `mcp_servers: []`.
 *  - Gemini CLI: a deny-all policy (`toolName = "*"`, deny), a system-settings file that allows no
 *    MCP server, and the default approval mode. NOT verified end to end (the CLI could not sign in
 *    on the machine this was written on); the docs say so.
 *  - Ollama: a plain `POST /api/chat` with `stream: false` and no `tools` field.
 *  - OpenAI-compatible (LM Studio, llama.cpp): a plain `POST /v1/chat/completions` with no
 *    `tools` field.
 *
 * Local requests only ever go to a loopback origin, with redirects refused (agent-runner/local/net).
 * CLIs are only the allowlisted binaries found by name, run without a shell, in an empty private
 * working directory, with HelmStack's variables scrubbed from the environment. The prompt goes
 * through stdin (CLI) or the request body (local), never argv. Nothing here logs.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DENIED_TOOLS } from "../../agent-runner/adapters/claude.js";
import { scrubbedEnv } from "../../agent-runner/env.js";
import { LoopbackError, loopbackFetch, loopbackOrigin, readJsonCapped } from "../../agent-runner/local/net.js";
import { killGroup } from "../../agent-runner/runner.js";
import { MODEL_ID_PATTERN } from "../../agent-runner/types.js";
import { classifyFailure } from "../../agent-runner/util.js";
import { INFER_MAX_OUTPUT_TOKENS, ModelCallError, type InferenceModel, type ModelRequest } from "./inference.js";

const MAX_STDOUT_BYTES = 512 * 1024;
const KILL_GRACE_MS = 2000;

// ── Claude ──────────────────────────────────────────────────────────────────

/** The complete argv for a tool-less Claude call. The prompt is on stdin; the instruction is `system`. */
export function claudeInferenceArgs(opts: { model?: string; system: string }): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools=",
    `--disallowedTools=${DENIED_TOOLS.join(",")}`,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk"
  ];
  if (opts.model) {
    if (!MODEL_ID_PATTERN.test(opts.model)) throw new ModelCallError("The model id is not valid.", "unavailable");
    args.push("--model", opts.model);
  }
  args.push("--system-prompt", opts.system);
  return args;
}

/** Text of a Claude `--output-format json` result; throws a fixed-sentence error when it failed. */
export function parseClaudeResult(stdout: string): string {
  let msg: unknown;
  try {
    msg = JSON.parse(stdout);
  } catch {
    // Some versions print an array of events.
    msg = undefined;
  }
  const result = Array.isArray(msg) ? [...msg].reverse().find((m) => m && typeof m === "object" && (m as { type?: unknown }).type === "result") : msg;
  if (!result || typeof result !== "object") throw new ModelCallError("The model returned something unreadable.", "failed");
  const r = result as { is_error?: unknown; subtype?: unknown; result?: unknown };
  if (r.is_error === true || (r.subtype !== undefined && r.subtype !== "success") || typeof r.result !== "string") {
    const known = classifyFailure(typeof r.result === "string" ? r.result : "", 0);
    throw new ModelCallError(known.startsWith("The agent process exited") ? "The model reported an error." : known, /not signed in|not available for this account/.test(known) ? "unavailable" : "failed");
  }
  return r.result;
}

// ── Gemini ──────────────────────────────────────────────────────────────────

export const GEMINI_DENY_ALL_POLICY = ["[[rule]]", 'toolName = "*"', 'decision = "deny"', "priority = 999", 'denyMessage = "No tools are available."', ""].join("\n");
export const GEMINI_NO_MCP_SETTINGS = JSON.stringify({ mcpServers: {}, mcp: { allowed: [] } });

export function geminiInferenceInvocation(opts: { model?: string; policyPath: string; settingsPath: string }): { args: string[]; env: Record<string, string> } {
  const args = ["-p", "Follow the request below.", "--output-format", "json", "--approval-mode", "default", "--policy", opts.policyPath, "--allowed-mcp-server-names="];
  if (opts.model) {
    if (!MODEL_ID_PATTERN.test(opts.model)) throw new ModelCallError("The model id is not valid.", "unavailable");
    args.push("--model", opts.model);
  }
  return { args, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: opts.settingsPath } };
}

export function parseGeminiResult(stdout: string): string {
  try {
    const v: unknown = JSON.parse(stdout);
    if (v && typeof v === "object" && typeof (v as { response?: unknown }).response === "string") return (v as { response: string }).response;
  } catch {
    /* plain text */
  }
  return stdout;
}

// ── CLI process ─────────────────────────────────────────────────────────────

export type SpawnFn = (command: string, args: readonly string[], options: Parameters<typeof nodeSpawn>[2]) => ChildProcess;

export type CliModelOptions = {
  cli: "claude" | "gemini";
  /** Absolute path found by detection. */
  binary: string;
  label: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  tmpRoot?: string;
};

export function createCliInferenceModel(opts: CliModelOptions): InferenceModel {
  return {
    label: opts.label,
    local: false,
    async complete(req: ModelRequest): Promise<string> {
      const dir = mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "helmstack-judge-"));
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* best effort */
      }
      try {
        let args: string[];
        let stdin = req.user;
        let extraEnv: Record<string, string> = {};
        if (opts.cli === "claude") {
          args = claudeInferenceArgs({ ...(opts.model ? { model: opts.model } : {}), system: req.system });
        } else {
          const policyPath = path.join(dir, "deny-all.toml");
          const settingsPath = path.join(dir, "settings.json");
          writeFileSync(policyPath, GEMINI_DENY_ALL_POLICY, { mode: 0o600 });
          writeFileSync(settingsPath, GEMINI_NO_MCP_SETTINGS, { mode: 0o600 });
          const inv = geminiInferenceInvocation({ ...(opts.model ? { model: opts.model } : {}), policyPath, settingsPath });
          args = inv.args;
          extraEnv = inv.env;
          stdin = `${req.system}\n\n${req.user}`;
        }
        const out = await runProcess({ binary: opts.binary, args, stdin, env: { ...scrubbedEnv(opts.env ?? process.env), ...extraEnv }, cwd: dir, spawn: opts.spawn ?? nodeSpawn, req });
        if (opts.cli === "claude" && out.stdout.trim() !== "") {
          // A failed run still prints a result object; it carries the better reason.
          const text = parseClaudeResult(out.stdout);
          if (out.code === 0) return text;
        } else if (out.code === 0) {
          return parseGeminiResult(out.stdout);
        }
        const known = classifyFailure(out.stderr, out.code);
        throw new ModelCallError(known, /not signed in|not available for this account|could not be started/.test(known) ? "unavailable" : "failed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

type RunProcess = {
  binary: string;
  args: string[];
  stdin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: SpawnFn;
  req: ModelRequest;
};

function runProcess(p: RunProcess): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    if (p.req.signal.aborted) return reject(new ModelCallError("Cancelled.", "cancelled"));
    let child: ChildProcess;
    try {
      child = p.spawn(p.binary, p.args, {
        cwd: p.cwd,
        env: p.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch {
      return reject(new ModelCallError("The CLI could not be started.", "unavailable"));
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timedOut = false;
    let capped = false;
    let killTimer: NodeJS.Timeout | null = null;
    const kill = (): void => {
      if (child.pid) killGroup(child.pid, "SIGTERM");
      else child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid) killGroup(child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, p.req.timeoutMs);
    const onAbort = (): void => {
      kill();
    };
    p.req.signal.addEventListener("abort", onAbort, { once: true });
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.req.signal.removeEventListener("abort", onAbort);
      fn();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDOUT_BYTES) {
        capped = true;
        kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.on("error", () => done(() => reject(new ModelCallError("The CLI could not be started.", "unavailable"))));
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      done(() => {
        if (p.req.signal.aborted) return reject(new ModelCallError("Cancelled.", "cancelled"));
        if (timedOut) return reject(new ModelCallError("The model took too long to answer.", "timeout"));
        if (capped) return reject(new ModelCallError("The model produced too much output.", "failed"));
        resolve({ stdout, stderr, code });
      });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(p.stdin);
  });
}

// ── local runtimes ──────────────────────────────────────────────────────────

export const DEFAULT_JUDGE_NUM_CTX = 8192;

export type LocalRequest = { path: string; body: Record<string, unknown> };

/** Ollama chat request: messages only, no `tools`. */
export function ollamaChatRequest(opts: { model: string; system: string; user: string; numCtx?: number }): LocalRequest {
  return {
    path: "/api/chat",
    body: {
      model: opts.model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user }
      ],
      options: { temperature: 0, num_ctx: opts.numCtx ?? DEFAULT_JUDGE_NUM_CTX, num_predict: INFER_MAX_OUTPUT_TOKENS }
    }
  };
}

/** OpenAI-compatible chat request: messages only, no `tools`. */
export function openAiChatRequest(opts: { model: string; system: string; user: string }): LocalRequest {
  return {
    path: "/v1/chat/completions",
    body: {
      model: opts.model,
      stream: false,
      temperature: 0,
      max_tokens: INFER_MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user }
      ]
    }
  };
}

export type LocalModelOptions = {
  kind: "ollama" | "openai-compat";
  origin: string;
  model: string;
  label: string;
  numCtx?: number;
  fetchImpl?: typeof fetch;
};

export function createLocalInferenceModel(opts: LocalModelOptions): InferenceModel {
  return {
    label: opts.label,
    local: true,
    async complete(req: ModelRequest): Promise<string> {
      if (!loopbackOrigin(opts.origin)) throw new ModelCallError("Only a model server on this computer can be used.", "unavailable");
      const wire =
        opts.kind === "ollama"
          ? ollamaChatRequest({ model: opts.model, system: req.system, user: req.user, ...(opts.numCtx ? { numCtx: opts.numCtx } : {}) })
          : openAiChatRequest({ model: opts.model, system: req.system, user: req.user });
      // One controller covers connecting, generating and reading the body.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeoutMs);
      const onAbort = (): void => controller.abort();
      req.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const res = await loopbackFetch(opts.origin, wire.path, { method: "POST", body: wire.body, signal: controller.signal, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
        if (!res.ok) {
          void res.body?.cancel().catch(() => undefined);
          throw new ModelCallError(res.status === 404 ? "The local model server does not have that model." : "The local model server returned an error.", res.status === 404 ? "unavailable" : "failed");
        }
        const json = (await readJsonCapped(res, 2 * 1024 * 1024)) as { message?: { content?: unknown }; choices?: Array<{ message?: { content?: unknown } }> } | null;
        const content = opts.kind === "ollama" ? json?.message?.content : json?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new ModelCallError("The local model server returned something unreadable.", "failed");
        return content;
      } catch (err) {
        if (err instanceof ModelCallError) throw err;
        if (req.signal.aborted) throw new ModelCallError("Cancelled.", "cancelled");
        if (timedOut) throw new ModelCallError("The model took too long to answer.", "timeout");
        if (err instanceof LoopbackError) throw new ModelCallError("The local model server is not reachable.", "unavailable");
        throw new ModelCallError("The local model server is not reachable.", "unavailable");
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
      }
    }
  };
}
