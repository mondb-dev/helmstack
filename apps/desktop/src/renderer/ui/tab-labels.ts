/**
 * Human labels for tab ids that outlive the tab: activity rows and approvals
 * can reference a tab that has since closed, and a raw UUID means nothing to
 * the person reading the feed. Labels are cached from every tab summary seen.
 */

import type { TabId, TabSummary } from "../../../../../packages/shared/src/index.js";
import { safeHostLabel } from "./format.js";

/** Bound on remembered closed tabs (oldest forgotten first). */
export const TAB_LABEL_CACHE_CAP = 500;

export interface TabLabelCache {
  /** Record labels for the current tab list. */
  remember(tabs: TabSummary[]): void;
  /** Host (or title) of an open tab; the last known label of a closed one, suffixed "(closed)". */
  label(tabId: TabId): string | undefined;
}

/** Compact label for a tab: its host, else its title. */
export function tabSummaryLabel(tab: Pick<TabSummary, "url" | "title">): string | undefined {
  const host = tab.url ? safeHostLabel(tab.url) : "";
  return host || tab.title || undefined;
}

export function createTabLabelCache(cap = TAB_LABEL_CACHE_CAP): TabLabelCache {
  const known = new Map<TabId, string>();
  let open = new Set<TabId>();

  return {
    remember(tabs) {
      open = new Set(tabs.map((tab) => tab.id));
      for (const tab of tabs) {
        const label = tabSummaryLabel(tab);
        if (!label) continue;
        known.delete(tab.id); // re-insert → most recent last
        known.set(tab.id, label);
      }
      while (known.size > cap) {
        const oldest = known.keys().next().value as TabId;
        known.delete(oldest);
      }
    },
    label(tabId) {
      const label = known.get(tabId);
      if (!label) return undefined;
      return open.has(tabId) ? label : `${label} (closed)`;
    },
  };
}
