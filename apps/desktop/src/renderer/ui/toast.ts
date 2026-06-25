/**
 * Transient toast notifications (styleguide §3.6).
 *
 * Info/success toasts auto-dismiss after a few seconds; error toasts persist
 * with a manual close button (an error you didn't see is an error you can't
 * act on). All live in a single polite `role="status"` region so screen
 * readers announce them; error nodes additionally carry `role="alert"`.
 */

import { icon } from "./icons.js";

export type ToastKind = "info" | "success" | "error";

const AUTO_DISMISS_MS = 4000;

let cachedRegion: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (cachedRegion && document.body.contains(cachedRegion)) {
    return cachedRegion;
  }
  const existing = document.getElementById("toast-region");
  if (existing) {
    cachedRegion = existing;
    return existing;
  }
  const region = document.createElement("div");
  region.id = "toast-region";
  region.className = "toast-region";
  region.setAttribute("role", "status");
  region.setAttribute("aria-live", "polite");
  document.body.append(region);
  cachedRegion = region;
  return region;
}

export interface ToastHandle {
  element: HTMLElement;
  dismiss(): void;
}

export function toast(message: string, kind: ToastKind = "info"): ToastHandle {
  const region = ensureRegion();

  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  if (kind === "error") {
    node.setAttribute("role", "alert");
  }

  const text = document.createElement("span");
  text.className = "toast__message";
  text.textContent = message;
  node.append(text);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    node.remove();
  };

  if (kind === "error") {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast__close";
    close.setAttribute("aria-label", "Dismiss");
    close.append(icon("x", { size: 14 }));
    close.addEventListener("click", dismiss);
    node.append(close);
  } else {
    timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  }

  region.append(node);
  return { element: node, dismiss };
}
