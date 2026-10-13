/**
 * Style-rule enumeration and rule-usage matching for CSS coverage.
 *
 * Chrome's `CSS.stopRuleUsageTracking` / `CSS.takeCoverageDelta` only list the
 * rules that were *used*, so the full rule set has to come from the sheet text.
 * CDP has no call that enumerates a stylesheet's rules with source ranges, so
 * this module runs a small CSS tokenizer over `CSS.getStyleSheetText` output.
 *
 * What counts as a rule — matching what Chrome's usage list reports:
 *  - Every style rule (`selector { … }`), at the top level, inside grouping
 *    at-rules (`@media`, `@supports`, `@layer`, `@container`, `@scope`,
 *    `@starting-style`, `@document`), and native-nested inside other style rules.
 *  - NOT at-rules themselves: Chrome reports `@media`/`@supports` conditions and
 *    `@layer` blocks as separate usage ranges, and never reports `@keyframes`,
 *    `@font-face`, `@page`, `@property`, … — those are recorded as `atRules` so
 *    their usage entries can be ignored, and are never counted as rules.
 *  - NOT the implicit "nested declarations" blocks (`main { h1 {} color: red }`)
 *    Chrome reports separately; their bytes and usage belong to the parent rule.
 *
 * Pure — no CDP access — so it is unit-tested directly.
 */

/** One style rule found in a stylesheet's text. */
export type CssRuleSpan = {
  /** Selector text, whitespace-collapsed. */
  selector: string;
  /** Offset of the first selector character. */
  startOffset: number;
  /** Offset just past the closing `}` (or end of text for an unterminated rule). */
  endOffset: number;
  /** Bytes of this rule excluding nested child style rules (no double counting). */
  ownBytes: number;
  /** Index of the enclosing style rule in the result array, or -1 when not nested. */
  parent: number;
};

/** An at-rule found in a stylesheet's text (`@media … { … }`, `@import …;`). */
export type CssAtRuleSpan = {
  name: string;
  startOffset: number;
  endOffset: number;
};

export type CssRuleEnumeration = {
  rules: CssRuleSpan[];
  atRules: CssAtRuleSpan[];
};

/** At-rules whose block holds rules (recursed into); every other block at-rule is skipped. */
const GROUPING_AT_RULES = new Set([
  "media",
  "supports",
  "layer",
  "container",
  "scope",
  "starting-style",
  "document",
  "-moz-document"
]);

type Ctx = "rules" | "style";

/**
 * Enumerate every style rule in `text` with its source range. Tolerates
 * comments, strings and escapes containing braces, unquoted `url(…)`, nested
 * grouping at-rules, native nesting, and unterminated input (rules run to EOF).
 */
