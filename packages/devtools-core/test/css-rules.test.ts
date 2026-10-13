import { describe, expect, it } from "vitest";

import { enumerateCssRules, lineColumnAt, matchRuleUsage } from "../src/core/css-rules.js";
import { buildCssCoverageReport, rawStylesheetFromUsage, summarizeStylesheet } from "../src/core/reports/css-coverage.js";

const selectors = (css: string) => enumerateCssRules(css).rules.map((r) => r.selector);
/** The usage range Chrome reports for a style rule: selector start through `}`. */
const usageFor = (css: string, ruleText: string) => {
  const startOffset = css.indexOf(ruleText);
  if (startOffset < 0) throw new Error(`not found: ${ruleText}`);
  return { startOffset, endOffset: startOffset + ruleText.length, used: true };
};

describe("enumerateCssRules", () => {
  it("finds flat rules with exact source ranges", () => {
    const css = "a { color: red; }\n.b, .c > d { margin: 0 }";
    const { rules } = enumerateCssRules(css);
    expect(rules.map((r) => [r.selector, css.slice(r.startOffset, r.endOffset)])).toEqual([
      ["a", "a { color: red; }"],
      [".b, .c > d", ".b, .c > d { margin: 0 }"]
    ]);
  });

  it("ignores braces inside comments, strings, escapes and unquoted url()", () => {
    const css = [
      "/* .fake { color: red } } { */",
      'a::before { content: "} .x { {"; }',
      "b::after { content: '\\'}{' }",
      ".c\\{ { color: blue }",
      "d { background: url(img{1}.png) }",
      "e { color: /* } */ red }"
    ].join("\n");
    expect(selectors(css)).toEqual(["a::before", "b::after", ".c\\{", "d", "e"]);
  });

  it("recurses into nested grouping at-rules but not into keyframes / font-face", () => {
    const css = `
@import url("x.css");
@layer base, theme;
@media (min-width: 600px) { h1 { color: blue } @supports (display: grid) { .grid { display: grid } } }
@layer base { p { color: green } }
@container card (min-width: 1px) { .in-card { padding: 0 } }
@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }
@font-face { font-family: X; src: local(Arial); }
@page :first { margin: 1in }
footer { color: gray }`;
    expect(selectors(css)).toEqual(["h1", ".grid", "p", ".in-card", "footer"]);
    const names = enumerateCssRules(css).atRules.map((a) => a.name);
    expect(names).toEqual(["import", "layer", "media", "supports", "layer", "container", "keyframes", "font-face", "page"]);
  });

  it("enumerates native nesting with parent links and own bytes", () => {
    const css = "main { color: black; h1 { font-size: 10px; } &:hover { color: red; } @media (x) { .deep { a: b } color: blue } padding: 1px; }";
    const { rules } = enumerateCssRules(css);
    expect(rules.map((r) => r.selector)).toEqual(["main", "h1", "&:hover", ".deep"]);
    expect(rules.map((r) => r.parent)).toEqual([-1, 0, 0, 0]);
    const span = (i: number) => rules[i].endOffset - rules[i].startOffset;
    expect(rules[0].ownBytes).toBe(span(0) - span(1) - span(2) - span(3));
    expect(rules[1].ownBytes).toBe(span(1));
  });

  it("treats `prop:value` with a colon-like selector correctly and keeps custom-property blocks as declarations", () => {
    const css = "a { --mixin: { color: red; }; color: blue; b:hover { x: y } }";
    expect(selectors(css)).toEqual(["a", "b:hover"]);
  });

  it("survives unterminated input and stray braces", () => {
    expect(selectors("} a { color: red } b { color: blue")).toEqual(["a", "b"]);
    expect(selectors('a { content: "unterminated }')).toEqual(["a"]);
    expect(selectors("/* never closed a { }")).toEqual([]);
    expect(selectors("")).toEqual([]);
  });
});

describe("matchRuleUsage", () => {
  it("marks rules used by exact start or innermost containment and ignores at-rule ranges", () => {
    const css = "@media (min-width: 1px) { h1 { color: blue } .no { x: y } }\nmain { h2 { a: b } .nope { c: d } padding: 1px; }\n@layer l { p { e: f } }";
    const e = enumerateCssRules(css);
    const usage = [
      usageFor(css, "(min-width: 1px) "), // @media condition — ignored
      usageFor(css, "h1 { color: blue }"),
      usageFor(css, "main { h2 { a: b } .nope { c: d } padding: 1px; }"),
      usageFor(css, "main { h2 { a: b } .nope { c: d } padding: 1px; }"), // duplicate
      usageFor(css, "padding: 1px; "), // nested declarations → parent
      usageFor(css, "h2 { a: b }"),
      usageFor(css, "l { p { e: f } }"), // @layer block — ignored
      { ...usageFor(css, "p { e: f }"), used: true },
      { ...usageFor(css, ".no { x: y }"), used: false } // explicit unused entry
    ];
    const { used, unmatched } = matchRuleUsage(e, usage);
    expect(Object.fromEntries(e.rules.map((r, i) => [r.selector, used[i]]))).toEqual({
      h1: true,
      ".no": false,
      main: true,
      h2: true,
      ".nope": false,
      p: true
    });
    expect(unmatched).toEqual([]);
  });

  it("reports used ranges outside any rule or at-rule as unmatched (deduplicated)", () => {
    const css = "a { b: c }   ";
    const stray = { startOffset: 11, endOffset: 13, used: true };
    expect(matchRuleUsage(enumerateCssRules(css), [stray, stray]).unmatched).toEqual([stray]);
  });
});

