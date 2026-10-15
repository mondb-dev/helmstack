/**
 * Adapter contract for in-window agent chat. An adapter knows how to find one
 * agent CLI, which models to offer, how to build a fixed-template argv for one
 * turn, and how to turn that CLI's streaming output into neutral events.
 *
 * Adding a CLI = one new file implementing `AgentCliAdapter` + one line in
 * `adapters/index.ts`. Nothing here may import Electron.
 */
import type { AgentCliId, AgentModelOption } from "../../../shared/src/index.js";

/** Neutral parse result of one output line (never carries tool arguments/results). */
export type AdapterEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text_delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool_call"; callId: string; name: string; summary?: string; status: "running" | "ok" | "error" }
  | { kind: "result"; ok: boolean; error?: string };

export interface TurnParser {
  /** Feed one stdout line. Must never throw. */
  push(line: string): AdapterEvent[];
  /** Called once when the process has ended. */
  end(exit: { code: number | null; stderr: string }): AdapterEvent[];
}

/** How to launch HelmStack's MCP server (a stdio server) for this conversation. */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface PrepareInput {
  /** Private per-conversation directory (0700); files written here are deleted on close. */
  dir: string;
  mcp: McpServerSpec | null;
}

export interface BuildTurnInput {
  prepared: unknown;
  model: string;
  sessionId: string;
  /** True when a previous turn of this conversation established the session. */
  resume: boolean;
  prompt: string;
  tabId: string;
  /** Tab/context instructions the agent should see. */
  context: string;
  unconfined: boolean;
}

export interface BuiltTurn {
  /** Fixed-template argv; the binary is supplied separately. */
  args: string[];
  /** Written to the child's stdin, then closed. */
  stdin: string;
  /** Extra env vars (merged over the scrubbed base env). */
  env: Record<string, string>;
}

export interface AgentCliAdapter {
  readonly id: AgentCliId;
  readonly label: string;
  /** Allowlisted executable names looked up on PATH. Nothing else is ever run. */
  readonly binaryNames: readonly string[];
  /** True only when the adapter's MCP-only confinement was verified. */
  readonly confined: boolean;
  readonly experimental: boolean;
  readonly supportsResume: boolean;
  readonly models: readonly AgentModelOption[];
  /** The CLI's own configured default model, or null. Reads ONLY the model key. */
  readConfiguredModel(home: string): string | null;
  prepare(input: PrepareInput): unknown;
  buildTurn(input: BuildTurnInput): BuiltTurn;
  createParser(): TurnParser;
}

/** Model ids are validated against this before ever reaching an argv. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,80}$/;

export function isValidModelId(model: string): boolean {
  return model === "" || MODEL_ID_PATTERN.test(model);
}
