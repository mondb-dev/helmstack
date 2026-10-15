/**
 * Pure reducer from streamed `AgentChatEvent`s to the items a chat thread
 * renders. No DOM; events are de-duplicated by `seq` so a replay and the live
 * stream can overlap safely.
 */
import type { AgentChatEvent } from "../../../../../packages/shared/src/index.js";

export type ChatItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; final: boolean }
  | { kind: "tool"; key: string; callId: string; name: string; summary?: string; status: "running" | "ok" | "error" }
  | { kind: "error"; key: string; message: string }
  | { kind: "stopped"; key: string };

export interface ChatThread {
  items: ChatItem[];
  lastSeq: number;
  busy: boolean;
  turnId: string | null;
  turnStartedAt: number | null;
  finishedTurns: Set<string>;
}

export function createThread(busy = false): ChatThread {
  return { items: [], lastSeq: 0, busy, turnId: null, turnStartedAt: null, finishedTurns: new Set() };
}

function openAssistant(thread: ChatThread): (ChatItem & { kind: "assistant" }) | null {
  const last = thread.items[thread.items.length - 1];
  return last && last.kind === "assistant" && !last.final ? last : null;
}

/** Apply one event. Returns false when it was a duplicate / out of date. */
export function applyChatEvent(thread: ChatThread, event: AgentChatEvent): boolean {
  if (event.seq <= thread.lastSeq) return false;
  thread.lastSeq = event.seq;
  const key = `m-${event.seq}`;
  switch (event.type) {
    case "user_message":
      thread.items.push({ kind: "user", key, text: event.text });
      break;
    case "turn_started":
      thread.busy = true;
      thread.turnId = event.turnId;
      thread.turnStartedAt = event.at;
      break;
    case "text_delta": {
      const open = openAssistant(thread);
      if (open) open.text += event.text;
      else thread.items.push({ kind: "assistant", key, text: event.text, final: false });
      break;
    }
    case "text": {
      const open = openAssistant(thread);
      if (open) {
        open.text = event.text;
        open.final = true;
      } else {
        thread.items.push({ kind: "assistant", key, text: event.text, final: true });
      }
      break;
    }
    case "tool_call": {
      const existing = thread.items.find((item) => item.kind === "tool" && item.callId === event.callId);
      if (existing && existing.kind === "tool") {
        existing.status = event.status;
        existing.name = event.name;
        if (event.summary !== undefined) existing.summary = event.summary;
      } else {
        // Text streamed before a tool call is complete, whatever the CLI said.
        const open = openAssistant(thread);
        if (open) open.final = true;
        thread.items.push({
          kind: "tool",
          key: `tool-${event.callId}`,
          callId: event.callId,
          name: event.name,
          summary: event.summary,
          status: event.status,
        });
      }
      break;
    }
    case "turn_finished": {
      const open = openAssistant(thread);
      if (open) open.final = true;
      // A tool still "running" when the turn ends never reported back.
      for (const item of thread.items) {
        if (item.kind === "tool" && item.status === "running") item.status = event.outcome === "completed" ? "ok" : "error";
      }
      thread.busy = false;
      thread.turnId = null;
      thread.turnStartedAt = null;
      thread.finishedTurns.add(event.turnId);
      if (event.outcome === "stopped") thread.items.push({ kind: "stopped", key });
      else if (event.error || event.outcome === "error") {
        thread.items.push({ kind: "error", key, message: event.error ?? "The agent stopped because of an error." });
      }
      break;
    }
  }
  return true;
}

export function applyChatEvents(thread: ChatThread, events: AgentChatEvent[]): void {
  for (const event of events) applyChatEvent(thread, event);
}

/** "12s", "1m 05s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}
