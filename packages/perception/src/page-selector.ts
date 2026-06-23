/**
 * Single source of truth for the **descriptive selector hint** used across the
 * page-world inspector scripts (mutation timeline, component source, focus
 * order, element bounds, layout issues). Before this, each module carried its
 * own near-identical `selectorFor` copy that could drift.
 *
 * Algorithm: `tag#id` › `tag[data-testid="…"]` › `tag.firstClass` ›
 * `tag:nth-of-type(n)` (only when same-tag siblings exist) › `tag`. The result
 * is a short, human-readable hint for reports — NOT a guaranteed-unique
 * actuation selector.
 *
 * This is deliberately distinct from `dom-extractor.buildSelectorHint`, which is
 * an actuation-grade generator (semantic attribute priority — name / autocomplete
 * / type / role / aria — plus `:nth-of-type` uniqueness qualification) tuned for
 * re-resolving an element across a perceive→act cycle. The two serve different
 * jobs; unifying them would either strip the semantic attributes actuation needs
 * or bury readable class hints the reports want.
 *
 * Consumed two ways (mirroring `page-dom-roots`): bundled importers call
 * {@link selectorForElement} directly; injected-string builders interpolate
 * {@link SELECTOR_FOR_SOURCE}, derived from the function via `.toString()` so the
 * two can never drift. The function is self-contained (only DOM globals) so its
 * serialized form runs verbatim in the page.
 */
export function selectorForElement(node: Node | null): string {
  const el: Element | null = node && node.nodeType === 1
    ? (node as Element)
    : (node && (node as { parentElement?: Element | null }).parentElement) || null;
  if (!el) return "(detached)";

  const esc = (s: string): string => (typeof CSS !== "undefined" && CSS && CSS.escape ? CSS.escape(s) : s);
  const tag = el.tagName.toLowerCase();

  if (el.id) return tag + "#" + esc(el.id);

  const testid = el.getAttribute("data-testid");
  if (testid) return tag + '[data-testid="' + testid + '"]';

  const cls = ((el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean))[0];
  if (cls) return tag + "." + esc(cls);

  // Positional fallback — only when a sibling shares the tag (so unique elements
  // like <body> stay as a bare tag).
  let nth = 1;
  let count = 0;
  let sib: Element | null = el.parentElement ? el.parentElement.firstElementChild : null;
  while (sib) {
    if (sib.tagName === el.tagName) {
      count++;
      if (sib === el) nth = count;
    }
    sib = sib.nextElementSibling;
  }
  return count > 1 ? tag + ":nth-of-type(" + nth + ")" : tag;
}

/**
 * Page-world source for {@link selectorForElement}, derived from the function so
 * it can never drift. Injected as `const selectorFor = ${SELECTOR_FOR_SOURCE};`.
 */
export const SELECTOR_FOR_SOURCE = selectorForElement.toString();
