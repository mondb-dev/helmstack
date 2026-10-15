/**
 * Live benchmark: lite vs full toolset on the fixture site, driven by a real
 * model. SKIPPED unless HELMSTACK_LITE_BENCH=1 (it spends tokens).
 *
 *   HELMSTACK_LITE_BENCH=1 npx vitest run --project dom packages/mcp-server/test/lite-bench
 *
 * Knobs (all env):
 *   HELMSTACK_LITE_BENCH_TOOLSETS   "lite,full" (default)
 *   HELMSTACK_LITE_BENCH_TASKS      comma-separated task ids (default: all)
 *   HELMSTACK_LITE_BENCH_MODEL      claude alias/model id (default "haiku")
 *   HELMSTACK_LITE_BENCH_MAX_RUNS   hard cap on live invocations (default 30)
 *   HELMSTACK_LITE_BENCH_PORT       daemon port (default 7193; 7070/7183/7184 refused)
 *   HELMSTACK_LITE_BENCH_PAGES_PORT fixture site port (default 4188)
 *   HELMSTACK_LITE_BENCH_OUT        write the JSON report here
 *   HELMSTACK_LITE_BENCH_OPENAI_BASE_URL + HELMSTACK_LITE_BENCH_OPENAI_MODEL
 *       drive an OpenAI-compatible endpoint (e.g. Ollama http://127.0.0.1:11434/v1)
 *       instead of the claude CLI.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  type BenchTask,
  type RunOutcome,
  type TaskResult,
  type Toolset,
  planClaudeTurn,
  runClaude,
  runOpenAiCompatible,
  scrubbedNames,
  startDaemon,
  startPageServer,
  summarize
} from "./harness.js";
import { TASKS } from "./tasks.js";

const enabled = process.env.HELMSTACK_LITE_BENCH === "1";
const env = (name: string, fallback = "") => process.env[`HELMSTACK_LITE_BENCH_${name}`]?.trim() || fallback;

describe.skipIf(!enabled)("lite vs full toolset (live model)", () => {
  const results: TaskResult[] = [];

  afterAll(() => {
    const summary = summarize(results);
    const report = { model: env("OPENAI_MODEL") || env("MODEL", "haiku"), summary, results: results.map((r) => ({ ...r, outcome: { ...r.outcome, toolCalls: r.outcome.toolCalls.map((c) => ({ name: c.name, input: c.input, isError: c.isError, result: c.result.slice(0, 400) })) } })) };
    const out = env("OUT");
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ model: report.model, summary }, null, 2));
  });

  it(
    "runs every task under each toolset",
    async () => {
      const toolsets = env("TOOLSETS", "lite,full").split(",").map((s) => s.trim()).filter((s): s is Toolset => s === "lite" || s === "full");
      const wanted = env("TASKS") ? new Set(env("TASKS").split(",").map((s) => s.trim())) : null;
      const tasks: BenchTask[] = TASKS.filter((t) => !wanted || wanted.has(t.id));
      const maxRuns = Number(env("MAX_RUNS", "30"));
      const model = env("MODEL", "haiku");
      const openAiBase = env("OPENAI_BASE_URL");
      const daemonPort = Number(env("PORT", "7193"));
      const pagesPort = Number(env("PAGES_PORT", "4188"));

      const root = mkdtempSync(path.join(tmpdir(), "helmstack-lite-bench-"));
      const token = `bench-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const tokenFile = path.join(root, "agent-token");
      writeFileSync(tokenFile, token, { mode: 0o600 });
      console.log(`removed from the child environment: ${scrubbedNames(process.env).join(", ") || "(nothing)"}`);

      const pages = await startPageServer(pagesPort);
      let live = 0;
      try {
        for (const toolset of toolsets) {
          for (const task of tasks) {
            if (live >= maxRuns) break;
            live += 1;
            // A fresh daemon per run: no leftover tabs, storage or viewport.
            const daemon = await startDaemon({ port: daemonPort, dataDir: path.join(root, `data-${live}`), token });
            try {
              const tabs = await daemon.client.listTabs();
              const tabId = tabs[0]!.id;
              await daemon.client.navigate(tabId, `${pages.baseUrl}${task.start}`);
              await new Promise((r) => setTimeout(r, 500));

              let outcome: RunOutcome;
              if (openAiBase) {
                outcome = await runOpenAiCompatible({ baseUrl: openAiBase, model: env("OPENAI_MODEL"), prompt: task.prompt, toolset, daemonPort, tokenFile });
              } else {
                const dir = path.join(root, `turn-${live}`);
                mkdirSync(dir, { recursive: true, mode: 0o700 });
                const plan = planClaudeTurn({ dir, toolset, model, prompt: task.prompt, daemonPort, tokenFile });
                outcome = await runClaude(plan, { cwd: root });
              }

              const ctx = {
                browser: daemon.client,
                tabId,
                baseUrl: pages.baseUrl,
                finalText: outcome.finalText,
                toolCalls: outcome.toolCalls,
                evaluate: async <T,>(expression: string) => {
                  const list = await daemon.client.listTabs();
                  const active = list.find((t) => t.isActive) ?? list[0]!;
                  // Pages live in the original tab unless the model opened another.
                  const target = list.find((t) => t.id === tabId) ?? active;
                  return daemon.client.evaluate<T>(target.id, expression);
                },
                tabUrls: async () => (await daemon.client.listTabs()).map((t) => t.url)
              };
              const verdict = outcome.ok ? await task.check(ctx) : { pass: false, why: `run failed: ${outcome.error ?? "unknown"}` };
              results.push({ taskId: task.id, toolset, pass: verdict.pass, why: verdict.why, outcome });
              console.log(`[${toolset}] ${task.id}: ${verdict.pass ? "PASS" : "FAIL"} (${verdict.why}) calls=${outcome.toolCalls.length} in=${outcome.usage.inputTokens}+${outcome.usage.cacheReadTokens}cached out=${outcome.usage.outputTokens}`);
            } finally {
              await daemon.close();
            }
          }
        }
      } finally {
        await pages.close();
      }
      expect(results.length).toBeGreaterThan(0);
    },
    90 * 60_000
  );
});
