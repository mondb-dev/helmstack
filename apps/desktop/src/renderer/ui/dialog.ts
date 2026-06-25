/**
 * Focus management for modal dialogs (styleguide §3.5).
 *
 * `openDialog` stores the currently-focused element, moves focus into the
 * dialog, traps Tab/Shift+Tab inside it, optionally closes on Escape, and
 * restores focus to the opener on close. It does NOT toggle visibility — the
 * caller shows/hides the element; this only owns focus.
 *
 * Deliberately layout-free (no `offsetParent`/`getClientRects`) so it behaves
 * identically under jsdom and in the real renderer.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export interface OpenDialogOptions {
  /** When true, Escape closes the dialog. Required decisions pass false. */
  dismissable?: boolean;
  /** Focus this element first; defaults to `[data-autofocus]` then first focusable. */
  initialFocus?: HTMLElement;
  /** Invoked once when the dialog closes (via Escape or `handle.close()`). */
  onClose?: () => void;
}

export interface DialogHandle {
  close(): void;
}

/** Focusable descendants, skipping disabled / aria-hidden / `[hidden]` subtrees. */
export function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.closest("[hidden]") === null
  );
}

export function openDialog(dialog: HTMLElement, options: OpenDialogOptions = {}): DialogHandle {
  const { dismissable = false, initialFocus, onClose } = options;
  const opener = document.activeElement as HTMLElement | null;
  let closed = false;

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (dismissable) {
        event.preventDefault();
        handle.close();
      }
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const items = getFocusable(dialog);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    if (event.shiftKey) {
      if (index <= 0) {
        event.preventDefault();
        items[items.length - 1].focus();
      }
    } else if (index === -1 || index === items.length - 1) {
      event.preventDefault();
      items[0].focus();
    }
  };

  dialog.addEventListener("keydown", onKeydown);

  const handle: DialogHandle = {
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      dialog.removeEventListener("keydown", onKeydown);
      onClose?.();
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        opener.focus();
      }
    },
  };

  // Move focus in: explicit override → [data-autofocus] → first focusable → dialog.
  const autofocus = dialog.querySelector<HTMLElement>("[data-autofocus]");
  const target = initialFocus ?? autofocus ?? getFocusable(dialog)[0] ?? dialog;
  if (target === dialog && !dialog.hasAttribute("tabindex")) {
    dialog.setAttribute("tabindex", "-1");
  }
  target.focus();

  return handle;
}
