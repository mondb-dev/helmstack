import { describe, expect, it } from "vitest";

import { buildA11yReport, type A11yReportInput, type RawAxNode } from "../src/main/a11y-audit.js";

function node(partial: Partial<RawAxNode>): RawAxNode {
  return { nodeId: "n", backendDOMNodeId: 1, ...partial };
}

function input(over: Partial<A11yReportInput>): A11yReportInput {
  return {
    nodes: [],
    pageLang: "en",
    pageTitle: "A page",
    scoped: false,
    url: "https://example.com",
    tabId: "tab-1",
    capturedAt: 1000,
    ...over
  };
}

describe("buildA11yReport — page-level rules", () => {
  it("flags missing lang and empty title on a full-page audit", () => {
    const r = buildA11yReport(input({ pageLang: null, pageTitle: "" }));
    const rules = r.violations.map((v) => v.rule).sort();
    expect(rules).toEqual(["2.4.2-page-title", "3.1.1-page-lang"]);
  });

  it("does NOT apply page-level rules when scoped to a subtree", () => {
    const r = buildA11yReport(input({ pageLang: null, pageTitle: "", scoped: true, selector: "#widget", nodes: [node({ role: { value: "button" }, name: { value: "Save" } })] }));
    expect(r.violations.find((v) => v.rule === "3.1.1-page-lang")).toBeUndefined();
    expect(r.violations.find((v) => v.rule === "2.4.2-page-title")).toBeUndefined();
    expect(r.selector).toBe("#widget");
  });

  it("notes when a scoped selector matched no elements", () => {
    const r = buildA11yReport(input({ scoped: true, selector: ".missing", nodes: [] }));
    expect(r.nodeCount).toBe(0);
    expect(r.recommendations[0]).toContain(".missing");
    expect(r.recommendations[0]).toContain("matched no accessible");
  });

  it("omits the selector field on a full-page audit", () => {
    const r = buildA11yReport(input({}));
    expect(r.selector).toBeUndefined();
  });
});

describe("buildA11yReport — per-node rules", () => {
  it("flags an image with no accessible name (1.1.1, critical)", () => {
    const r = buildA11yReport(input({ nodes: [node({ role: { value: "img" }, name: { value: "" } })] }));
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ rule: "1.1.1-image-alt", impact: "critical" });
    expect(r.violationCounts.critical).toBe(1);
    expect(r.score).toBe(92); // 100 - 8 (one critical)
  });

  it("flags an unlabelled button and counts a labelled one as a pass", () => {
    const r = buildA11yReport(input({
      nodes: [
        node({ nodeId: "a", role: { value: "button" }, name: { value: "" } }),
        node({ nodeId: "b", role: { value: "button" }, name: { value: "Submit" } })
      ]
    }));
    expect(r.violations.map((v) => v.rule)).toEqual(["2.4.6-button-label"]);
    expect(r.passes).toBe(1);
  });

  it("flags a skipped heading level (h1 → h3)", () => {
    const r = buildA11yReport(input({
      nodes: [
        node({ nodeId: "h1", role: { value: "heading" }, name: { value: "Title" }, properties: [{ name: "level", value: { value: 1 } }] }),
        node({ nodeId: "h3", role: { value: "heading" }, name: { value: "Sub" }, properties: [{ name: "level", value: { value: 3 } }] })
      ]
    }));
    expect(r.violations.map((v) => v.rule)).toEqual(["2.4.3-heading-order"]);
  });

  it("flags ambiguous link text (2.4.4)", () => {
    const r = buildA11yReport(input({ nodes: [node({ role: { value: "link" }, name: { value: "click here" } })] }));
    expect(r.violations.map((v) => v.rule)).toEqual(["2.4.4-link-purpose"]);
  });

  it("skips ignored nodes", () => {
    const r = buildA11yReport(input({ nodes: [node({ role: { value: "img" }, name: { value: "" }, ignored: true })] }));
    expect(r.violations).toHaveLength(0);
    expect(r.nodeCount).toBe(1);
  });
});
