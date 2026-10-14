/**
 * Tab strip rendering (ARIA tablist, roving tabindex) with an "agent" badge on
 * tabs that agents have touched; the badge tooltip names the agent ids.
 */

import type { TabId, TabSummary } from "../../../../../packages/shared/src/index.js";
import { icon } from "../ui/icons.js";
import { safeHostLabel } from "../ui/format.js";

export interface TabStripHandlers {
  onActivate(tab: TabSummary): void;
  onClose(tab: TabSummary): void;
}

/** "Used by an agent" / "Used by agent claude-code" / "Used by agents a, b". */
export function agentBadgeTooltip(agentIds: Iterable<string>): string {
  const ids = [...agentIds];
  if (ids.length === 0) return "Used by an agent";
  return `Used by agent${ids.length > 1 ? "s" : ""} ${ids.join(", ")}`;
}

export function renderTabStrip(
  container: HTMLElement,
  tabs: TabSummary[],
  agentsByTab: Map<TabId, Set<string>>,
  handlers: TabStripHandlers
): void {
  const focusedIndex = Array.from(container.children).findIndex((el) => el === document.activeElement);

  container.replaceChildren(
    ...tabs.map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `tab-pill${tab.isActive ? " is-active" : ""}${tab.status === "loading" ? " is-loading" : ""}${tab.status === "error" ? " is-error" : ""}`;
      button.title = tab.url;
      button.dataset.tabId = tab.id;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", tab.isActive ? "true" : "false");
      button.setAttribute("aria-controls", "viewport-frame");
      // Roving tabindex: only the active tab is in the Tab order; ←/→ rove the rest.
      button.tabIndex = tab.isActive ? 0 : -1;
      button.addEventListener("click", () => handlers.onActivate(tab));

      const status = document.createElement("span");
      status.className = "tab-status";

      const copy = document.createElement("span");
      copy.className = "tab-copy";
      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.status === "error" ? "Load failed" : tab.title || "New tab";
      const meta = document.createElement("span");
      meta.className = "tab-meta";
      meta.textContent = safeHostLabel(tab.url);
      copy.append(title, meta);

      button.append(status, copy);

      const agents = agentsByTab.get(tab.id);
      if (agents) {
        const badge = document.createElement("span");
        badge.className = "tab-agent";
        const tooltip = agentBadgeTooltip(agents);
        badge.title = tooltip;
        badge.append(icon("bot", { size: 12 }));
        const text = document.createElement("span");
        text.className = "sr-only";
        text.textContent = `, ${tooltip}`;
        badge.append(text);
        button.append(badge);
      }

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "tab-close";
      closeBtn.replaceChildren(icon("x", { size: 14 }));
      closeBtn.title = "Close tab";
      closeBtn.setAttribute("aria-label", `Close ${tab.title || "tab"}`);
      // Out of the Tab order — reachable via the tab's Delete/Backspace key.
      closeBtn.tabIndex = -1;
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        handlers.onClose(tab);
      });
      button.append(closeBtn);
      return button;
    })
  );

  // Keep keyboard focus in the strip across re-renders.
  if (focusedIndex >= 0) {
    const items = container.querySelectorAll<HTMLElement>('[role="tab"]');
    items[Math.min(focusedIndex, items.length - 1)]?.focus();
  }
}
