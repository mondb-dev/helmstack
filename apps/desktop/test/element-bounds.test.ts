import { describe, expect, it } from "vitest";

import { correlateRegionsToElements, elementBoundsScript } from "../src/main/element-bounds.js";
import type { DiffRegion, ElementBound } from "../../../packages/shared/src/index.js";

const el = (selector: string, x: number, y: number, width: number, height: number): ElementBound => ({ selector, x, y, width, height });
const region = (x: number, y: number, width: number, height: number): DiffRegion => ({ x, y, width, height });

describe("correlateRegionsToElements", () => {
  const elements = [
    el("body", 0, 0, 1000, 1000),          // huge container
    el("header.top", 0, 0, 1000, 80),      // overlaps top region
    el("button.cta", 100, 100, 120, 40)    // small, specific
  ];

  it("picks the smallest (most specific) element overlapping a region", () => {
    const changed = correlateRegionsToElements([region(110, 110, 10, 10)], elements);
    expect(changed[0].selector).toBe("button.cta");
  });

  it("counts how many regions each element covers and ranks by it", () => {
    const changed = correlateRegionsToElements(
      [region(110, 110, 5, 5), region(150, 110, 5, 5), region(10, 10, 5, 5)],
      elements
    );
    // button.cta covers two regions, header.top one
    expect(changed[0]).toMatchObject({ selector: "button.cta", regions: 2 });
    expect(changed.find((c) => c.selector === "header.top")?.regions).toBe(1);
  });

  it("returns nothing when no element overlaps", () => {
    expect(correlateRegionsToElements([region(5000, 5000, 10, 10)], elements)).toEqual([]);
  });

  it("falls back to a container when no specific element matches", () => {
    const changed = correlateRegionsToElements([region(900, 900, 10, 10)], elements);
    expect(changed[0].selector).toBe("body");
  });
});

describe("elementBoundsScript", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(`return (${elementBoundsScript()});`)).not.toThrow();
  });
});
