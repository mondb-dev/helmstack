/**
 * Right-hand "Agent activity" panel: a reverse-chronological feed of agent API
 * calls (`listAgentActivity` + `onAgentActivity`) interleaved with agent log
 * lines (`onAgentLog`, styled distinctly), a This tab / All tabs filter, a
 * rendered-row cap, an empty state that explains how to connect an agent, the
 * intent box (only while some agent listens for intents), and a collapse
 * toggle remembered in localStorage.
 */

import type {
  AgentActivityEntry,
  AgentLogEntry,
  BrowserShellBridge,
  TabId,
} from "../../../../../packages/shared/src/index.js";
import { buildEmptyState } from "../ui/states.js";
import { icon } from "../ui/icons.js";
import { relativeTime } from "../ui/format.js";
import { toast } from "../ui/toast.js";

export type ActivityBridge = Pick<BrowserShellBridge, "setIntent" | "getIntent">;

export type FeedItem =
  | { kind: "call"; id: string; at: number; entry: AgentActivityEntry }
  | { kind: "log"; id: string; at: number; entry: AgentLogEntry };

export type ActivityFilter = "tab" | "all";

/** Max rows rendered at once. */
export const ACTIVITY_RENDER_CAP = 200;
/** Max items retained in memory. */
export const ACTIVITY_RETAIN_CAP = 1000;

export const COLLAPSED_STORAGE_KEY = "helmstack-activity-collapsed";
export const FILTER_STORAGE_KEY = "helmstack-activity-filter";

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — preference just won't persist */
  }
}

/**
 * Pure: the items to show for a filter, newest first, capped. Log lines aren't
 * tab-scoped, so they appear under "All tabs" only.
 */
export function selectFeed(
  items: FeedItem[],
  filter: ActivityFilter,
  activeTabId: TabId | undefined,
  cap = ACTIVITY_RENDER_CAP
): { rows: FeedItem[]; total: number } {
  const matching = items.filter((item) =>
    filter === "all" ? true : item.kind === "call" && item.entry.tabId !== undefined && item.entry.tabId === activeTabId
  );
  const sorted = matching.sort((a, b) => b.at - a.at);
  return { rows: sorted.slice(0, cap), total: sorted.length };
}

export interface ActivityOptions {
  root?: ParentNode;
  bridge: ActivityBridge;
  activeTabId: () => TabId | undefined;
  tabLabel?: (tabId: TabId) => string | undefined;
  /** Width changed (collapse/expand) — re-sync the page viewport. */
  onLayoutChange?: () => void;
  /** Agents touched a new tab — refresh tab badges. */
  onAgentsByTabChange?: (agentsByTab: Map<TabId, Set<string>>) => void;
  /** Empty-state action: open the connection popover. */
  onShowConnection?: () => void;
  now?: () => number;
}

export interface ActivityController {
  setActivity(entries: AgentActivityEntry[]): void;
  addActivity(entry: AgentActivityEntry): void;
  addLog(entry: AgentLogEntry): void;
  /** Re-render after the active tab changed (affects the "This tab" filter). */
  refreshForTab(): void;
  setFilter(filter: ActivityFilter): void;
  setIntentListeners(count: number): void;
  setCollapsed(collapsed: boolean): void;
  isCollapsed(): boolean;
  agentsByTab(): Map<TabId, Set<string>>;
  items(): FeedItem[];
  destroy(): void;
}

