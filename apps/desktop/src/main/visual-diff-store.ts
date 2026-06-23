import { nativeImage } from "electron";

import type { DiffRegion, PageScreenshot, ScreenshotDiff } from "../../../../packages/shared/src/index.js";
import { ScreenshotBaselineStore } from "./baseline-store.js";
import { buildIgnoreMask, comparePixels, computeDiffRegions } from "./pixel-compare.js";

/**
 * Owns named screenshots: an in-memory cache backed by a disk store
 * (`ScreenshotBaselineStore`), plus pixel-diff comparison of two captures.
 * Extracted from `TabManager`, which still performs the CDP capture itself and
 * hands the result here via {@link put}.
 */
export class VisualDiffStore {
  private readonly cache = new Map<string, PageScreenshot>();
  private readonly store: ScreenshotBaselineStore;

  constructor(userDataPath: string) {
    this.store = new ScreenshotBaselineStore(userDataPath);
    // Warm the in-memory cache from disk so named baselines survive a restart.
    for (const { id, shot } of this.store.all()) {
      this.cache.set(id, shot);
    }
  }

  /** Store a captured screenshot under `id`; persisted to disk unless `persist` is false. */
  put(id: string, shot: PageScreenshot, persist = true): void {
    this.cache.set(id, shot);
    if (persist) {
      this.store.put(id, shot);
    }
  }

  /** Look up a cached screenshot. */
  get(id: string): PageScreenshot | undefined {
    return this.cache.get(id);
  }

  /** Remove a named screenshot from the cache and disk. Returns false if it didn't exist. */
  remove(id: string): boolean {
    const existed = this.cache.delete(id);
    this.store.remove(id);
    return existed;
  }

  /** All cached entries (id + screenshot) for listing. */
  entries(): IterableIterator<[string, PageScreenshot]> {
    return this.cache.entries();
  }

  /** Compare two previously stored named screenshots pixel-by-pixel. */
  diff(
    beforeId: string,
    afterId: string,
    options: { ignoreRegions?: DiffRegion[]; perceptual?: boolean; threshold?: number } = {}
  ): ScreenshotDiff {
    const before = this.cache.get(beforeId);
    const after  = this.cache.get(afterId);
    if (!before) throw new Error(`Screenshot "${beforeId}" not found in cache`);
    if (!after)  throw new Error(`Screenshot "${afterId}" not found in cache`);

    const imgA = nativeImage.createFromDataURL(`data:image/png;base64,${before.data}`);
    const imgB = nativeImage.createFromDataURL(`data:image/png;base64,${after.data}`);

    const { width: wA, height: hA } = imgA.getSize();
    const { width: wB, height: hB } = imgB.getSize();
    const totalPixels = wA * hA;

    if (wA !== wB || hA !== hB) {
      return {
        beforeId, afterId,
        diffPixelCount: totalPixels, diffPercentage: 100, totalPixels,
        width: wA, height: hA, diffRegions: [{ x: 0, y: 0, width: wA, height: hA }],
        capturedAt: Date.now()
      };
    }

    const rawA   = imgA.toBitmap(); // BGRA, 4 bytes/pixel
    const rawB   = imgB.toBitmap();
    // Start with the "before" image as the base — changed areas will be tinted.
    const diffBuf = Buffer.from(rawA);
    // Track which pixels changed as a flat boolean array for region detection.
    const changed = new Uint8Array(totalPixels);
    // Optional mask of pixels to ignore (e.g. dynamic timestamps/ads).
    const ignoreMask = options.ignoreRegions?.length ? buildIgnoreMask(options.ignoreRegions, wA, hA) : null;
    let diffCount = 0;

    if (options.perceptual) {
      // Perceptual (YIQ) comparison: ignores anti-aliasing / sub-pixel noise.
      const cmp = comparePixels(rawA, rawB, wA, hA, { threshold: options.threshold, ignoreMask });
      changed.set(cmp.changed);
      diffCount = cmp.diffCount;
    } else {
      // Default: raw per-channel ±10 comparison (unchanged behavior).
      for (let i = 0; i < rawA.length; i += 4) {
        const px = i >> 2;
        if (ignoreMask && ignoreMask[px]) continue;
        const db = Math.abs(rawA[i]   - rawB[i]);
        const dg = Math.abs(rawA[i + 1] - rawB[i + 1]);
        const dr = Math.abs(rawA[i + 2] - rawB[i + 2]);
        if (dr > 10 || dg > 10 || db > 10) {
          diffCount++;
          changed[px] = 1;
        }
      }
    }

    // Tint changed pixels red over the dimmed original so context stays legible.
    for (let px = 0; px < totalPixels; px++) {
      if (!changed[px]) continue;
      const i = px * 4;
      diffBuf[i]     = Math.round(rawA[i]     * 0.4);            // B dimmed
      diffBuf[i + 1] = Math.round(rawA[i + 1] * 0.4);            // G dimmed
      diffBuf[i + 2] = Math.round(rawA[i + 2] * 0.4 + 255 * 0.6); // R boosted
      diffBuf[i + 3] = 255;
    }

    const diffImg = nativeImage.createFromBitmap(diffBuf, { width: wA, height: hA });

    return {
      beforeId, afterId,
      diffPixelCount: diffCount,
      diffPercentage: Math.round((diffCount / totalPixels) * 10000) / 100,
      totalPixels,
      width: wA, height: hA,
      diffRegions: computeDiffRegions(changed, wA, hA),
      diffImageData: diffImg.toPNG().toString("base64"),
      capturedAt: Date.now()
    };
  }
}
