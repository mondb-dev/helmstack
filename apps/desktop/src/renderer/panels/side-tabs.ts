/**
 * Tabs ("Activity" | "Chat" | "Reports") in the right-hand panel. The selected tab is
 * remembered in localStorage. Panels are shown/hidden with `hidden`, and the
 * aside's `data-panel` attribute lets CSS keep the activity body hidden while
 * Chat is selected without fighting the activity panel's own collapse state.
 */
import { attachRovingKeys, applyRovingTabindex } from "../ui/roving.js";

export type SidePanelId = "activity" | "chat" | "reports";

export const SIDE_TAB_STORAGE_KEY = "helmstack-side-panel-tab";

export interface SideTabsOptions {
  root?: ParentNode;
  /** Show the Reports tab. Off when the bridge can't list reports. */
  reports?: boolean;
  onChange?: (panel: SidePanelId) => void;
}

export interface SideTabsController {
  select(panel: SidePanelId, options?: { focus?: boolean }): void;
  selected(): SidePanelId;
  /** Unread count on a tab (0 hides the badge). */
  setBadge(panel: SidePanelId, count: number): void;
  destroy(): void;
}

function readStored(reportsAvailable: boolean): SidePanelId {
  try {
    const stored = localStorage.getItem(SIDE_TAB_STORAGE_KEY);
    if (stored === "chat") return "chat";
    if (stored === "reports" && reportsAvailable) return "reports";
    return "activity";
  } catch {
    return "activity";
  }
}

export function mountSideTabs(options: SideTabsOptions = {}): SideTabsController {
  const root = options.root ?? document;
  const list = root.querySelector<HTMLElement>("#side-tabs");
  const aside = root.querySelector<HTMLElement>("#activity-panel");
  if (!list || !aside) throw new Error("Side tabs markup missing");
  const reportsAvailable = options.reports === true;
  const reportsTab = list.querySelector<HTMLButtonElement>('[data-panel="reports"]');
  if (reportsTab) reportsTab.hidden = !reportsAvailable;
  const allTabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const tabs = allTabs.filter((tab) => !tab.hidden);
  const idOf = (tab: HTMLElement): SidePanelId =>
    tab.dataset.panel === "chat" ? "chat" : tab.dataset.panel === "reports" ? "reports" : "activity";
  let current: SidePanelId = readStored(reportsAvailable);

  const apply = (): void => {
    aside.dataset.panel = current;
    tabs.forEach((tab) => {
      const on = idOf(tab) === current;
      tab.setAttribute("aria-selected", String(on));
      const panel = root.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`);
      // Activity body's `hidden` belongs to the collapse toggle; CSS covers it.
      if (panel && idOf(tab) !== "activity") panel.hidden = !on;
    });
    applyRovingTabindex(tabs, tabs.findIndex((tab) => idOf(tab) === current));
  };

  const select = (panel: SidePanelId, opts: { focus?: boolean } = {}): void => {
    const changed = panel !== current;
    current = panel;
    try {
      localStorage.setItem(SIDE_TAB_STORAGE_KEY, panel);
    } catch {
      /* preference just won't persist */
    }
    apply();
    if (opts.focus) tabs.find((tab) => idOf(tab) === panel)?.focus();
    if (changed) options.onChange?.(panel);
  };

  const setBadge = (panel: SidePanelId, count: number): void => {
    const tab = tabs.find((candidate) => idOf(candidate) === panel);
    if (!tab) return;
    let badge = tab.querySelector<HTMLElement>(".side-tabs__badge");
    let hint = tab.querySelector<HTMLElement>(".sr-only");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "side-tabs__badge";
      badge.setAttribute("aria-hidden", "true");
      hint = document.createElement("span");
      hint.className = "sr-only";
      tab.append(badge, hint);
    }
    badge.hidden = count <= 0;
    badge.textContent = count > 9 ? "9+" : String(Math.max(0, count));
    if (hint) hint.textContent = count > 0 ? ` (${count} new)` : "";
  };

  const detach = attachRovingKeys(list, '[role="tab"]:not([hidden])', { orientation: "horizontal", wrap: true });
  tabs.forEach((tab) => tab.addEventListener("click", () => select(idOf(tab))));
  apply();
  options.onChange?.(current);

  return { select, selected: () => current, setBadge, destroy: detach };
}
