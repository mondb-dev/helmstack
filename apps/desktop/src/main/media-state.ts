import type { MediaStateReport, TabId } from "../../../../packages/shared/src/index.js";

/** Raw media-state payload returned by the in-page collector script. */
export type MediaStateRaw = {
  url: string;
  features: Record<string, string>;
  viewport: { width: number; height: number };
  mediaQueries: Array<{ query: string; matches: boolean }>;
};

/**
 * Assemble a MediaStateReport from raw collector output: sort the media-query
 * list (matching first, then alphabetical) for stable, readable output. Pure —
 * unit-testable without a DOM.
 */
export function buildMediaStateReport(raw: MediaStateRaw, tabId: TabId, capturedAt: number): MediaStateReport {
  const mediaQueries = [...raw.mediaQueries].sort(
    (a, b) => Number(b.matches) - Number(a.matches) || a.query.localeCompare(b.query)
  );
  return {
    tabId,
    url: raw.url,
    capturedAt,
    features: raw.features,
    viewport: raw.viewport,
    mediaQueries
  };
}

/**
 * In-page collector. Returns a string evaluating to a `MediaStateRaw`. Resolves
 * common media features via `matchMedia` and walks stylesheet `@media` rules
 * (cross-origin-safe) to report which currently match.
 */
export function mediaStateCollectorScript(): string {
  return `(() => {
    const FEATURE_QUERIES = {
      "prefers-color-scheme": ["light", "dark"],
      "prefers-reduced-motion": ["reduce", "no-preference"],
      "prefers-contrast": ["more", "less", "no-preference"],
      "forced-colors": ["active", "none"],
      "pointer": ["coarse", "fine", "none"],
      "hover": ["hover", "none"],
      "orientation": ["portrait", "landscape"]
    };

    const features = {};
    for (const [feature, values] of Object.entries(FEATURE_QUERIES)) {
      for (const value of values) {
        try {
          if (matchMedia("(" + feature + ": " + value + ")").matches) {
            features[feature] = value;
            break;
          }
        } catch (_) {}
      }
    }

    const seen = new Set();
    const mediaQueries = [];
    const addQuery = (text) => {
      if (!text) return;
      const q = String(text).trim();
      if (!q || seen.has(q)) return;
      seen.add(q);
      let matches = false;
      try { matches = matchMedia(q).matches; } catch (_) {}
      mediaQueries.push({ query: q, matches });
    };

    const walkRules = (rules) => {
      for (const rule of Array.from(rules || [])) {
        if (rule.type === CSSRule.MEDIA_RULE) {
          addQuery(rule.media && rule.media.mediaText);
          if (rule.cssRules) walkRules(rule.cssRules);
        } else if (rule.cssRules) {
          walkRules(rule.cssRules);
        }
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        if (sheet.media && sheet.media.mediaText) addQuery(sheet.media.mediaText);
        walkRules(sheet.cssRules);
      } catch (_) { continue; }
    }

    return {
      url: location.href,
      features,
      viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      mediaQueries
    };
  })()`;
}
