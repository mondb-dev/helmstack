/**
 * Shared plain-text helpers for the lite toolset: the uniform result protocol
 * (`ERROR: … NEXT: …`, `NEEDS APPROVAL: …`) and small formatters. Pure.
 */

import type { BrowserCommandResult, TabSummary } from "../../../shared/src/index.js";

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clip(value: string | undefined, max: number): string {
  const flat = (value ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Quote a label for display; inner double quotes become single quotes. */
export function q(value: string, max = 60): string {
  return `"${clip(value, max).replace(/"/g, "'")}"`;
}

function sentence(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
}

/** `ERROR: <what happened>. NEXT: <exact tool call>` */
export function liteError(what: string, next: string): string {
  return `ERROR: ${sentence(what)}. NEXT: ${sentence(next)}`;
}

/** Approval-gated action. There is deliberately no lite tool to approve. */
export function liteNeedsApproval(summary: string): string {
  return `NEEDS APPROVAL: ${sentence(summary) || "this action shares personal data"}. The user must approve in the HelmStack window; then call look.`;
}

export const STALE_ELEMENT_MESSAGE = liteError("That element number is from an older view", "look");

/** `Tabs:` list with a `*` on the active tab. Numbers feed `tabs n`. */
export function renderTabs(tabs: readonly TabSummary[], activeId?: string): string {
  if (tabs.length === 0) return liteError("No tabs are open", 'go "https://example.com"');
  const lines = tabs.map((tab, i) => {
    const active = activeId !== undefined ? tab.id === activeId : tab.isActive;
    const title = clip(tab.title, 50) || "(untitled)";
    const state = tab.status === "loading" ? " (loading)" : tab.status === "error" ? " (failed to load)" : "";
    return `[${i + 1}]${active ? " *" : ""} ${title} (${clip(tab.url, 80)})${state}`;
  });
  return [`Tabs (${tabs.length}, * = current):`, ...lines, 'Say tabs N to switch.'].join("\n");
}

export type LiteResultKind = "ok" | "needs_approval" | "needs_human" | "error";

/**
 * One result line for a command outcome. `action` is a short past-tense phrase
 * ("Clicked [4] button \"Send\""). The caller appends the compact page state.
 */
export function renderCommandResult(
  result: BrowserCommandResult,
  action: string
): { kind: LiteResultKind; text: string } {
  switch (result.status) {
    case "completed":
      return { kind: "ok", text: `OK: ${sentence(action)}.` };
    case "awaiting_approval":
      return { kind: "needs_approval", text: liteNeedsApproval(result.summary) };
    case "awaiting_human":
      return {
        kind: "needs_human",
        text: `NEEDS HUMAN: a ${result.reason} step must be completed by the user in the HelmStack window; then call look.`
      };
    case "blocked":
      return {
        kind: "error",
        text: liteError(`Blocked by the user's approval policy (${clip(result.reason, 140)})`, "look; do not retry, tell the user")
      };
    case "failed":
      return { kind: "error", text: liteError(`The page action failed (${clip(result.reason, 140)})`, "look") };
  }
}

/** Plain-language message for an unexpected thrown error. Never a stack trace or JSON. */
export function plainErrorMessage(error: unknown): string {
  const e = error as { message?: unknown; status?: unknown; body?: unknown; code?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(error);
  if (/ECONNREFUSED|ECONNRESET|fetch failed|socket hang up/i.test(message) || e?.code === "ECONNREFUSED") {
    return liteError("HelmStack is not reachable", "ask the user to start HelmStack, then call look");
  }
  if (e?.status === 401 || e?.status === 403) {
    return liteError("HelmStack rejected the request (not authorised)", "ask the user to check the HelmStack auth token");
  }
  let detail = message;
  if (typeof e?.body === "string") {
    try {
      const parsed = JSON.parse(e.body) as { error?: unknown; message?: unknown };
      const text = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
      if (text) detail = text;
    } catch {
      /* non-JSON body: fall back to the message */
    }
  }
  detail = detail.replace(/^HTTP \d+ [A-Z]+ \S+:\s*/, "").replace(/[{}"\\]/g, "");
  return liteError(`That did not work (${clip(detail, 140) || "unknown problem"})`, "look");
}