export function enumerateCssRules(text: string): CssRuleEnumeration {
  const rules: CssRuleSpan[] = [];
  const atRules: CssAtRuleSpan[] = [];
  const len = text.length;
  let i = 0;

  /** If a comment starts at `i`, return the offset past it; else `i`. */
  const skipComment = (p: number): number => {
    if (text.charCodeAt(p) === 47 /* / */ && text.charCodeAt(p + 1) === 42 /* * */) {
      const end = text.indexOf("*/", p + 2);
      return end === -1 ? len : end + 2;
    }
    return p;
  };

  const skipWsAndComments = (p: number): number => {
    for (;;) {
      while (p < len && /\s/.test(text[p])) p++;
      const q = skipComment(p);
      if (q === p) return p;
      p = q;
    }
  };

  /** Past a string starting at `p` (which holds the quote). */
  const skipString = (p: number): number => {
    const quote = text[p];
    p++;
    while (p < len) {
      const c = text[p];
      if (c === "\\") p += 2;
      else if (c === quote || c === "\n") return p + 1; // newline ends a bad string
      else p++;
    }
    return len;
  };

  /**
   * Advance one "atomic" token from `p`: a comment, string, escape, or unquoted
   * `url(…)` is skipped whole; anything else is one character.
   */
  const step = (p: number): number => {
    const c = text[p];
    if (c === "/") {
      const q = skipComment(p);
      if (q !== p) return q;
    }
    if (c === '"' || c === "'") return skipString(p);
    if (c === "\\") return Math.min(len, p + 2);
    if ((c === "u" || c === "U") && /^url\(\s*[^"'\s)]/i.test(text.slice(p, p + 64)) && !/[\w-]/.test(text[p - 1] ?? "")) {
      const close = text.indexOf(")", p + 4);
      return close === -1 ? len : close + 1;
    }
    return p + 1;
  };

  /**
   * Scan from `p` until one of `stops` at paren/bracket depth 0. Returns the
   * offset of the stop char (or `len`).
   */
  const scanUntil = (p: number, stops: string): number => {
    let depth = 0;
    while (p < len) {
      const c = text[p];
      if (depth === 0 && stops.includes(c)) return p;
      if (c === "(" || c === "[") depth++;
      else if ((c === ")" || c === "]") && depth > 0) depth--;
      else if (c === "}" && depth > 0) return p; // a stray close brace always ends the scan
      p = step(p);
    }
    return len;
  };

  /** `p` is at `{`; return the offset past its matching `}`. */
  const skipBlock = (p: number): number => {
    let depth = 0;
    while (p < len) {
      const c = text[p];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return p + 1;
      }
      p = step(p);
    }
    return len;
  };

  const collapse = (s: string): string =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ")
      .trim();

  /**
   * Parse block contents from `i` until the closing `}` (consumed) or EOF.
   * `parent` is the enclosing style rule index (-1 at top level) — used both for
   * the nesting link and to decide whether `;` can end an item.
   */
  const parseContents = (ctx: Ctx, parent: number): void => {
    while (i < len) {
      i = skipWsAndComments(i);
      if (i >= len) return;
      const c = text[i];
      if (c === "}") {
        i++;
        return;
      }
      if (c === ";") {
        i++;
        continue;
      }
      // Legacy HTML comment tokens at the top level are ignored by CSS.
      if (ctx === "rules" && parent === -1 && (text.startsWith("<!--", i) || text.startsWith("-->", i))) {
        i += text.startsWith("<!--", i) ? 4 : 3;
        continue;
      }
      const start = i;

      if (c === "@") {
        const m = /^@(-?[\w-]+)/.exec(text.slice(i, i + 64));
        const name = (m?.[1] ?? "").toLowerCase();
        const stop = scanUntil(i + 1, "{;}");
        if (stop >= len || text[stop] !== "{") {
          // Statement at-rule (`@import …;`, `@layer a, b;`) or unterminated.
          i = stop < len && text[stop] === ";" ? stop + 1 : stop;
          atRules.push({ name, startOffset: start, endOffset: i });
          continue;
        }
        const at: CssAtRuleSpan = { name, startOffset: start, endOffset: len };
        atRules.push(at);
        if (GROUPING_AT_RULES.has(name)) {
          i = stop + 1;
          // Inside a style rule, a grouping rule holds declarations + nested rules.
          parseContents(parent === -1 ? "rules" : "style", parent);
        } else {
          i = skipBlock(stop);
        }
        at.endOffset = i;
        continue;
      }

      if (ctx === "style") {
        // Custom properties may hold `{}` blocks; they are always declarations.
        if (/^--[\w-]*\s*:/.test(text.slice(i, i + 256))) {
          let p = i;
          let depth = 0;
          while (p < len) {
            const ch = text[p];
            if (ch === "{" || ch === "(" || ch === "[") depth++;
            else if ((ch === "}" || ch === ")" || ch === "]") && depth > 0) depth--;
            else if (depth === 0 && (ch === ";" || ch === "}")) break;
            p = step(p);
          }
          i = p < len && text[p] === ";" ? p + 1 : p;
          continue;
        }
        const stop = scanUntil(i, "{;}");
        if (stop >= len || text[stop] !== "{") {
          // A plain declaration.
          i = stop < len && text[stop] === ";" ? stop + 1 : stop;
          continue;
        }
        // Otherwise it is a nested style rule — fall through.
      }

      // Qualified (style) rule. At the top level `;` does not end the prelude.
      const stop = scanUntil(i, ctx === "rules" && parent === -1 ? "{}" : "{;}");
      if (stop >= len || text[stop] !== "{") {
        // Invalid prelude with no block: drop it like a browser would.
        i = stop < len && text[stop] === ";" ? stop + 1 : stop;
        continue;
      }
      const index = rules.length;
      rules.push({ selector: collapse(text.slice(start, stop)), startOffset: start, endOffset: len, ownBytes: 0, parent });
      i = stop + 1;
      parseContents("style", index);
      rules[index].endOffset = i;
    }
  };

  // The top level is a rule list; a stray `}` there is just skipped.
  while (i < len) {
    parseContents("rules", -1);
  }

  // Own bytes: span minus the spans of direct child style rules.
  for (const r of rules) r.ownBytes = r.endOffset - r.startOffset;
  for (const r of rules) {
    if (r.parent >= 0) rules[r.parent].ownBytes -= r.endOffset - r.startOffset;
  }
  return { rules, atRules };
}

/** One CDP `RuleUsage` entry for a stylesheet (offsets into the sheet text). */
export type RuleUsageRange = {
  startOffset: number;
  endOffset: number;
  used: boolean;
};

export type MatchedRuleUsage = {
  /** Parallel to `rules`: whether each rule was used. */
  used: boolean[];
  /**
   * Used ranges that matched no enumerated rule and no at-rule (a tokenizer
   * miss). Reported as extra used rules so coverage is never understated.
   */
  unmatched: RuleUsageRange[];
};

/**
 * Match usage ranges to enumerated rules by offset containment.
 *
 * A range marks a rule used when it starts exactly at that rule (Chrome's
 * style-rule ranges run from the selector to the closing brace), or otherwise
 * when that rule is the innermost one containing it (nested-declarations
 * blocks). Ranges lying in an at-rule but in no style rule — `@media`
 * conditions, `@layer` blocks, `@keyframes` — are ignored. Duplicates are fine.
 */
export function matchRuleUsage(enumeration: CssRuleEnumeration, usage: readonly RuleUsageRange[]): MatchedRuleUsage {
  const { rules, atRules } = enumeration;
  const used = rules.map(() => false);
  const unmatched: RuleUsageRange[] = [];
  const byStart = new Map<number, number>();
  rules.forEach((r, idx) => byStart.set(r.startOffset, idx));
  const seenUnmatched = new Set<string>();

  for (const u of usage) {
    if (!u.used) continue;
    const exact = byStart.get(u.startOffset);
    if (exact !== undefined) {
      used[exact] = true;
      continue;
    }
    let innermost = -1;
    for (let idx = 0; idx < rules.length; idx++) {
      const r = rules[idx];
      if (r.startOffset <= u.startOffset && u.endOffset <= r.endOffset) {
        if (innermost === -1 || r.startOffset >= rules[innermost].startOffset) innermost = idx;
      }
    }
    if (innermost !== -1) {
      used[innermost] = true;
      continue;
    }
    if (atRules.some((a) => a.startOffset <= u.startOffset && u.endOffset <= a.endOffset)) continue;
    const key = `${u.startOffset}:${u.endOffset}`;
    if (!seenUnmatched.has(key)) {
      seenUnmatched.add(key);
      unmatched.push(u);
    }
  }
  return { used, unmatched };
}

/** 1-based line and column of `offset` within `text`. */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let p = 0; p < end; p++) {
    if (text.charCodeAt(p) === 10) {
      line++;
      lineStart = p + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}
