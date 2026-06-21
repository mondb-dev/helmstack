import { describe, expect, it, vi } from "vitest";

// tab-manager imports electron at module scope (only used inside methods); a
// stub lets us import and test its pure module-level functions.
vi.mock("electron", () => ({ BrowserWindow: class {}, nativeImage: {}, WebContentsView: class {} }));

import {
  computeDiffRegions,
  computePerceptionDiff,
  evaluateAssertionAgainstGraph,
  evaluateStyleAssertion,
  matchesMockRule
} from "../src/main/tab-manager.js";
import type {
  ElementStyleInspection,
  PageGraph,
  StyleAssertion
} from "../../../packages/shared/src/index.js";

function graph(overrides: Partial<PageGraph> = {}): PageGraph {
  return {
    tabId: "t",
    url: "https://example.com/",
    title: "Home",
    kind: "landing",
    headings: [],
    forms: [],
    actions: [],
    alerts: [],
    media: [],
    oauthProviders: [],
    accessibility: { nodeCount: 0, roleCounts: {}, headingTrail: [], interactiveNodes: [] },
    signals: { documentCount: 1, accessibilityNodeCount: 0, formCount: 0, actionCount: 0, capturedAt: 0 },
    ...overrides
  };
}

describe("evaluateAssertionAgainstGraph (NL assertion heuristics)", () => {
  it("counts elements quantitatively", () => {
    const g = graph({
      actions: [
        { id: "a1", label: "Save", kind: "button", selectorHint: "button", disabled: false },
        { id: "a2", label: "Submit", kind: "submit", selectorHint: "button", disabled: false }
      ]
    });
    expect(evaluateAssertionAgainstGraph("t", "2 buttons", g).pass).toBe(true);
    expect(evaluateAssertionAgainstGraph("t", "3 buttons", g).pass).toBe(false);
  });

  it("detects absence by substring (subject not present on the page)", () => {
    // The absence heuristic confirms when the subject phrase is absent from page text.
    expect(evaluateAssertionAgainstGraph("t", "no errors", graph()).pass).toBe(true);
    const withError = graph({ alerts: ["3 errors occurred"] });
    expect(evaluateAssertionAgainstGraph("t", "no errors", withError).pass).toBe(false);
  });

  it("checks the page title", () => {
    const g = graph({ title: "Dashboard" });
    expect(evaluateAssertionAgainstGraph("t", "the page title is 'Dashboard'", g).pass).toBe(true);
    expect(evaluateAssertionAgainstGraph("t", "the page title is 'Settings'", g).pass).toBe(false);
  });

  it("returns evidence with the assertion", () => {
    const result = evaluateAssertionAgainstGraph("t", "anything", graph({ headings: ["A", "B"] }));
    expect(result.evidence.counts.headings).toBe(2);
    expect(result.assertion).toBe("anything");
  });
});

describe("evaluateStyleAssertion", () => {
  const el: ElementStyleInspection = {
    index: 0,
    selectorHint: ".btn",
    computed: { "background-color": "rgb(37, 99, 235)", "border-radius": "8px", "font-weight": "600" },
    box: { margin: { top: 0, right: 0, bottom: 0, left: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, border: { top: 0, right: 0, bottom: 0, left: 0 } },
    bounds: { x: 0, y: 0, width: 10, height: 10, top: 0, right: 10, bottom: 10, left: 0 },
    issues: []
  } as unknown as ElementStyleInspection;

  const check = (a: StyleAssertion) => evaluateStyleAssertion(el, a);

  it("passes a numeric min and fails below it", () => {
    expect(check({ property: "border-radius", min: 6 }).pass).toBe(true);
    expect(check({ property: "border-radius", min: 10 }).pass).toBe(false);
  });

  it("compares colors via canonical equality", () => {
    expect(check({ property: "background-color", equals: "rgb(37, 99, 235)" }).pass).toBe(true);
  });

  it("supports contains and not", () => {
    expect(check({ property: "background-color", contains: "235" }).pass).toBe(true);
    expect(check({ property: "font-weight", not: "400" }).pass).toBe(true);
  });

  it("fails when the property was not captured", () => {
    expect(check({ property: "color", equals: "red" }).pass).toBe(false);
  });
});

describe("computePerceptionDiff", () => {
  const wrap = (g: PageGraph) => ({ graph: g, url: g.url, title: g.title, capturedAt: 0 });

  it("reports a clean diff for identical graphs", () => {
    const g = graph({ headings: ["Welcome"] });
    const diff = computePerceptionDiff("a", "b", wrap(g), wrap(g));
    expect(diff.identical).toBe(true);
    expect(diff.changes).toHaveLength(0);
  });

  it("detects added/removed headings and a title change", () => {
    const before = graph({ title: "Login", headings: ["Sign in"] });
    const after = graph({ title: "Dashboard", headings: ["Overview"] });
    const diff = computePerceptionDiff("a", "b", wrap(before), wrap(after));
    const kinds = diff.changes.map((c) => c.kind);
    expect(kinds).toContain("title_changed");
    expect(kinds).toContain("heading_removed");
    expect(kinds).toContain("heading_added");
    expect(diff.identical).toBe(false);
  });
});

describe("computeDiffRegions", () => {
  it("merges nearby changed pixels into one box and keeps distant ones separate", () => {
    const w = 40;
    const h = 40;
    const changed = new Uint8Array(w * h);
    changed[0 * w + 0] = 1;   // cluster A
    changed[1 * w + 1] = 1;   // within MERGE_GAP of A
    changed[35 * w + 35] = 1; // far away → cluster B
    const regions = computeDiffRegions(changed, w, h);
    expect(regions).toHaveLength(2);
  });
});

describe("matchesMockRule", () => {
  it("matches glob wildcards and respects method", () => {
    expect(matchesMockRule("https://x/api/products?id=1", "GET", { urlPattern: "*/api/products*" })).toBe(true);
    expect(matchesMockRule("https://x/api/users", "GET", { urlPattern: "*/api/products*" })).toBe(false);
    expect(matchesMockRule("https://x/api/p", "POST", { urlPattern: "*/api/p", method: "GET" })).toBe(false);
  });

  it("matches /regex/flags patterns", () => {
    expect(matchesMockRule("https://x/api/v2/items", "GET", { urlPattern: "/\\/api\\/v\\d+\\//i" })).toBe(true);
  });
});
