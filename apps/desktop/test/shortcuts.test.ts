import { describe, expect, it } from "vitest";

import {
  SHORTCUTS,
  SHORTCUTS_BY_ID,
  acceleratorsFor,
  detectShortcutPlatform,
  formatAccelerator,
  matchShortcut,
  shortcutSections,
  tabIndexForShortcut,
  type KeyInputLike,
  type ShortcutPlatform
} from "../../../packages/shared/src/shortcuts.js";

const PLATFORMS: ShortcutPlatform[] = ["mac", "win", "linux"];

const key = (k: string, mods: Partial<Pick<KeyInputLike, "control" | "meta" | "alt" | "shift">> = {}, code?: string): KeyInputLike => ({
  type: "keyDown",
  key: k,
  code,
  ...mods
});

/** Canonical form of an accelerator on a platform, for collision checks. */
function canonical(accelerator: string, platform: ShortcutPlatform): string {
  const parts = accelerator.split("+").map((part) => {
    const p = part.toLowerCase();
    if (p === "commandorcontrol" || p === "cmdorctrl") return platform === "mac" ? "meta" : "ctrl";
    if (p === "command" || p === "cmd" || p === "super") return "meta";
    if (p === "control") return "ctrl";
    if (p === "option") return "alt";
    if (p === "esc") return "escape";
    return p;
  });
  const key = parts.pop()!;
  return [...new Set(parts)].sort().concat(key).join("+");
}

describe("shortcut table", () => {
  it.each(PLATFORMS)("has no duplicate accelerators on %s", (platform) => {
    const seen = new Map<string, string>();
    for (const def of SHORTCUTS) {
      for (const accelerator of acceleratorsFor(def, platform)) {
        const canon = canonical(accelerator, platform);
        expect(seen.get(canon), `${accelerator} (${def.id}) collides with ${seen.get(canon)}`).toBeUndefined();
        seen.set(canon, def.id);
      }
    }
  });

  it("gives every shortcut a primary accelerator and a unique id", () => {
    expect(new Set(SHORTCUTS.map((d) => d.id)).size).toBe(SHORTCUTS.length);
    for (const def of SHORTCUTS) {
      expect(def.mac.length, def.id).toBeGreaterThan(0);
      expect(def.other.length, def.id).toBeGreaterThan(0);
    }
  });

  it("covers the standard browser set", () => {
    const has = (id: string, platform: ShortcutPlatform, accelerator: string) =>
      expect(acceleratorsFor(SHORTCUTS_BY_ID.get(id as never)!, platform).map((a) => canonical(a, platform))).toContain(
        canonical(accelerator, platform)
      );
    has("new-tab", "mac", "Cmd+T");
    has("reopen-tab", "win", "Ctrl+Shift+T");
    has("focus-address", "linux", "Alt+D");
    has("focus-address", "win", "F6");
    has("back", "mac", "Cmd+[");
    has("back", "win", "Alt+Left");
    has("reload", "win", "F5");
    has("hard-reload", "mac", "Cmd+Shift+R");
    has("toggle-devtools", "mac", "Cmd+Alt+I");
    has("toggle-devtools", "win", "F12");
    has("toggle-devtools", "linux", "Ctrl+Shift+I");
    has("next-tab", "mac", "Cmd+Alt+Right");
    has("next-tab", "mac", "Cmd+Shift+]");
    has("previous-tab", "win", "Ctrl+PageUp");
    has("find-next", "win", "F3");
    has("find-previous", "win", "Shift+F3");
    has("zoom-in", "mac", "Cmd+=");
    has("zoom-in", "win", "Ctrl+Plus");
    has("select-last-tab", "mac", "Cmd+9");
  });

  it("never registers Escape as a menu accelerator (inputOnly)", () => {
    expect(SHORTCUTS_BY_ID.get("stop")?.inputOnly).toBe(true);
  });
});

describe("formatAccelerator", () => {
  it("uses glyphs on macOS and words elsewhere", () => {
    expect(formatAccelerator("CommandOrControl+Shift+T", "mac")).toBe("⌘⇧T");
    expect(formatAccelerator("Command+Alt+Right", "mac")).toBe("⌘⌥→");
    expect(formatAccelerator("Ctrl+Tab", "mac")).toBe("⌃⇥");
    expect(formatAccelerator("CommandOrControl+Shift+T", "win")).toBe("Ctrl+Shift+T");
    expect(formatAccelerator("Alt+Left", "linux")).toBe("Alt+Left");
    expect(formatAccelerator("CommandOrControl+Plus", "win")).toBe("Ctrl++");
    expect(formatAccelerator("Escape", "win")).toBe("Esc");
  });

  it("detects platforms from process.platform and navigator.platform", () => {
    expect(detectShortcutPlatform("darwin")).toBe("mac");
    expect(detectShortcutPlatform("MacIntel")).toBe("mac");
    expect(detectShortcutPlatform("win32")).toBe("win");
    expect(detectShortcutPlatform("Win32")).toBe("win");
    expect(detectShortcutPlatform("Linux x86_64")).toBe("linux");
    expect(detectShortcutPlatform(undefined)).toBe("linux");
  });
});

