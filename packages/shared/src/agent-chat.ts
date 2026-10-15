/**
 * In-window chat with a locally installed agent CLI (Claude Code, Gemini CLI…).
 * The shell starts conversations and renders streamed events; the CLI drives
 * the browser through HelmStack's own MCP server. Conversations are started
 * only by the human through the shell bridge — never through the agent HTTP API.
 */
import type { TabId } from "./browser.js";

/**
 * Known agent providers. CLI adapters are allowlisted; unknown binaries are never run.
 * "ollama" and "openai-compat" (LM Studio, llama.cpp) are loopback-only local model
 * servers: they are HTTP model APIs, not CLIs, and HelmStack runs the agent loop.
 */
export type AgentCliId = "claude" | "gemini" | "ollama" | "openai-compat";

/** Whether a provider is a spawned agent CLI or a local model server. Absent means "cli". */
export type AgentProviderKind = "cli" | "local";

/** Detection state of a local model server. */
export type LocalRuntimeState = "not_installed" | "not_running" | "no_models" | "running";

export type AgentModelSource =
  /** A stable alias the CLI itself resolves (e.g. "sonnet"). */
  | "alias"
  /** Read from the CLI's own settings file as the configured default. */
  | "configured"
  /** Typed by the user; validated against a strict character set. */
  | "custom"
  /** Reported by a running local model server. */
  | "local";

export type AgentModelOption = {
  /** Value passed to the CLI's `--model` flag. Empty string = the CLI's own default. */
  id: string;
  label: string;
  source: AgentModelSource;
  /** Local models only: why this model can't be selected (e.g. "No tool-calling support"). */
  disabledReason?: string;
  /** Local models only: e.g. "3.2B · 2.0 GB". */
  sizeLabel?: string;
  /** Local models only: whether the server reports tool-calling support. */
  toolSupport?: "yes" | "no" | "unknown";
};

export type AgentCliInfo = {
  id: AgentCliId;
  /** "local" for model servers (Ollama…); absent or "cli" for agent CLIs. */
  kind?: AgentProviderKind;
  /** Local providers only: detection state, for a precise empty state. */
  localState?: LocalRuntimeState;
  label: string;
  /** Absolute path of the binary found on PATH; null when not installed. */
  path: string | null;
  version: string | null;
  available: boolean;
  /** Why it can't be used, e.g. "not installed" or "version too old". */
  reason?: string;
  /** Curated aliases plus the configured default. The UI also offers a custom id. */
  models: AgentModelOption[];
  /** True when the adapter can confine the agent to HelmStack's MCP tools only. */
  confined: boolean;
  /** Adapter hasn't been verified end to end; the UI should say so. */
  experimental: boolean;
  supportsResume: boolean;
};

export type AgentRunnerStatus = {
  enabled: boolean;
  /** Set when disabled, e.g. the packaged app can't locate the MCP server entry. */
  reason?: string;
  clis: AgentCliInfo[];
  /** Directory CLIs run in unless the conversation overrides it. */
  defaultWorkingDirectory: string;
};

export type AgentConversationSummary = {
  id: string;
  tabId: TabId;
  cliId: AgentCliId;
  model: string;
  workingDirectory: string;
  title: string;
  createdAt: number;
  /** True while a turn is running. */
  busy: boolean;
  turnCount: number;
};

export type AgentTurnOutcome = "completed" | "stopped" | "error";

/**
 * One streamed event of a conversation. `seq` is strictly monotonic per
 * conversation (1, 2, 3 …) and unique, so a consumer can dedupe by `seq`.
 *
 * Delivery: events are pushed to subscribers as they happen and are NOT held
 * back until `sendAgentMessage` resolves — `user_message`, `turn_started`,
 * `text_delta` and `tool_call` may all arrive before that promise settles.
 *
 * Replay: `getAgentConversationEvents(id, afterSeq)` returns the bounded
 * buffer (last ~500 events) including the in-progress turn's events so far.
 * Passing the last `seq` already held yields exactly the events after it, so
 * replay followed by live events neither drops nor duplicates at the boundary
 * (still dedupe by `seq` while subscribing). When a `text` event arrives it
 * supersedes the `text_delta`s of that turn, which are then removed from the
 * buffer — a replay may therefore contain a `text` where a live consumer saw
 * deltas.
 */
export type AgentChatEvent =
  | { type: "user_message"; conversationId: string; seq: number; at: number; turnId: string; text: string }
  | { type: "turn_started"; conversationId: string; seq: number; at: number; turnId: string }
  | { type: "text_delta"; conversationId: string; seq: number; at: number; turnId: string; text: string }
  /** The complete assistant text block; replaces the deltas received for it. */
  | { type: "text"; conversationId: string; seq: number; at: number; turnId: string; text: string }
  /** Tool use by the agent. Arguments are never included — name and a short summary only. */
  | {
      type: "tool_call";
      conversationId: string;
      seq: number;
      at: number;
      turnId: string;
      callId: string;
      name: string;
      summary?: string;
      status: "running" | "ok" | "error";
    }
  | {
      type: "turn_finished";
      conversationId: string;
      seq: number;
      at: number;
      turnId: string;
      outcome: AgentTurnOutcome;
      /** Sanitised, human-readable; never raw stderr. */
      error?: string;
    };

export type StartAgentConversationInput = {
  tabId: TabId;
  cliId: AgentCliId;
  /** One of the listed model ids, or a custom id matching /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/ (it can never start with "-", so it cannot be read as a CLI flag). */
  model: string;
  /** Defaults to `AgentRunnerStatus.defaultWorkingDirectory`. Must be an existing directory. */
  workingDirectory?: string;
  /**
   * Required (and enforced by the runner) to start a CLI whose
   * `AgentCliInfo.confined` is false: it cannot be proven to be limited to
   * HelmStack's MCP tools, so the human must acknowledge that explicitly for
   * this conversation. Ignored for confined CLIs.
   */
  allowUnconfined?: boolean;
};
