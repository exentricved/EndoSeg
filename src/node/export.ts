// Export stage: packages annotated frames + multi-class label maps + metadata.json
// into 03_export/<export-id>/ for ML training use.
//
// Label maps are 8-bit grayscale PNGs where each pixel value is the class ID
// (0 = background, 1-10 = annotated classes). Class IDs mirror SegmentationView.tsx.

import { deflateSync, inflateSync } from "node:zlib";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { projectDir } from "./library.js";
import type { ExportProgress } from "../shared/ipc.js";

// ---- Class catalog (must stay in sync with SegmentationView.tsx CLASSES) ----
const EXPORT_CLASSES = [
  { id: 0,  name: "background",               abbr: "BG",  color: "#000000" },
  { id: 1,  name: "PAPILLA_BODY",               abbr: "PB",  color: "#F472B6" },
  { id: 2,  name: "PAPILLA_ORIFICE",            abbr: "PO",  color: "#A78BFA" },
  { id: 3,  name: "HOODING_FOLD",               abbr: "HF",  color: "#FB923C" },
  { id: 4,  name: "PERIAMPULLARY_DIVERTICULUM", abbr: "PAD", color: "#7C3AED" },
  { id: 5,  name: "DUODENAL_WALL",              abbr: "DW",  color: "#4ADE80" },
  { id: 6,  name: "INSTRUMENT_MASK",            abbr: "INS", color: "#9CA3AF" },
  { id: 7,  name: "SPECULAR_HIGHLIGHT",         abbr: "SH",  color: "#FDE68A" },
  { id: 8,  name: "FLUID_POOL",                 abbr: "FP",  color: "#22D3EE" },
  { id: 9,  name: "ENDOSCOPE",                  abbr: "ENS", color: "#0EA5E9" },
  { id: 10, name: "SPHINCTEROTOME",             abbr: "SPH", color: "#EF4444" },
] as const;

// ---- Internal types ----
type Pt = { x: number; y: number };
type Polygon = { id: string; classId: number; points: Pt[] };

interface AnnotationFrame {
  frameId: string;
  name: string;
  polygons: Polygon[];
  phase?: string;
}

interface NativeSnapshot {
  version: 1;
  frames: AnnotationFrame[];
  /** Frame ids marked as split-screen (endoscopy + fluoroscopy) — excluded from export. */
  splitScreen?: string[];
}

export interface ExportResult {
  exportId: string;
  exportDir: string;
  frameCount: number;
  labelMapCount: number;
}

// ---- Minimal dep-free 8-bit grayscale PNG encoder ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** Encode a Uint8Array of grayscale pixel values as an 8-bit PNG. */
function writePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each row is prefixed with filter byte 0 (None).
  const raw = Buffer.allocUnsafe(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) {
      raw[y * (width + 1) + 1 + x] = pixels[y * width + x]!;
    }
  }

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- Polygon rasterizer ----

/** Scanline even-odd fill into a flat pixel array (same algorithm as canvas fill). */
function fillPoly(pts: Pt[], value: number, px: Uint8Array, w: number, h: number): void {
  if (pts.length < 3) return;
  const n = pts.length;
  const minY = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(...pts.map((p) => p.y))));
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = pts[i]!, pj = pts[j]!;
      if ((pi.y <= y && y < pj.y) || (pj.y <= y && y < pi.y))
        xs.push(pi.x + ((y - pi.y) / (pj.y - pi.y)) * (pj.x - pi.x));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]!));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1]!));
      for (let x = x0; x <= x1; x++) px[y * w + x] = value;
    }
  }
}

/**
 * Rasterize a frame's polygons into an 8-bit label map (pixel = class ID, 0 = background).
 * Polygons are drawn in class-ID order so higher IDs (instruments) overwrite lower ones (anatomy).
 */
function rasterizeLabelMap(polygons: Polygon[], w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h);
  const sorted = [...polygons].sort((a, b) => a.classId - b.classId);
  for (const p of sorted) {
    if (p.classId >= 1 && p.classId <= 255) fillPoly(p.points, p.classId, px, w, h);
  }
  return px;
}

// ---- PNG decoder (for reading canvas-produced mask PNGs) ----