describe("shortcutSections (dialog source)", () => {
  it("groups in the documented order with platform glyphs", () => {
    const sections = shortcutSections("mac");
    expect(sections.map((s) => s.group)).toEqual(["Tabs", "Navigation", "Page", "Find", "Zoom", "HelmStack"]);
    const tabs = sections[0]!.rows;
    expect(tabs.find((r) => r.id === "new-tab")?.keys).toEqual(["⌘T"]);
    // Tab digits collapse to one range row.
    expect(tabs.filter((r) => r.id.startsWith("select-tab-"))).toHaveLength(1);
    expect(tabs.find((r) => r.id === "select-tab-1")).toMatchObject({ label: "Select tab 1–8", keys: ["⌘1–8"] });
    const win = shortcutSections("win");
    expect(win[0]!.rows.find((r) => r.id === "select-tab-1")?.keys).toEqual(["Ctrl+1–8"]);
    expect(win[1]!.rows.find((r) => r.id === "focus-address")?.keys).toEqual(["Ctrl+L", "Alt+D", "F6"]);
  });
});

describe("matchShortcut (in-page routing)", () => {
  it("routes Ctrl+Tab and Ctrl+Shift+Tab on every platform", () => {
    for (const platform of PLATFORMS) {
      expect(matchShortcut(key("Tab", { control: true }), platform)).toBe("next-tab");
      expect(matchShortcut(key("Tab", { control: true, shift: true }), platform)).toBe("previous-tab");
    }
  });

  it("routes Escape as the contextual stop, with no modifiers only", () => {
    expect(matchShortcut(key("Escape"), "mac")).toBe("stop");
    expect(matchShortcut(key("Escape", { shift: true }), "mac")).toBeNull();
  });

  it("leaves menu-handled shortcuts to the menu on macOS", () => {
    expect(matchShortcut(key("t", { meta: true }), "mac")).toBeNull();
    expect(matchShortcut(key("r", { meta: true }), "mac")).toBeNull();
  });

  it("routes the whole table in-page on Windows/Linux", () => {
    expect(matchShortcut(key("t", { control: true }), "win")).toBe("new-tab");
    expect(matchShortcut(key("T", { control: true, shift: true }), "linux")).toBe("reopen-tab");
    expect(matchShortcut(key("F5"), "win")).toBe("reload");
    expect(matchShortcut(key("F5", { control: true }), "win")).toBe("hard-reload");
    expect(matchShortcut(key("ArrowLeft", { alt: true }), "win")).toBe("back");
    expect(matchShortcut(key("l", { control: true }), "linux")).toBe("focus-address");
    expect(matchShortcut(key("f", { control: true }), "win")).toBe("find");
    expect(matchShortcut(key("F3", { shift: true }), "win")).toBe("find-previous");
    expect(matchShortcut(key("=", { control: true }), "win")).toBe("zoom-in");
    expect(matchShortcut(key("+", { control: true, shift: true }), "win")).toBe("zoom-in");
    expect(matchShortcut(key("-", { control: true }), "linux")).toBe("zoom-out");
    expect(matchShortcut(key("0", { control: true }), "linux")).toBe("zoom-reset");
    expect(matchShortcut(key("3", { control: true }), "win")).toBe("select-tab-3");
    expect(matchShortcut(key("9", { control: true }), "win")).toBe("select-last-tab");
    expect(matchShortcut(key("PageDown", { control: true }), "win")).toBe("next-tab");
    expect(matchShortcut(key("I", { control: true, shift: true }), "linux")).toBe("toggle-devtools");
  });

  it("does not take keys pages legitimately need", () => {
    for (const platform of PLATFORMS) {
      const mod = platform === "mac" ? { meta: true } : { control: true };
      for (const k of ["c", "v", "x", "a", "z", "y"]) expect(matchShortcut(key(k, mod), platform), `${platform} ${k}`).toBeNull();
      expect(matchShortcut(key("ArrowLeft"), platform)).toBeNull();
      expect(matchShortcut(key("Enter"), platform)).toBeNull();
      expect(matchShortcut(key("a"), platform)).toBeNull();
      expect(matchShortcut(key("Tab"), platform)).toBeNull();
    }
    // Option+Left is word navigation on macOS and Ctrl+Left on Windows is too.
    expect(matchShortcut(key("ArrowLeft", { alt: true }), "mac")).toBeNull();
    expect(matchShortcut(key("ArrowLeft", { meta: true }), "mac")).toBeNull();
    expect(matchShortcut(key("ArrowLeft", { control: true }), "win")).toBeNull();
  });

  it("ignores key-up events and the shell surface's menu-covered keys", () => {
    expect(matchShortcut({ ...key("F5"), type: "keyUp" }, "win")).toBeNull();
    expect(matchShortcut(key("t", { control: true }), "win", "shell")).toBeNull();
    expect(matchShortcut(key("Tab", { control: true }), "win", "shell")).toBe("next-tab");
  });

  it("falls back to the physical key when Option remaps the character (macOS Cmd+Alt+I)", () => {
    // Not in the routed set on macOS, but the physical-key fallback must work where routed.
    expect(matchShortcut(key("ˆ", { control: true, alt: true }, "KeyI"), "linux")).toBeNull();
    expect(matchShortcut(key("Dead", { control: true, shift: true }, "KeyI"), "win")).toBe("toggle-devtools");
  });
});

describe("tabIndexForShortcut", () => {
  it("maps digit shortcuts to indexes and 9 to the last tab", () => {
    expect(tabIndexForShortcut("select-tab-1")).toBe(0);
    expect(tabIndexForShortcut("select-tab-8")).toBe(7);
    expect(tabIndexForShortcut("select-last-tab")).toBe(-1);
    expect(tabIndexForShortcut("reload")).toBeNull();
  });
});
