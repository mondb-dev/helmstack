/**
 * Tabs ("Activity" | "Chat" | "Reports" | "Routines") in the right-hand panel. The selected tab is
 * remembered in localStorage. Panels are shown/hidden with `hidden`, and the
 * aside's `data-panel` attribute lets CSS keep the activity body hidden while
 * Chat is selected without fighting the activity panel's own collapse state.
 */
import { attachRovingKeys, applyRovingTabindex } from "../ui/roving.js";

export type SidePanelId = "activity" | "chat" | "reports" | "routines";

/** Tabs the bridge may not support: hidden (and never restored) unless enabled by an option. */
const OPTIONAL_PANELS: readonly SidePanelId[] = ["reports", "routines"];
const ALL_PANELS: readonly SidePanelId[] = ["activity", "chat", ...OPTIONAL_PANELS];

export const SIDE_TAB_STORAGE_KEY = "helmstack-side-panel-tab";

export interface SideTabsOptions {
  root?: ParentNode;
  /** Show the Reports tab. Off when the bridge can't list reports. */
  reports?: boolean;
  /** Show the Routines tab. Off when the bridge can't list routines. */
  routines?: boolean;
  onChange?: (panel: SidePanelId) => void;
}

export interface SideTabsController {
  select(panel: SidePanelId, options?: { focus?: boolean }): void;
  selected(): SidePanelId;
  /** Count on a tab (0 hides the badge); `noun` completes the screen reader text, e.g. "3 new". */
  setBadge(panel: SidePanelId, count: number, noun?: string): void;
  destroy(): void;
}

function readStored(available: ReadonlySet<SidePanelId>): SidePanelId {
  try {
    const stored = localStorage.getItem(SIDE_TAB_STORAGE_KEY) as SidePanelId | null;
    if (stored && available.has(stored)) return stored;
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
  const available = new Set<SidePanelId>(["activity", "chat"]);
  if (options.reports === true) available.add("reports");
  if (options.routines === true) available.add("routines");
  for (const id of OPTIONAL_PANELS) {
    const optional = list.querySelector<HTMLButtonElement>(`[data-panel="${id}"]`);
    if (optional) optional.hidden = !available.has(id);
  }
  const allTabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const tabs = allTabs.filter((tab) => !tab.hidden);
  const idOf = (tab: HTMLElement): SidePanelId => {
    const id = tab.dataset.panel as SidePanelId | undefined;
    return id && ALL_PANELS.includes(id) ? id : "activity";
  };
  let current: SidePanelId = readStored(available);

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

  const setBadge = (panel: SidePanelId, count: number, noun = "new"): void => {
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
    if (hint) hint.textContent = count > 0 ? ` (${count} ${noun})` : "";
  };

  const detach = attachRovingKeys(list, '[role="tab"]:not([hidden])', { orientation: "horizontal", wrap: true });
  tabs.forEach((tab) => tab.addEventListener("click", () => select(idOf(tab))));
  apply();
  options.onChange?.(current);

  return { select, selected: () => current, setBadge, destroy: detach };
}
