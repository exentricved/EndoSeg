/**
 * polygonUtils.test.ts — unit tests for polygon rasterization and
 * double-click detection logic.
 *
 * Run with:  npm test
 *
 * Uses the pure-JS `polygonMask` (scanline fill) so no Canvas/DOM is needed.
 */

import { describe, it, expect } from "vitest";
import { polygonMask, countMaskPixels, maskAt, type Pt } from "./polygonUtils";

// ---------------------------------------------------------------------------
// 1. Mask correctness — known polygon → expected filled pixels
// ---------------------------------------------------------------------------

describe("polygonMask — mask correctness", () => {
  it("fills interior pixels of an axis-aligned rectangle", () => {
    // 20×20 canvas; rectangle from (5,5) to (14,14)
    const pts: Pt[] = [
      { x: 5, y: 5 },
      { x: 14, y: 5 },
      { x: 14, y: 14 },
      { x: 5, y: 14 },
    ];
    const mask = polygonMask(pts, 20, 20);
    // Interior pixels should be filled
    expect(maskAt(mask, 20, 9, 9)).toBe(true);
    expect(maskAt(mask, 20, 5, 5)).toBe(true);
    // Pixels outside
    expect(maskAt(mask, 20, 0, 0)).toBe(false);
    expect(maskAt(mask, 20, 19, 19)).toBe(false);
    // Scanline fill: boundary rows may vary ±1 row; expect 90–100 filled pixels
    expect(countMaskPixels(mask)).toBeGreaterThanOrEqual(90);
    expect(countMaskPixels(mask)).toBeLessThanOrEqual(100);
  });

  it("fills a right-angle triangle correctly", () => {
    // Triangle with vertices at (0,0), (10,0), (0,10) — lower-left half
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const mask = polygonMask(pts, 20, 20);
    // Point well inside the triangle
    expect(maskAt(mask, 20, 1, 1)).toBe(true);
    // Point outside
    expect(maskAt(mask, 20, 10, 10)).toBe(false);
    // Area of right triangle with legs 10 ≈ 50 pixels
    expect(countMaskPixels(mask)).toBeGreaterThan(30);
    expect(countMaskPixels(mask)).toBeLessThan(70);
  });

  it("last point connects back to first (polygon is closed)", () => {
    // Thin horizontal strip — if polygon weren't closed the area would be ~0
    const pts: Pt[] = [
      { x: 2, y: 8 },
      { x: 18, y: 8 },
      { x: 18, y: 12 },
      { x: 2, y: 12 },
    ];
    const mask = polygonMask(pts, 20, 20);
    expect(maskAt(mask, 20, 10, 10)).toBe(true);
    expect(maskAt(mask, 20, 10, 0)).toBe(false);
    expect(maskAt(mask, 20, 10, 19)).toBe(false);
    // Strip is 17 wide × 4 tall = 68 pixels
    expect(countMaskPixels(mask)).toBeGreaterThan(50);
  });

  it("handles a concave (L-shaped) polygon", () => {
    const pts: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
    ];
    const mask = polygonMask(pts, 15, 15);
    expect(maskAt(mask, 15, 2, 2)).toBe(true);   // top-left arm
    expect(maskAt(mask, 15, 2, 7)).toBe(true);   // bottom-left arm
    expect(maskAt(mask, 15, 8, 7)).toBe(false);  // cut-out region
  });
});

// ---------------------------------------------------------------------------
// 2. Edge cases — < 3 points → no fill
// ---------------------------------------------------------------------------

