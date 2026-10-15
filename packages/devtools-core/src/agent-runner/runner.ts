/**
 * AgentRunner — runs agent CLI turns as child processes for the in-window chat.
 *
 * Owned by the desktop main process (not HelmstackCore, not the daemon) and
 * driven only by human actions arriving over the shell IPC bridge. There is
 * deliberately no HTTP route for starting or controlling conversations.
 *
 * Safety properties:
 *  - only allowlisted CLIs found by name lookup are executed (see detect.ts);
 *  - argv is a fixed template; user text goes through stdin, never a shell;
 *  - the default run is confined to HelmStack's MCP tools (see adapters);
 *  - the child env is scrubbed of HelmStack secrets; the MCP server gets a
 *    token *file path* in a 0600 per-conversation temp dir;
 *  - one running turn per conversation, hard timeout, output caps, process
 *    group kill on stop/timeout/close/quit.
 */
import { spawn, type ChildProcess, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentChatEvent,
  AgentCliId,
  AgentCliInfo,
  AgentConversationSummary,
  AgentRunnerStatus,
  AgentTurnOutcome,
  StartAgentConversationInput,
  TabId
} from "../../../shared/src/index.js";
import { BUILTIN_ADAPTERS } from "./adapters/index.js";
import { detectCli, type DetectOptions } from "./detect.js";
import { scrubbedEnv } from "./env.js";
import { isValidModelId, type AdapterEvent, type AgentCliAdapter, type McpServerSpec } from "./types.js";
import { cleanText, ensurePrivateDir, writePrivateFile } from "./util.js";

export const MAX_PROMPT_CHARS = 32_000;

export type AgentRunnerOptions = {
  /** HelmStack agent server this instance's MCP server must talk to. */
  port: number;
  host?: string;
  /** Path of an existing 0600 token file; preferred (never copied). */
  tokenFile?: string | null;
  /** Used only when there is no token file: written to a 0600 temp file. */
  authToken?: string | null;
  /** Absolute path of the bundled MCP server entry; null disables the runner. */
  mcpEntry: string | null;
  /** Shown when `mcpEntry` is null. */
  disabledReason?: string;
  /** Directory the CLIs run in by default (created 0700 if missing). */
  defaultWorkingDirectory: string;
  /** Whether a tab id currently exists (conversation start validation). */
  isTabAlive?: (tabId: TabId) => boolean;
  /** Node-compatible executable used to run the MCP entry. Default `process.execPath`. */
  execPath?: string;
  /** True under Electron: sets ELECTRON_RUN_AS_NODE for the MCP server. */
  electron?: boolean;
  env?: NodeJS.ProcessEnv;
  adapters?: readonly AgentCliAdapter[];
  detect?: DetectOptions;
  tmpRoot?: string;
  turnTimeoutMs?: number;
  maxConversations?: number;
  replayLimit?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
  maxTextChars?: number;
};

type Turn = {
  id: string;
  child: ChildProcess;
  stopRequested: boolean;
  timedOut: boolean;
  capped: boolean;
  killTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
};

type Conversation = {
  id: string;
  tabId: TabId;
  cliId: AgentCliId;
  model: string;
  workingDirectory: string;
  title: string;
  createdAt: number;
  turnCount: number;
  sessionId: string;
  /** True once the CLI confirmed the session exists (so later turns resume). */
  sessionStarted: boolean;
  unconfined: boolean;
  adapter: AgentCliAdapter;
  binary: string;
  dir: string;
  prepared: unknown;
  seq: number;
  events: AgentChatEvent[];
  turn: Turn | null;
  closed: boolean;
};

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type EventInput = DistributiveOmit<AgentChatEvent, "conversationId" | "seq" | "at">;

