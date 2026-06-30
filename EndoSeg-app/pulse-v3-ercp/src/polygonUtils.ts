/**
 * polygonUtils.ts — pure polygon rasterization utilities.
 *
 * `polygonMask` uses a pure-JS scanline fill (no DOM/Canvas required) so it
 * can be unit-tested in Node / Vitest without a Canvas polyfill.
 *
 * App.tsx uses Canvas 2D for its drawing operations directly; this module
 * is the testable, environment-agnostic counterpart.
 */

export type Pt = { x: number; y: number };

/**
 * Rasterize a closed polygon into a flat Uint8Array mask (row-major).
 *
 * Uses the scanline + ray-casting algorithm (even-odd rule).  Any index
 * where mask[y * w + x] === 1 is "inside" the polygon.
 *
 * @param pts   Polygon vertices in pixel coordinates (>= 3 required)
 * @param w     Image width in pixels
 * @param h     Image height in pixels
 * @returns     Uint8Array of length w*h; 1 = inside, 0 = outside
 */
export function polygonMask(pts: Pt[], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (pts.length < 3) return mask;

  for (let y = 0; y < h; y++) {
    // Collect x-intersections of the polygon edges with scanline y+0.5
    const xs: number[] = [];
    const yc = y + 0.5;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i].y, yj = pts[j].y;
      if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) {
        // Edge crosses the scanline
        xs.push(pts[j].x + ((yc - yj) / (yi - yj)) * (pts[i].x - pts[j].x));
      }
    }
    xs.sort((a, b) => a - b);
    // Fill between pairs of intersections
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) {
        mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Count filled pixels in a polygonMask result.
 */
export function countMaskPixels(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/**
 * Return true if pixel (x, y) is filled.
 */
export function maskAt(mask: Uint8Array, w: number, x: number, y: number): boolean {
  return mask[y * w + x] === 1;
}
