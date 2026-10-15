/**
 * The application menu: every browser shortcut, generated from the shared
 * shortcut table (`packages/shared/src/shortcuts.ts`).
 *
 * `buildAppMenuTemplate` is pure (no Electron runtime) so it is unit-tested per
 * platform; `installAppMenu` is the thin Electron wrapper.
 *
 * Why a real menu: without one, Electron's default menu acts on the focused
 * *shell* webContents (Reload reloads HelmStack's chrome, Cmd+W closes the
 * window). Here every item targets the active page via `handlers.run`.
 * Alternate accelerators ride on hidden items. Esc ("stop") is never a menu
 * accelerator — it would swallow the key from pages — and is handled
 * contextually by the in-page key routing instead.
 */
import type { MenuItemConstructorOptions } from "electron";

import {
  SHORTCUTS_BY_ID,
  acceleratorsFor,
  type ShortcutDef,
  type ShortcutId,
  type ShortcutPlatform
} from "../../../../packages/shared/src/shortcuts.js";

export interface AppMenuHandlers {
  /** Execute a shortcut action against the active tab / the shell. */
  run(id: ShortcutId): void;
  /** Opens the project page in the system browser (Help menu item is omitted without it). */
  openProjectPage?(): void;
  /** Dev builds: toggle devtools for HelmStack's own window (never reachable from the page). */
  toggleShellDevTools?(): void;
}

export const APP_NAME = "HelmStack";

/** Electron accelerator for an app-menu item, platform-resolved by Electron itself. */
function item(def: ShortcutDef, platform: ShortcutPlatform, handlers: AppMenuHandlers, label = def.label): MenuItemConstructorOptions[] {
  const [primary, ...alternates] = acceleratorsFor(def, platform);
  const click = (): void => handlers.run(def.id);
  const items: MenuItemConstructorOptions[] = [];
  if (def.inputOnly || !primary) {
    // Shown for discoverability, no accelerator registered (Esc must reach pages).
    items.push({ label, click, id: def.id });
    return items;
  }
  items.push({ label, accelerator: primary, click, id: def.id });
  for (const accelerator of alternates) {
    items.push({ label, accelerator, click, visible: false, id: `${def.id}:${accelerator}` });
  }
  return items;
}

function byId(id: ShortcutId, platform: ShortcutPlatform, handlers: AppMenuHandlers, label?: string): MenuItemConstructorOptions[] {
  const def = SHORTCUTS_BY_ID.get(id);
  if (!def) throw new Error(`Unknown shortcut: ${id}`);
  return item(def, platform, handlers, label);
}

export function buildAppMenuTemplate(platform: ShortcutPlatform, handlers: AppMenuHandlers): MenuItemConstructorOptions[] {
  const mac = platform === "mac";
  const entry = (id: ShortcutId, label?: string) => byId(id, platform, handlers, label);
  const sep: MenuItemConstructorOptions = { type: "separator" };

  const template: MenuItemConstructorOptions[] = [];

  if (mac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { role: "about", label: `About ${APP_NAME}` },
        sep,
        { role: "services" },
        sep,
        { role: "hide", label: `Hide ${APP_NAME}` },
        { role: "hideOthers" },
        { role: "unhide", label: "Show all" },
        sep,
        { role: "quit", label: `Quit ${APP_NAME}` }
      ]
    });
  }

  template.push({
    label: "File",
    submenu: [
      ...entry("new-tab"),
      sep,
      ...entry("close-tab"),
      ...entry("reopen-tab"),
      ...entry("close-window"),
      sep,
      ...entry("print"),
      ...(mac ? [] : [sep, { role: "quit" as const, label: `Quit ${APP_NAME}` }])
    ]
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      sep,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle", label: "Paste and match style" },
      { role: "selectAll", label: "Select all" },
      sep,
      ...entry("find"),
      ...entry("find-next"),
      ...entry("find-previous")
    ]
  });

  template.push({
    label: "View",
    submenu: [
      ...entry("reload"),
      ...entry("hard-reload"),
      ...entry("stop"),
      sep,
      ...entry("zoom-in"),
      ...entry("zoom-out"),
      ...entry("zoom-reset"),
      sep,
      { role: "togglefullscreen", label: "Toggle full screen" },
      sep,
      ...entry("toggle-devtools"),
      ...(handlers.toggleShellDevTools
        ? [
            {
              label: `Developer tools for ${APP_NAME}`,
              accelerator: "CommandOrControl+Alt+Shift+I",
              click: () => handlers.toggleShellDevTools?.()
            } satisfies MenuItemConstructorOptions
          ]
        : []),
      sep,
      ...entry("toggle-agent-panel"),
      ...entry("select-for-agent"),
      ...entry("focus-chat")
    ]
  });

  template.push({
    label: "History",
    submenu: [...entry("back"), ...entry("forward"), sep, ...entry("focus-address")]
  });

  const selectTabs: MenuItemConstructorOptions[] = [];
  for (let n = 1; n <= 8; n += 1) selectTabs.push(...entry(`select-tab-${n}` as ShortcutId, `Select tab ${n}`));

  template.push({
    label: "Tab",
    submenu: [...entry("next-tab"), ...entry("previous-tab"), sep, ...selectTabs, ...entry("select-last-tab", "Select last tab")]
  });

  template.push({
    label: "Window",
    ...(mac ? { role: "window" as const } : {}),
    submenu: mac
      ? [{ role: "minimize" }, { role: "zoom" }, sep, { role: "front" }]
      : [{ role: "minimize" }, { role: "zoom" }]
  });

  template.push({
    label: "Help",
    role: "help",
    submenu: [
      ...entry("show-shortcuts"),
      ...(handlers.openProjectPage
        ? [{ label: `${APP_NAME} on GitHub`, click: () => handlers.openProjectPage?.() } satisfies MenuItemConstructorOptions]
        : [])
    ]
  });

  return template;
}

/** Every accelerator string a template registers (visible and hidden), roles excluded. */
export function collectAccelerators(template: readonly MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  const walk = (items: readonly MenuItemConstructorOptions[]): void => {
    for (const entry of items) {
      if (typeof entry.accelerator === "string") out.push(entry.accelerator);
      if (Array.isArray(entry.submenu)) walk(entry.submenu);
    }
  };
  walk(template);
  return out;
}

/**
 * Installs the menu on the application. On Windows/Linux the menu bar is hidden
 * by the window (Alt shows it); accelerators work regardless.
 */
export async function installAppMenu(platform: ShortcutPlatform, handlers: AppMenuHandlers): Promise<void> {
  const { Menu } = await import("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(platform, handlers)));
}
