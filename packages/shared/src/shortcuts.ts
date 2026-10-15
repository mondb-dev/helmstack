/**
 * Browser keyboard shortcuts: the single source of truth for the desktop
 * application menu, the in-page key routing in the main process and the
 * "Keyboard shortcuts" dialog. Electron-free so main, preload and renderer can
 * all import it.
 *
 * Accelerators use Electron's syntax (`CommandOrControl+Shift+T`). The first
 * entry of `mac` / `other` is the primary (shown in the menu and the dialog);
 * the rest are alternates registered as hidden menu items.
 */

export type ShortcutPlatform = "mac" | "win" | "linux";

export type ShortcutGroup = "Tabs" | "Navigation" | "Page" | "Find" | "Zoom" | "HelmStack";

export const SHORTCUT_GROUP_ORDER: readonly ShortcutGroup[] = ["Tabs", "Navigation", "Page", "Find", "Zoom", "HelmStack"];

export type ShortcutId =
  | "new-tab"
  | "close-tab"
  | "reopen-tab"
  | "close-window"
  | "next-tab"
  | "previous-tab"
  | "select-tab-1"
  | "select-tab-2"
  | "select-tab-3"
  | "select-tab-4"
  | "select-tab-5"
  | "select-tab-6"
  | "select-tab-7"
  | "select-tab-8"
  | "select-last-tab"
  | "back"
  | "forward"
  | "reload"
  | "hard-reload"
  | "stop"
  | "focus-address"
  | "print"
  | "toggle-devtools"
  | "find"
  | "find-next"
  | "find-previous"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "select-for-agent"
  | "toggle-agent-panel"
  | "focus-chat"
  | "show-shortcuts";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  /** macOS accelerators (primary first). */
  mac: readonly string[];
  /** Windows/Linux accelerators (primary first). */
  other: readonly string[];
  /**
   * Never registered as a menu accelerator (it would swallow a key pages need);
   * handled only by the in-page `before-input-event` routing, contextually.
   */
  inputOnly?: boolean;
  /** Dialog text overriding the formatted accelerators (e.g. a range). */
  display?: { mac: string; other: string };
  /** `false` hides the row from the dialog (the menu still has it). */
  listed?: boolean;
}