export function mountActivity(options: ActivityOptions): ActivityController {
  const root = options.root ?? document;
  const q = <T extends HTMLElement>(selector: string): T => {
    const el = root.querySelector<T>(selector);
    if (!el) throw new Error(`Activity markup missing: ${selector}`);
    return el;
  };
  const panel = q<HTMLElement>("#activity-panel");
  const body = q<HTMLElement>("#activity-body");
  const collapseButton = q<HTMLButtonElement>("#activity-collapse");
  const list = q<HTMLOListElement>("#activity-list");
  const footer = q<HTMLElement>("#activity-footer");
  const intentForm = q<HTMLFormElement>("#intent-form");
  const intentBox = q<HTMLTextAreaElement>("#intent-box");
  const filterButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("#activity-panel [data-filter]"));
  const now = options.now ?? (() => Date.now());

  let items: FeedItem[] = [];
  const agents = new Map<TabId, Set<string>>();
  let logCounter = 0;
  let filter: ActivityFilter = readStorage(FILTER_STORAGE_KEY) === "tab" ? "tab" : "all";
  let collapsed = readStorage(COLLAPSED_STORAGE_KEY) === "1";
  let intentListeners = 0;
  let intentLoaded = false;

  const trackAgent = (entry: AgentActivityEntry): boolean => {
    if (!entry.tabId) return false;
    let set = agents.get(entry.tabId);
    let changed = false;
    if (!set) {
      set = new Set();
      agents.set(entry.tabId, set);
      changed = true;
    }
    if (entry.agentId && !set.has(entry.agentId)) {
      set.add(entry.agentId);
      changed = true;
    }
    return changed;
  };

  const buildCallRow = (entry: AgentActivityEntry): HTMLLIElement => {
    const row = document.createElement("li");
    row.className = `activity-row activity-row--${entry.ok ? "ok" : "fail"}`;
    row.title = `${entry.method} ${entry.route} → ${entry.status}`;

    const status = document.createElement("span");
    status.className = "activity-row__status";
    const statusText = document.createElement("span");
    statusText.className = "sr-only";
    statusText.textContent = entry.ok ? "Succeeded: " : "Failed: ";
    status.append(icon(entry.ok ? "check" : "circle-x", { size: 14 }), statusText);

    const main = document.createElement("div");
    main.className = "activity-row__main";
    const line = document.createElement("p");
    line.className = "activity-row__line";
    const label = document.createElement("span");
    label.className = "activity-row__label";
    label.textContent = entry.label;
    line.append(label);
    if (entry.summary) {
      const summary = document.createElement("span");
      summary.className = "activity-row__summary";
      summary.textContent = entry.summary;
      line.append(summary);
    }

    const meta = document.createElement("p");
    meta.className = "activity-row__meta";
    meta.append(buildTime(entry.at));
    const parts: string[] = [];
    if (entry.tabId) parts.push(options.tabLabel?.(entry.tabId) ?? `Tab ${entry.tabId}`);
    if (entry.agentId) parts.push(entry.agentId);
    if (!entry.ok) parts.push(`HTTP ${entry.status}`);
    parts.push(`${Math.round(entry.durationMs)} ms`);
    meta.append(document.createTextNode(` · ${parts.join(" · ")}`));

    main.append(line, meta);
    row.append(status, main);
    return row;
  };

  const buildLogRow = (entry: AgentLogEntry): HTMLLIElement => {
    const row = document.createElement("li");
    row.className = `activity-row activity-row--log activity-row--log-${entry.level}`;

    const status = document.createElement("span");
    status.className = "activity-row__status";
    const statusText = document.createElement("span");
    statusText.className = "sr-only";
    statusText.textContent = entry.level === "error" ? "Log error: " : "Log: ";
    status.append(icon(entry.level === "error" ? "circle-x" : "terminal", { size: 14 }), statusText);

    const main = document.createElement("div");
    main.className = "activity-row__main";
    const line = document.createElement("p");
    line.className = "activity-row__line activity-row__line--mono";
    line.textContent = entry.message;
    const meta = document.createElement("p");
    meta.className = "activity-row__meta";
    meta.append(buildTime(entry.timestamp), document.createTextNode(` · Log · ${entry.level}`));
    main.append(line, meta);
    row.append(status, main);
    return row;
  };

  const buildTime = (at: number): HTMLTimeElement => {
    const time = document.createElement("time");
    time.dateTime = new Date(at).toISOString();
    time.dataset.at = String(at);
    time.title = new Date(at).toLocaleString();
    time.textContent = relativeTime(at, now());
    return time;
  };

  const renderEmpty = (): void => {
    if (items.length === 0) {
      const empty = buildEmptyState({
        title: "No agent activity yet",
        hint: "Connect your coding agent: open the connection status in the title bar (:7070), copy the MCP config into your agent, then ask it to check your page.",
      });
      if (options.onShowConnection) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "btn btn--sm btn--ghost";
        action.textContent = "Show connection details";
        action.addEventListener("click", () => options.onShowConnection?.());
        empty.append(action);
      }
      const li = document.createElement("li");
      li.className = "activity__empty";
      li.append(empty);
      list.replaceChildren(li);
    } else {
      const li = document.createElement("li");
      li.className = "activity__empty";
      li.append(
        buildEmptyState({
          title: "No agent calls on this tab yet",
          hint: "Switch to All tabs to see activity everywhere.",
        })
      );
      list.replaceChildren(li);
    }
  };

  const render = (): void => {
    filterButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === filter)));
    const { rows, total } = selectFeed(items, filter, options.activeTabId());
    if (rows.length === 0) {
      renderEmpty();
      footer.hidden = true;
      return;
    }
    list.replaceChildren(
      ...rows.map((item) => (item.kind === "call" ? buildCallRow(item.entry) : buildLogRow(item.entry)))
    );
    if (total > rows.length) {
      footer.hidden = false;
      footer.textContent = `Showing the latest ${rows.length} of ${total}.`;
    } else {
      footer.hidden = true;
    }
  };

  const refreshTimes = (): void => {
    list.querySelectorAll<HTMLTimeElement>("time[data-at]").forEach((time) => {
      time.textContent = relativeTime(Number(time.dataset.at), now());
    });
  };

  const trim = (): void => {
    if (items.length > ACTIVITY_RETAIN_CAP) {
      items.sort((a, b) => a.at - b.at);
      items = items.slice(items.length - ACTIVITY_RETAIN_CAP);
    }
  };

  const applyCollapsed = (): void => {
    panel.dataset.collapsed = String(collapsed);
    body.hidden = collapsed;
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    collapseButton.setAttribute("aria-label", collapsed ? "Expand agent activity" : "Collapse agent activity");
    collapseButton.title = collapsed ? "Show agent activity" : "Hide agent activity";
    collapseButton.replaceChildren(icon("panel-right", { size: 16 }));
  };

  const setCollapsed = (next: boolean): void => {
    collapsed = next;
    writeStorage(COLLAPSED_STORAGE_KEY, next ? "1" : "0");
    applyCollapsed();
    options.onLayoutChange?.();
  };

  const setIntentListeners = (count: number): void => {
    intentListeners = count;
    const show = count > 0;
    if (intentForm.hidden === !show) return;
    intentForm.hidden = !show;
    if (show && !intentLoaded) {
      intentLoaded = true;
      options.bridge
        .getIntent()
        .then((value) => {
          if (!intentBox.value) intentBox.value = value;
        })
        .catch(() => undefined);
    }
  };

  const submitIntent = async (): Promise<void> => {
    const text = intentBox.value.trim();
    if (!text) return;
    try {
      await options.bridge.setIntent(text);
      toast(`Intent sent to ${intentListeners === 1 ? "1 listening agent" : `${intentListeners} listening agents`}.`, "success");
    } catch (error) {
      toast(`Couldn't send the intent — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  // ── wiring ────────────────────────────────────────────────────────────────
  collapseButton.addEventListener("click", () => setCollapsed(!collapsed));
  filterButtons.forEach((button) =>
    button.addEventListener("click", () => {
      controller.setFilter(button.dataset.filter === "tab" ? "tab" : "all");
    })
  );
  intentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitIntent();
  });
  intentBox.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitIntent();
    }
  });
  const timer = window.setInterval(refreshTimes, 30_000);

  applyCollapsed();
  render();

  const controller: ActivityController = {
    setActivity(entries) {
      // Merge (not replace): live events may have arrived before the list did.
      const known = new Set(items.map((item) => item.id));
      let touched = false;
      for (const entry of entries) {
        if (known.has(entry.id)) continue;
        items.push({ kind: "call", id: entry.id, at: entry.at, entry });
        touched = trackAgent(entry) || touched;
      }
      trim();
      render();
      if (touched) options.onAgentsByTabChange?.(agents);
    },
    addActivity(entry) {
      if (items.some((item) => item.kind === "call" && item.id === entry.id)) return;
      items.push({ kind: "call", id: entry.id, at: entry.at, entry });
      trim();
      render();
      if (trackAgent(entry)) options.onAgentsByTabChange?.(agents);
    },
    addLog(entry) {
      logCounter += 1;
      items.push({ kind: "log", id: `log-${logCounter}`, at: entry.timestamp, entry });
      trim();
      render();
    },
    refreshForTab() {
      if (filter === "tab") render();
    },
    setFilter(next) {
      filter = next;
      writeStorage(FILTER_STORAGE_KEY, next);
      render();
    },
    setIntentListeners,
    setCollapsed,
    isCollapsed: () => collapsed,
    agentsByTab: () => agents,
    items: () => items,
    destroy() {
      window.clearInterval(timer);
    },
  };
  return controller;
}
