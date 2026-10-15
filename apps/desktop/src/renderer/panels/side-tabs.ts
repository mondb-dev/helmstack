/**
 * Tabs ("Activity" | "Chat") in the right-hand panel. The selected tab is
 * remembered in localStorage. Panels are shown/hidden with `hidden`, and the
 * aside's `data-panel` attribute lets CSS keep the activity body hidden while
 * Chat is selected without fighting the activity panel's own collapse state.
 */
import { attachRovingKeys, applyRovingTabindex } from "../ui/roving.js";

export type SidePanelId = "activity" | "chat";

export const SIDE_TAB_STORAGE_KEY = "helmstack-side-panel-tab";

export interface SideTabsOptions {
  root?: ParentNode;
  onChange?: (panel: SidePanelId) => void;
}

export interface SideTabsController {
  select(panel: SidePanelId, options?: { focus?: boolean }): void;
  selected(): SidePanelId;
  destroy(): void;
}

function readStored(): SidePanelId {
  try {
    return localStorage.getItem(SIDE_TAB_STORAGE_KEY) === "chat" ? "chat" : "activity";
  } catch {
    return "activity";
  }
}

export function mountSideTabs(options: SideTabsOptions = {}): SideTabsController {
  const root = options.root ?? document;
  const list = root.querySelector<HTMLElement>("#side-tabs");
  const aside = root.querySelector<HTMLElement>("#activity-panel");
  if (!list || !aside) throw new Error("Side tabs markup missing");
  const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const idOf = (tab: HTMLElement): SidePanelId => (tab.dataset.panel === "chat" ? "chat" : "activity");
  let current: SidePanelId = readStored();

  const apply = (): void => {
    aside.dataset.panel = current;
    tabs.forEach((tab) => {
      const on = idOf(tab) === current;
      tab.setAttribute("aria-selected", String(on));
      const panel = root.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls")}`);
      // Activity body's `hidden` belongs to the collapse toggle; CSS covers it.
      if (panel && idOf(tab) === "chat") panel.hidden = !on;
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

  const detach = attachRovingKeys(list, '[role="tab"]', { orientation: "horizontal", wrap: true });
  tabs.forEach((tab) => tab.addEventListener("click", () => select(idOf(tab))));
  apply();
  options.onChange?.(current);

  return { select, selected: () => current, destroy: detach };
}
