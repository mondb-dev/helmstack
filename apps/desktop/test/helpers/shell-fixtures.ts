/**
 * Test fixtures for the renderer panels: load the real index.html body into
 * jsdom, and a fake `BrowserShellBridge` whose methods are vi.fn()s and whose
 * on*() subscriptions can be fired from tests.
 */
import { readFileSync } from "node:fs";

import { vi } from "vitest";

import type {
  AgentActivityEntry,
  AgentConnectionStatus,
  PendingApproval,
  TabOverrides,
} from "../../../../packages/shared/src/index.js";

// vitest runs from the repo root.
const html = readFileSync("apps/desktop/src/renderer/index.html", "utf8");

/** Replace the document body with the shell's static markup (scripts inert). */
export function loadShellDom(): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach((s) => s.remove());
  document.body.innerHTML = parsed.body.innerHTML;
}

export function emptyOverrides(tabId: string): TabOverrides {
  return {
    tabId,
    viewport: null,
    media: null,
    resourceBudget: null,
    location: null,
    networkMockRuleCount: 0,
    recording: false,
    watches: { total: 0, passing: 0, failing: 0 },
  };
}

export function status(partial: Partial<AgentConnectionStatus> = {}): AgentConnectionStatus {
  return {
    listening: true,
    port: 7070,
    sseClients: 0,
    agentIds: [],
    tokenPath: "/Users/dev/Library/Application Support/HelmStack/agent-token",
    intentListeners: 0,
    profile: "fe-dev",
    ...partial,
  };
}

let entrySeq = 0;
export function activityEntry(partial: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  entrySeq += 1;
  return {
    id: `act-${entrySeq}`,
    at: 1_700_000_000_000 + entrySeq * 1000,
    durationMs: 42,
    method: "POST",
    route: "/api/tabs/:id/a11y",
    label: "Accessibility audit",
    status: 200,
    ok: true,
    ...partial,
  };
}

export function approval(partial: Partial<PendingApproval> = {}): PendingApproval {
  entrySeq += 1;
  return {
    requestId: `req-${entrySeq}`,
    tabId: "tab-1",
    command: { type: "invoke_site_tool", provider: "dom", toolName: "dom.submit.form", args: {} },
    effects: [{ type: "share_personal_data", fields: ["email"] }],
    summary: `Submit form ${entrySeq}`,
    createdAt: 1_700_000_000_000 + entrySeq,
    ...partial,
  };
}

/** Flush pending promise callbacks. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type Listener = (payload: never) => void;

export interface FakeBridge {
  bridge: import("../../../../packages/shared/src/index.js").BrowserShellBridge;
  /** Fire an `on*` subscription, e.g. emit("onApprovalsChanged", [...]). */
  emit(event: string, payload: unknown): void;
  fn(name: string): ReturnType<typeof vi.fn>;
}

/**
 * A full fake `window.browserShell`: every API method is a vi.fn() (resolving
 * to `overrides[name]`'s result, or undefined), every `on*` method records its
 * listener so tests can fire it.
 */
export function createFakeBridge(overrides: Record<string, (...args: never[]) => unknown> = {}): FakeBridge {
  const listeners = new Map<string, Listener[]>();
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const bridge = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (fns.has(prop)) return fns.get(prop);
        let fn: ReturnType<typeof vi.fn>;
        if (prop.startsWith("on") && !(prop in overrides)) {
          fn = vi.fn((callback: Listener) => {
            const list = listeners.get(prop) ?? [];
            list.push(callback);
            listeners.set(prop, list);
            return () => undefined;
          });
        } else {
          const impl = overrides[prop];
          fn = vi.fn(async (...args: never[]) => (impl ? impl(...args) : undefined));
        }
        fns.set(prop, fn);
        return fn;
      },
    }
  ) as FakeBridge["bridge"];
  return {
    bridge,
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload as never);
    },
    fn(name) {
      return (bridge as unknown as Record<string, ReturnType<typeof vi.fn>>)[name];
    },
  };
}
