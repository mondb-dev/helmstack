/**
 * Runs browser shortcuts and routes raw key input to them.
 *
 * Two entry points feed `run(id)`:
 *  - application menu clicks (shell focused, or page focused on macOS), and
 *  - `before-input-event` on the page views / shell window, for the keys a
 *    menu cannot deliver: Esc (contextual stop), Ctrl+Tab, and on
 *    Windows/Linux the whole table (so shortcuts work whichever view has focus
 *    without depending on Electron forwarding unhandled page keys to the menu).
 *
 * Reserved (never reach the page when routed): `reservedAccelerators()` and
 * the README shortcuts table. Everything else — Ctrl+C/V/X/A/Z, arrows, typing, Esc in page
 * dialogs — is left alone.
 */
import {
  SHORTCUTS_BY_ID,
  matchShortcut,
  tabIndexForShortcut,
  type KeyInputLike,
  type ShortcutId,
  type ShortcutPlatform
} from "../../../../packages/shared/src/shortcuts.js";

/** What the shortcut runner needs from the app (implemented in main.ts over the backend/core). */
export interface ShortcutHost {
  activeTabId(): string | null;
  tabCount(): number;
  tabAtOffset(delta: number): string | null;
  tabAtIndex(index: number): string | null;
  isLoading(tabId: string): boolean;
  openBlankTab(): Promise<unknown>;
  closeTab(tabId: string): Promise<unknown>;
  focusTab(tabId: string): Promise<unknown>;
  reopenClosedTab(): Promise<unknown>;
  goBack(tabId: string): Promise<unknown>;
  goForward(tabId: string): Promise<unknown>;
  reload(tabId: string, hard: boolean): Promise<unknown>;
  stop(tabId: string): void;
  zoom(tabId: string, action: "in" | "out" | "reset"): void;
  toggleDevTools(tabId: string): void;
  print(tabId: string): void;
  closeWindow(): void;
  /** Ask the shell renderer to act (focus address bar, open find, …). */
  toShell(id: ShortcutId): void;
  /** Give keyboard focus to the shell webContents (before focusing one of its inputs). */
  focusShell(): void;
  /** Give keyboard focus back to the active page. */
  focusPage(): void;
  onError?(id: ShortcutId, error: unknown): void;
}

/** Shortcuts the shell renderer acts on (the host only forwards them). */
const SHELL_ACTIONS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  "focus-address",
  "find",
  "find-next",
  "find-previous",
  "toggle-agent-panel",
  "focus-chat",
  "select-for-agent",
  "show-shortcuts"
]);

/** Shell actions that need the shell window (not the page view) to hold keyboard focus. */
const NEEDS_SHELL_FOCUS: ReadonlySet<ShortcutId> = new Set<ShortcutId>(["focus-address", "find", "focus-chat", "show-shortcuts"]);

export function createShortcutRunner(host: ShortcutHost): (id: ShortcutId) => void {
  const withActive = (fn: (tabId: string) => unknown): void => {
    const tabId = host.activeTabId();
    if (tabId) void fn(tabId);
  };

  const run = (id: ShortcutId): void => {
    if (SHELL_ACTIONS.has(id)) {
      if (NEEDS_SHELL_FOCUS.has(id)) host.focusShell();
      host.toShell(id);
      return;
    }
    const tabIndex = tabIndexForShortcut(id);
    if (tabIndex !== null) {
      const target = host.tabAtIndex(tabIndex);
      if (target) void host.focusTab(target).then(() => host.focusPage());
      return;
    }
    switch (id) {
      case "new-tab":
        void host.openBlankTab().then(() => {
          host.focusShell();
          host.toShell("focus-address");
        });
        return;
      case "close-tab":
        if (host.tabCount() <= 1) host.closeWindow();
        else withActive((tabId) => host.closeTab(tabId).then(() => host.focusPage()));
        return;
      case "reopen-tab":
        void host.reopenClosedTab().then(() => host.focusPage());
        return;
      case "close-window":
        host.closeWindow();
        return;
      case "next-tab":
      case "previous-tab": {
        const target = host.tabAtOffset(id === "next-tab" ? 1 : -1);
        if (target && target !== host.activeTabId()) void host.focusTab(target).then(() => host.focusPage());
        return;
      }
      case "back":
        withActive((tabId) => host.goBack(tabId));
        return;
      case "forward":
        withActive((tabId) => host.goForward(tabId));
        return;
      case "reload":
        withActive((tabId) => host.reload(tabId, false));
        return;
      case "hard-reload":
        withActive((tabId) => host.reload(tabId, true));
        return;
      case "stop":
        withActive((tabId) => {
          if (host.isLoading(tabId)) host.stop(tabId);
        });
        return;
      case "zoom-in":
        withActive((tabId) => host.zoom(tabId, "in"));
        return;
      case "zoom-out":
        withActive((tabId) => host.zoom(tabId, "out"));
        return;
      case "zoom-reset":
        withActive((tabId) => host.zoom(tabId, "reset"));
        return;
      case "toggle-devtools":
        withActive((tabId) => host.toggleDevTools(tabId));
        return;
      case "print":
        withActive((tabId) => host.print(tabId));
        return;
      default:
        host.onError?.(id, new Error(`No handler for shortcut ${id}`));
    }
  };

  return (id) => {
    try {
      run(id);
    } catch (error) {
      host.onError?.(id, error);
    }
  };
}

/** Subset of Electron's `Input` the router reads. */
export type RoutedInput = KeyInputLike & { isAutoRepeat?: boolean };

/**
 * `before-input-event` handler body. Returns what to do with the event:
 * `"consumed"` (call `preventDefault`), `"observed"` (acted, let the page see it
 * too: Esc) or `"ignored"`.
 */
export function routeKeyInput(
  input: RoutedInput,
  platform: ShortcutPlatform,
  surface: "page" | "shell",
  run: (id: ShortcutId) => void
): "consumed" | "observed" | "ignored" {
  const id = matchShortcut(input, platform, surface);
  if (!id) return "ignored";
  const def = SHORTCUTS_BY_ID.get(id);
  // Esc: stop a loading page but never take the key from the page (dialogs, fullscreen exit).
  if (def?.inputOnly) {
    run(id);
    return "observed";
  }
  run(id);
  return "consumed";
}

/** The reserved (page-invisible when routed) accelerators for documentation and tests. */
export function reservedAccelerators(platform: ShortcutPlatform): string[] {
  const out: string[] = [];
  for (const def of SHORTCUTS_BY_ID.values()) {
    if (def.inputOnly) continue;
    out.push(...(platform === "mac" ? def.mac : def.other));
  }
  return out;
}
