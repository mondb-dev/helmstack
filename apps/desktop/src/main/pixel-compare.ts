/**
 * Perceptual pixel comparison in YIQ color space (the metric used by pixelmatch).
 * Small differences — sub-pixel font rendering, anti-aliasing — produce a tiny
 * YIQ delta and fall under the threshold, so this is far less noisy than the
 * raw per-channel ±10 comparison. Operates on BGRA buffers (Electron
 * `nativeImage.toBitmap()`). Pure — unit-testable with synthetic buffers.
 */

const MAX_YIQ_DELTA = 35215; // = (255²·0.5053 + 255²·0.299 + 255²·0.1957), pixelmatch's max

const rgb2y = (r: number, g: number, b: number) => r * 0.29889531 + g * 0.58662247 + b * 0.11448223;
const rgb2i = (r: number, g: number, b: number) => r * 0.59597799 - g * 0.27417610 - b * 0.32180189;
const rgb2q = (r: number, g: number, b: number) => r * 0.21147017 - g * 0.52261711 + b * 0.31114694;

/** Blend a channel toward a white background by alpha. */
const blend = (c: number, a: number) => 255 + (c - 255) * a;

/**
 * Squared, perceptually-weighted YIQ color distance between pixel `k` (byte
 * offset) of two BGRA buffers. 0 when identical.
 */
export function colorDelta(a: Uint8Array | Buffer, b: Uint8Array | Buffer, k: number): number {
  const a1 = a[k + 3], a2 = b[k + 3];
  let b1 = a[k], g1 = a[k + 1], r1 = a[k + 2];
  let b2 = b[k], g2 = b[k + 1], r2 = b[k + 2];

  if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;

  if (a1 < 255) { const f = a1 / 255; r1 = blend(r1, f); g1 = blend(g1, f); b1 = blend(b1, f); }
  if (a2 < 255) { const f = a2 / 255; r2 = blend(r2, f); g2 = blend(g2, f); b2 = blend(b2, f); }

  const y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
  const i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
  const q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);

  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

export type PixelCompareOptions = {
  /** 0–1; higher tolerates larger differences. Default 0.1 (pixelmatch default). */
  threshold?: number;
  /** Pixels to exclude from comparison (1 = ignore), flat row-major. */
  ignoreMask?: Uint8Array | null;
};

/**
 * Compare two BGRA buffers perceptually. Returns a per-pixel changed flag array
 * and the changed-pixel count. A pixel counts as changed only when its YIQ
 * delta exceeds `threshold²·MAX`, so anti-aliasing noise is ignored.
 */
export function comparePixels(
  a: Uint8Array | Buffer,
  b: Uint8Array | Buffer,
  width: number,
  height: number,
  options: PixelCompareOptions = {}
): { changed: Uint8Array; diffCount: number } {
  const threshold = options.threshold ?? 0.1;
  const maxDelta = MAX_YIQ_DELTA * threshold * threshold;
  const changed = new Uint8Array(width * height);
  let diffCount = 0;

  for (let pos = 0; pos < width * height; pos++) {
    if (options.ignoreMask && options.ignoreMask[pos]) continue;
    if (colorDelta(a, b, pos * 4) > maxDelta) {
      changed[pos] = 1;
      diffCount++;
    }
  }

  return { changed, diffCount };
}
