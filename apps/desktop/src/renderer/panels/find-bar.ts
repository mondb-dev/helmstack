/**
 * Find in page: a bar pinned between the nav bar and the page (a layout row,
 * not an overlay on the native view). Typing searches; Enter / Shift+Enter
 * step through matches; Esc closes and clears the selection. State is
 * per active tab and dropped on navigation or tab switch.
 */
import type { BrowserShellBridge, FindInPageResult, TabId } from "../../../../../packages/shared/src/index.js";
import {
  formatAccelerator,
  primaryAccelerator,
  type ShortcutPlatform
} from "../../../../../packages/shared/src/shortcuts.js";
import { icon } from "../ui/icons.js";

export type FindBarBridge = Pick<BrowserShellBridge, "findInPage" | "stopFindInPage">;

export interface FindBarOptions {
  root?: ParentNode;
  bridge: FindBarBridge;
  platform: ShortcutPlatform;
  activeTabId: () => TabId | undefined;
  /** The bar appeared/disappeared: re-report the page rect. */
  onLayoutChange?: () => void;
  /** Where focus goes when the bar closes (the page). */
  onClosed?: () => void;
}

export interface FindBarController {
  /** Cmd/Ctrl+F: show (if hidden), focus and select the query. Re-searches a prefilled query. */
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Cmd/Ctrl+G / Shift+G / F3 */
  step(forward: boolean): void;
  /** A `found-in-page` result from the main process. */
  handleResult(result: FindInPageResult): void;
  /** The active tab changed or navigated: drop find state for the page that went away. */
  tabChanged(previousTabId: TabId | undefined): void;
  /** The active tab finished loading: re-run a pending search against the new page. */
  pageLoaded(tabId: TabId | undefined): void;
}

const RESEARCH_DEBOUNCE_MS = 150;

const ignore = (promise: Promise<unknown> | undefined): void => {
  void promise?.catch(() => {
    // The tab may have closed since; nothing to clear.
  });
};

export function mountFindBar(options: FindBarOptions): FindBarController {
  const root = options.root ?? document;
  const q = <T extends HTMLElement>(id: string): T => {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`Find bar markup missing: #${id}`);
    return el;
  };
  const bar = q<HTMLElement>("find-bar");
  const input = q<HTMLInputElement>("find-input");
  const count = q<HTMLElement>("find-count");
  const prev = q<HTMLButtonElement>("find-prev");
  const next = q<HTMLButtonElement>("find-next");
  const close = q<HTMLButtonElement>("find-close");

  prev.replaceChildren(icon("chevron-up"));
  next.replaceChildren(icon("chevron-down"));
  close.replaceChildren(icon("x"));
  const tip = (id: "find-previous" | "find-next", label: string): string => {
    const accelerator = primaryAccelerator(id, options.platform);
    return accelerator ? `${label} (${formatAccelerator(accelerator, options.platform)})` : label;
  };
  prev.title = tip("find-previous", "Previous match");
  next.title = tip("find-next", "Next match");
  close.title = "Close (Esc)";

  let searchedTabId: TabId | undefined;
  let lastQuery = "";
  /** A navigation cleared the results while the bar had a query: search again once the page loads. */
  let researchTabId: TabId | undefined;
  let researchTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelResearch = (): void => {
    researchTabId = undefined;
    if (researchTimer !== undefined) clearTimeout(researchTimer);
    researchTimer = undefined;
  };

  const setCount = (text: string, none = false): void => {
    count.textContent = text;
    count.dataset.state = none ? "none" : "ok";
  };

  const search = (forward: boolean, findNext: boolean): void => {
    const tabId = options.activeTabId();
    const text = input.value;
    if (!tabId) return;
    if (!text) {
      ignore(options.bridge.stopFindInPage(tabId));
      searchedTabId = undefined;
      lastQuery = "";
      setCount("");
      return;
    }
    searchedTabId = tabId;
    // Only a continuation of the same text may use findNext; a new term starts a new search.
    const continuing = findNext && text === lastQuery;
    lastQuery = text;
    ignore(options.bridge.findInPage(tabId, text, { forward, findNext: continuing }));
  };

  const hide = (clear: boolean): void => {
    if (bar.hidden) return;
    cancelResearch();
    if (clear && searchedTabId) ignore(options.bridge.stopFindInPage(searchedTabId));
    searchedTabId = undefined;
    lastQuery = "";
    bar.hidden = true;
    setCount("");
    options.onLayoutChange?.();
  };

  input.addEventListener("input", () => search(true, false));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      search(!event.shiftKey, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      hide(true);
      options.onClosed?.();
    }
  });
  prev.addEventListener("click", () => search(false, true));
  next.addEventListener("click", () => search(true, true));
  close.addEventListener("click", () => {
    hide(true);
    options.onClosed?.();
  });

  return {
    open() {
      const wasHidden = bar.hidden;
      bar.hidden = false;
      if (wasHidden) options.onLayoutChange?.();
      input.focus();
      input.select();
      // Re-opening with the previous term still in the box: show its matches again.
      if (wasHidden && input.value) search(true, false);
    },
    close: () => hide(true),
    isOpen: () => !bar.hidden,
    step(forward) {
      if (bar.hidden) {
        this.open();
        return;
      }
      search(forward, true);
    },
    handleResult(result) {
      if (result.tabId !== options.activeTabId()) return;
      if (result.cleared) {
        // Navigation: highlights are gone with the old document.
        lastQuery = "";
        searchedTabId = undefined;
        setCount("");
        researchTabId = !bar.hidden && input.value ? result.tabId : undefined;
        return;
      }
      if (!input.value) return;
      if (result.matches === 0) setCount("No matches", true);
      else setCount(`${result.activeMatchOrdinal} of ${result.matches}`);
    },
    tabChanged(previousTabId) {
      cancelResearch();
      if (bar.hidden) return;
      // Per-tab state: leave the previous page clean and restart for the new one.
      if (previousTabId) ignore(options.bridge.stopFindInPage(previousTabId));
      searchedTabId = undefined;
      lastQuery = "";
      setCount("");
      if (input.value) search(true, false);
    },
    pageLoaded(tabId) {
      if (!tabId || researchTabId !== tabId || bar.hidden) return;
      if (researchTimer !== undefined) clearTimeout(researchTimer);
      researchTimer = setTimeout(() => {
        researchTimer = undefined;
        const pending = researchTabId;
        researchTabId = undefined;
        if (!bar.hidden && pending && pending === options.activeTabId() && input.value) search(true, false);
      }, RESEARCH_DEBOUNCE_MS);
    }
  };
}
