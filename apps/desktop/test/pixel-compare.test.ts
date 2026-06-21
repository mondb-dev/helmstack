import { describe, expect, it } from "vitest";

import { colorDelta, comparePixels } from "../src/main/pixel-compare.js";

/** Build a BGRA buffer from [b,g,r,a] tuples. */
function bgra(pixels: Array<[number, number, number, number]>): Uint8Array {
  const buf = new Uint8Array(pixels.length * 4);
  pixels.forEach(([b, g, r, a], i) => { buf[i * 4] = b; buf[i * 4 + 1] = g; buf[i * 4 + 2] = r; buf[i * 4 + 3] = a; });
  return buf;
}

const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const NEAR_BLACK: [number, number, number, number] = [3, 3, 3, 255]; // sub-pixel noise

describe("colorDelta", () => {
  it("is 0 for identical pixels", () => {
    const a = bgra([BLACK]); const b = bgra([BLACK]);
    expect(colorDelta(a, b, 0)).toBe(0);
  });

  it("is large for black vs white", () => {
    const a = bgra([BLACK]); const b = bgra([WHITE]);
    expect(colorDelta(a, b, 0)).toBeGreaterThan(30000);
  });

  it("is small for near-identical pixels (anti-aliasing noise)", () => {
    const a = bgra([BLACK]); const b = bgra([NEAR_BLACK]);
    expect(colorDelta(a, b, 0)).toBeLessThan(50);
  });
});

describe("comparePixels", () => {
  it("reports no change for identical buffers", () => {
    const a = bgra([BLACK, WHITE]); const b = bgra([BLACK, WHITE]);
    expect(comparePixels(a, b, 2, 1).diffCount).toBe(0);
  });

  it("flags a hard color change", () => {
    const a = bgra([BLACK, BLACK]); const b = bgra([BLACK, WHITE]);
    const r = comparePixels(a, b, 2, 1);
    expect(r.diffCount).toBe(1);
    expect([...r.changed]).toEqual([0, 1]);
  });

  it("ignores sub-threshold anti-aliasing noise that ±10 per-channel would miss too", () => {
    const a = bgra([BLACK]); const b = bgra([NEAR_BLACK]);
    expect(comparePixels(a, b, 1, 1).diffCount).toBe(0);
  });

  it("a higher threshold tolerates more difference", () => {
    const a = bgra([BLACK]); const b = bgra([[120, 120, 120, 255]]); // mid-grey
    expect(comparePixels(a, b, 1, 1, { threshold: 0.1 }).diffCount).toBe(1);
    expect(comparePixels(a, b, 1, 1, { threshold: 0.9 }).diffCount).toBe(0);
  });

  it("skips pixels in the ignore mask", () => {
    const a = bgra([BLACK, BLACK]); const b = bgra([WHITE, WHITE]);
    const mask = new Uint8Array([1, 0]); // ignore pixel 0
    expect(comparePixels(a, b, 2, 1, { ignoreMask: mask }).diffCount).toBe(1);
  });
});
