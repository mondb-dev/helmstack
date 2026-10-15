import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountFindBar } from "../src/renderer/panels/find-bar.js";
import { mountNavControls, tooltipFor } from "../src/renderer/panels/nav-controls.js";
import { mountShortcutsDialog, renderShortcutSections } from "../src/renderer/panels/shortcuts-dialog.js";
import { shortcutSections } from "../../../packages/shared/src/shortcuts.js";
import type { TabSummary } from "../../../packages/shared/src/index.js";

const tab = (patch: Partial<TabSummary> = {}): TabSummary => ({
  id: "t1",
  title: "T",
  url: "https://a.test/",
  isActive: true,
  status: "idle",
  canGoBack: false,
  canGoForward: false,
  zoomFactor: 1,
  ...patch
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("nav controls", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="nav-back"></button><button id="nav-forward"></button><button id="nav-reload"></button>
      <button id="zoom-chip" hidden></button>`;
  });

  const setup = (initial: TabSummary | undefined, platform: "mac" | "win" = "mac") => {
    let current = initial;
    const bridge = {
      goBack: vi.fn(async () => [tab()]),
      goForward: vi.fn(async () => [tab()]),
      reload: vi.fn(async () => [tab()]),
      stopLoading: vi.fn(async () => [tab()]),
      zoomTab: vi.fn(async () => [tab()])
    };
    const onTabs = vi.fn();
    const controls = mountNavControls({ bridge, platform, activeTab: () => current, onTabs });
    return { bridge, onTabs, controls, set: (next: TabSummary | undefined) => { current = next; controls.sync(); } };
  };
  const el = (id: string) => document.getElementById(id) as HTMLButtonElement;

  it("disables everything without a tab and follows history flags", () => {
    const { set } = setup(undefined);
    expect([el("nav-back").disabled, el("nav-forward").disabled, el("nav-reload").disabled]).toEqual([true, true, true]);
    set(tab({ canGoBack: true }));
    expect([el("nav-back").disabled, el("nav-forward").disabled, el("nav-reload").disabled]).toEqual([false, true, false]);
    set(tab({ canGoBack: true, canGoForward: true }));
    expect(el("nav-forward").disabled).toBe(false);
  });

  it("treats unknown flags (agent-created or older summaries) as unavailable", () => {
    const summary = tab();
    delete summary.canGoBack;
    const { set } = setup(summary);
    set(summary);
    expect(el("nav-back").disabled).toBe(true);
  });

  it("turns reload into stop while loading", async () => {
    const { bridge, set } = setup(tab({ status: "loading" }));
    expect(el("nav-reload").dataset.mode).toBe("stop");
    expect(el("nav-reload").title).toMatch(/^Stop loading/);
    el("nav-reload").click();
    await Promise.resolve();
    expect(bridge.stopLoading).toHaveBeenCalledWith("t1");
    expect(bridge.reload).not.toHaveBeenCalled();

    set(tab({ status: "idle" }));
    expect(el("nav-reload").dataset.mode).toBe("reload");
    el("nav-reload").click();
    expect(bridge.reload).toHaveBeenCalledWith("t1", false);
  });

  it("shift-click reloads without cache", () => {
    const { bridge } = setup(tab());
    el("nav-reload").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(bridge.reload).toHaveBeenCalledWith("t1", true);
  });

  it("calls back/forward and feeds the returned tabs on", async () => {
    const { bridge, onTabs } = setup(tab({ canGoBack: true, canGoForward: true }));
    el("nav-back").click();
    el("nav-forward").click();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.goBack).toHaveBeenCalledWith("t1");
    expect(bridge.goForward).toHaveBeenCalledWith("t1");
    expect(onTabs).toHaveBeenCalledTimes(2);
  });

  it("does not call the bridge for disabled buttons", () => {
    const { bridge } = setup(tab());
    el("nav-back").click();
    expect(bridge.goBack).not.toHaveBeenCalled();
  });

  it("puts the platform shortcut in tooltips", () => {
    setup(tab(), "mac");
    expect(el("nav-back").title).toBe("Back (⌘[)");
    expect(el("nav-reload").title).toBe("Reload (⌘R)");
    expect(tooltipFor("Back", "back", "win")).toBe("Back (Alt+Left)");
  });

  it("shows the zoom chip only off 100% and resets on click", () => {
    const { bridge, set } = setup(tab());
    expect(el("zoom-chip").hidden).toBe(true);
    set(tab({ zoomFactor: 1.25 }));
    expect(el("zoom-chip").hidden).toBe(false);
    expect(el("zoom-chip").textContent).toBe("125%");
    expect(el("zoom-chip").getAttribute("aria-label")).toContain("125%");
    el("zoom-chip").click();
    expect(bridge.zoomTab).toHaveBeenCalledWith("t1", "reset");
  });
});

describe("find bar", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <section id="find-bar" hidden>
        <input id="find-input" /><span id="find-count"></span>
        <button id="find-prev"></button><button id="find-next"></button><button id="find-close"></button>
      </section>`;
  });

  const setup = (tabId = "t1") => {
    let active: string | undefined = tabId;
    const bridge = { findInPage: vi.fn(async () => {}), stopFindInPage: vi.fn(async () => {}) };
    const onLayoutChange = vi.fn();
    const onClosed = vi.fn();
    const bar = mountFindBar({ bridge, platform: "win", activeTabId: () => active, onLayoutChange, onClosed });
    const input = document.getElementById("find-input") as HTMLInputElement;
    const type = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const keydown = (key: string, shiftKey = false) =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    return { bar, bridge, input, type, keydown, onLayoutChange, onClosed, setActive: (id: string | undefined) => (active = id) };
  };

  it("opens, focuses and reports the layout change", () => {
    const { bar, input, onLayoutChange } = setup();
    bar.open();
    expect((document.getElementById("find-bar") as HTMLElement).hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onLayoutChange).toHaveBeenCalled();
    expect(bar.isOpen()).toBe(true);
  });

  it("searches as you type and shows the match count", () => {
    const { bar, bridge, type } = setup();
    bar.open();
    type("needle");
    expect(bridge.findInPage).toHaveBeenCalledWith("t1", "needle", { forward: true, findNext: false });
    bar.handleResult({ tabId: "t1", activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    expect(document.getElementById("find-count")!.textContent).toBe("2 of 5");
    bar.handleResult({ tabId: "t1", activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    expect(document.getElementById("find-count")!.textContent).toBe("No matches");
  });

  it("ignores results for other tabs", () => {
    const { bar, type } = setup();
    bar.open();
    type("x");
    bar.handleResult({ tabId: "other", activeMatchOrdinal: 1, matches: 9, finalUpdate: true });
    expect(document.getElementById("find-count")!.textContent).toBe("");
  });

  it("Enter goes to the next match and Shift+Enter to the previous", () => {
    const { bar, bridge, type, keydown } = setup();
    bar.open();
    type("needle");
    bridge.findInPage.mockClear();
    keydown("Enter");
    expect(bridge.findInPage).toHaveBeenLastCalledWith("t1", "needle", { forward: true, findNext: true });
    keydown("Enter", true);
    expect(bridge.findInPage).toHaveBeenLastCalledWith("t1", "needle", { forward: false, findNext: true });
  });

  it("a changed term starts a fresh search even via Enter", () => {
    const { bar, bridge, input, keydown, type } = setup();
    bar.open();
    type("one");
    input.value = "two"; // e.g. paste without an input event
    keydown("Enter");
    expect(bridge.findInPage).toHaveBeenLastCalledWith("t1", "two", { forward: true, findNext: false });
  });

  it("Escape closes, clears the selection and returns focus to the page", () => {
    const { bar, bridge, type, keydown, onClosed } = setup();
    bar.open();
    type("needle");
    keydown("Escape");
    expect(bar.isOpen()).toBe(false);
    expect(bridge.stopFindInPage).toHaveBeenCalledWith("t1");
    expect(onClosed).toHaveBeenCalled();
  });

  it("an empty query clears the highlights instead of searching", () => {
    const { bar, bridge, type } = setup();
    bar.open();
    type("a");
    type("");
    expect(bridge.stopFindInPage).toHaveBeenCalledWith("t1");
    expect(document.getElementById("find-count")!.textContent).toBe("");
  });

  it("drops per-tab state on navigation and re-searches on a tab switch", () => {
    const { bar, bridge, type, setActive } = setup();
    bar.open();
    type("needle");
    bar.handleResult({ tabId: "t1", activeMatchOrdinal: 1, matches: 3, finalUpdate: true });
    bar.handleResult({ tabId: "t1", activeMatchOrdinal: 0, matches: 0, finalUpdate: true, cleared: true });
    expect(document.getElementById("find-count")!.textContent).toBe("");

    bridge.findInPage.mockClear();
    setActive("t2");
    bar.tabChanged("t1");
    expect(bridge.stopFindInPage).toHaveBeenCalledWith("t1");
    expect(bridge.findInPage).toHaveBeenCalledWith("t2", "needle", { forward: true, findNext: false });
  });

  it("re-runs the search on the new page once it loads (debounced); empty query does nothing", () => {
    vi.useFakeTimers();
    try {
      const { bar, bridge, type } = setup();
      bar.open();
      type("needle");
      bar.handleResult({ tabId: "t1", activeMatchOrdinal: 0, matches: 0, finalUpdate: true, cleared: true });
      bridge.findInPage.mockClear();
      bar.pageLoaded("t1");
      bar.pageLoaded("t1");
      expect(bridge.findInPage).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(bridge.findInPage).toHaveBeenCalledTimes(1);
      expect(bridge.findInPage).toHaveBeenCalledWith("t1", "needle", { forward: true, findNext: false });

      type("");
      bar.handleResult({ tabId: "t1", activeMatchOrdinal: 0, matches: 0, finalUpdate: true, cleared: true });
      bridge.findInPage.mockClear();
      bar.pageLoaded("t1");
      vi.advanceTimersByTime(300);
      expect(bridge.findInPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a rejected stop for a tab that already closed", async () => {
    const { bar, bridge, type, setActive } = setup();
    bridge.stopFindInPage.mockRejectedValue(new Error("Unknown tab."));
    bar.open();
    type("x");
    setActive("t2");
    expect(() => bar.tabChanged("gone")).not.toThrow();
    await Promise.resolve();
  });

  it("find next opens the bar when closed", () => {
    const { bar } = setup();
    bar.step(true);
    expect(bar.isOpen()).toBe(true);
  });
});

describe("keyboard shortcuts dialog", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="opener">open</button>
      <div id="shortcuts-modal" hidden>
        <div id="shortcuts-backdrop"></div>
        <div role="dialog"><button id="shortcuts-close">Close</button><div id="shortcuts-body"></div></div>
      </div>`;
  });

  it("renders every section and row from the shared table", () => {
    const sections = shortcutSections("mac");
    const fragment = renderShortcutSections(sections);
    const host = document.createElement("div");
    host.append(fragment);
    expect([...host.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(sections.map((s) => s.group));
    const labels = [...host.querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).toContain("New tab");
    expect(labels).toContain("Reopen closed tab");
    expect([...host.querySelectorAll("kbd")].map((k) => k.textContent)).toContain("⌘⇧T");
    expect(host.querySelectorAll("dt").length).toBe(host.querySelectorAll("dd").length);
  });

  it("opens with platform glyphs, traps focus, closes on Escape and restores focus", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const opener = document.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    const dialog = mountShortcutsDialog({ platform: "win", onOpen, onClose });
    dialog.open();
    const modal = document.getElementById("shortcuts-modal")!;
    expect(modal.hidden).toBe(false);
    expect(onOpen).toHaveBeenCalled();
    expect(document.getElementById("shortcuts-body")!.textContent).toContain("Ctrl+Shift+T");
    expect(document.activeElement?.id).toBe("shortcuts-close");

    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(modal.hidden).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus to the page on close when the page had focus", () => {
    const focusPage = vi.fn();
    const dialog = mountShortcutsDialog({ platform: "mac", focusPage, pageHadFocus: () => true });
    dialog.open();
    const modal = document.getElementById("shortcuts-modal")!;
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(focusPage).toHaveBeenCalledTimes(1);

    dialog.open();
    document.getElementById("shortcuts-close")!.click();
    expect(focusPage).toHaveBeenCalledTimes(2);
    dialog.open();
    document.getElementById("shortcuts-backdrop")!.click();
    expect(focusPage).toHaveBeenCalledTimes(3);
  });

  it("does not steal focus when opened from a shell control", () => {
    const focusPage = vi.fn();
    const dialog = mountShortcutsDialog({ platform: "mac", focusPage, pageHadFocus: () => false });
    dialog.open();
    document.getElementById("shortcuts-close")!.click();
    expect(focusPage).not.toHaveBeenCalled();
  });

  it("uses the text Esc, never the ⎋ glyph", () => {
    const text = [...renderShortcutSections(shortcutSections("mac")).querySelectorAll("kbd")].map((k) => k.textContent);
    expect(text).toContain("Esc");
    expect(text.join("")).not.toContain("⎋");
  });

  it("closes from the close button and backdrop, once", () => {
    const onClose = vi.fn();
    const dialog = mountShortcutsDialog({ platform: "mac", onClose });
    dialog.open();
    document.getElementById("shortcuts-close")!.click();
    document.getElementById("shortcuts-backdrop")!.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
