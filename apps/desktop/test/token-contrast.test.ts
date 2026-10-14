/**
 * WCAG contrast of status text tokens against the surfaces they sit on,
 * computed straight from styles/tokens.css for both themes. Tinted
 * backgrounds (`--color-*-subtle`, rgba) are composited over their base
 * surface first, exactly as the browser paints them.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync("apps/desktop/src/renderer/styles/tokens.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Theme = "dark" | "light";
type RGBA = [number, number, number, number];

function declarations(block: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(match[1], match[2].trim());
  return vars;
}

function block(selectorPattern: RegExp): string {
  const match = css.match(selectorPattern);
  if (!match) throw new Error(`tokens.css block not found: ${selectorPattern}`);
  return match[1];
}

const primitives = declarations(block(/:root\s*\{([^}]*)\}/));
const themes: Record<Theme, Map<string, string>> = {
  dark: declarations(block(/:root,\s*:root\[data-theme="dark"\]\s*\{([^}]*)\}/)),
  light: declarations(block(/:root\[data-theme="light"\]\s*\{([^}]*)\}/)),
};

function resolve(theme: Theme, name: string, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle at ${name}`);
  const raw = themes[theme].get(name) ?? primitives.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined for ${theme}`);
  const ref = raw.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(theme, ref[1], depth + 1) : raw;
}

function parseColor(value: string): RGBA {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`Unsupported colour: ${value}`);
}

function over(top: RGBA, base: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + base[i] * (1 - a)).concat(1) as RGBA;
}

function luminance([r, g, b]: RGBA): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast of `text` on `tint` (optional) composited over the opaque `surface`. */
function contrast(theme: Theme, text: string, surface: string, tint?: string): number {
  let bg = parseColor(resolve(theme, surface));
  if (tint) bg = over(parseColor(resolve(theme, tint)), bg);
  const fg = over(parseColor(resolve(theme, text)), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** [what, text token, surface token, tint token?, minimum ratio] — all small text, so AA 4.5:1. */
const PAIRS: Array<[string, string, string, string | undefined, number]> = [
  ["Override chip (warning)", "--color-warning-text", "--color-surface-sunken", "--color-warning-subtle", 4.5],
  ["Override chip (failing)", "--color-danger-text", "--color-surface-sunken", "--color-danger-subtle", 4.5],
  ['"Approval needed:" lead', "--color-warning-text", "--color-bg", "--color-warning-subtle", 4.5],
  ['"Overrides" strip title', "--color-text-tertiary", "--color-surface-sunken", undefined, 4.5],
  ["Badge (warning) on a dialog", "--color-warning-text", "--color-surface-raised", "--color-warning-subtle", 4.5],
  ["Badge / button (danger) on a dialog", "--color-danger-text", "--color-surface-raised", "--color-danger-subtle", 4.5],
  ['"Agent API off" indicator', "--color-danger-text", "--color-surface-sunken", undefined, 4.5],
  ["Pending activity summary", "--color-warning-text", "--color-surface", undefined, 4.5],
  ["Failed activity summary / inline error", "--color-danger-text", "--color-surface", undefined, 4.5],
  ["Popover status (danger) on overlay surface", "--color-danger-text", "--color-surface-overlay", undefined, 4.5],
];

describe("status text token contrast (WCAG AA)", () => {
  for (const theme of ["light", "dark"] as const) {
    describe(`${theme} theme`, () => {
      for (const [what, text, surface, tint, min] of PAIRS) {
        it(`${what}: ${text} on ${tint ? `${tint} over ` : ""}${surface} ≥ ${min}:1`, () => {
          expect(contrast(theme, text, surface, tint)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it("lifts the dark failing chip clearly above the 4.5:1 line (was 4.49:1)", () => {
    expect(contrast("dark", "--color-danger-text", "--color-surface-sunken", "--color-danger-subtle")).toBeGreaterThanOrEqual(5);
  });

  it("reproduces the QA measurements for the old light-theme pairings", () => {
    // Sanity check of the maths: the raw status colours on tints are what failed QA.
    expect(contrast("light", "--color-warning", "--color-surface-sunken", "--color-warning-subtle")).toBeCloseTo(2.7, 1);
    expect(contrast("light", "--color-danger", "--color-surface-sunken", "--color-danger-subtle")).toBeCloseTo(3.78, 1);
    expect(contrast("light", "--color-warning", "--color-bg", "--color-warning-subtle")).toBeCloseTo(2.88, 1);
  });
});
