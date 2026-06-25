/**
 * Roving-tabindex keyboard navigation for composite widgets (tablist, etc.),
 * per the ARIA Authoring Practices. The index math is a pure function so it is
 * unit-testable; the DOM glue (`attachRovingKeys`) is a thin wrapper.
 *
 * This implements MANUAL activation: arrows move focus + which item is tabbable;
 * activation (Enter/Space/click) is left to the items themselves (native
 * <button> behaviour), so callers don't have to re-focus after a re-render.
 */

export interface RovingOptions {
  orientation?: "horizontal" | "vertical";
  wrap?: boolean;
}

/**
 * The index a nav key should move to, or `null` when `key` isn't a nav key.
 * `current` may be -1 (nothing focused): Next → first, Prev → last.
 */
export function nextRovingIndex(
  key: string,
  current: number,
  count: number,
  options: RovingOptions = {}
): number | null {
  const { orientation = "horizontal", wrap = true } = options;
  if (count === 0) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }
  const isPrev = key === (orientation === "vertical" ? "ArrowUp" : "ArrowLeft");
  const isNext = key === (orientation === "vertical" ? "ArrowDown" : "ArrowRight");
  if (!isPrev && !isNext) {
    return null;
  }
  if (current < 0) {
    return isNext ? 0 : count - 1;
  }
  let index = current + (isNext ? 1 : -1);
  if (index < 0) {
    index = wrap ? count - 1 : 0;
  } else if (index >= count) {
    index = wrap ? 0 : count - 1;
  }
  return index;
}

/** Make only `activeIndex` tabbable (tabindex 0); the rest get -1. */
export function applyRovingTabindex(items: HTMLElement[], activeIndex: number): void {
  items.forEach((item, i) => {
    item.tabIndex = i === activeIndex ? 0 : -1;
  });
}

/**
 * Wire arrow/Home/End roving onto `container`. Items are queried live (via
 * `itemSelector`) on each keydown so the handler survives re-renders. Returns a
 * disposer.
 */
export function attachRovingKeys(
  container: HTMLElement,
  itemSelector: string,
  options: RovingOptions = {}
): () => void {
  const handler = (event: KeyboardEvent): void => {
    const items = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    if (items.length === 0) {
      return;
    }
    const current = items.findIndex((el) => el === document.activeElement);
    const next = nextRovingIndex(event.key, current, items.length, options);
    if (next === null) {
      return;
    }
    event.preventDefault();
    applyRovingTabindex(items, next);
    items[next].focus();
  };
  container.addEventListener("keydown", handler);
  return () => container.removeEventListener("keydown", handler);
}
