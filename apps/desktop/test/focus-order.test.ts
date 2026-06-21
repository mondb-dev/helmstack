import { describe, expect, it } from "vitest";

import { analyzeFocusOrder, focusableElementsScript } from "../src/main/focus-order.js";
import type { FocusableElement } from "../../../packages/shared/src/index.js";

const fe = (selector: string, x: number, y: number, tabindex = 0): FocusableElement => ({
  selector, tabindex, x, y, width: 80, height: 30
});

const run = (elements: FocusableElement[]) => analyzeFocusOrder({ url: "https://example.com/", elements }, "t", 0);

describe("analyzeFocusOrder", () => {
  it("reports no issues for top-to-bottom DOM order matching layout", () => {
    const report = run([fe("a.one", 0, 0), fe("a.two", 0, 40), fe("a.three", 0, 80)]);
    expect(report.focusableCount).toBe(3);
    expect(report.issues).toHaveLength(0);
    expect(report.order).toEqual(["a.one", "a.two", "a.three"]);
  });

  it("flags positive tabindex and puts it first in tab order", () => {
    const report = run([fe("a.normal", 0, 0), fe("a.hijack", 0, 200, 5)]);
    expect(report.positiveTabindexCount).toBe(1);
    expect(report.issues.some((i) => i.kind === "positive_tabindex" && i.selector === "a.hijack")).toBe(true);
    expect(report.order[0]).toBe("a.hijack"); // positive tabindex focuses first
  });

  it("flags a reading-order jump when tab order goes to an element above", () => {
    // DOM order: bottom element then top element → tab moves upward
    const report = run([fe("a.bottom", 0, 300), fe("a.top", 0, 0)]);
    expect(report.issues.some((i) => i.kind === "reading_order_jump" && i.selector === "a.top")).toBe(true);
  });

  it("flags a backwards jump on the same row", () => {
    const report = run([fe("a.right", 400, 0), fe("a.left", 0, 0)]);
    expect(report.issues.some((i) => i.kind === "reading_order_jump" && i.selector === "a.left")).toBe(true);
  });
});

describe("focusableElementsScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return (${focusableElementsScript()});`)).not.toThrow();
  });
});
