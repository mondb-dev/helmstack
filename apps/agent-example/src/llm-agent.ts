/**
 * HelmStack — Vertex AI (Gemini) agentic browser loop
 *
 * Usage:
 *   npm run llm -w @helmstack/agent-example
 *   TASK="Go to Wikipedia and find today's featured article" npm run llm -w @helmstack/agent-example
 *
 * Prerequisites: npm run dev -w @helmstack/desktop
 */

import {
  GoogleGenAI,
  createPartFromFunctionResponse,
} from "@google/genai";
import type { FunctionDeclaration, Content, Part } from "@google/genai";
import { createBrowserClient } from "@helmstack/agent-sdk";
import type { PageGraph } from "@helmstack/agent-sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const TASK =
  process.env.TASK ??
  process.argv[2] ??
  "Navigate to https://news.ycombinator.com and list the top 5 story titles.";

const PROJECT  = process.env.VERTEX_PROJECT;
const LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const MODEL    = process.env.VERTEX_MODEL    ?? "gemini-2.5-pro";
const MAX_STEPS = 15;

if (!PROJECT) {
  console.error("Missing VERTEX_PROJECT env var. Set it to your GCP project ID.");
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Missing GOOGLE_APPLICATION_CREDENTIALS env var. Set it to your service-account key file.");
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const browser = createBrowserClient({ timeout: 90_000 });

const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });

// ── Tool definitions ──────────────────────────────────────────────────────────

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL",
    parametersJsonSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL e.g. https://example.com" },
      },
      required: ["url"],
    },
  },
  {
    name: "click",
    description:
      "Click a UI element. Use the exact action_id from the Actions list in the " +
      "current page state (e.g. 'link-3', 'btn-0'). Do NOT invent IDs — " +
      "only use IDs visible in the current page state.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        action_id: {
          type: "string",
          description: "Exact ID from the Actions list in the current page state",
        },
      },
      required: ["action_id"],
    },
  },
  {
    name: "fill_form",
    description: "Fill form fields by field ID",
    parametersJsonSchema: {
      type: "object",
      properties: {
        form_id: { type: "string", description: "Form ID from the forms list" },
        fields: {
          type: "object",
          description: "Map of field_id to string value",
          additionalProperties: { type: "string" },
        },
      },
      required: ["form_id", "fields"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down",
    parametersJsonSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["down", "up"] },
      },
      required: ["direction"],
    },
  },
  {
    name: "submit_form",
    description: "Submit a form after filling it. Use the exact form_id from the Forms list.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        form_id: { type: "string", description: "Form ID from the forms list" },
      },
      required: ["form_id"],
    },
  },
  {
    name: "set_viewport",
    description:
      "Switch the browser viewport to emulate a device size. " +
      "Use this to check responsive layout. After calling, a new screenshot will be captured. " +
      "Presets: mobile=375×812 (iPhone), tablet=768×1024 (iPad), desktop=1440×900.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["mobile", "tablet", "desktop"],
          description: "mobile=375px wide, tablet=768px wide, desktop=1440px wide",
        },
      },
      required: ["preset"],
    },
  },
  {
    name: "done",
    description: "Signal task completion with a full summary of findings",
    parametersJsonSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Full answer or summary" },
      },
      required: ["summary"],
    },
  },
];

// ── Page description ──────────────────────────────────────────────────────────