export class AgentRunner {
  private readonly opts: Required<
    Pick<AgentRunnerOptions, "turnTimeoutMs" | "maxConversations" | "replayLimit" | "killGraceMs" | "maxOutputBytes" | "maxTextChars">
  > &
    AgentRunnerOptions;
  private readonly adapters: readonly AgentCliAdapter[];
  private readonly conversations = new Map<string, Conversation>();
  private readonly listeners = new Set<(event: AgentChatEvent) => void>();
  private clis: AgentCliInfo[] = [];
  private tmpBase: string | null = null;
  private disposed = false;

  constructor(options: AgentRunnerOptions) {
    this.opts = {
      turnTimeoutMs: 10 * 60_000,
      maxConversations: 4,
      replayLimit: 500,
      killGraceMs: 3000,
      maxOutputBytes: 16 * 1024 * 1024,
      maxTextChars: 400_000,
      ...options
    };
    this.adapters = options.adapters ?? BUILTIN_ADAPTERS;
  }

  // ── status ────────────────────────────────────────────────────────────────

  async refresh(): Promise<AgentRunnerStatus> {
    this.clis = await Promise.all(this.adapters.map((a) => detectCli(a, { env: this.opts.env, ...this.opts.detect })));
    return this.getStatus();
  }

  getStatus(): AgentRunnerStatus {
    const enabled = !!this.opts.mcpEntry && existsSync(this.opts.mcpEntry);
    return {
      enabled,
      ...(enabled ? {} : { reason: this.opts.disabledReason ?? "The HelmStack MCP server entry was not found." }),
      clis: this.clis,
      defaultWorkingDirectory: this.opts.defaultWorkingDirectory
    };
  }

