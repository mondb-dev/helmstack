import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { autoApprovalPolicies, parseClaudeStream, planClaudeTurn, resolvePagePath, scrubbedNames, startDaemon, summarize, toOpenAiTools } from "./harness.js";
import { TASKS } from "./tasks.js";

describe("lite-bench harness (offline)", () => {
  it("has ~12 tasks with unique ids and every fixture page present", () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    for (const task of TASKS) expect(resolvePagePath(task.start), task.start).not.toBeNull();
  });

  it("serves only inside the fixture directories", () => {
    expect(resolvePagePath("/../../package.json")).toBeNull();
    expect(resolvePagePath("/contact-form.html")).toMatch(/test-pages\/contact-form\.html$/);
  });

  it("plans a confined claude invocation without leaking the token or scrubbed vars", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bench-plan-"));
    const source = { PATH: process.env.PATH, VITEST: "true", HELMSTACK_AUTH_TOKEN: "super-secret", DISABLE_MICROCOMPACT: "1", MCP_CONNECTION_NONBLOCKING: "1", KEEP_ME: "x" };
    const saved = { ...process.env };
    Object.assign(process.env, source);
    try {
      const plan = planClaudeTurn({ dir, toolset: "lite", model: "haiku", prompt: "do it", daemonPort: 7193, tokenFile: "/tmp/tok" });
      expect(plan.args).toContain("--strict-mcp-config");
      expect(plan.args).toContain("--tools=");
      expect(plan.args).toContain("--permission-mode");
      expect(plan.args).toContain("dontAsk");
      expect(plan.args).not.toContain("--dangerously-skip-permissions");
      expect(plan.args[plan.args.indexOf("--model") + 1]).toBe("haiku");
      expect(plan.stdin).toBe("do it");
      expect(plan.env.DISABLE_MICROCOMPACT).toBeUndefined();
      expect(plan.env.MCP_CONNECTION_NONBLOCKING).toBeUndefined();
      expect(plan.env.HELMSTACK_AUTH_TOKEN).toBeUndefined();
      expect(plan.env.KEEP_ME).toBe("x");
      expect(plan.env.VITEST).toBeUndefined();
      const config = JSON.parse(readFileSync(plan.mcpConfigPath, "utf8"));
      expect(config.mcpServers.helmstack.env).toEqual({ HELMSTACK_PORT: "7193", HELMSTACK_TOKEN_FILE: "/tmp/tok", HELMSTACK_TOOLSET: "lite" });
      expect(JSON.stringify(config)).not.toContain("super-secret");
      expect(scrubbedNames(source)).toEqual(["DISABLE_MICROCOMPACT", "HELMSTACK_AUTH_TOKEN", "MCP_CONNECTION_NONBLOCKING", "VITEST"]);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("parses a stream-json transcript into trace and usage", () => {
    const lines = [
      { type: "system", subtype: "init", session_id: "s" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__helmstack__look", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "Page: X" }] }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } }
    ].map((l) => JSON.stringify(l));
    const out = parseClaudeStream(lines.join("\n"));
    expect(out.ok).toBe(true);
    expect(out.finalText).toBe("Done.");
    expect(out.toolCalls).toEqual([{ name: "look", input: {}, result: "Page: X", isError: false }]);
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 7, costUsd: 0.01, turns: 2 });
    expect(parseClaudeStream("garbage\n{").ok).toBe(false);
  });

  it("summarizes per toolset and bridges MCP tools to OpenAI tool format", () => {
    const outcome = { finalText: "", toolCalls: [{ name: "a", input: {}, result: "", isError: false }], usage: { inputTokens: 3, outputTokens: 2, cacheCreationTokens: 0, cacheReadTokens: 1, costUsd: 0.5, turns: 1 }, ok: true, durationMs: 1 };
    const s = summarize([
      { taskId: "x", toolset: "lite", pass: true, why: "", outcome },
      { taskId: "y", toolset: "lite", pass: false, why: "", outcome }
    ]);
    expect(s.lite).toMatchObject({ runs: 2, passed: 1, toolCalls: 2, inputTokens: 6, costUsd: 1 });
    expect(s.full.runs).toBe(0);
    expect(toOpenAiTools([{ name: "look", description: "d", inputSchema: { type: "object" } }])).toEqual([
      { type: "function", function: { name: "look", description: "d", parameters: { type: "object" } } }
    ]);
  });

  it("writes an auto policy that still blocks payments, and refuses the user's ports", async () => {
    const policies = JSON.parse(autoApprovalPolicies()).policies as Array<{ key: string; decision: string }>;
    expect(Object.fromEntries(policies.map((p) => [p.key, p.decision]))).toEqual({
      share_personal_data: "auto",
      create_account: "auto",
      accept_legal_terms: "auto",
      submit_payment: "block"
    });
    for (const port of [7070, 7183, 7184]) {
      await expect(startDaemon({ port, dataDir: tmpdir(), token: "t" })).rejects.toThrow(/reserved/);
    }
  });
});
