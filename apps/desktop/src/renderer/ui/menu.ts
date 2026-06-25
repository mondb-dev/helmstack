/**
 * Keyboard + ARIA wiring for a button-triggered menu (styleguide §3.4).
 *
 * Sets `aria-haspopup`/`aria-expanded`/`aria-controls` on the trigger, focus
 * roves `[role="menuitem"]` with ↑/↓/Home/End (reusing the roving index math),
 * Enter/Space/↓ on the trigger opens to the first item (↑ to the last), Escape
 * closes and restores focus to the trigger, Tab closes, and a click outside
 * closes. Item activation is native `<button>` click; selecting one closes.
 */

import { nextRovingIndex } from "./roving.js";

const ITEM_SELECTOR = '[role="menuitem"]';

export interface MenuController {
  open(focus?: "first" | "last"): void;
  close(restoreFocus?: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createMenu(trigger: HTMLElement, menu: HTMLElement): MenuController {
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  if (menu.id) {
    trigger.setAttribute("aria-controls", menu.id);
  }
  if (!menu.hasAttribute("role")) {
    menu.setAttribute("role", "menu");
  }

  const items = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
  items().forEach((item) => {
    item.tabIndex = -1;
  });

  const isOpen = (): boolean => !menu.hasAttribute("hidden");

  const open = (focus: "first" | "last" = "first"): void => {
    menu.removeAttribute("hidden");
    trigger.setAttribute("aria-expanded", "true");
    const list = items();
    const target = focus === "last" ? list[list.length - 1] : list[0];
    target?.focus();
  };

  const close = (restoreFocus = false): void => {
    if (!isOpen()) {
      return;
    }
    menu.setAttribute("hidden", "");
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
      trigger.focus();
    }
  };

  const toggle = (): void => {
    if (isOpen()) {
      close(true);
    } else {
      open("first");
    }
  };

  const onTriggerKeydown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      open("last");
    }
  };

  const onTriggerClick = (event: MouseEvent): void => {
    event.stopPropagation();
    toggle();
  };

  const onMenuKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    const list = items();
    const current = list.findIndex((el) => el === document.activeElement);
    const next = nextRovingIndex(event.key, current, list.length, { orientation: "vertical", wrap: true });
    if (next === null) {
      return;
    }
    event.preventDefault();
    list[next].focus();
  };

  const onMenuClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement).closest(ITEM_SELECTOR)) {
      close(false);
    }
  };

  const onDocumentClick = (event: MouseEvent): void => {
    if (!trigger.contains(event.target as Node) && !menu.contains(event.target as Node)) {
      close(false);
    }
  };

  trigger.addEventListener("keydown", onTriggerKeydown);
  trigger.addEventListener("click", onTriggerClick);
  menu.addEventListener("keydown", onMenuKeydown);
  menu.addEventListener("click", onMenuClick);
  document.addEventListener("click", onDocumentClick);

  return {
    open,
    close,
    toggle,
    isOpen,
    destroy(): void {
      trigger.removeEventListener("keydown", onTriggerKeydown);
      trigger.removeEventListener("click", onTriggerClick);
      menu.removeEventListener("keydown", onMenuKeydown);
      menu.removeEventListener("click", onMenuClick);
      document.removeEventListener("click", onDocumentClick);
    },
  };
}
