import path from "node:path";

import type { AgentModelOption } from "../../../../shared/src/index.js";
import { MODEL_ID_PATTERN } from "../types.js";
import type { AdapterEvent, AgentCliAdapter, BuildTurnInput, BuiltTurn, McpServerSpec, PrepareInput, TurnParser } from "../types.js";
import { classifyFailure, readJsonFile, shortToolName, toolSummary, writePrivateFile } from "../util.js";

const SERVER = "helmstack";

/** Built-in Claude Code tools. Disabled via `--tools ""`; also denied explicitly (belt and braces). */
export const DENIED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "SlashCommand",
  "Skill"
];

const MODELS: readonly AgentModelOption[] = [
  { id: "", label: "Default", source: "alias" },
  { id: "sonnet", label: "Sonnet", source: "alias" },
  { id: "opus", label: "Opus", source: "alias" },
  { id: "haiku", label: "Haiku", source: "alias" }
];

type Prepared = { mcpConfigPath: string | null };

export const claudeAdapter: AgentCliAdapter = {
  id: "claude",
  label: "Claude Code",
  binaryNames: process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"],
  confined: true,
  experimental: false,
  supportsResume: true,
  models: MODELS,

  readConfiguredModel(home) {
    const json = readJsonFile(path.join(home, ".claude", "settings.json"));
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const model = (json as Record<string, unknown>).model;
      if (typeof model === "string" && MODEL_ID_PATTERN.test(model)) return model;
    }
    return null;
  },

  prepare({ dir, mcp }: PrepareInput): Prepared {
    if (!mcp) return { mcpConfigPath: null };
    const file = path.join(dir, "claude-mcp.json");
    writePrivateFile(file, JSON.stringify({ mcpServers: { [mcp.name]: mcpEntry(mcp) } }));
    return { mcpConfigPath: file };
  },

  buildTurn(input: BuildTurnInput): BuiltTurn {
    const prepared = input.prepared as Prepared;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (input.model) args.push("--model", input.model);
    args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
    if (!input.unconfined) {
      // Confinement: no built-in tools at all, only HelmStack's MCP server's
      // tools, and anything not pre-allowed is denied (never prompted) in
      // headless mode. Never `--dangerously-skip-permissions`/bypassPermissions.
      args.push("--tools=");
      args.push(`--allowedTools=mcp__${SERVER}`);
      args.push(`--disallowedTools=${DENIED_TOOLS.join(",")}`);
      args.push("--permission-mode", "dontAsk");
      args.push("--strict-mcp-config");
    }
    if (prepared.mcpConfigPath) args.push("--mcp-config", prepared.mcpConfigPath);
    args.push("--disable-slash-commands");
    args.push("--append-system-prompt", input.context);
    return { args, stdin: input.prompt, env: {} };
  },

  createParser: createClaudeParser
};

function mcpEntry(mcp: McpServerSpec) {
  return { type: "stdio", command: mcp.command, args: mcp.args, env: mcp.env };
}

export function createClaudeParser(): TurnParser {
  const open = new Map<string, true>();
  let sawResult = false;
  let sawText = false;
  return {
    push(line: string): AdapterEvent[] {
      const out: AdapterEvent[] = [];
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return out;
      }
      if (!msg || typeof msg !== "object") return out;
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init" && typeof msg.session_id === "string") {
            out.push({ kind: "session", sessionId: msg.session_id });
          }
          break;
        case "stream_event": {
          const delta = msg.event?.delta;
          // Only text deltas. `input_json_delta` carries tool arguments — never forwarded.
          if (msg.event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
            out.push({ kind: "text_delta", text: delta.text });
          }
          break;
        }
        case "assistant": {
          const content = msg.message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string" && block.text) {
              sawText = true;
              out.push({ kind: "text", text: block.text });
            } else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
              const short = shortToolName(block.name, SERVER);
              open.set(block.id, true);
              out.push({
                kind: "tool_call",
                callId: block.id,
                name: short.name,
                summary: toolSummary(short.name, short.mcp),
                status: "running"
              });
            }
          }
          break;
        }
        case "user": {
          const content = msg.message?.content;
          if (!Array.isArray(content)) break;
          for (const block of content) {
            if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
              // Status only; the result content is dropped.
              open.delete(block.tool_use_id);
              out.push({
                kind: "tool_call",
                callId: block.tool_use_id,
                name: "",
                status: block.is_error === true ? "error" : "ok"
              });
            }
          }
          break;
        }
        case "result": {
          sawResult = true;
          const ok = msg.is_error !== true && msg.subtype === "success";
          if (ok && !sawText && typeof msg.result === "string" && msg.result) {
            out.push({ kind: "text", text: msg.result });
          }
          out.push({ kind: "result", ok, ...(ok ? {} : { error: resultError(msg.subtype, msg.result) }) });
          break;
        }
      }
      return out;
    },
    end({ code, stderr }) {
      if (sawResult) return [];
      return [{ kind: "result", ok: code === 0, ...(code === 0 ? {} : { error: classifyFailure(stderr, code) }) }];
    }
  };
}

function resultError(subtype: unknown, text: unknown): string {
  // Classified into a fixed sentence; the CLI's own text is never forwarded.
  const known = classifyFailure(typeof text === "string" ? text : "", 0);
  if (!known.startsWith("The agent process exited")) return known;
  switch (subtype) {
    case "error_max_turns":
      return "The agent reached its turn limit.";
    case "error_during_execution":
      return "The agent hit an error while working.";
    default:
      return "The agent reported an error.";
  }
}