  onEvent(listener: (event: AgentChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── conversations ─────────────────────────────────────────────────────────

  async startConversation(input: StartAgentConversationInput): Promise<AgentConversationSummary> {
    if (this.disposed) throw new Error("Agent runner is shut down.");
    const status = this.getStatus();
    if (!status.enabled) throw new Error(status.reason ?? "In-window agent chat is not available.");
    if (this.clis.length === 0) await this.refresh();
    if (this.conversations.size >= this.opts.maxConversations) {
      throw new Error(`At most ${this.opts.maxConversations} agent conversations can be open at once. Close one first.`);
    }
    if (typeof input.tabId !== "string" || !input.tabId) throw new Error("A tab is required.");
    if (this.opts.isTabAlive && !this.opts.isTabAlive(input.tabId)) throw new Error("That tab no longer exists.");
    const adapter = this.adapters.find((a) => a.id === input.cliId);
    const info = this.clis.find((c) => c.id === input.cliId);
    if (!adapter || !info) throw new Error("Unknown agent CLI.");
    if (!info.available || !info.path) throw new Error(`${adapter.label} is not available: ${info.reason ?? "unknown reason"}.`);
    if (typeof input.model !== "string" || !isValidModelId(input.model)) {
      throw new Error("Invalid model id. Use letters, digits and . _ : / - only (max 80 characters).");
    }
    const unconfined = !adapter.confined;
    if (unconfined && input.allowUnconfined !== true) {
      throw new Error(`${adapter.label} cannot be confined to HelmStack tools; start it with explicit acknowledgement.`);
    }
    const workingDirectory = this.resolveWorkingDirectory(input.workingDirectory);

    const id = randomUUID();
    const dir = this.makeConversationDir();
    try {
      const mcp = this.buildMcpSpec(dir, input.cliId);
      const prepared = adapter.prepare({ dir, mcp });
      const conv: Conversation = {
        id,
        tabId: input.tabId,
        cliId: input.cliId,
        model: input.model,
        workingDirectory,
        title: "New chat",
        createdAt: Date.now(),
        turnCount: 0,
        sessionId: randomUUID(),
        sessionStarted: false,
        unconfined,
        adapter,
        binary: info.path,
        dir,
        prepared,
        seq: 0,
        events: [],
        turn: null,
        closed: false
      };
      this.conversations.set(id, conv);
      return this.summary(conv);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async sendMessage(conversationId: string, text: string): Promise<{ turnId: string }> {
    const conv = this.require(conversationId);
    if (typeof text !== "string" || text.trim() === "") throw new Error("Message is empty.");
    if (text.length > MAX_PROMPT_CHARS) throw new Error(`Message is too long (max ${MAX_PROMPT_CHARS} characters).`);
    if (conv.turn) throw new Error("The agent is still working on the previous message. Stop it or wait.");
    if (this.opts.isTabAlive && !this.opts.isTabAlive(conv.tabId)) throw new Error("That tab no longer exists.");

    const turnId = randomUUID();
    const built = conv.adapter.buildTurn({
      prepared: conv.prepared,
      model: conv.model,
      sessionId: conv.sessionId,
      resume: conv.sessionStarted,
      prompt: text,
      tabId: conv.tabId,
      context: contextPrompt(conv.tabId),
      unconfined: conv.unconfined
    });
    const env: NodeJS.ProcessEnv = { ...scrubbedEnv(this.opts.env ?? process.env), ...built.env };

    if (conv.title === "New chat") conv.title = cleanText(text.replace(/\s+/g, " ").trim(), 60) || "New chat";
    conv.turnCount += 1;
    this.emit(conv, { type: "user_message", turnId, text });

    let child: ChildProcess;
    try {
      child = spawn(conv.binary, built.args, {
        cwd: conv.workingDirectory,
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch {
      this.emit(conv, { type: "turn_started", turnId });
      this.emit(conv, { type: "turn_finished", turnId, outcome: "error", error: "The CLI could not be started." });
      return { turnId };
    }
    const turn: Turn = { id: turnId, child, stopRequested: false, timedOut: false, capped: false, killTimer: null, timeoutTimer: null };
    conv.turn = turn;
    this.emit(conv, { type: "turn_started", turnId });
    this.attach(conv, turn, built.stdin);
    return { turnId };
  }

  async stopTurn(conversationId: string): Promise<void> {
    const conv = this.conversations.get(conversationId);
    if (!conv || !conv.turn) return;
    conv.turn.stopRequested = true;
    this.killTurn(conv.turn);
  }

  listConversations(tabId?: TabId): AgentConversationSummary[] {
    return [...this.conversations.values()].filter((c) => tabId === undefined || c.tabId === tabId).map((c) => this.summary(c));
  }

  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }

  getEvents(conversationId: string, afterSeq = 0): AgentChatEvent[] {
    const conv = this.require(conversationId);
    return conv.events.filter((e) => e.seq > afterSeq);
  }

  async closeConversation(conversationId: string): Promise<void> {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;
    conv.closed = true;
    this.conversations.delete(conversationId);
    if (conv.turn) {
      conv.turn.stopRequested = true;
      this.killTurn(conv.turn, true);
    }
    rmSync(conv.dir, { recursive: true, force: true });
  }

  /** The tab went away: end its conversations. */
  async closeTab(tabId: TabId): Promise<void> {
    for (const conv of [...this.conversations.values()]) {
      if (conv.tabId === tabId) await this.closeConversation(conv.id);
    }
  }

  /** Stop everything and remove temp files. Call on app quit. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const id of [...this.conversations.keys()]) await this.closeConversation(id);
    this.removeTmpBase();
  }

  /** Synchronous last-resort cleanup for `process.on("exit")`. */
  killAllSync(): void {
    for (const conv of this.conversations.values()) {
      const pid = conv.turn?.child.pid;
      if (pid) killGroup(pid, "SIGKILL");
    }
    this.removeTmpBase();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private require(conversationId: string): Conversation {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw new Error("Unknown conversation.");
    return conv;
  }

  private summary(conv: Conversation): AgentConversationSummary {
    return {
      id: conv.id,
      tabId: conv.tabId,
      cliId: conv.cliId,
      model: conv.model,
      workingDirectory: conv.workingDirectory,
      title: conv.title,
      createdAt: conv.createdAt,
      busy: conv.turn !== null,
      turnCount: conv.turnCount
    };
  }

  private resolveWorkingDirectory(requested: string | undefined): string {
    const isDefault = requested === undefined || requested.trim() === "";
    const wanted = isDefault ? this.opts.defaultWorkingDirectory : (requested as string);
    if (typeof wanted !== "string" || wanted.includes("\0") || !path.isAbsolute(wanted)) {
      throw new Error("The working directory must be an absolute path.");
    }
    if (isDefault) ensurePrivateDir(wanted);
    let real: string;
    try {
      real = realpathSync(wanted);
      if (!statSync(real).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error("The working directory does not exist or is not a directory.");
    }
    return real;
  }

  private makeConversationDir(): string {
    if (!this.tmpBase) {
      this.tmpBase = mkdtempSync(path.join(this.opts.tmpRoot ?? os.tmpdir(), "helmstack-agent-"));
    }
    const dir = path.join(this.tmpBase, randomUUID());
    ensurePrivateDir(dir);
    return dir;
  }

  private removeTmpBase(): void {
    if (this.tmpBase) {
      try {
        rmSync(this.tmpBase, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.tmpBase = null;
    }
  }

  private buildMcpSpec(dir: string, cliId: AgentCliId): McpServerSpec {
    const entry = this.opts.mcpEntry as string;
    let tokenFile = this.opts.tokenFile ?? null;
    if (tokenFile && !existsSync(tokenFile)) tokenFile = null;
    if (!tokenFile && this.opts.authToken) {
      tokenFile = path.join(dir, "agent-token");
      writePrivateFile(tokenFile, this.opts.authToken);
    }
    const env: Record<string, string> = {
      HELMSTACK_PORT: String(this.opts.port),
      HELMSTACK_HOST: this.opts.host ?? "127.0.0.1",
      HELMSTACK_AGENT_ID: `chat:${cliId}`,
      // The chat agent never gets the accounts/TOTP/approval tool surface.
      HELMSTACK_AGENT_SUBSTRATE: "0"
    };
    if (tokenFile) env.HELMSTACK_TOKEN_FILE = tokenFile;
    if (this.opts.electron) env.ELECTRON_RUN_AS_NODE = "1";
    return { name: "helmstack", command: this.opts.execPath ?? process.execPath, args: [entry], env };
  }

  private emit(conv: Conversation, partial: EventInput): void {
    if (conv.closed) return;
    const event = { ...partial, conversationId: conv.id, seq: ++conv.seq, at: Date.now() } as AgentChatEvent;
    if (event.type === "text") {
      // The complete block supersedes its deltas: keep the replay buffer small.
      conv.events = conv.events.filter((e) => !(e.type === "text_delta" && e.turnId === event.turnId));
    }
    conv.events.push(event);
    if (conv.events.length > this.opts.replayLimit) conv.events.splice(0, conv.events.length - this.opts.replayLimit);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a faulty subscriber must not break the stream
      }
    }
  }

  private attach(conv: Conversation, turn: Turn, stdin: string): void {
    const { child } = turn;
    const parser = conv.adapter.createParser();
    let buffer = "";
    let stderrTail = "";
    let bytes = 0;
    let textChars = 0;
    let segment = "";
    let finished = false;
    const known = new Map<string, { name: string; summary?: string }>();
    let result: { ok: boolean; error?: string } | null = null;

    const flushSegment = () => {
      if (segment) {
        this.emit(conv, { type: "text", turnId: turn.id, text: segment });
        segment = "";
      }
    };

    const handle = (events: AdapterEvent[]) => {
      for (const ev of events) {
        switch (ev.kind) {
          case "session":
            conv.sessionStarted = true;
            break;
          case "text_delta": {
            if (textChars >= this.opts.maxTextChars) break;
            const text = ev.text.slice(0, 8192);
            textChars += text.length;
            segment += text;
            this.emit(conv, { type: "text_delta", turnId: turn.id, text });
            break;
          }
          case "text":
            segment = "";
            textChars += ev.text.length;
            this.emit(conv, { type: "text", turnId: turn.id, text: ev.text.slice(0, this.opts.maxTextChars) });
            break;
          case "tool_call": {
            if (ev.status === "running") {
              flushSegment();
              if (known.size < 1000) known.set(ev.callId, { name: ev.name, summary: ev.summary });
            }
            const prior = known.get(ev.callId);
            const name = ev.name || prior?.name || "tool";
            const summary = ev.summary ?? prior?.summary;
            this.emit(conv, {
              type: "tool_call",
              turnId: turn.id,
              callId: ev.callId.slice(0, 128),
              name: cleanText(name, 80),
              ...(summary ? { summary: cleanText(summary, 120) } : {}),
              status: ev.status
            });
            break;
          }
          case "result":
            result = { ok: ev.ok, error: ev.error };
            break;
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > this.opts.maxOutputBytes && !turn.capped) {
        turn.capped = true;
        this.killTurn(turn);
        return;
      }
      if (turn.capped) return;
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line && line.length <= 2 * 1024 * 1024) handle(parser.push(line));
      }
      // A single line with no newline must not grow without bound.
      if (buffer.length > 2 * 1024 * 1024) buffer = "";
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Kept only to classify failures; never forwarded.
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
    });
    child.stdin?.on("error", () => {
      // EPIPE when the CLI exits before reading the prompt
    });
    child.stdin?.end(stdin);

    turn.timeoutTimer = setTimeout(() => {
      turn.timedOut = true;
      this.killTurn(turn);
    }, this.opts.turnTimeoutMs);
    turn.timeoutTimer.unref?.();

    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      if (turn.timeoutTimer) clearTimeout(turn.timeoutTimer);
      if (turn.killTimer) clearTimeout(turn.killTimer);
      // Reap any grandchildren (e.g. the MCP server) left in the process group.
      if (child.pid) killGroup(child.pid, "SIGKILL");
      if (buffer.trim() && !turn.capped) handle(parser.push(buffer.trim()));
      handle(parser.end({ code, stderr: stderrTail }));
      flushSegment();
      let outcome: AgentTurnOutcome;
      let error: string | undefined;
      const r = result as { ok: boolean; error?: string } | null;
      if (turn.stopRequested) {
        outcome = "stopped";
      } else if (turn.timedOut) {
        outcome = "error";
        error = "The agent took too long and was stopped.";
      } else if (turn.capped) {
        outcome = "error";
        error = "The agent produced too much output and was stopped.";
      } else if (r && r.ok) {
        outcome = "completed";
      } else {
        outcome = "error";
        error = r?.error ?? "The agent process ended unexpectedly.";
      }
      if (conv.turn === turn) conv.turn = null;
      this.emit(conv, { type: "turn_finished", turnId: turn.id, outcome, ...(error ? { error } : {}) });
    };
    child.on("error", () => {
      result = { ok: false, error: "The CLI could not be started." };
      finish(null);
    });
    child.on("close", (code) => finish(code));
  }

  /** SIGTERM the process group, SIGKILL after the grace period. */
  private killTurn(turn: Turn, immediate = false): void {
    const pid = turn.child.pid;
    if (!pid) {
      turn.child.kill("SIGKILL");
      return;
    }
    if (immediate) {
      killGroup(pid, "SIGKILL");
      return;
    }
    killGroup(pid, "SIGTERM");
    if (!turn.killTimer) {
      turn.killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), this.opts.killGraceMs);
      turn.killTimer.unref?.();
    }
  }
}

/** Kill a whole process group (POSIX) or process tree (Windows). Never throws. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function contextPrompt(tabId: string): string {
  return [
    "You are an assistant embedded in the HelmStack browser window. You act on the web page the user has open only through the HelmStack browser_* tools.",
    `The user's current tab id is "${tabId}". Use this tab id for tool calls unless the user asks about another tab.`,
    "You have no shell, file or web-fetch access. Never ask for or type passwords or secrets; ask the user to enter them themselves.",
    "Keep replies concise."
  ].join(" ");
}