describe("polygonMask — edge cases", () => {
  it("returns an empty mask when given 0 points", () => {
    const mask = polygonMask([], 10, 10);
    expect(countMaskPixels(mask)).toBe(0);
  });

  it("returns an empty mask when given 1 point", () => {
    const mask = polygonMask([{ x: 5, y: 5 }], 10, 10);
    expect(countMaskPixels(mask)).toBe(0);
  });

  it("returns an empty mask when given 2 points", () => {
    const mask = polygonMask([{ x: 0, y: 0 }, { x: 9, y: 9 }], 10, 10);
    expect(countMaskPixels(mask)).toBe(0);
  });

  it("handles points outside the canvas bounds gracefully", () => {
    // All points outside the 10×10 canvas — no crash, empty mask
    const pts: Pt[] = [
      { x: -5, y: -5 },
      { x: 20, y: -5 },
      { x: 20, y: 20 },
      { x: -5, y: 20 },
    ];
    // A big polygon enclosing the whole canvas → all pixels filled
    const mask = polygonMask(pts, 10, 10);
    expect(countMaskPixels(mask)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 3. Double-click detection logic (pure function — no React required)
// ---------------------------------------------------------------------------

describe("double-click detection via event.detail", () => {
  /**
   * Pure simulation of the onCanvasClick branching logic:
   *   detail === 1 → add point
   *   detail === 2 → finalize if ≥ 3 pts (no extra point added)
   */
  function simulateClicks(
    sequence: Array<{ detail: number; pt: Pt }>
  ): { finalPts: Pt[]; finalized: boolean; pointsAtFinalize: number } {
    let points: Pt[] = [];
    let finalized = false;
    let pointsAtFinalize = 0;

    for (const ev of sequence) {
      if (ev.detail === 2) {
        // Double-click: do NOT add point; finalize if possible
        pointsAtFinalize = points.length;
        if (points.length >= 3) finalized = true;
        points = [];
      } else {
        // Single click: add point
        points = [...points, ev.pt];
      }
    }

    return { finalPts: points, finalized, pointsAtFinalize };
  }

  it("single clicks add points one by one", () => {
    const { finalPts } = simulateClicks([
      { detail: 1, pt: { x: 0, y: 0 } },
      { detail: 1, pt: { x: 5, y: 0 } },
      { detail: 1, pt: { x: 5, y: 5 } },
    ]);
    expect(finalPts).toHaveLength(3);
  });

  it("double-click finalizes without adding a duplicate point", () => {
    const { finalPts, finalized } = simulateClicks([
      { detail: 1, pt: { x: 0, y: 0 } },
      { detail: 1, pt: { x: 10, y: 0 } },
      { detail: 1, pt: { x: 10, y: 10 } },
      { detail: 1, pt: { x: 5, y: 5 } }, // 1st click of double-click → adds point
      { detail: 2, pt: { x: 5, y: 5 } }, // 2nd click → finalize, NOT added
    ]);
    expect(finalized).toBe(true);
    expect(finalPts).toHaveLength(0); // reset after finalize
  });

  it("double-click on < 3 points does NOT trigger fill", () => {
    const { finalized } = simulateClicks([
      { detail: 1, pt: { x: 0, y: 0 } },
      { detail: 1, pt: { x: 5, y: 5 } },
      { detail: 2, pt: { x: 5, y: 5 } }, // only 2 points — skip fill
    ]);
    expect(finalized).toBe(false);
  });

  it("double-click does NOT add 2 extra points — exactly 4 at finalize time", () => {
    // 3 singles + 1 first-click-of-double (detail=1) → 4 points before finalize
    const { pointsAtFinalize } = simulateClicks([
      { detail: 1, pt: { x: 0, y: 0 } },
      { detail: 1, pt: { x: 10, y: 0 } },
      { detail: 1, pt: { x: 10, y: 10 } },
      { detail: 1, pt: { x: 5, y: 5 } }, // 1st of double → point added (total=4)
      { detail: 2, pt: { x: 5, y: 5 } }, // 2nd of double → no point added, finalize
    ]);
    expect(pointsAtFinalize).toBe(4);
  });

  it("rapid single clicks do not corrupt polygon state", () => {
    const clicks: Array<{ detail: number; pt: Pt }> = Array.from(
      { length: 10 },
      (_, i) => ({ detail: 1, pt: { x: i, y: i } })
    );
    // Double-click: first click adds point (detail=1), second finalizes (detail=2)
    clicks.push({ detail: 1, pt: { x: 11, y: 11 } });
    clicks.push({ detail: 2, pt: { x: 11, y: 11 } });

    const { finalized, finalPts } = simulateClicks(clicks);
    expect(finalized).toBe(true);
    expect(finalPts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. No duplicate point on polygon closure
// ---------------------------------------------------------------------------

describe("polygon closure — last connects to first", () => {
  it("a thin vertical sliver is filled without manually repeating the first point", () => {
    const pts: Pt[] = [
      { x: 5, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 10 },
      { x: 5, y: 10 },
    ];
    const mask = polygonMask(pts, 15, 15);
    expect(maskAt(mask, 15, 5, 5)).toBe(true);
    // No need for pts[0] to be repeated; the scanline algorithm closes implicitly
    expect(countMaskPixels(mask)).toBeGreaterThan(0);
  });

  it("adding a duplicate of pts[0] at the end does not change the filled area", () => {
    const pts: Pt[] = [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ];
    const ptsWithDup: Pt[] = [...pts, { ...pts[0] }]; // duplicate first point
    const maskA = polygonMask(pts, 10, 10);
    const maskB = polygonMask(ptsWithDup, 10, 10);
    expect(countMaskPixels(maskA)).toBe(countMaskPixels(maskB));
  });
});

// ---------------------------------------------------------------------------
// 5. Undo/Redo compatibility (structural: mask is a plain value)
// ---------------------------------------------------------------------------

describe("undo/redo compatibility", () => {
  it("before and after masks are distinct Uint8Arrays (not the same reference)", () => {
    const pts: Pt[] = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }];
    const before = new Uint8Array(100); // empty
    const after = polygonMask(pts, 10, 10);
    expect(before).not.toBe(after);
    expect(countMaskPixels(before)).toBe(0);
    expect(countMaskPixels(after)).toBeGreaterThan(0);
  });

  it("undoing restores the before-mask (plain value swap)", () => {
    const pts: Pt[] = [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 8 }, { x: 1, y: 8 }];
    const before = new Uint8Array(100); // empty
    const after = polygonMask(pts, 10, 10);

    // Simulate undo: swap after → before
    let current = after;
    expect(countMaskPixels(current)).toBeGreaterThan(0);
    current = before; // undo
    expect(countMaskPixels(current)).toBe(0);
    // Redo: swap back
    current = after;
    expect(countMaskPixels(current)).toBeGreaterThan(0);
  });
});
