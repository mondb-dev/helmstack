/**
 * HelmStack — OpenAI (GPT-4o) agentic browser loop
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npm run openai -w @helmstack/agent-example
 *   TASK="Go to Wikipedia and find today's featured article" OPENAI_API_KEY=sk-... npm run openai -w @helmstack/agent-example
 *
 * Prerequisites: npm run dev -w @helmstack/desktop
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { createBrowserClient } from "@helmstack/agent-sdk";
import type { PageGraph } from "@helmstack/agent-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const TASK =
  process.env.TASK ??
  process.argv[2] ??
  "Navigate to https://news.ycombinator.com and list the top 5 story titles.";

const MODEL     = process.env.OPENAI_MODEL    ?? "gpt-4o";
const MAX_STEPS = Number(process.env.MAX_STEPS ?? 15);

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const browser = createBrowserClient({ timeout: 90_000 });
const openai  = new OpenAI();

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the browser to a URL",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL including https://" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click a UI element. Use the exact action_id from the Actions list in the " +
        "current page state (e.g. 'action-3'). Never invent IDs.",
      parameters: {
        type: "object",
        properties: {
          action_id: {
            type: "string",
            description: "Exact ID from the Actions list in the current page state"
          }
        },
        required: ["action_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fill_form",
      description: "Fill form fields by field ID",
      parameters: {
        type: "object",
        properties: {
          form_id:  { type: "string", description: "Form ID from the Forms list" },
          fields: {
            type: "object",
            description: "Map of field_id to string value",
            additionalProperties: { type: "string" }
          }
        },
        required: ["form_id", "fields"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "submit_form",
      description: "Submit a form after filling it. Use the exact form_id from the Forms list.",
      parameters: {
        type: "object",
        properties: {
          form_id: { type: "string", description: "Form ID from the Forms list" }
        },
        required: ["form_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_viewport",
      description: "Emulate a device viewport. Presets: mobile=375×812, tablet=768×1024, desktop=1440×900.",
      parameters: {
        type: "object",
        properties: {
          preset: {
            type: "string",
            enum: ["mobile", "tablet", "desktop"]
          }
        },
        required: ["preset"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Signal task completion with a final summary",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Full answer or summary" }
        },
        required: ["summary"]
      }
    }
  }
];

// ── Page description ──────────────────────────────────────────────────────────

function describeGraph(url: string, title: string, graph: PageGraph): string {
  const lines = [`URL: ${url}`, `Title: ${title}`, `Page type: ${graph.kind}`];

  if (graph.headings.length > 0) {
    lines.push(`Headings: ${graph.headings.slice(0, 10).join(" | ")}`);
  }

  if (graph.alerts.length > 0) {
    lines.push(`Alerts: ${graph.alerts.join(" | ")}`);
  }

  if (graph.actions.length > 0) {
    lines.push(`\nActions (${graph.actions.length}):`);
    for (const a of graph.actions.slice(0, 40)) {
      const href = a.href ? ` -> ${a.href}` : "";
      lines.push(`  [${a.id}] (${a.kind}) ${a.label}${href}`);
    }
    if (graph.actions.length > 40) lines.push(`  … and ${graph.actions.length - 40} more`);
  }

  if (graph.forms.length > 0) {
    lines.push(`\nForms:`);
    for (const f of graph.forms) {
      lines.push(`  Form [${f.id}] (${f.purpose})`);
      for (const field of f.fields) {
        lines.push(`    [${field.id}] "${field.label}" (${field.fieldType}${field.required ? ", required" : ""})`);
      }
    }
  }

  return lines.join("\n");
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(
  tabId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case "navigate": {
        await browser.navigate(tabId, args.url as string);
        await sleep(3000);
        return `Navigated to ${args.url}`;
      }
      case "click": {
        const res = await browser.execute(tabId, {
          type: "invoke_site_tool",
          provider: "dom",
          toolName: `dom.activate.${args.action_id}`,
          args: {}
        });
        if (res.status === "awaiting_approval") await browser.approveCommand(res.requestId!);
        await sleep(1500);
        return `Clicked [${args.action_id}]: ${res.status}`;
      }
      case "fill_form": {
        const res = await browser.execute(tabId, {
          type: "invoke_site_tool",
          provider: "dom",
          toolName: `dom.fill.${args.form_id}`,
          args: args.fields as Record<string, unknown>
        });
        if (res.status === "awaiting_approval") await browser.approveCommand(res.requestId!);
        return `Filled form [${args.form_id}]: ${res.status}`;
      }
      case "submit_form": {
        const res = await browser.execute(tabId, {
          type: "invoke_site_tool",
          provider: "dom",
          toolName: `dom.submit.${args.form_id}`,
          args: {}
        });
        if (res.status === "awaiting_approval") {
          const approved = await browser.approveCommand(res.requestId!);
          await sleep(2000);
          return `Submitted form [${args.form_id}]: ${approved.status}`;
        }
        await sleep(2000);
        return `Submitted form [${args.form_id}]: ${res.status}`;
      }
      case "set_viewport": {
        const presets: Record<string, [number, number, boolean]> = {
          mobile:  [375,  812, true],
          tablet:  [768, 1024, false],
          desktop: [1440, 900, false]
        };
        const [w, h, mob] = presets[args.preset as string] ?? presets.desktop!;
        await browser.setViewport(tabId, w, h, mob);
        await sleep(800);
        return `Viewport set to ${args.preset} (${w}×${h})`;
      }
      case "done":
        return "DONE";
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error in ${name}: ${(err as Error).message}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const log   = (msg: string) => console.log(`[agent] ${msg}`);

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  const health = await browser.health().catch(() => null);
  if (!health) {
    console.error("[agent] Browser not reachable. Run: npm run dev -w @helmstack/desktop");
    process.exit(1);
  }
  log(`Browser OK — ${health.tabs} tab(s)`);

  const tabs = await browser.listTabs();
  let tabId  = tabs[0]?.id;
  if (!tabId) tabId = (await browser.openTab("about:blank"))[0]!.id;

  log(`Using tab ${tabId.slice(0, 8)}…  model: ${MODEL}`);
  log(`Task: "${TASK}"\n`);

  async function observe(label = "Current browser state"): Promise<string> {
    const perception = await browser.getPerception(tabId!);
    const snap = perception.result.snapshot;
    return `${label}:\n${describeGraph(snap.url, snap.title, perception.result.graph)}`;
  }

  const SYSTEM = `You are a web browsing agent controlling a real Chromium browser via the HelmStack substrate.
You receive structured page descriptions (URL, headings, actions, forms) and screenshots.
Only use action_ids and form_ids that appear in the current page state — never invent IDs.
Use tools to complete the task, then call done() with your final answer.`;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user",   content: `Task: ${TASK}\n\n${await observe()}` }
  ];

  log("Sending to OpenAI…\n");

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: "auto"
    });

    const msg = response.choices[0]?.message;
    if (!msg) { log("No message returned."); break; }

    messages.push(msg);

    if (msg.content) log(`GPT: ${msg.content.slice(0, 300)}`);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) { log("No tool calls — done."); break; }

    log(`→ [step ${step + 1}] ${toolCalls.map(c => c.function.name).join(", ")}`);

    let isDone = false;

    // Execute tools sequentially (page state changes between calls)
    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      log(`  ${call.function.name}(${JSON.stringify(args).slice(0, 100)})`);

      const output = await executeTool(tabId!, call.function.name, args);
      log(`  ← ${output.slice(0, 140)}`);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output
      });

      if (call.function.name === "done") {
        isDone = true;
        console.log(`\n${"=".repeat(64)}`);
        console.log("  TASK COMPLETE");
        console.log("=".repeat(64));
        console.log(args.summary as string);
        console.log("=".repeat(64) + "\n");
      }
    }

    if (isDone) break;

    // Append fresh page state so the model sees what changed
    messages.push({
      role: "user",
      content: await observe("Updated browser state")
    });
  }

  log("Agent finished.");
  process.exit(0);
}

run().catch(err => {
  console.error("[agent] Fatal:", err);
  process.exit(1);
});