function pngUnfilter(row: Buffer, prev: Buffer, bpp: number): void {
  const f = row[0]!;
  if (f === 0) return;
  if (f === 1) {
    for (let i = bpp + 1; i < row.length; i++) row[i] = (row[i]! + row[i - bpp]!) & 0xff;
  } else if (f === 2) {
    for (let i = 1; i < row.length; i++) row[i] = (row[i]! + prev[i]!) & 0xff;
  } else if (f === 3) {
    for (let i = 1; i < row.length; i++) {
      const a = i - bpp >= 1 ? row[i - bpp]! : 0;
      row[i] = (row[i]! + ((a + prev[i]!) >>> 1)) & 0xff;
    }
  } else if (f === 4) {
    for (let i = 1; i < row.length; i++) {
      const a = i - bpp >= 1 ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i - bpp >= 1 ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      row[i] = (row[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
}

/**
 * Decode a canvas-generated mask PNG (white or colored on transparent background)
 * and return a 1-bit mask (Uint8Array of 0/1) plus dimensions, or null on failure.
 * Handles color types 0 (gray), 2 (RGB), 4 (gray+alpha), 6 (RGBA).
 */
function decodeMaskPng(data: Buffer): { mask: Uint8Array; width: number; height: number } | null {
  try {
    if (data.length < 33 || data[0] !== 0x89 || data.toString("ascii", 1, 4) !== "PNG") return null;
    let pos = 8;
    let width = 0, height = 0, colorType = -1;
    const idatChunks: Buffer[] = [];
    while (pos + 12 <= data.length) {
      const len = data.readUInt32BE(pos); pos += 4;
      const type = data.toString("ascii", pos, pos + 4); pos += 4;
      if (type === "IHDR") {
        width = data.readUInt32BE(pos);
        height = data.readUInt32BE(pos + 4);
        colorType = data[pos + 9]!;
      } else if (type === "IDAT") {
        idatChunks.push(data.subarray(pos, pos + len));
      } else if (type === "IEND") { break; }
      pos += len + 4;
    }
    if (!width || !height || idatChunks.length === 0) return null;
    // bpp (bytes per pixel) by color type: 0=gray(1), 2=RGB(3), 3=idx(1), 4=gray+A(2), 6=RGBA(4)
    const bpp = [1, 0, 3, 1, 2, 0, 4][colorType] ?? 0;
    if (!bpp) return null;
    const alphaOff = colorType === 4 ? 1 : colorType === 6 ? 3 : -1;
    const raw = inflateSync(Buffer.concat(idatChunks));
    const stride = 1 + width * bpp;
    if (raw.length < stride * height) return null;
    const mask = new Uint8Array(width * height);
    const prev = Buffer.alloc(stride, 0);
    for (let y = 0; y < height; y++) {
      const row = Buffer.from(raw.subarray(y * stride, (y + 1) * stride));
      pngUnfilter(row, prev, bpp);
      row.copy(prev);
      for (let x = 0; x < width; x++) {
        const base = 1 + x * bpp;
        const check = alphaOff >= 0 ? base + alphaOff : base;
        if (row[check]! > 0) mask[y * width + x] = 1;
      }
    }
    return { mask, width, height };
  } catch { return null; }
}

/**
 * Build an 8-bit label map (pixel = class ID, 0 = background) by combining
 * polygon rasterization with any saved per-class binary mask PNGs.
 * Higher class IDs overwrite lower ones on overlap (same as polygon rasterizer).
 */
async function buildLabelMap(
  polys: Polygon[],
  masksDir: string,
  frameName: string,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const pixels = rasterizeLabelMap(polys, w, h);
  try {
    const files = await fs.readdir(masksDir);
    const prefix = `${frameName}__class`;
    const maskFiles = files
      .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
      .sort((a, b) => {
        const aId = parseInt(a.slice(prefix.length, -4)) || 0;
        const bId = parseInt(b.slice(prefix.length, -4)) || 0;
        return aId - bId; // ascending so higher IDs overwrite lower on overlap
      });
    for (const mf of maskFiles) {
      const classId = parseInt(mf.slice(prefix.length, -4)) || 0;
      if (classId < 1 || classId > 255) continue;
      const data = await fs.readFile(path.join(masksDir, mf));
      const decoded = decodeMaskPng(data);
      if (!decoded || decoded.width !== w || decoded.height !== h) continue;
      for (let i = 0; i < decoded.mask.length; i++) {
        if (decoded.mask[i]) pixels[i] = classId;
      }
    }
  } catch { /* masks dir may not exist */ }
  return pixels;
}

// ---- Helpers ----

const FRAME_RE = /\.(png|jpg|jpeg)$/i;

async function findFrameDir(baseDir: string, projectId: string): Promise<string | null> {
  for (const sub of ["raw", "kept"] as const) {
    const dir = path.join(projectDir(baseDir, projectId), "01_frames", sub);
    try {
      const files = await fs.readdir(dir);
      if (files.some((f) => FRAME_RE.test(f))) return dir;
    } catch { /* try next */ }
  }
  return null;
}

async function pngSize(file: string): Promise<{ w: number; h: number }> {
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    if (buf.toString("ascii", 1, 4) !== "PNG") return { w: 0, h: 0 };
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return { w: 0, h: 0 };
  } finally {
    await fh?.close();
  }
}

function makeExportId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `export_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- Main export function ----

export async function runExport(
  baseDir: string,
  projectId: string,
  onProgress: (p: ExportProgress) => void,
  /** Folder to write <export-id>/ into; defaults to the project's 03_export/. */
  exportRoot?: string,
): Promise<ExportResult> {
  const projDir = projectDir(baseDir, projectId);
  const segDir  = path.join(projDir, "02_segmentation");
  const masksDir = path.join(segDir, "masks");

  // Load annotations snapshot.
  let annotatedFrames: AnnotationFrame[] = [];
  try {
    const raw = await fs.readFile(path.join(segDir, "annotations.leus"), "utf8");
    const snap = JSON.parse(raw) as NativeSnapshot;
    if (snap.version === 1 && Array.isArray(snap.frames)) {
      const skip = new Set(Array.isArray(snap.splitScreen) ? snap.splitScreen : []);
      annotatedFrames = snap.frames.filter((f) => !skip.has(f.frameId));
    }
  } catch { /* no annotations yet — export will be empty */ }

  // Locate source frames (raw; legacy deduped projects fall back to kept).
  const framesDir = await findFrameDir(baseDir, projectId);

  // Create timestamped output directory.
  const exportId = makeExportId();
  const exportDir = path.join(exportRoot ?? path.join(projDir, "03_export"), exportId);
  const imagesDir = path.join(exportDir, "images");
  const labelsDir = path.join(exportDir, "label_maps");
  await fs.mkdir(imagesDir, { recursive: true });
  await fs.mkdir(labelsDir, { recursive: true });

  const total = annotatedFrames.length;
  let labelMapCount = 0;

  type MetaFrame = {
    name: string;
    image: string | null;
    labelMap: string | null;
    phase: string | null;
    polygonCount: number;
    classIds: number[];
  };
  const metaFrames: MetaFrame[] = [];

  for (let i = 0; i < annotatedFrames.length; i++) {
    const f = annotatedFrames[i]!;
    onProgress({ phase: "frames", done: i, total });

    const pngName = `${f.name}.png`;
    let imageCopied = false;
    let labelMapWritten = false;

    // Copy the source frame image.
    if (framesDir) {
      try {
        await fs.copyFile(path.join(framesDir, pngName), path.join(imagesDir, pngName));
        imageCopied = true;
      } catch { /* frame file missing; skip */ }
    }

    const polys = f.polygons ?? [];

    // Build label map from polygon annotations + any brush-painted pixel masks.
    let w = 0, h = 0;
    if (framesDir) ({ w, h } = await pngSize(path.join(framesDir, pngName)));
    // Fallback: probe a saved binary mask file for dimensions when frame is missing.
    if (!w || !h) {
      try {
        const mf = (await fs.readdir(masksDir)).find((n) => n.startsWith(f.name + "__class") && n.endsWith(".png"));
        if (mf) ({ w, h } = await pngSize(path.join(masksDir, mf)));
      } catch { /* no masks dir */ }
    }
    if (w > 0 && h > 0) {
      const pixels = await buildLabelMap(polys, masksDir, f.name, w, h);
      if (pixels.some((v) => v > 0)) {
        await fs.writeFile(path.join(labelsDir, pngName), writePng(pixels, w, h));
        labelMapWritten = true;
        labelMapCount++;
      }
    }

    metaFrames.push({
      name: f.name,
      image: imageCopied ? `images/${pngName}` : null,
      labelMap: labelMapWritten ? `label_maps/${pngName}` : null,
      phase: f.phase ?? null,
      polygonCount: polys.length,
      classIds: [...new Set(polys.map((p) => p.classId))].sort((a, b) => a - b),
    });
  }

  onProgress({ phase: "metadata", done: total, total });

  // Write metadata.json.
  const metadata = {
    version: 1,
    exportId,
    exportedAt: new Date().toISOString(),
    project: { id: projectId },
    classes: EXPORT_CLASSES,
    frames: metaFrames,
  };
  await fs.writeFile(
    path.join(exportDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );

  return { exportId, exportDir, frameCount: total, labelMapCount };
}
