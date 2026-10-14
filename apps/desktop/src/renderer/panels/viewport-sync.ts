/**
 * Keeps the native page view (a WebContentsView positioned by the main
 * process) glued to `#viewport-frame`.
 *
 * - `queue()` reports the frame's rect on the next-next animation frame
 *   (after layout settles); `stabilize()` keeps re-reporting for a short
 *   window while things like page loads or window resizes shuffle layout.
 * - A ResizeObserver on the frame **and** on every chrome region that can push
 *   it around (`observe(el)`: override strip, approval banner, activity panel)
 *   re-queues on any size change, including hidden → shown.
 * - `occlude(key)` / `release(key)`: the native view always paints above the
 *   renderer, so while a popover/dialog overlaps the page we freeze-frame it
 *   (screenshot into `#viewport-freeze`) and report a zero-size rect, which
 *   hides the view. The last release restores the live view.
 * - With an emulated viewport (agent override) the page renders at its CSS
 *   size in the top-left of the view, so the still frame is drawn at that
 *   natural size too, instead of being stretched over the whole frame.
 * - A capture slower than `captureTimeoutMs` doesn't block hiding the view;
 *   the frame is still painted when it arrives, if the overlay is still up.
 */

import type { BrowserShellBridge, TabId, ViewportRect } from "../../../../../packages/shared/src/index.js";

export type ViewportBridge = Pick<BrowserShellBridge, "setViewport" | "captureScreenshot">;

export interface ViewportSync {
  /** Report the frame rect after layout settles. */
  queue(): void;
  /** Keep re-reporting for `durationMs` (layout may shift during loads). */
  stabilize(durationMs?: number, intervalMs?: number): void;
  /** Re-sync whenever `el` changes size (incl. hidden ↔ shown). */
  observe(el: Element): void;
  /** Hide the live page behind a still frame while an overlay is up. */
  occlude(key: string): Promise<void>;
  release(key: string): void;
  isOccluded(): boolean;
  /** Synchronously report the current rect (exposed for tests). */
  layoutNow(): void;
}

export interface ViewportSyncOptions {
  frame: HTMLElement;
  freeze?: HTMLImageElement | null;
  bridge: ViewportBridge;
  activeTabId: () => TabId | undefined;
  /** Upper bound on waiting for the freeze-frame before hiding the view. */
  captureTimeoutMs?: number;
  /** CSS size the active tab is emulating (agent viewport override), or null. */
  emulatedSize?: () => { width: number; height: number } | null;
}

export function createViewportSync(options: ViewportSyncOptions): ViewportSync {
  const { frame, freeze, bridge, activeTabId, captureTimeoutMs = 300, emulatedSize } = options;
  const occluders = new Set<string>();
  let frameHandle = 0;
  let stabilizer = 0;
  let stabilizerTimeout = 0;
  /** Bumped on every occlusion episode, so a late capture can't leak into the next. */
  let episode = 0;

  const report = (rect: ViewportRect): void => {
    void bridge.setViewport(rect);
  };

  const layoutNow = (): void => {
    const rect = frame.getBoundingClientRect();
    const x = Math.round(rect.left);
    const y = Math.round(rect.top);
    if (occluders.size > 0) {
      report({ x, y, width: 0, height: 0 });
      return;
    }
    report({ x, y, width: Math.round(rect.width), height: Math.round(rect.height) });
  };

  const queue = (): void => {
    if (frameHandle) cancelAnimationFrame(frameHandle);
    frameHandle = requestAnimationFrame(() => {
      frameHandle = requestAnimationFrame(() => {
        frameHandle = 0;
        layoutNow();
      });
    });
  };

  const stabilize = (durationMs = 2000, intervalMs = 120): void => {
    if (stabilizer) window.clearInterval(stabilizer);
    if (stabilizerTimeout) window.clearTimeout(stabilizerTimeout);
    queue();
    stabilizer = window.setInterval(queue, intervalMs);
    stabilizerTimeout = window.setTimeout(() => {
      window.clearInterval(stabilizer);
      stabilizer = 0;
      stabilizerTimeout = 0;
      queue();
    }, durationMs);
  };

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => queue()) : null;
  observer?.observe(frame);

  const clearFreeze = (): void => {
    if (!freeze) return;
    freeze.hidden = true;
    freeze.removeAttribute("src");
    delete freeze.dataset.fit;
    freeze.style.removeProperty("width");
    freeze.style.removeProperty("height");
  };

  const paintFreeze = (shot: { mimeType: string; data: string }): void => {
    if (!freeze) return;
    const size = emulatedSize?.() ?? null;
    if (size && size.width > 0 && size.height > 0) {
      freeze.dataset.fit = "natural";
      freeze.style.width = `${size.width}px`;
      freeze.style.height = `${size.height}px`;
    } else {
      freeze.dataset.fit = "fill";
      freeze.style.removeProperty("width");
      freeze.style.removeProperty("height");
    }
    freeze.src = `data:${shot.mimeType};base64,${shot.data}`;
    freeze.hidden = false;
  };

  const occlude = async (key: string): Promise<void> => {
    const first = occluders.size === 0;
    occluders.add(key);
    if (!first) return;
    episode += 1;
    const mine = episode;
    const stillMine = (): boolean => occluders.size > 0 && episode === mine;
    const tabId = activeTabId();
    if (freeze && tabId) {
      const capture = bridge.captureScreenshot(tabId).then(
        (shot) => {
          // Late frames still land, as long as this overlay is still up.
          if (shot && stillMine()) paintFreeze(shot);
          return shot;
        },
        () => null /* no still frame — the page area just shows the empty surface */
      );
      await Promise.race([
        capture,
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), captureTimeoutMs)),
      ]);
    }
    if (occluders.size > 0) layoutNow();
  };

  const release = (key: string): void => {
    if (!occluders.delete(key) || occluders.size > 0) return;
    clearFreeze();
    layoutNow();
  };

  return {
    queue,
    stabilize,
    observe: (el) => observer?.observe(el),
    occlude,
    release,
    isOccluded: () => occluders.size > 0,
    layoutNow,
  };
}