const TAB_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const SHORTCUTS: readonly ShortcutDef[] = [
  // Tabs
  { id: "new-tab", label: "New tab", group: "Tabs", mac: ["CommandOrControl+T"], other: ["CommandOrControl+T"] },
  { id: "close-tab", label: "Close tab", group: "Tabs", mac: ["CommandOrControl+W"], other: ["CommandOrControl+W", "CommandOrControl+F4"] },
  { id: "reopen-tab", label: "Reopen closed tab", group: "Tabs", mac: ["CommandOrControl+Shift+T"], other: ["CommandOrControl+Shift+T"] },
  { id: "close-window", label: "Close window", group: "Tabs", mac: ["CommandOrControl+Shift+W"], other: ["CommandOrControl+Shift+W"] },
  {
    id: "next-tab",
    label: "Next tab",
    group: "Tabs",
    mac: ["Ctrl+Tab", "Command+Alt+Right", "Command+Shift+]"],
    other: ["Ctrl+Tab", "Ctrl+PageDown"]
  },
  {
    id: "previous-tab",
    label: "Previous tab",
    group: "Tabs",
    mac: ["Ctrl+Shift+Tab", "Command+Alt+Left", "Command+Shift+["],
    other: ["Ctrl+Shift+Tab", "Ctrl+PageUp"]
  },
  ...TAB_DIGITS.map(
    (n): ShortcutDef => ({
      id: `select-tab-${n}` as ShortcutId,
      label: n === 1 ? "Select tab 1–8" : `Select tab ${n}`,
      group: "Tabs",
      mac: [`CommandOrControl+${n}`],
      other: [`CommandOrControl+${n}`],
      ...(n === 1 ? { display: { mac: "⌘1–8", other: "Ctrl+1–8" } } : { listed: false })
    })
  ),
  { id: "select-last-tab", label: "Select last tab", group: "Tabs", mac: ["CommandOrControl+9"], other: ["CommandOrControl+9"] },

  // Navigation
  { id: "back", label: "Back", group: "Navigation", mac: ["Command+["], other: ["Alt+Left"] },
  { id: "forward", label: "Forward", group: "Navigation", mac: ["Command+]"], other: ["Alt+Right"] },
  { id: "reload", label: "Reload", group: "Navigation", mac: ["CommandOrControl+R", "F5"], other: ["CommandOrControl+R", "F5"] },
  {
    id: "hard-reload",
    label: "Hard reload (bypass cache)",
    group: "Navigation",
    mac: ["CommandOrControl+Shift+R"],
    other: ["CommandOrControl+Shift+R", "Ctrl+F5", "Shift+F5"]
  },
  { id: "stop", label: "Stop loading", group: "Navigation", mac: ["Escape"], other: ["Escape"], inputOnly: true },
  { id: "focus-address", label: "Focus address bar", group: "Navigation", mac: ["CommandOrControl+L"], other: ["CommandOrControl+L", "Alt+D", "F6"] },

  // Page
  { id: "print", label: "Print…", group: "Page", mac: ["CommandOrControl+P"], other: ["CommandOrControl+P"] },
  {
    id: "toggle-devtools",
    label: "Developer tools for the page",
    group: "Page",
    mac: ["Command+Alt+I", "F12"],
    other: ["F12", "Ctrl+Shift+I"]
  },

  // Find
  { id: "find", label: "Find in page", group: "Find", mac: ["CommandOrControl+F"], other: ["CommandOrControl+F"] },
  { id: "find-next", label: "Find next", group: "Find", mac: ["Command+G"], other: ["F3", "Ctrl+G"] },
  { id: "find-previous", label: "Find previous", group: "Find", mac: ["Command+Shift+G"], other: ["Shift+F3", "Ctrl+Shift+G"] },

  // Zoom
  { id: "zoom-in", label: "Zoom in", group: "Zoom", mac: ["CommandOrControl+Plus", "CommandOrControl+="], other: ["CommandOrControl+Plus", "CommandOrControl+="] },
  { id: "zoom-out", label: "Zoom out", group: "Zoom", mac: ["CommandOrControl+-"], other: ["CommandOrControl+-"] },
  { id: "zoom-reset", label: "Actual size", group: "Zoom", mac: ["CommandOrControl+0"], other: ["CommandOrControl+0"] },

  // HelmStack
  { id: "select-for-agent", label: "Select an element for the agent", group: "HelmStack", mac: ["CommandOrControl+Shift+E"], other: ["CommandOrControl+Shift+E"] },
  { id: "toggle-agent-panel", label: "Show or hide the agent panel", group: "HelmStack", mac: ["CommandOrControl+Shift+A"], other: ["CommandOrControl+Shift+A"] },
  { id: "focus-chat", label: "Focus the chat composer", group: "HelmStack", mac: ["CommandOrControl+Shift+K"], other: ["CommandOrControl+Shift+K"] },
  { id: "show-shortcuts", label: "Keyboard shortcuts…", group: "HelmStack", mac: ["CommandOrControl+/"], other: ["CommandOrControl+/"] }
];

export const SHORTCUTS_BY_ID: ReadonlyMap<ShortcutId, ShortcutDef> = new Map(SHORTCUTS.map((def) => [def.id, def]));

/**
 * Accelerators that macOS's menu cannot deliver reliably (Cocoa's key-view loop
 * owns Ctrl+Tab), so they are routed through `before-input-event` there too.
 */
const MAC_INPUT_ROUTED = new Set(["Ctrl+Tab", "Ctrl+Shift+Tab"]);
// (Windows/Linux Chromium also reserves Ctrl+Tab; the same two strings are the only
// ones the shell window needs routed there, since the application menu covers the rest.)