function describeGraph(url: string, title: string, graph: PageGraph): string {
  const lines = [`URL: ${url}`, `Title: ${title}`, `Page type: ${graph.kind}`];

  if (graph.headings.length > 0) {
    lines.push(`Headings: ${graph.headings.slice(0, 10).join(" | ")}`);
  }

  if (graph.actions.length > 0) {
    lines.push(`\nActions (${graph.actions.length}):`);
    for (const a of graph.actions.slice(0, 40)) {
      const href = a.href ? ` -> ${a.href}` : "";
      lines.push(`  [${a.id}] (${a.kind}) ${a.label}${href}`);
    }
    if (graph.actions.length > 40) lines.push(`  ... and ${graph.actions.length - 40} more`);
  }

  if (graph.forms.length > 0) {
    lines.push(`\nForms:`);
    for (const f of graph.forms) {
      lines.push(`  Form [${f.id}] (${f.purpose})`);
      for (const field of f.fields) {
        lines.push(`    [${field.id}] "${field.label}" (${field.fieldType})`);
      }
    }
  }

  return lines.join("\n");
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(
  tabId: string,
  name: string,
  args: Record<string, unknown>,
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
          args: {},
        });
        if (res.status === "awaiting_approval") await browser.approveCommand(res.requestId!);
        await sleep(1500);
        return `Clicked [${args.action_id}]: ${res.status}`;
      }
      case "submit_form": {
        const res = await browser.execute(tabId, {
          type: "invoke_site_tool",
          provider: "dom",
          toolName: `dom.submit.${args.form_id}`,
          args: {},
        });
        if (res.status === "awaiting_approval") {
          const approved = await browser.approveCommand(res.requestId!);
          await sleep(2000);
          return `Submitted form [${args.form_id}]: ${approved.status}`;
        }
        await sleep(2000);
        return `Submitted form [${args.form_id}]: ${res.status}`;
      }
      case "fill_form": {
        const res = await browser.execute(tabId, {
          type: "invoke_site_tool",
          provider: "dom",
          toolName: `dom.fill.${args.form_id}`,
          args: args.fields as Record<string, unknown>,
        });
        if (res.status === "awaiting_approval") await browser.approveCommand(res.requestId!);
        return `Filled form [${args.form_id}]: ${res.status}`;
      }
      case "scroll": {
        const res = await browser.execute(tabId, {
          type: "invoke_site_tool",
          provider: "dom",
          toolName: `dom.scroll.${args.direction}`,
          args: {},
        });
        await sleep(600);
        return `Scrolled ${args.direction}: ${res.status}`;
      }
      case "set_viewport": {
        const presets: Record<string, [number, number, boolean]> = {
          mobile:  [375,  812, true],
          tablet:  [768, 1024, false],
          desktop: [1440, 900, false],
        };
        const [w, h, mob] = presets[args.preset as string] ?? presets.desktop!;
        await browser.setViewport(tabId, w, h, mob);
        await sleep(800);
        return `Viewport set to ${args.preset} (${w}×${h}, mobile=${mob})`;
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
const log = (msg: string) => console.log(`[agent] ${msg}`);

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  const health = await browser.health().catch(() => null);
  if (!health) {
    console.error("[agent] Browser not reachable. Run: npm run dev -w @helmstack/desktop");
    process.exit(1);
  }
  log(`Browser OK — ${health.tabs} tab(s)`);

  const tabs = await browser.listTabs();
  let tabId = tabs[0]?.id;
  if (!tabId) tabId = (await browser.openTab("about:blank"))[0]!.id;

  log(`Using tab ${tabId.slice(0, 8)}...  model: ${MODEL}`);
  log(`Task: "${TASK}"\n`);

  async function observe(label = "Current browser state"): Promise<Part[]> {
    const [perception, screenshot] = await Promise.allSettled([
      browser.getPerception(tabId!),
      browser.getScreenshot(tabId!),
    ]);

    const parts: Part[] = [];

    if (perception.status === "fulfilled") {
      const snap = perception.value.result.snapshot;
      parts.push({ text: `${label}:\n${describeGraph(snap.url, snap.title, perception.value.result.graph)}` });
    } else {
      parts.push({ text: `${label}: (perception unavailable)` });
    }

    if (screenshot.status === "fulfilled") {
      parts.push({ inlineData: { mimeType: "image/png", data: screenshot.value.data } });
    }

    return parts;
  }

  const history: Content[] = [];

  history.push({
    role: "user",
    parts: [{ text: `Task: ${TASK}` }, ...await observe()],
  });

  log("Sending to Vertex AI...\n");

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: history,
      config: {
        systemInstruction:
          "You are a web browsing agent controlling a real browser. " +
          "You receive structured page descriptions (URL, headings, actions, forms). " +
          "Always respond in English. " +
          "Only use action IDs that appear in the current page state — never invent IDs. " +
          "Use tools to complete the task. Call done() when finished.",
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content) { log("No candidate returned."); break; }

    history.push({ role: "model", parts: candidate.content.parts });

    const text = response.text;
    if (text) log(`Gemini: ${text.slice(0, 300)}`);

    const fnCalls = response.functionCalls ?? [];
    if (fnCalls.length === 0) { log("No function calls — done."); break; }

    let isDone = false;
    const responseParts = fnCalls.map(call => {
      return { call, resultPromise: null as Promise<string> | null };
    });

    // Execute tools sequentially (each may change page state)
    const fnResponseParts = [];
    for (const call of fnCalls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      log(`-> [step ${step + 1}] ${call.name}(${JSON.stringify(args).slice(0, 100)})`);

      const output = await executeTool(tabId!, call.name ?? "", args);
      log(`<- ${output.slice(0, 140)}`);

      if (call.name === "done") {
        isDone = true;
        console.log(`\n${"=".repeat(64)}`);
        console.log("  TASK COMPLETE");
        console.log("=".repeat(64));
        console.log(args.summary as string);
        console.log("=".repeat(64) + "\n");
      }

      fnResponseParts.push(
        createPartFromFunctionResponse(call.id ?? call.name ?? "", call.name ?? "", { output }),
      );
    }

    void responseParts; // unused after refactor

    if (isDone) break;

    const updatedState = await observe("Updated browser state");
    history.push({
      role: "user",
      parts: [
        ...fnResponseParts,
        ...updatedState,
      ],
    });
  }

  log("Agent finished.");
  process.exit(0);
}

run().catch(err => {
  console.error("[agent] Fatal:", err);
  process.exit(1);
});
