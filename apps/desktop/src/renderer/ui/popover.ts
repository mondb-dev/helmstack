/**
 * Non-modal popover anchored to a trigger button (styleguide §4 "Overlays":
 * menu → popover → dialog). The panel gets `role="dialog"` + a label, the
 * trigger `aria-haspopup="dialog"` / `aria-expanded` / `aria-controls`.
 *
 * Open moves focus into the panel; Escape (from the panel or the trigger)
 * closes and returns focus to the trigger; a pointer-down outside, or focus
 * leaving to somewhere else, closes without stealing focus. Only one popover is
 * open at a time. Positioning is `position: fixed` from the trigger's rect so
 * no ancestor `overflow` can clip it.
 */

import { getFocusable } from "./dialog.js";

export interface PopoverOptions {
  /** Accessible name of the popover panel. */
  label: string;
  /** Align the panel's right edge with the trigger's (for right-hand triggers). */
  align?: "start" | "end";
  onOpen?: () => void;
  onClose?: () => void;
}

export interface PopoverController {
  open(): void;
  close(restoreFocus?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

let openPopover: PopoverController | null = null;

const GAP = 4;
const EDGE = 8;

let idCounter = 0;

export function createPopover(trigger: HTMLElement, panel: HTMLElement, options: PopoverOptions): PopoverController {
  if (!panel.id) {
    idCounter += 1;
    panel.id = `popover-${idCounter}`;
  }
  panel.classList.add("popover");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", options.label);
  panel.hidden = true;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", panel.id);

  const isOpen = (): boolean => !panel.hidden;

  const position = (): void => {
    const anchor = trigger.getBoundingClientRect();
    const width = panel.offsetWidth || 0;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    let left = options.align === "end" ? anchor.right - width : anchor.left;
    left = Math.min(left, viewportWidth - width - EDGE);
    left = Math.max(EDGE, left);
    panel.style.top = `${Math.round(anchor.bottom + GAP)}px`;
    panel.style.left = `${Math.round(left)}px`;
  };

  const controller: PopoverController = {
    open(): void {
      if (isOpen()) return;
      if (openPopover && openPopover !== controller) {
        openPopover.close(false);
      }
      openPopover = controller;
      panel.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      position();
      const target = panel.querySelector<HTMLElement>("[data-autofocus]") ?? getFocusable(panel)[0] ?? panel;
      if (target === panel && !panel.hasAttribute("tabindex")) {
        panel.tabIndex = -1;
      }
      target.focus();
      options.onOpen?.();
    },
    close(restoreFocus = true): void {
      if (!isOpen()) return;
      const hadFocus = panel.contains(document.activeElement);
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      if (openPopover === controller) {
        openPopover = null;
      }
      if (restoreFocus && (hadFocus || document.activeElement === document.body) && document.contains(trigger)) {
        trigger.focus();
      }
      options.onClose?.();
    },
    toggle(): void {
      if (isOpen()) controller.close(true);
      else controller.open();
    },
    isOpen,
    destroy(): void {
      controller.close(false);
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("keydown", onKeydown);
      panel.removeEventListener("keydown", onKeydown);
      panel.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onDocumentPointer, true);
      window.removeEventListener("resize", onResize);
    },
  };

  const onTriggerClick = (event: MouseEvent): void => {
    event.stopPropagation();
    controller.toggle();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      controller.close(true);
    }
  };

  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget as Node | null;
    if (next && !panel.contains(next) && next !== trigger) {
      controller.close(false);
    }
  };

  const onDocumentPointer = (event: Event): void => {
    const target = event.target as Node;
    if (isOpen() && !panel.contains(target) && !trigger.contains(target)) {
      controller.close(false);
    }
  };

  const onResize = (): void => {
    if (isOpen()) position();
  };

  trigger.addEventListener("click", onTriggerClick);
  trigger.addEventListener("keydown", onKeydown);
  panel.addEventListener("keydown", onKeydown);
  panel.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", onDocumentPointer, true);
  window.addEventListener("resize", onResize);

  return controller;
}

/** The currently open popover, if any (for tests / global Escape handling). */
export function currentPopover(): PopoverController | null {
  return openPopover;
}