// ── Platform helpers ────────────────────────────────────────────────────────

/** `process.platform` ("darwin"/"win32"/"linux") or `navigator.platform` → platform. */
export function detectShortcutPlatform(value: string | undefined): ShortcutPlatform {
  const v = (value ?? "").toLowerCase();
  if (v.startsWith("darwin") || v.includes("mac") || v.includes("iphone") || v.includes("ipad")) return "mac";
  if (v.startsWith("win")) return "win";
  return "linux";
}

export function acceleratorsFor(def: ShortcutDef, platform: ShortcutPlatform): readonly string[] {
  return platform === "mac" ? def.mac : def.other;
}

export function primaryAccelerator(id: ShortcutId, platform: ShortcutPlatform): string | undefined {
  const def = SHORTCUTS_BY_ID.get(id);
  return def ? acceleratorsFor(def, platform)[0] : undefined;
}

// ── Formatting ──────────────────────────────────────────────────────────────

const MAC_GLYPHS: Record<string, string> = {
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  command: "⌘",
  cmd: "⌘",
  meta: "⌘",
  super: "⌘",
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧"
};

const KEY_NAMES: Record<string, { mac: string; other: string }> = {
  plus: { mac: "+", other: "+" },
  left: { mac: "←", other: "Left" },
  right: { mac: "→", other: "Right" },
  up: { mac: "↑", other: "Up" },
  down: { mac: "↓", other: "Down" },
  escape: { mac: "⎋", other: "Esc" },
  esc: { mac: "⎋", other: "Esc" },
  tab: { mac: "⇥", other: "Tab" },
  pagedown: { mac: "⇟", other: "PgDn" },
  pageup: { mac: "⇞", other: "PgUp" }
};

/** `CommandOrControl+Shift+T` → `⌘⇧T` (mac) or `Ctrl+Shift+T`. */
export function formatAccelerator(accelerator: string, platform: ShortcutPlatform): string {
  const parts = accelerator.split("+");
  const out: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (platform === "mac") {
      const glyph = MAC_GLYPHS[lower];
      if (glyph) {
        out.push(glyph);
        continue;
      }
      out.push(KEY_NAMES[lower]?.mac ?? (part.length === 1 ? part.toUpperCase() : part));
    } else {
      if (lower === "commandorcontrol" || lower === "cmdorctrl" || lower === "control" || lower === "ctrl") out.push("Ctrl");
      else if (lower === "command" || lower === "cmd" || lower === "meta" || lower === "super") out.push("Win");
      else if (lower === "option") out.push("Alt");
      else out.push(KEY_NAMES[lower]?.other ?? (part.length === 1 ? part.toUpperCase() : part));
    }
  }
  return platform === "mac" ? out.join("") : out.join("+");
}

export interface ShortcutRow {
  id: ShortcutId;
  label: string;
  /** Formatted accelerators, primary first (one entry when `display` overrides). */
  keys: string[];
}

export interface ShortcutSection {
  group: ShortcutGroup;
  rows: ShortcutRow[];
}

/** The dialog's content: grouped, platform-formatted, generated from `SHORTCUTS`. */
export function shortcutSections(platform: ShortcutPlatform): ShortcutSection[] {
  const sections: ShortcutSection[] = [];
  for (const group of SHORTCUT_GROUP_ORDER) {
    const rows: ShortcutRow[] = [];
    for (const def of SHORTCUTS) {
      if (def.group !== group || def.listed === false) continue;
      const keys = def.display
        ? [platform === "mac" ? def.display.mac : def.display.other]
        : acceleratorsFor(def, platform).map((a) => formatAccelerator(a, platform));
      rows.push({ id: def.id, label: def.label, keys });
    }
    if (rows.length > 0) sections.push({ group, rows });
  }
  return sections;
}

