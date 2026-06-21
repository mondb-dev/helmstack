import type { ChangedElement, DiffRegion, ElementBound } from "../../../../packages/shared/src/index.js";

function intersects(a: DiffRegion, b: ElementBound): boolean {
  return !(a.x + a.width < b.x || a.x > b.x + b.width || a.y + a.height < b.y || a.y > b.y + b.height);
}

const area = (b: ElementBound): number => Math.max(1, b.width) * Math.max(1, b.height);

/**
 * Map changed pixel regions to the DOM elements that occupy them. For each
 * region, picks the smallest (most specific) intersecting element, then rolls
 * the picks up per element with a region count. Pure — unit-testable.
 */
export function correlateRegionsToElements(regions: DiffRegion[], elements: ElementBound[], limit = 50): ChangedElement[] {
  const bySelector = new Map<string, ChangedElement>();

  for (const region of regions) {
    let best: ElementBound | null = null;
    for (const el of elements) {
      if (!intersects(region, el)) continue;
      if (!best || area(el) < area(best)) best = el;
    }
    if (!best) continue;
    const existing = bySelector.get(best.selector);
    if (existing) existing.regions += 1;
    else bySelector.set(best.selector, { selector: best.selector, bounds: best, regions: 1 });
  }

  return [...bySelector.values()]
    .sort((a, b) => b.regions - a.regions || area(a.bounds) - area(b.bounds))
    .slice(0, limit);
}

/**
 * In-page collector for visible element boxes (viewport coordinates, matching a
 * default viewport screenshot). Returns a string evaluating to
 * `{ url, elements: ElementBound[] }`.
 */
export function elementBoundsScript(cap = 4000): string {
  return `(() => {
    const selectorFor = (el) => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return tag + "#" + el.id;
      const tid = el.getAttribute("data-testid");
      if (tid) return tag + "[data-testid=\\"" + tid + "\\"]";
      const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean)[0];
      if (cls) return tag + "." + cls;
      return tag;
    };
    const elements = [];
    const all = Array.prototype.slice.call(document.querySelectorAll("body *"), 0, ${cap});
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      elements.push({ selector: selectorFor(el), x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
    }
    return { url: location.href, elements };
  })()`;
}
