import { describe, it, expect } from "vitest";
import {
  pointInPolygon,
  findVertexHit,
  findPolygonHit,
  findEdgeHit,
  pointToSegment,
  polygonCentroid,
  polygonBBox,
  bboxesOverlap,
  polygonsOverlap,
} from "./polygonGeom";
import type { AnnotationInstance } from "./ercpClasses";

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

const offsetSquare = [
  { x: 5, y: 5 },
  { x: 15, y: 5 },
  { x: 15, y: 15 },
  { x: 5, y: 15 },
];

const farSquare = [
  { x: 100, y: 100 },
  { x: 110, y: 100 },
  { x: 110, y: 110 },
  { x: 100, y: 110 },
];

describe("pointInPolygon", () => {
  it("returns true for interior points", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
  });
  it("returns false for exterior points", () => {
    expect(pointInPolygon({ x: 20, y: 20 }, square)).toBe(false);
  });
  it("returns false for degenerate polygon", () => {
    expect(pointInPolygon({ x: 0, y: 0 }, [{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(false);
  });
});

describe("polygonBBox + bboxesOverlap", () => {
  it("computes tight bbox", () => {
    expect(polygonBBox(square)).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
  it("detects overlap", () => {
    expect(bboxesOverlap(square, offsetSquare)).toBe(true);
    expect(bboxesOverlap(square, farSquare)).toBe(false);
  });
});

describe("polygonsOverlap", () => {
  it("detects polygon overlap via vertex containment", () => {
    expect(polygonsOverlap(square, offsetSquare)).toBe(true);
  });
  it("returns false for disjoint polygons", () => {
    expect(polygonsOverlap(square, farSquare)).toBe(false);
  });
});

describe("polygonCentroid", () => {
  it("averages vertices", () => {
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(5);
  });
});

describe("findVertexHit", () => {
  const mkInst = (id: string, points: { x: number; y: number }[]): AnnotationInstance => ({
    id, classId: 1,
    geometry: { kind: "polygon", points },
    depth_rank: 2, depth_rank_fixed: false, attributes: {},
  });
  const items = [mkInst("a", square), mkInst("b", offsetSquare)];

  it("finds nearest vertex within radius", () => {
    const hit = findVertexHit({ x: 0.5, y: 0.5 }, items, 1.5);
    expect(hit?.instanceId).toBe("a");
    expect(hit?.vertexIdx).toBe(0);
  });
  it("returns null when no vertex in radius", () => {
    expect(findVertexHit({ x: 50, y: 50 }, items, 2)).toBeNull();
  });
  it("ignores mask-geom instances", () => {
    const mixed: AnnotationInstance[] = [
      { id: "m", classId: 1, geometry: { kind: "mask", bbox: [0, 0, 5, 5], maskPNG: "" },
        depth_rank: 2, depth_rank_fixed: false, attributes: {} },
    ];
    expect(findVertexHit({ x: 0, y: 0 }, mixed, 5)).toBeNull();
  });
});

describe("pointToSegment", () => {
  it("computes perpendicular distance to interior point", () => {
    const r = pointToSegment({ x: 5, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.dist).toBeCloseTo(2);
    expect(r.t).toBeCloseTo(0.5);
    expect(r.closest.x).toBeCloseTo(5);
    expect(r.closest.y).toBeCloseTo(0);
  });
  it("clamps t to 0..1 outside the segment", () => {
    const r = pointToSegment({ x: -3, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.t).toBe(0);
    expect(r.closest).toEqual({ x: 0, y: 0 });
  });
});

describe("findEdgeHit", () => {
  it("finds an edge midpoint hit on a square", () => {
    const r = findEdgeHit({ x: 5, y: 0.5 }, square, 1.5);
    expect(r).not.toBeNull();
    expect(r!.edgeIdx).toBe(0); // first edge (0,0)→(10,0)
    expect(r!.t).toBeCloseTo(0.5);
    expect(r!.closest.x).toBeCloseTo(5);
    expect(r!.closest.y).toBeCloseTo(0);
  });
  it("returns null when no edge is within radius", () => {
    expect(findEdgeHit({ x: 50, y: 50 }, square, 2)).toBeNull();
  });
});

describe("findPolygonHit", () => {
  const mkInst = (id: string, points: { x: number; y: number }[]): AnnotationInstance => ({
    id, classId: 1,
    geometry: { kind: "polygon", points },
    depth_rank: 2, depth_rank_fixed: false, attributes: {},
  });

  it("returns the last-drawn polygon containing the point (z-order)", () => {
    const items = [mkInst("under", square), mkInst("over", offsetSquare)];
    // Point (7,7) is inside BOTH; the later-drawn 'over' wins.
    const hit = findPolygonHit({ x: 7, y: 7 }, items);
    expect(hit?.id).toBe("over");
  });
  it("returns null when point is in no polygon", () => {
    expect(findPolygonHit({ x: 50, y: 50 }, [mkInst("a", square)])).toBeNull();
  });
});