// ── Key matching (before-input-event) ───────────────────────────────────────

export interface KeyInputLike {
  type: string;
  key: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

interface ParsedAccelerator {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
  down: "arrowdown",
  esc: "escape",
  plus: "+",
  pgdn: "pagedown",
  pgup: "pageup"
};

export function parseAccelerator(accelerator: string, platform: ShortcutPlatform): ParsedAccelerator {
  const parsed: ParsedAccelerator = { ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of accelerator.split("+")) {
    switch (part.toLowerCase()) {
      case "commandorcontrol":
      case "cmdorctrl":
        if (platform === "mac") parsed.meta = true;
        else parsed.ctrl = true;
        break;
      case "command":
      case "cmd":
      case "meta":
      case "super":
        parsed.meta = true;
        break;
      case "control":
      case "ctrl":
        parsed.ctrl = true;
        break;
      case "alt":
      case "option":
        parsed.alt = true;
        break;
      case "shift":
        parsed.shift = true;
        break;
      default: {
        const lower = part.toLowerCase();
        parsed.key = KEY_ALIASES[lower] ?? lower;
      }
    }
  }
  return parsed;
}

/** Keys whose character already implies Shift on some layouts (`+` is Shift+`=` on US). */
const SHIFT_AGNOSTIC = new Set(["+", "="]);

function keyMatches(parsed: ParsedAccelerator, input: KeyInputLike): boolean {
  const key = input.key.toLowerCase();
  if (parsed.key === "+" || parsed.key === "=") return key === "+" || key === "=";
  if (key === parsed.key) return true;
  // Option/Alt remaps characters on macOS ("ˆ" for I); fall back to the physical key.
  const code = input.code;
  if (code && parsed.key.length === 1) {
    if (/^[a-z]$/.test(parsed.key)) return code === `Key${parsed.key.toUpperCase()}`;
    if (/^[0-9]$/.test(parsed.key)) return code === `Digit${parsed.key}` || code === `Numpad${parsed.key}`;
  }
  return false;
}

/** True when this accelerator is delivered by the in-page `before-input-event` routing. */
export function isInputRouted(def: ShortcutDef, accelerator: string, platform: ShortcutPlatform): boolean {
  if (def.inputOnly) return true;
  if (platform !== "mac") return true;
  return MAC_INPUT_ROUTED.has(accelerator);
}

/**
 * Maps a key-down to a shortcut id among the in-page-routed set, or null.
 * `surface: "shell"` is the app's own window, where the application menu
 * already handles everything, so only Ctrl+Tab / Ctrl+Shift+Tab are matched
 * (they are not reliably delivered by a menu) and nothing fires twice.
 */
export function matchShortcut(
  input: KeyInputLike,
  platform: ShortcutPlatform,
  surface: "page" | "shell" = "page"
): ShortcutId | null {
  if (input.type !== "keyDown") return null;
  for (const def of SHORTCUTS) {
    for (const accelerator of acceleratorsFor(def, platform)) {
      const routed = isInputRouted(def, accelerator, platform);
      if (!routed) continue;
      if (surface === "shell" && !MAC_INPUT_ROUTED.has(accelerator)) continue;
      const parsed = parseAccelerator(accelerator, platform);
      if (parsed.ctrl !== !!input.control || parsed.meta !== !!input.meta || parsed.alt !== !!input.alt) continue;
      if (parsed.shift !== !!input.shift && !SHIFT_AGNOSTIC.has(parsed.key)) continue;
      if (keyMatches(parsed, input)) return def.id;
    }
  }
  return null;
}

/** Step the tab selection digit shortcuts resolve to (`select-tab-3` → 3, `select-last-tab` → -1). */
export function tabIndexForShortcut(id: ShortcutId): number | null {
  if (id === "select-last-tab") return -1;
  const match = /^select-tab-(\d)$/.exec(id);
  return match ? Number(match[1]) - 1 : null;
}