describe("rawStylesheetFromUsage + summarizeStylesheet", () => {
  // Mirrors the contract fixture's fixture.css: 5 rules, 2 never match.
  const css = `:root { --brand: rgb(29, 127, 90); --space-md: 16px; }
body { margin: 0; font-family: sans-serif; }
.cta { color: rgb(255, 255, 255); background: var(--brand); padding: var(--space-md); border-radius: 8px; }
.never-used-rule { color: rgb(1, 2, 3); }
.also-never-used > span { outline: 3px dotted red; }
`;
  // Current Chrome lists only used rules.
  const usage = [
    usageFor(css, ":root { --brand: rgb(29, 127, 90); --space-md: 16px; }"),
    usageFor(css, "body { margin: 0; font-family: sans-serif; }"),
    usageFor(css, ".cta { color: rgb(255, 255, 255); background: var(--brand); padding: var(--space-md); border-radius: 8px; }")
  ];

  it("counts never-matched rules as unused and lists them with locations", () => {
    const s = summarizeStylesheet(rawStylesheetFromUsage({ styleSheetId: "s", sourceURL: "http://x/fixture.css", text: css, usage }));
    expect(s).toMatchObject({ status: "measured", ruleCount: 5, usedRuleCount: 3, unusedRuleCount: 2, unusedRulesTruncated: false });
    expect(s.usedPercent).toBeLessThan(100);
    expect(s.unusedBytes).toBe(".never-used-rule { color: rgb(1, 2, 3); }".length + ".also-never-used > span { outline: 3px dotted red; }".length);
    expect(s.unusedRules).toEqual([
      expect.objectContaining({ selector: ".never-used-rule", line: 4, column: 1 }),
      expect.objectContaining({ selector: ".also-never-used > span", line: 5, column: 1 })
    ]);
  });

  it("reports a sheet with no used rules as 0% used rather than omitting it", () => {
    const s = summarizeStylesheet(rawStylesheetFromUsage({ styleSheetId: "i", sourceURL: "", text: ".never{}", usage: [], isInline: true }));
    expect(s).toMatchObject({ ruleCount: 1, usedRuleCount: 0, unusedRuleCount: 1, usedPercent: 0, isInline: true });
  });

  it("does not double count bytes of nested rules", () => {
    const nested = "main { color: red; h1 { x: y } }";
    const s = summarizeStylesheet(rawStylesheetFromUsage({ styleSheetId: "n", sourceURL: "", text: nested, usage: [] }));
    expect(s.ruleBytes).toBe(nested.length);
    expect(s.ruleCount).toBe(2);
  });

  it("keeps unmatched used ranges as extra used rules", () => {
    const s = summarizeStylesheet(
      rawStylesheetFromUsage({ styleSheetId: "u", sourceURL: "", text: "a { b: c }   xyz", usage: [{ startOffset: 13, endOffset: 16, used: true }] })
    );
    expect(s).toMatchObject({ ruleCount: 2, usedRuleCount: 1, unusedRuleCount: 1 });
  });

  it("reports sheets whose text is unavailable as unknown and keeps them out of the totals", () => {
    const unknown = rawStylesheetFromUsage({ styleSheetId: "gone", sourceURL: "http://x/gone.css", text: null, usage: usage });
    const known = rawStylesheetFromUsage({ styleSheetId: "s", sourceURL: "http://x/fixture.css", text: css, usage });
    expect(summarizeStylesheet(unknown)).toMatchObject({ status: "unknown", ruleCount: 0, usedPercent: 0 });
    const report = buildCssCoverageReport({ url: "http://x", stylesheets: [unknown, known] }, "t", 1);
    expect(report.summary).toMatchObject({ stylesheetCount: 2, unknownStylesheetCount: 1, ruleCount: 5, usedRuleCount: 3, unusedRuleCount: 2 });
  });

  it("caps the unusedRules listing", () => {
    const many = Array.from({ length: 250 }, (_, i) => `.r${i} { a: b }`).join("\n");
    const s = summarizeStylesheet(rawStylesheetFromUsage({ styleSheetId: "m", sourceURL: "", text: many, usage: [] }));
    expect(s.unusedRuleCount).toBe(250);
    expect(s.unusedRules).toHaveLength(200);
    expect(s.unusedRulesTruncated).toBe(true);
  });
});

describe("lineColumnAt", () => {
  it("returns 1-based positions", () => {
    expect(lineColumnAt("ab\ncd", 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumnAt("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
});
