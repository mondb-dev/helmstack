import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodePngToBgra, encodeBgraToPng, VisualDiffStore } from "../src/core/stores/visual-diff-store.js";
import type { PageScreenshot } from "../../shared/src/index.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function shot(tabId: string): PageScreenshot {
  return { tabId, capturedAt: 123, data: PNG_1X1, mimeType: "image/png", width: 1, height: 1 };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "helmstack-visualdiff-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("VisualDiffStore", () => {
  it("puts and gets a screenshot from the cache", () => {
    const store = new VisualDiffStore(dir);
    expect(store.get("a")).toBeUndefined();
    store.put("a", shot("tab-1"));
    expect(store.get("a")?.tabId).toBe("tab-1");
    expect([...store.entries()].map(([id]) => id)).toEqual(["a"]);
  });

  it("persists to disk by default — a fresh store rehydrates it", () => {
    new VisualDiffStore(dir).put("baseline", shot("tab-1"));
    const reopened = new VisualDiffStore(dir);
    expect(reopened.get("baseline")?.tabId).toBe("tab-1");
  });

  it("persist:false keeps it in memory only (not rehydrated)", () => {
    const store = new VisualDiffStore(dir);
    store.put("transient", shot("tab-1"), false);
    expect(store.get("transient")).toBeDefined();          // in this instance's cache
    expect(new VisualDiffStore(dir).get("transient")).toBeUndefined(); // not on disk
  });

  it("remove() deletes from cache and disk, reporting prior existence", () => {
    const store = new VisualDiffStore(dir);
    store.put("x", shot("tab-1"));
    expect(store.remove("x")).toBe(true);
    expect(store.get("x")).toBeUndefined();
    expect(new VisualDiffStore(dir).get("x")).toBeUndefined(); // gone from disk too
    expect(store.remove("missing")).toBe(false);
  });

});

type Rgba = [number, number, number, number];

/** Encode an opaque-by-default RGBA image as a base64 PNG screenshot. */
function pngShot(width: number, height: number, pixel: (x: number, y: number) => Rgba): PageScreenshot {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      png.data.set(pixel(x, y), (y * width + x) * 4);
    }
  }
  const data = PNG.sync.write(png).toString("base64");
  return { tabId: "tab-1", capturedAt: 1, data, mimeType: "image/png", width, height };
}

const GREY: Rgba = [100, 120, 140, 255];

function rgbaAt(base64Png: string, x: number, y: number): Rgba {
  const png = PNG.sync.read(Buffer.from(base64Png, "base64"));
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

describe("VisualDiffStore.diff (real PNG decode via pngjs)", () => {
  it("decodes PNG RGBA into the BGRA layout pixel-compare expects, and round-trips", () => {
    const red = pngShot(1, 1, () => [255, 0, 0, 255]);
    const bgra = decodePngToBgra(red.data);
    expect([...bgra.data]).toEqual([0, 0, 255, 255]);
    expect(rgbaAt(encodeBgraToPng(bgra.data, 1, 1).toString("base64"), 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it("identical captures → 0 changed pixels, no regions", () => {
    const store = new VisualDiffStore(dir);
    store.put("a", pngShot(8, 6, () => GREY), false);
    store.put("b", pngShot(8, 6, () => GREY), false);
    const d = store.diff("a", "b");
    expect(d).toMatchObject({ diffPixelCount: 0, diffPercentage: 0, totalPixels: 48, width: 8, height: 6, diffRegions: [] });
    expect(rgbaAt(d.diffImageData!, 0, 0)).toEqual(GREY);
  });

  it("counts changed pixels, finds the region and tints it red in the diff image", () => {
    const store = new VisualDiffStore(dir);
    store.put("before", pngShot(10, 10, () => GREY), false);
    // 2×2 block at (3,4) turns blue; one pixel at (9,9) moves by only 5 (under the ±10 tolerance).
    store.put("after", pngShot(10, 10, (x, y) =>
      x >= 3 && x <= 4 && y >= 4 && y <= 5 ? [0, 0, 255, 255] : x === 9 && y === 9 ? [105, 120, 140, 255] : GREY), false);

    const d = store.diff("before", "after");
    expect(d.diffPixelCount).toBe(4);
    expect(d.diffPercentage).toBe(4);
    expect(d.diffRegions).toHaveLength(1);
    const [r] = d.diffRegions;
    expect(r.x).toBeLessThanOrEqual(3);
    expect(r.y).toBeLessThanOrEqual(4);
    expect(r.x + r.width).toBeGreaterThanOrEqual(5);
    expect(r.y + r.height).toBeGreaterThanOrEqual(6);

    // Changed pixel: before-colour dimmed to 40% with red boosted; unchanged pixels untouched.
    expect(rgbaAt(d.diffImageData!, 3, 4)).toEqual([Math.round(100 * 0.4 + 255 * 0.6), 48, 56, 255]);
    expect(rgbaAt(d.diffImageData!, 0, 0)).toEqual(GREY);
    expect(rgbaAt(d.diffImageData!, 9, 9)).toEqual(GREY);
  });

  it("perceptual mode and ignore regions operate on the decoded pixels", () => {
    const store = new VisualDiffStore(dir);
    store.put("before", pngShot(10, 10, () => GREY), false);
    store.put("after", pngShot(10, 10, (x, y) => (x < 2 && y < 2 ? [255, 255, 255, 255] : GREY)), false);

    expect(store.diff("before", "after", { perceptual: true }).diffPixelCount).toBe(4);
    expect(store.diff("before", "after", { ignoreRegions: [{ x: 0, y: 0, width: 1, height: 2 }] }).diffPixelCount).toBe(2);
  });

  it("reports a 100% diff when dimensions differ", () => {
    const store = new VisualDiffStore(dir);
    store.put("a", pngShot(4, 4, () => GREY), false);
    store.put("b", pngShot(4, 3, () => GREY), false);
    expect(store.diff("a", "b")).toMatchObject({ diffPixelCount: 16, diffPercentage: 100, diffRegions: [{ x: 0, y: 0, width: 4, height: 4 }] });
  });

  it("throws for an unknown id", () => {
    expect(() => new VisualDiffStore(dir).diff("nope", "nope")).toThrow(/not found/);
  });
});
