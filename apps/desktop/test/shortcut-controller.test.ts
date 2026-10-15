import { describe, expect, it, vi } from "vitest";

import { createShortcutRunner, reservedAccelerators, routeKeyInput, type ShortcutHost } from "../src/main/shortcut-controller.js";
import type { ShortcutId } from "../../../packages/shared/src/shortcuts.js";

function makeHost(overrides: Partial<ShortcutHost> = {}) {
  const calls: string[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args].join(":"));
    return Promise.resolve();
  };
  const host: ShortcutHost = {
    activeTabId: () => "t2",
    tabCount: () => 3,
    tabAtOffset: (delta) => (delta > 0 ? "t3" : "t1"),
    tabAtIndex: (index) => ({ 0: "t1", 2: "t3", [-1]: "t3" })[index] ?? null,
    isLoading: () => true,
    openBlankTab: record("open"),
    closeTab: record("close"),
    focusTab: record("focus"),
    reopenClosedTab: record("reopen"),
    goBack: record("back"),
    goForward: record("forward"),
    reload: record("reload"),
    stop: (id) => void calls.push(`stop:${id}`),
    zoom: (id, action) => void calls.push(`zoom:${id}:${action}`),
    toggleDevTools: (id) => void calls.push(`devtools:${id}`),
    print: (id) => void calls.push(`print:${id}`),
    closeWindow: () => void calls.push("closeWindow"),
    toShell: (id) => void calls.push(`shell:${id}`),
    focusShell: () => void calls.push("focusShell"),
    focusPage: () => void calls.push("focusPage"),
    ...overrides
  };
  return { host, calls, run: createShortcutRunner(host) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shortcut runner", () => {
  it("acts on the active page, never on the shell", async () => {
    const { calls, run } = makeHost();
    run("reload");
    run("hard-reload");
    run("back");
    run("forward");
    run("zoom-in");
    run("zoom-out");
    run("zoom-reset");
    run("toggle-devtools");
    run("print");
    expect(calls).toEqual([
      "reload:t2:false",
      "reload:t2:true",
      "back:t2",
      "forward:t2",
      "zoom:t2:in",
      "zoom:t2:out",
      "zoom:t2:reset",
      "devtools:t2",
      "print:t2"
    ]);
  });

  it("stop only acts while the page is loading", () => {
    const loading = makeHost({ isLoading: () => true });
    loading.run("stop");
    expect(loading.calls).toEqual(["stop:t2"]);
    const idle = makeHost({ isLoading: () => false });
    idle.run("stop");
    expect(idle.calls).toEqual([]);
  });

  it("forwards shell-owned actions and focuses the shell for inputs", () => {
    const { calls, run } = makeHost();
    run("focus-address");
    run("find");
    run("toggle-agent-panel");
    expect(calls).toEqual(["focusShell", "shell:focus-address", "focusShell", "shell:find", "shell:toggle-agent-panel"]);
  });

  it("new tab opens blank and focuses the address bar", async () => {
    const { calls, run } = makeHost();
    run("new-tab");
    await flush();
    expect(calls).toEqual(["open", "focusShell", "shell:focus-address"]);
  });

  it("closes the tab, or the window when it is the last tab", async () => {
    const many = makeHost();
    many.run("close-tab");
    await flush();
    expect(many.calls).toEqual(["close:t2", "focusPage"]);
    const last = makeHost({ tabCount: () => 1 });
    last.run("close-tab");
    expect(last.calls).toEqual(["closeWindow"]);
  });

  it("cycles tabs and selects by number, 9 = last", async () => {
    const { calls, run } = makeHost();
    run("next-tab");
    run("previous-tab");
    run("select-tab-1");
    run("select-last-tab");
    run("select-tab-5"); // no such tab: nothing happens
    await flush();
    // Independent promise chains: assert the focus order and that each switch refocused the page.
    expect(calls.filter((c) => c.startsWith("focus:"))).toEqual(["focus:t3", "focus:t1", "focus:t1", "focus:t3"]);
    expect(calls.filter((c) => c === "focusPage")).toHaveLength(4);
  });

  it("reopens a closed tab", async () => {
    const { calls, run } = makeHost();
    run("reopen-tab");
    await flush();
    expect(calls).toEqual(["reopen", "focusPage"]);
  });

  it("reports handler failures instead of throwing", () => {
    const onError = vi.fn();
    const { run } = makeHost({
      zoom: () => {
        throw new Error("boom");
      },
      onError
    });
    expect(() => run("zoom-in")).not.toThrow();
    expect(onError).toHaveBeenCalledWith("zoom-in", expect.any(Error));
  });

  it("does nothing without an active tab", () => {
    const { calls, run } = makeHost({ activeTabId: () => null });
    run("reload");
    run("back");
    expect(calls).toEqual([]);
  });
});

describe("routeKeyInput", () => {
  const input = (key: string, mods: Record<string, boolean> = {}) => ({ type: "keyDown", key, ...mods });

  it("consumes routed shortcuts and runs them", () => {
    const run = vi.fn();
    expect(routeKeyInput(input("t", { control: true }), "win", "page", run)).toBe("consumed");
    expect(run).toHaveBeenCalledWith("new-tab");
  });

  it("lets Esc through to the page while still stopping the load", () => {
    const run = vi.fn();
    expect(routeKeyInput(input("Escape"), "mac", "page", run)).toBe("observed");
    expect(run).toHaveBeenCalledWith("stop");
  });

  it("ignores page keys", () => {
    const run = vi.fn();
    expect(routeKeyInput(input("c", { control: true }), "win", "page", run)).toBe("ignored");
    expect(routeKeyInput(input("t", { meta: true }), "mac", "page", run)).toBe("ignored");
    expect(run).not.toHaveBeenCalled();
  });

  it("routes Ctrl+Tab on macOS for both the page and the shell", () => {
    for (const surface of ["page", "shell"] as const) {
      const run = vi.fn();
      expect(routeKeyInput(input("Tab", { control: true }), "mac", surface, run)).toBe("consumed");
      expect(run).toHaveBeenCalledWith("next-tab" satisfies ShortcutId);
    }
  });

  it("lists the reserved accelerators (no Esc)", () => {
    const reserved = reservedAccelerators("win");
    expect(reserved).toContain("CommandOrControl+T");
    expect(reserved).not.toContain("Escape");
  });
});
