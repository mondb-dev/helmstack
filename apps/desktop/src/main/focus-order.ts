import type { FocusableElement, FocusOrderIssue, FocusOrderReport, TabId } from "../../../../packages/shared/src/index.js";

export type RawFocusOrder = {
  url: string;
  elements: FocusableElement[];
};

/** Browser tab order: positive tabindex first (ascending), then DOM order (tabindex 0). */
function tabOrder(elements: FocusableElement[]): FocusableElement[] {
  const positive = elements.filter((e) => e.tabindex > 0).sort((a, b) => a.tabindex - b.tabindex);
  const zero = elements.filter((e) => e.tabindex <= 0); // already in DOM order from the collector
  return [...positive, ...zero];
}

/**
 * Analyze keyboard focus order against visual reading order. Pure — testable.
 * Flags positive tabindex usage and points where tab order jumps "backwards"
 * (to an element visually above, or far to the left on the same row).
 */
export function analyzeFocusOrder(raw: RawFocusOrder, tabId: TabId, capturedAt: number): FocusOrderReport {
  const elements = raw.elements;
  const issues: FocusOrderIssue[] = [];

  let positiveTabindexCount = 0;
  for (const el of elements) {
    if (el.tabindex > 0) {
      positiveTabindexCount++;
      issues.push({
        kind: "positive_tabindex",
        selector: el.selector,
        detail: `tabindex="${el.tabindex}" overrides natural order; prefer 0 or DOM ordering.`
      });
    }
  }

  const order = tabOrder(elements);
  const ROW_TOLERANCE = 12; // px; treat as same visual row within this band
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1];
    const cur = order[i];
    const sameRow = Math.abs(cur.y - prev.y) <= ROW_TOLERANCE;
    const jumpsUp = cur.y < prev.y - ROW_TOLERANCE;
    const jumpsLeftOnRow = sameRow && cur.x < prev.x - 1;
    if (jumpsUp || jumpsLeftOnRow) {
      issues.push({
        kind: "reading_order_jump",
        selector: cur.selector,
        detail: `Tab order reaches this element after ${prev.selector}, but it sits ${jumpsUp ? "above" : "left of"} it — focus jumps against reading order.`
      });
    }
  }

  return {
    tabId,
    url: raw.url,
    capturedAt,
    focusableCount: elements.length,
    positiveTabindexCount,
    issues,
    order: order.map((e) => e.selector)
  };
}

/**
 * In-page collector for focusable elements in DOM order, with tabindex, box,
 * and accessible name. Returns a string evaluating to a `RawFocusOrder`.
 */
export function focusableElementsScript(cap = 2000): string {
  return `(() => {
    const sel = "a[href], button, input:not([type='hidden']), select, textarea, [tabindex], [contenteditable='true']";
    const selectorFor = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return tag + "#" + el.id;
      const tid = el.getAttribute("data-testid");
      if (tid) return tag + "[data-testid=\\"" + tid + "\\"]";
      const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean)[0];
      if (cls) return tag + "." + cls;
      return tag;
    };
    const nameOf = (el) => (el.getAttribute("aria-label") || (el.textContent || "").replace(/\\s+/g, " ").trim()).slice(0, 60);
    const elements = [];
    const all = Array.prototype.slice.call(document.querySelectorAll(sel), 0, ${cap});
    for (const el of all) {
      if (el.disabled) continue;
      const ti = el.getAttribute("tabindex");
      const tabindex = ti === null ? 0 : parseInt(ti, 10);
      if (tabindex < 0 || isNaN(tabindex)) continue; // not in tab order
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      elements.push({ selector: selectorFor(el), tabindex,
        x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
        name: nameOf(el) || undefined });
    }
    return { url: location.href, elements };
  })()`;
}
