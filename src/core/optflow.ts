// Sparse optical flow for annotation tracking: pyramidal Lucas-Kanade on
// grayscale images, plus a robust similarity-transform fit used to move whole
// masks/polygons when individual points cannot be tracked. Pure TypeScript (no
// DOM, no OpenCV) so it runs in the renderer and is unit-testable in Node.

export interface Gray {
  data: Float32Array;
  w: number;
  h: number;
}

export type Pt = { x: number; y: number };

/** RGBA bytes (canvas ImageData layout) → luminance image. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return { data, w, h };
}

/** Halve resolution with a 2x2 box filter. */
function downsample(img: Gray): Gray {
  const w = Math.max(1, img.w >> 1);
  const h = Math.max(1, img.h >> 1);
  const out = new Float32Array(w * h);
  const s = img.data;
  const sw = img.w;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(img.h - 1, y * 2) * sw;
    const y1 = Math.min(img.h - 1, y * 2 + 1) * sw;
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, x * 2);
      const x1 = Math.min(sw - 1, x * 2 + 1);
      out[y * w + x] = (s[y0 + x0] + s[y0 + x1] + s[y1 + x0] + s[y1 + x1]) * 0.25;
    }
  }
  return { data: out, w, h };
}

export function buildPyramid(img: Gray, levels: number): Gray[] {
  const pyr = [img];
  while (pyr.length < levels) {
    const top = pyr[pyr.length - 1];
    if (top.w < 32 || top.h < 32) break;
    pyr.push(downsample(top));
  }
  return pyr;
}

/** Bilinear sample with edge clamping. */
function sample(img: Gray, x: number, y: number): number {
  const { data, w, h } = img;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * w + x0];
  const b = data[y0 * w + x1];
  const c = data[y1 * w + x0];
  const d = data[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export interface LkOptions {
  /** Half-size of the integration window (window = 2r+1 square). */
  radius?: number;
  /** Pyramid levels (including full resolution). */
  levels?: number;
  maxIters?: number;
  /** Reject points whose window has too little texture (min eigenvalue per pixel). */
  minEigen?: number;
  /** Forward-backward consistency threshold in pixels; failing points are marked lost. */
  fbThreshold?: number;
}

const LK_DEFAULTS: Required<LkOptions> = {
  radius: 10,
  levels: 4,
  maxIters: 20,
  minEigen: 1e-2,
  fbThreshold: 2,
};

/** Track one point between pyramid images. Returns null if untrackable. */
function lkPoint(prev: Gray[], next: Gray[], pt: Pt, o: Required<LkOptions>): Pt | null {
  const top = Math.min(prev.length, next.length) - 1;
  const r = o.radius;
  const n = (2 * r + 1) * (2 * r + 1);
  const ix = new Float32Array(n);
  const iy = new Float32Array(n);
  const iv = new Float32Array(n);
  let gx = 0;
  let gy = 0;

  for (let L = top; L >= 0; L--) {
    const I = prev[L];
    const J = next[L];
    const scale = 1 / (1 << L);
    const px = pt.x * scale;
    const py = pt.y * scale;

    // Spatial gradient matrix over the window in the previous image.
    let gxx = 0, gxy = 0, gyy = 0;
    let k = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++, k++) {
        const x = px + dx;
        const y = py + dy;
        const vx = (sample(I, x + 1, y) - sample(I, x - 1, y)) * 0.5;
        const vy = (sample(I, x, y + 1) - sample(I, x, y - 1)) * 0.5;
        ix[k] = vx;
        iy[k] = vy;
        iv[k] = sample(I, x, y);
        gxx += vx * vx;
        gxy += vx * vy;
        gyy += vy * vy;
      }
    }
    const det = gxx * gyy - gxy * gxy;
    const tr = gxx + gyy;
    const minEig = (tr - Math.sqrt(Math.max(0, tr * tr - 4 * det))) / 2 / n;
    if (minEig < o.minEigen || Math.abs(det) < 1e-9) return null;

    let nx = 0;
    let ny = 0;
    for (let it = 0; it < o.maxIters; it++) {
      let bx = 0;
      let by = 0;
      k = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++, k++) {
          const diff = iv[k] - sample(J, px + dx + gx + nx, py + dy + gy + ny);
          bx += diff * ix[k];
          by += diff * iy[k];
        }
      }
      const ex = (gyy * bx - gxy * by) / det;
      const ey = (gxx * by - gxy * bx) / det;
      nx += ex;
      ny += ey;
      if (ex * ex + ey * ey < 1e-4) break;
    }
    if (L > 0) {
      gx = 2 * (gx + nx);
      gy = 2 * (gy + ny);
    } else {
      gx += nx;
      gy += ny;
    }
  }
  const out = { x: pt.x + gx, y: pt.y + gy };
  const base = prev[0];
  if (!Number.isFinite(out.x) || !Number.isFinite(out.y)) return null;
  if (out.x < 0 || out.y < 0 || out.x > base.w - 1 || out.y > base.h - 1) return null;
  return out;
}

