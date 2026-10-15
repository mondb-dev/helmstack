/**
 * Back / Forward / Reload(Stop) buttons left of the address bar. State comes
 * from the active tab's summary (`canGoBack`, `canGoForward`, `status`); the
 * reload button turns into Stop while the page is loading. Tooltips carry the
 * platform's shortcut, generated from the shared shortcut table.
 */
import type { BrowserShellBridge, TabSummary } from "../../../../../packages/shared/src/index.js";
import {
  formatAccelerator,
  primaryAccelerator,
  type ShortcutId,
  type ShortcutPlatform
} from "../../../../../packages/shared/src/shortcuts.js";
import { icon } from "../ui/icons.js";
import { toast } from "../ui/toast.js";

export type NavControlsBridge = Pick<BrowserShellBridge, "goBack" | "goForward" | "reload" | "stopLoading" | "zoomTab">;

export interface NavControlsOptions {
  root?: ParentNode;
  bridge: NavControlsBridge;
  platform: ShortcutPlatform;
  activeTab: () => TabSummary | undefined;
  /** Receives the tab list a navigation command resolved with. */
  onTabs?: (tabs: TabSummary[]) => void;
  /** Focus the page/address after a click is not needed; the layout hook keeps the native view in sync. */
  onLayoutChange?: () => void;
}

export interface NavControlsController {
  /** Re-derive disabled/label state from the active tab. */
  sync(): void;
}

/** `Back (⌘[)` — label plus the platform shortcut, when one exists. */
export function tooltipFor(label: string, id: ShortcutId, platform: ShortcutPlatform): string {
  const accelerator = primaryAccelerator(id, platform);
  return accelerator ? `${label} (${formatAccelerator(accelerator, platform)})` : label;
}

export function mountNavControls(options: NavControlsOptions): NavControlsController {
  const root = options.root ?? document;
  const q = (id: string): HTMLButtonElement => {
    const el = root.querySelector<HTMLButtonElement>(`#${id}`);
    if (!el) throw new Error(`Nav controls markup missing: #${id}`);
    return el;
  };
  const back = q("nav-back");
  const forward = q("nav-forward");
  const reload = q("nav-reload");
  const zoomChip = root.querySelector<HTMLButtonElement>("#zoom-chip");
  const { platform } = options;

  back.replaceChildren(icon("arrow-left"));
  forward.replaceChildren(icon("arrow-right"));

  const setTooltip = (button: HTMLButtonElement, text: string): void => {
    button.title = text;
    button.setAttribute("aria-label", text);
  };

  const run = async (action: () => Promise<TabSummary[]>): Promise<void> => {
    try {
      options.onTabs?.(await action());
    } catch (error) {
      toast(`Couldn't complete that — ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const sync = (): void => {
    const tab = options.activeTab();
    const loading = tab?.status === "loading";
    back.disabled = !tab || tab.canGoBack !== true;
    forward.disabled = !tab || tab.canGoForward !== true;
    reload.disabled = !tab;
    reload.dataset.mode = loading ? "stop" : "reload";
    reload.replaceChildren(icon(loading ? "x" : "rotate-cw"));
    setTooltip(back, tooltipFor("Back", "back", platform));
    setTooltip(forward, tooltipFor("Forward", "forward", platform));
    if (zoomChip) {
      const factor = tab?.zoomFactor ?? 1;
      const percent = `${Math.round(factor * 100)}%`;
      zoomChip.hidden = Math.abs(factor - 1) < 0.005;
      zoomChip.textContent = percent;
      zoomChip.setAttribute("aria-label", `Page zoom ${percent}. Reset to 100%`);
      zoomChip.title = tooltipFor("Reset zoom to 100%", "zoom-reset", platform);
    }
    setTooltip(reload, loading ? tooltipFor("Stop loading", "stop", platform) : tooltipFor("Reload", "reload", platform));
  };

  back.addEventListener("click", () => {
    const tab = options.activeTab();
    if (tab && !back.disabled) void run(() => options.bridge.goBack(tab.id));
  });
  forward.addEventListener("click", () => {
    const tab = options.activeTab();
    if (tab && !forward.disabled) void run(() => options.bridge.goForward(tab.id));
  });
  reload.addEventListener("click", (event) => {
    const tab = options.activeTab();
    if (!tab) return;
    if (reload.dataset.mode === "stop") void run(() => options.bridge.stopLoading(tab.id));
    // Shift-click is a hard reload, like the keyboard shortcut.
    else void run(() => options.bridge.reload(tab.id, event.shiftKey));
  });

  zoomChip?.addEventListener("click", () => {
    const tab = options.activeTab();
    if (tab) void run(() => options.bridge.zoomTab(tab.id, "reset"));
  });

  sync();
  return { sync };
}
