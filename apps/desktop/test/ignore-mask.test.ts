import { describe, expect, it } from "vitest";

import { buildIgnoreMask } from "../src/main/pixel-compare.js";
import type { DiffRegion } from "../../../packages/shared/src/index.js";

function setPixels(mask: Uint8Array, width: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) out.push([i % width, Math.floor(i / width)]);
  return out;
}

describe("buildIgnoreMask", () => {
  it("marks exactly the pixels inside a rectangle", () => {
    const mask = buildIgnoreMask([{ x: 1, y: 1, width: 2, height: 2 }], 5, 5);
    expect(setPixels(mask, 5).sort()).toEqual([
      [1, 1], [2, 1],
      [1, 2], [2, 2]
    ].sort());
  });

  it("clamps rectangles to the image bounds", () => {
    const mask = buildIgnoreMask([{ x: -2, y: -2, width: 4, height: 4 }], 3, 3);
    // Only the in-bounds portion (0,0)-(1,1) is marked.
    expect(setPixels(mask, 3).sort()).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]].sort());
  });

  it("unions multiple regions and leaves the rest clear", () => {
    const regions: DiffRegion[] = [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 4, y: 4, width: 1, height: 1 }
    ];
    const mask = buildIgnoreMask(regions, 5, 5);
    expect(mask[0]).toBe(1);
    expect(mask[24]).toBe(1); // (4,4)
    expect(mask[12]).toBe(0); // (2,2) untouched
    expect(setPixels(mask, 5)).toHaveLength(2);
  });

  it("returns an all-clear mask for no regions", () => {
    expect(buildIgnoreMask([], 4, 4).some((v) => v === 1)).toBe(false);
  });
});
