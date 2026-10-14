/**
 * The address bar must show the styleguide focus ring (base.css :focus-visible:
 * 2px solid accent outline, 2px offset). jsdom can't evaluate :focus-visible,
 * so this checks the stylesheet rules that produce it.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const base = strip(readFileSync("apps/desktop/src/renderer/styles/base.css", "utf8"));
const layout = strip(readFileSync("apps/desktop/src/renderer/styles/layout.css", "utf8"));

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Rule not found: ${selector}`);
  return match[1];
}

const outline = (body: string) => body.match(/outline:\s*([^;]+);/)?.[1].trim();
const offset = (body: string) => body.match(/outline-offset:\s*([^;]+);/)?.[1].trim();

describe("address bar focus ring", () => {
  it("matches the global :focus-visible spec", () => {
    const spec = rule(base, ":focus-visible");
    const input = rule(layout, ".nav-input:focus-visible");
    expect(outline(input)).toBe(outline(spec));
    expect(offset(input)).toBe(offset(spec));
    expect(outline(input)).toBe("2px solid var(--color-accent)");
  });

  it("doesn't suppress the outline on the base rule", () => {
    expect(rule(layout, ".nav-input")).not.toMatch(/outline:\s*none/);
    expect(rule(layout, ".nav-input:focus")).not.toMatch(/outline:\s*none/);
  });
});
