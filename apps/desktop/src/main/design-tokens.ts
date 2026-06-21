import type { DesignTokenSample, DesignTokensReport, TabId } from "../../../../packages/shared/src/index.js";

/** Raw frequency tallies returned by the in-page collector script. */
export type RawDesignTokens = {
  url: string;
  cssVariables: Record<string, string>;
  counts: {
    colors: Record<string, number>;
    fontFamilies: Record<string, number>;
    fontSizes: Record<string, number>;
    fontWeights: Record<string, number>;
    spacing: Record<string, number>;
    radii: Record<string, number>;
    shadows: Record<string, number>;
    zIndices: Record<string, number>;
  };
  sampledElements: number;
};

/** Rank a value→count map into a usage-sorted, top-N sample list. */
export function rankTokens(counts: Record<string, number>, limit = 24): DesignTokenSample[] {
  return Object.entries(counts)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit);
}

/**
 * Turn raw in-page tallies into a ranked DesignTokensReport. Pure — no CDP or
 * DOM access — so it can be unit-tested directly.
 */
export function buildDesignTokensReport(raw: RawDesignTokens, tabId: TabId, capturedAt: number): DesignTokensReport {
  return {
    tabId,
    url: raw.url,
    capturedAt,
    cssVariables: raw.cssVariables ?? {},
    colors: rankTokens(raw.counts.colors),
    fontFamilies: rankTokens(raw.counts.fontFamilies),
    fontSizes: rankTokens(raw.counts.fontSizes),
    fontWeights: rankTokens(raw.counts.fontWeights),
    spacing: rankTokens(raw.counts.spacing),
    radii: rankTokens(raw.counts.radii),
    shadows: rankTokens(raw.counts.shadows),
    zIndices: rankTokens(raw.counts.zIndices),
    sampledElements: raw.sampledElements
  };
}

/**
 * The in-page collector. Returns a string that evaluates to a `RawDesignTokens`
 * object. Walks up to `cap` elements' computed styles plus declared CSS custom
 * properties; resilient to cross-origin stylesheet access errors.
 */
export function designTokenCollectorScript(cap = 4000): string {
  return `(() => {
    const counts = { colors: {}, fontFamilies: {}, fontSizes: {}, fontWeights: {}, spacing: {}, radii: {}, shadows: {}, zIndices: {} };
    const bump = (bucket, value) => {
      if (!value) return;
      const v = String(value).trim();
      if (!v) return;
      bucket[v] = (bucket[v] || 0) + 1;
    };

    const elements = Array.prototype.slice.call(document.querySelectorAll("*"), 0, ${cap});
    for (const el of elements) {
      const s = getComputedStyle(el);

      const color = s.color;
      if (color && color !== "rgba(0, 0, 0, 0)") bump(counts.colors, color);
      const bg = s.backgroundColor;
      if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") bump(counts.colors, bg);

      bump(counts.fontFamilies, s.fontFamily);
      bump(counts.fontSizes, s.fontSize);
      bump(counts.fontWeights, s.fontWeight);

      for (const prop of ["marginTop", "marginRight", "marginBottom", "marginLeft", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap", "columnGap"]) {
        const val = s[prop];
        if (val && val !== "0px" && val !== "normal") bump(counts.spacing, val);
      }

      if (s.borderRadius && s.borderRadius !== "0px") bump(counts.radii, s.borderRadius);
      if (s.boxShadow && s.boxShadow !== "none") bump(counts.shadows, s.boxShadow);
      if (s.zIndex && s.zIndex !== "auto") bump(counts.zIndices, s.zIndex);
    }

    // Declared CSS custom properties on :root / html.
    const cssVariables = {};
    const readVars = (styleText) => {
      const re = /(--[\\w-]+)\\s*:\\s*([^;]+)/g;
      let m;
      while ((m = re.exec(styleText)) !== null) {
        cssVariables[m[1].trim()] = m[2].trim();
      }
    };
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        if (!rules) continue;
        for (const rule of Array.from(rules)) {
          if (rule.selectorText && /(^|,)\\s*(:root|html)\\s*($|,)/.test(rule.selectorText) && rule.style) {
            readVars(rule.style.cssText);
          }
        }
      }
    } catch (_) {}
    if (document.documentElement.getAttribute("style")) {
      readVars(document.documentElement.getAttribute("style"));
    }

    return { url: location.href, cssVariables, counts, sampledElements: elements.length };
  })()`;
}
