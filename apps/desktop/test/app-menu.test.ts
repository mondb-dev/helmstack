import { describe, expect, it, vi } from "vitest";

import { buildAppMenuTemplate, collectAccelerators } from "../src/main/app-menu.js";
import { SHORTCUTS, acceleratorsFor, type ShortcutId, type ShortcutPlatform } from "../../../packages/shared/src/shortcuts.js";

type Item = { label?: string; role?: string; accelerator?: string; click?: () => void; submenu?: Item[]; visible?: boolean; id?: string };

const PLATFORMS: ShortcutPlatform[] = ["mac", "win", "linux"];

const flatten = (items: Item[]): Item[] => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu) : [])]);
const build = (platform: ShortcutPlatform, extra: Record<string, unknown> = {}) => {
  const run = vi.fn();
  const template = buildAppMenuTemplate(platform, { run, ...extra }) as unknown as Item[];
  return { run, template, all: flatten(template) };
};

/** Accelerators Electron attaches to roles implicitly (must not collide with ours). */
const ROLE_ACCELERATORS: Record<ShortcutPlatform, string[]> = {
  mac: ["Cmd+Z", "Cmd+Shift+Z", "Cmd+X", "Cmd+C", "Cmd+V", "Cmd+Alt+Shift+V", "Cmd+A", "Cmd+Q", "Cmd+H", "Cmd+Alt+H", "Cmd+M", "Ctrl+Cmd+F"],
  win: ["Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+X", "Ctrl+C", "Ctrl+V", "Ctrl+Shift+V", "Ctrl+A", "F11"],
  linux: ["Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+X", "Ctrl+C", "Ctrl+V", "Ctrl+Shift+V", "Ctrl+A", "F11"]
};

const canon = (accelerator: string, platform: ShortcutPlatform): string => {
  const parts = accelerator.split("+").map((p) => {
    const l = p.toLowerCase();
    if (l === "commandorcontrol" || l === "cmdorctrl") return platform === "mac" ? "cmd" : "ctrl";
    if (l === "command") return "cmd";
    if (l === "control") return "ctrl";
    return l;
  });
  const k = parts.pop()!;
  return [...new Set(parts)].sort().concat(k).join("+");
};

describe("application menu template", () => {
  it.each(PLATFORMS)("registers no colliding accelerators on %s (hidden alternates and roles included)", (platform) => {
    const { template } = build(platform, { toggleShellDevTools: () => {} });
    const used = [...collectAccelerators(template as never), ...ROLE_ACCELERATORS[platform]].map((a) => canon(a, platform));
    const dupes = used.filter((a, i) => used.indexOf(a) !== i);
    expect(dupes).toEqual([]);
  });

  it.each(PLATFORMS)("registers every table accelerator exactly once on %s, except Esc", (platform) => {
    const { template } = build(platform);
    const registered = new Set(collectAccelerators(template as never).map((a) => canon(a, platform)));
    for (const def of SHORTCUTS) {
      for (const accelerator of acceleratorsFor(def, platform)) {
        const present = registered.has(canon(accelerator, platform));
        expect(present, `${def.id} ${accelerator}`).toBe(!def.inputOnly);
      }
    }
  });

  it("has the macOS app menu only on macOS", () => {
    const mac = build("mac");
    expect(mac.template[0]!.label).toBe("HelmStack");
    const roles = (mac.template[0]!.submenu as Item[]).map((i) => i.role);
    expect(roles).toEqual(expect.arrayContaining(["about", "hide", "hideOthers", "unhide", "quit"]));
    expect(build("win").template[0]!.label).toBe("File");
    // Windows/Linux get Quit in the File menu instead.
    expect(build("win").all.some((i) => i.role === "quit")).toBe(true);
  });

  it("includes the standard Edit roles", () => {
    const edit = build("win").template.find((m) => m.label === "Edit")!;
    const roles = (edit.submenu as Item[]).map((i) => i.role).filter(Boolean);
    expect(roles).toEqual(["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "selectAll"]);
  });

  it("has File, Edit, View, History, Tab, Window and Help menus", () => {
    const labels = build("linux").template.map((m) => m.label);
    expect(labels).toEqual(["File", "Edit", "View", "History", "Tab", "Window", "Help"]);
  });

  it("wires every shortcut item to the handler with its id", () => {
    const { run, all } = build("win");
    const wired = all.filter((i) => i.id && SHORTCUTS.some((d) => i.id!.split(":")[0] === d.id));
    expect(wired.length).toBeGreaterThan(SHORTCUTS.length); // hidden alternates included
    for (const entry of wired) entry.click!();
    const ids = new Set(run.mock.calls.map((c) => c[0] as ShortcutId));
    for (const def of SHORTCUTS) expect(ids.has(def.id), def.id).toBe(true);
  });

  it("keeps alternates hidden and the primary visible", () => {
    const { all } = build("win");
    const reloads = all.filter((i) => i.id?.startsWith("reload"));
    expect(reloads.find((i) => i.id === "reload")?.visible).toBeUndefined();
    expect(reloads.find((i) => i.id === "reload:F5")?.visible).toBe(false);
  });

  it("targets the page, not the focused shell: no Electron reload/close/devtools roles", () => {
    const roles = build("mac").all.map((i) => i.role);
    for (const banned of ["reload", "forceReload", "toggleDevTools", "close", "zoomIn", "zoomOut", "resetZoom"]) {
      expect(roles).not.toContain(banned);
    }
  });

  it("adds the shell devtools item only when asked", () => {
    expect(build("win").all.some((i) => i.label?.startsWith("Developer tools for HelmStack"))).toBe(false);
    const toggle = vi.fn();
    const item = build("win", { toggleShellDevTools: toggle }).all.find((i) => i.label?.startsWith("Developer tools for HelmStack"));
    item!.click!();
    expect(toggle).toHaveBeenCalled();
  });

  it("adds the project link only with a handler", () => {
    expect(build("win").all.some((i) => i.label === "HelmStack on GitHub")).toBe(false);
    const open = vi.fn();
    build("win", { openProjectPage: open }).all.find((i) => i.label === "HelmStack on GitHub")!.click!();
    expect(open).toHaveBeenCalled();
  });
});
