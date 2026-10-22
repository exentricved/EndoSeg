import { describe, it, expect } from "vitest";
import {
  type Gray,
  type Pt,
  trackPoints,
  fitSimilarity,
  applySimilarity,
  trackPolygon,
  globalMotion,
  sampleMask,
  IDENTITY,
} from "./optflow.js";

/** Smooth, textured synthetic scene sampled at an offset (sub-pixel ok). */
function scene(w: number, h: number, dx: number, dy: number): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x - dx;
      const v = y - dy;
      data[y * w + x] =
        128 +
        40 * Math.sin(u / 7) * Math.cos(v / 9) +
        30 * Math.sin((u + v) / 13) +
        20 * Math.cos(u / 4.3 - v / 5.1);
    }
  }
  return { data, w, h };
}

describe("trackPoints", () => {
  it("recovers a pure translation, including large motion via the pyramid", () => {
    for (const [dx, dy] of [[2.5, -1.5], [18, 11]]) {
      const a = scene(200, 160, 0, 0);
      const b = scene(200, 160, dx, dy);
      const pts: Pt[] = [{ x: 60, y: 60 }, { x: 100, y: 80 }, { x: 130, y: 70 }];
      const r = trackPoints(a, b, pts);
      r.points.forEach((p, i) => {
        expect(r.ok[i]).toBe(true);
        expect(p.x - pts[i].x).toBeCloseTo(dx, 0);
        expect(p.y - pts[i].y).toBeCloseTo(dy, 0);
      });
    }
  });

  it("marks points in a flat (textureless) region as lost", () => {
    const flat: Gray = { data: new Float32Array(100 * 100).fill(90), w: 100, h: 100 };
    const r = trackPoints(flat, flat, [{ x: 50, y: 50 }]);
    expect(r.ok[0]).toBe(false);
    expect(r.points[0]).toEqual({ x: 50, y: 50 });
  });
});

describe("fitSimilarity", () => {
  it("fits rotation + scale + translation and ignores an outlier", () => {
    const t = { a: 1.05 * Math.cos(0.1), b: 1.05 * Math.sin(0.1), tx: 7, ty: -4 };
    const src: Pt[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 40 }, { x: 30, y: 30 }, { x: 10, y: 20 }];
    const dst = src.map((p) => applySimilarity(t, p));
    dst[4] = { x: 500, y: 500 }; // outlier
    const fit = fitSimilarity(src, dst)!;
    expect(fit.a).toBeCloseTo(t.a, 3);
    expect(fit.b).toBeCloseTo(t.b, 3);
    expect(fit.tx).toBeCloseTo(t.tx, 2);
    expect(fit.ty).toBeCloseTo(t.ty, 2);
  });
});

describe("trackPolygon / globalMotion", () => {
  it("moves a polygon with the scene", () => {
    const a = scene(220, 180, 0, 0);
    const b = scene(220, 180, 6, 4);
    const poly: Pt[] = [{ x: 70, y: 60 }, { x: 140, y: 65 }, { x: 130, y: 120 }, { x: 75, y: 115 }];
    const r = trackPolygon(a, b, poly, IDENTITY);
    r.points.forEach((p, i) => {
      expect(p.x - poly[i].x).toBeCloseTo(6, 0);
      expect(p.y - poly[i].y).toBeCloseTo(4, 0);
    });
    expect(r.trackedFraction).toBeGreaterThan(0.5);

    const g = globalMotion(a, b);
    expect(g.tx).toBeCloseTo(6, 0);
    expect(g.ty).toBeCloseTo(4, 0);
  });
});

describe("sampleMask", () => {
  it("samples only painted pixels", () => {
    const w = 40, h = 40;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) rgba[(y * w + x) * 4 + 3] = 255;
    const pts = sampleMask(rgba, w, h);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThan(20);
      expect(p.y).toBeGreaterThanOrEqual(10);
      expect(p.y).toBeLessThan(20);
    }
  });
});
