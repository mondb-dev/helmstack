import path from "node:path";

import type { AgentModelOption } from "../../../../shared/src/index.js";
import { MODEL_ID_PATTERN } from "../types.js";
import type { AdapterEvent, AgentCliAdapter, BuildTurnInput, BuiltTurn, PrepareInput, TurnParser } from "../types.js";
import { classifyFailure, readJsonFile, shortToolName, toolSummary, writePrivateFile } from "../util.js";

const SERVER = "helmstack";

/**
 * Model ids come from the installed CLI itself (its bundled docs and model
 * table: `VALID_GEMINI_MODELS` plus the `auto`/`pro`/`flash`/`flash-lite`
 * aliases), not from memory. "Default" lets the CLI choose.
 */
const MODELS: readonly AgentModelOption[] = [
  { id: "", label: "Default (auto)", source: "alias" },
  { id: "pro", label: "Pro", source: "alias" },
  { id: "flash", label: "Flash", source: "alias" },
  { id: "flash-lite", label: "Flash-Lite", source: "alias" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", source: "alias" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", source: "alias" },
  { id: "gemini-3-pro-preview", label: "Gemini 3 Pro (preview)", source: "alias" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", source: "alias" }
];

type Prepared = { settingsPath: string | null; policyPath: string };

export const geminiAdapter: AgentCliAdapter = {
  id: "gemini",
  label: "Gemini CLI",
  binaryNames: process.platform === "win32" ? ["gemini.cmd", "gemini.exe"] : ["gemini"],
  // The deny-all + allow-HelmStack-MCP policy below is applied on every run, but
  // it could not be verified end to end (the CLI could not authenticate on the
  // machine this adapter was built on), so it is NOT claimed as confinement:
  // starting a Gemini conversation requires the explicit `allowUnconfined`
  // acknowledgement and the UI labels it experimental.
  confined: false,
  experimental: true,
  supportsResume: true,
  models: MODELS,

  readConfiguredModel(home) {
    const json = readJsonFile(path.join(home, ".gemini", "settings.json"));
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const model = (json as Record<string, any>).model;
      const name = typeof model === "string" ? model : model && typeof model === "object" ? model.name : undefined;
      if (typeof name === "string" && MODEL_ID_PATTERN.test(name)) return name;
    }
    return null;
  },

  prepare({ dir, mcp }: PrepareInput): Prepared {
    // Gemini has no per-run MCP flag; a system-settings file (highest
    // precedence, selected via GEMINI_CLI_SYSTEM_SETTINGS_PATH) carries the
    // server so the user's own ~/.gemini/settings.json is never modified.
    let settingsPath: string | null = null;
    if (mcp) {
      settingsPath = path.join(dir, "gemini-settings.json");
      writePrivateFile(
        settingsPath,
        JSON.stringify({
          mcpServers: { [mcp.name]: { command: mcp.command, args: mcp.args, env: mcp.env, trust: true } },
          mcp: { allowed: [mcp.name] }
        })
      );
    }
    // Policy: deny every tool, then allow only the HelmStack MCP server's tools.
    const policyPath = path.join(dir, "gemini-policy.toml");
    writePrivateFile(
      policyPath,
      [
        "[[rule]]",
        'toolName = "*"',
        'decision = "deny"',
        "priority = 100",
        'denyMessage = "Only HelmStack browser tools are available in this chat."',
        "",
        "[[rule]]",
        'toolName = "*"',
        `mcpName = "${SERVER}"`,
        'decision = "allow"',
        "priority = 500",
        ""
      ].join("\n")
    );
    return { settingsPath, policyPath };
  },

  buildTurn(input: BuildTurnInput): BuiltTurn {
    const prepared = input.prepared as Prepared;
    // The prompt travels on stdin (appended to the fixed `-p` text); only the
    // fixed instruction string is on argv.
    const args = ["-p", "Follow the request below.", "--output-format", "stream-json"];
    if (input.model) args.push("--model", input.model);
    args.push(input.resume ? "--resume" : "--session-id", input.sessionId);
    // Always restricted as far as the CLI allows, even when acknowledged
    // unconfined. Never --yolo / auto_edit.
    args.push("--approval-mode", "default");
    args.push("--policy", prepared.policyPath);
    args.push(`--allowed-mcp-server-names=${SERVER}`);
    const env: Record<string, string> = {};
    if (prepared.settingsPath) env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = prepared.settingsPath;
    // Gemini has no system-prompt flag: the context is prepended to the request.
    return { args, stdin: `${input.context}\n\n${input.prompt}`, env };
  },

  createParser: createGeminiParser
};

export function createGeminiParser(): TurnParser {
  let sawResult = false;
  const names = new Map<string, true>();
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
        case "init":
          if (typeof msg.session_id === "string") out.push({ kind: "session", sessionId: msg.session_id });
          break;
        case "message":
          if (msg.role === "assistant" && typeof msg.content === "string" && msg.content) {
            out.push({ kind: "text_delta", text: msg.content });
          }
          break;
        case "tool_use":
          if (typeof msg.tool_id === "string" && typeof msg.tool_name === "string") {
            const short = shortToolName(msg.tool_name, SERVER);
            names.set(msg.tool_id, true);
            // `parameters` carries the arguments and is deliberately dropped.
            out.push({
              kind: "tool_call",
              callId: msg.tool_id,
              name: short.name,
              summary: toolSummary(short.name, short.mcp),
              status: "running"
            });
          }
          break;
        case "tool_result":
          if (typeof msg.tool_id === "string") {
            out.push({ kind: "tool_call", callId: msg.tool_id, name: "", status: msg.status === "success" ? "ok" : "error" });
          }
          break;
        case "result":
          sawResult = true;
          out.push({ kind: "result", ok: msg.status === "success", ...(msg.status === "success" ? {} : { error: "The agent reported an error." }) });
          break;
      }
      return out;
    },
    end({ code, stderr }) {
      if (sawResult) return [];
      return [{ kind: "result", ok: code === 0, ...(code === 0 ? {} : { error: classifyFailure(stderr, code) }) }];
    }
  };
}