export interface TrackResult {
  /** Tracked positions (equal to the input for lost points). */
  points: Pt[];
  /** Whether each point passed the texture and forward-backward checks. */
  ok: boolean[];
}

/** Pyramidal Lucas-Kanade with a forward-backward consistency check. */
export function trackPoints(prevImg: Gray, nextImg: Gray, pts: Pt[], opts: LkOptions = {}): TrackResult {
  const o = { ...LK_DEFAULTS, ...opts };
  const prev = buildPyramid(prevImg, o.levels);
  const next = buildPyramid(nextImg, o.levels);
  const points: Pt[] = [];
  const ok: boolean[] = [];
  for (const p of pts) {
    const fwd = lkPoint(prev, next, p, o);
    const back = fwd && lkPoint(next, prev, fwd, o);
    const good = !!back && Math.hypot(back.x - p.x, back.y - p.y) <= o.fbThreshold;
    points.push(good ? fwd! : { ...p });
    ok.push(good);
  }
  return { points, ok };
}

// ── Similarity transform: x' = a·x − b·y + tx, y' = b·x + a·y + ty ──────────

export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

export const IDENTITY: Similarity = { a: 1, b: 0, tx: 0, ty: 0 };

export function applySimilarity(t: Similarity, p: Pt): Pt {
  return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty };
}

function fitOnce(src: Pt[], dst: Pt[]): Similarity | null {
  const n = src.length;
  if (n === 0) return null;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) {
    msx += src[i].x; msy += src[i].y; mdx += dst[i].x; mdy += dst[i].y;
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  if (n === 1) return { a: 1, b: 0, tx: mdx - msx, ty: mdy - msy };
  let sxx = 0, sxy = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i].x - msx, py = src[i].y - msy;
    const qx = dst[i].x - mdx, qy = dst[i].y - mdy;
    sxx += px * qx + py * qy;
    sxy += px * qy - py * qx;
    v += px * px + py * py;
  }
  if (v < 1e-9) return { a: 1, b: 0, tx: mdx - msx, ty: mdy - msy };
  let a = sxx / v;
  let b = sxy / v;
  // Frame-to-frame motion is small: clamp scale to a sane range.
  const s = Math.hypot(a, b);
  const clamped = Math.min(1.25, Math.max(0.8, s));
  if (s > 0 && clamped !== s) { a *= clamped / s; b *= clamped / s; }
  return { a, b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy) };
}

/** Least-squares similarity fit with one round of outlier rejection. */
export function fitSimilarity(src: Pt[], dst: Pt[]): Similarity | null {
  const t = fitOnce(src, dst);
  if (!t || src.length < 4) return t;
  const res = src.map((p, i) => {
    const q = applySimilarity(t, p);
    return Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
  });
  const med = [...res].sort((x, y) => x - y)[res.length >> 1];
  const cut = Math.max(2, 2.5 * med);
  const keep = res.map((r) => r <= cut);
  const s2 = src.filter((_, i) => keep[i]);
  const d2 = dst.filter((_, i) => keep[i]);
  return s2.length >= 2 ? fitOnce(s2, d2) : t;
}

