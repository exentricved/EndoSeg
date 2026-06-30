/**
 * Geometric helpers for polygon-instance hit-testing and selection.
 *
 * Image-space coordinates throughout (no zoom/pan transform here — caller is
 * expected to project the cursor into image space first).
 */

import type { Pt, AnnotationInstance } from "./ercpClasses";

/** Point-in-polygon via ray casting. Edge cases (point on edge) count as inside. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  if (poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect =
      ((yi > p.y) !== (yj > p.y)) &&
      (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Squared distance, avoids the sqrt for hot-loop comparisons. */
export function distSq(a: Pt, b: Pt): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Perpendicular distance from point `p` to segment AB, plus the projected `t` (0..1). */
export function pointToSegment(p: Pt, a: Pt, b: Pt): { dist: number; t: number; closest: Pt } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = a.x + dx * t, cy = a.y + dy * t;
  const ex = p.x - cx, ey = p.y - cy;
  return { dist: Math.sqrt(ex * ex + ey * ey), t, closest: { x: cx, y: cy } };
}

/**
 * Find the closest polygon edge of `poly` within `radiusPx`. Returns the index
 * of the edge's first vertex (so the new vertex would be inserted at `edgeIdx + 1`),
 * the projection point, and the t parameter along the edge.
 */
export function findEdgeHit(
  cursor: Pt,
  poly: Pt[],
  radiusPx: number,
): { edgeIdx: number; t: number; closest: Pt; dist: number } | null {
  if (poly.length < 2) return null;
  let best: { edgeIdx: number; t: number; closest: Pt; dist: number } | null = null;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const r = pointToSegment(cursor, poly[i], poly[j]);
    if (r.dist <= radiusPx && (!best || r.dist < best.dist)) {
      best = { edgeIdx: i, t: r.t, closest: r.closest, dist: r.dist };
    }
  }
  return best;
}

/** Find the closest vertex of any polygon-geom instance within `radiusPx` (image-space). */
export function findVertexHit(
  cursor: Pt,
  annotations: AnnotationInstance[],
  radiusPx: number,
): { instanceId: string; vertexIdx: number; dist: number } | null {
  const rsq = radiusPx * radiusPx;
  let best: { instanceId: string; vertexIdx: number; dist: number } | null = null;
  for (const a of annotations) {
    if (a.geometry.kind !== "polygon") continue;
    const pts = a.geometry.points;
    for (let i = 0; i < pts.length; i++) {
      const d = distSq(cursor, pts[i]);
      if (d <= rsq && (!best || d < best.dist)) {
        best = { instanceId: a.id, vertexIdx: i, dist: d };
      }
    }
  }
  return best;
}

/** Find the topmost polygon-geom instance containing the cursor (last-drawn wins). */
export function findPolygonHit(
  cursor: Pt,
  annotations: AnnotationInstance[],
): AnnotationInstance | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.geometry.kind === "polygon" && pointInPolygon(cursor, a.geometry.points)) {
      return a;
    }
  }
  return null;
}

/** Polygon centroid (average of vertices); used to place badges/labels. */
export function polygonCentroid(poly: Pt[]): Pt {
  if (poly.length === 0) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of poly) { sx += p.x; sy += p.y; }
  return { x: sx / poly.length, y: sy / poly.length };
}

/** Axis-aligned bounding box of a polygon. */
export function polygonBBox(poly: Pt[]): { x: number; y: number; w: number; h: number } {
  if (poly.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = poly[0].x, minY = poly[0].y, maxX = poly[0].x, maxY = poly[0].y;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** True if axis-aligned bboxes of two polygons overlap. */
export function bboxesOverlap(a: Pt[], b: Pt[]): boolean {
  const A = polygonBBox(a), B = polygonBBox(b);
  return !(A.x + A.w < B.x || B.x + B.w < A.x || A.y + A.h < B.y || B.y + B.h < A.y);
}

/**
 * Cheap polygon-overlap check: bbox overlap + sampled-point fallback.
 * Samples up to `samples` points uniformly inside polygon A's bbox and tests
 * whether any sampled point is inside both polygons. Conservative on near-misses
 * but fast and good enough for the auto-usability flag in v1.
 */
export function polygonsOverlap(a: Pt[], b: Pt[], samples: number = 24): boolean {
  if (!bboxesOverlap(a, b)) return false;
  // Easy win: any vertex of A inside B (or vice versa)?
  for (const p of a) if (pointInPolygon(p, b)) return true;
  for (const p of b) if (pointInPolygon(p, a)) return true;
  // Sampled grid inside A's bbox
  const A = polygonBBox(a);
  const n = Math.max(2, Math.floor(Math.sqrt(samples)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const px = A.x + ((i + 0.5) / n) * A.w;
      const py = A.y + ((j + 0.5) / n) * A.h;
      const p = { x: px, y: py };
      if (pointInPolygon(p, a) && pointInPolygon(p, b)) return true;
    }
  }
  return false;
}