/** Evenly spaced sample points inside a polygon (for tracking its interior). */
export function samplePolygon(poly: Pt[], max = 40): Pt[] {
  if (poly.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  const step = Math.max(4, Math.sqrt(area / max));
  const out: Pt[] = [];
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      if (pointInPolygon(poly, x, y)) out.push({ x, y });
    }
  }
  return out;
}

function pointInPolygon(ps: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) {
    const xi = ps[i].x, yi = ps[i].y, xj = ps[j].x, yj = ps[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Evenly spaced points where a mask's alpha channel is set. */
export function sampleMask(alpha: Uint8ClampedArray | Uint8Array, w: number, h: number, max = 150): Pt[] {
  let count = 0;
  for (let i = 3; i < alpha.length; i += 4) if (alpha[i] > 0) count++;
  if (!count) return [];
  const step = Math.max(2, Math.round(Math.sqrt(count / max)));
  const out: Pt[] = [];
  for (let y = Math.floor(step / 2); y < h; y += step) {
    for (let x = Math.floor(step / 2); x < w; x += step) {
      if (alpha[(y * w + x) * 4 + 3] > 0) out.push({ x, y });
    }
  }
  return out;
}

export interface PolygonTrack {
  points: Pt[];
  /** Fraction of the polygon's vertices that were tracked directly. */
  trackedFraction: number;
}

/**
 * Move a polygon to the next frame: vertices that track reliably use their own
 * flow; the rest follow a similarity transform fitted to every tracked point of
 * the polygon (vertices + interior samples). `fallback` is used when nothing
 * on the polygon tracks at all.
 */
export function trackPolygon(prev: Gray, next: Gray, poly: Pt[], fallback: Similarity, opts?: LkOptions): PolygonTrack {
  const interior = samplePolygon(poly);
  const all = [...poly, ...interior];
  const tr = trackPoints(prev, next, all, opts);
  const src = all.filter((_, i) => tr.ok[i]);
  const dst = tr.points.filter((_, i) => tr.ok[i]);
  const t = src.length >= 2 ? fitSimilarity(src, dst)! : fallback;
  let direct = 0;
  const points = poly.map((p, i) => {
    if (tr.ok[i]) {
      // Guard against a single vertex snapping far from the shape's motion.
      const pred = applySimilarity(t, p);
      const q = tr.points[i];
      if (Math.hypot(q.x - pred.x, q.y - pred.y) <= 8) { direct++; return q; }
      return pred;
    }
    return applySimilarity(t, p);
  });
  return { points, trackedFraction: poly.length ? direct / poly.length : 0 };
}

/** Similarity transform describing how a mask region moves between frames. */
export function trackRegion(prev: Gray, next: Gray, pts: Pt[], fallback: Similarity, opts?: LkOptions): { transform: Similarity; tracked: number } {
  const tr = trackPoints(prev, next, pts, opts);
  const src = pts.filter((_, i) => tr.ok[i]);
  const dst = tr.points.filter((_, i) => tr.ok[i]);
  const t = src.length >= 3 ? fitSimilarity(src, dst) : null;
  return { transform: t ?? fallback, tracked: src.length };
}

/** Global frame motion from a coarse grid — fallback for untextured regions. */
export function globalMotion(prev: Gray, next: Gray, opts?: LkOptions): Similarity {
  const pts: Pt[] = [];
  const nx = 8, ny = 6;
  for (let j = 1; j <= ny; j++) {
    for (let i = 1; i <= nx; i++) {
      pts.push({ x: (prev.w * i) / (nx + 1), y: (prev.h * j) / (ny + 1) });
    }
  }
  return trackRegion(prev, next, pts, IDENTITY, opts).transform;
}
