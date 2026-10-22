// Segmentation-stage IO: feed the embedded annotator the project's frames and
// persist its masks/annotations back into 02_segmentation/. Frames are served to
// the renderer lazily via the endoseg-frame:// protocol (see electron/main.ts),
// so we never base64 thousands of full-res frames into memory.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { projectDir, renameWithRetry, writeFileAtomic } from "./library.js";
import type { SegFrame, SegFramesResult, SegSaveResult, FrameReviewResult } from "../shared/ipc.js";

const FRAME_RE = /\.(png|jpg|jpeg)$/i;
type FrameSource = "kept" | "raw";

function framesDir(baseDir: string, projectId: string, source: FrameSource): string {
  return path.join(projectDir(baseDir, projectId), "01_frames", source);
}

function segDir(baseDir: string, projectId: string): string {
  return path.join(projectDir(baseDir, projectId), "02_segmentation");
}

async function listImageFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => FRAME_RE.test(n)).sort();
}

/** Read a PNG's pixel dimensions from its IHDR header (no decode), or 0/0. */
async function pngSize(file: string): Promise<{ width: number; height: number }> {
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    // 8-byte PNG signature, then IHDR: length(4) + "IHDR"(4) + width(4) + height(4).
    if (buf.toString("ascii", 1, 4) !== "PNG") return { width: 0, height: 0 };
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return { width: 0, height: 0 };
  } finally {
    await fh?.close();
  }
}

/**
 * Resolve (and security-check) an absolute frame path for the protocol handler.
 * Rejects unknown sources and any filename that tries to escape the frames dir.
 */
export function resolveFramePath(
  baseDir: string,
  projectId: string,
  source: string,
  filename: string,
): string | null {
  if (source !== "kept" && source !== "raw") return null;
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const dir = framesDir(baseDir, projectId, source);
  const abs = path.normalize(path.join(dir, filename));
  // Must stay within the frames directory.
  if (abs !== path.join(dir, filename)) return null;
  return abs;
}

/** Prefer the deduped representatives; fall back to raw; else none. */
export async function listSegFrames(
  baseDir: string,
  projectId: string,
): Promise<SegFramesResult> {
  for (const source of ["kept", "raw"] as const) {
    const dir = framesDir(baseDir, projectId, source);
    const files = await listImageFiles(dir);
    if (files.length) {
      const frames: SegFrame[] = await Promise.all(
        files.map(async (name) => {
          const { width, height } = await pngSize(path.join(dir, name));
          return {
            frameId: name,
            name: name.replace(FRAME_RE, ""),
            url: `endoseg-frame://frame/${encodeURIComponent(projectId)}/${source}/${encodeURIComponent(name)}`,
            width,
            height,
          };
        }),
      );
      return { source, frames };
    }
  }
  return { source: "none", frames: [] };
}

/** Load dedup-report.json and attach frame thumbnail URLs for the review page. */
export async function getFrameReview(
  baseDir: string,
  projectId: string,
): Promise<FrameReviewResult | null> {
  const reportPath = path.join(projectDir(baseDir, projectId), "01_frames", "dedup-report.json");
  try {
    const text = await fs.readFile(reportPath, "utf8");
    const report = JSON.parse(text) as {
      kept: number; dropped: number; total: number;
      decisions: Array<{ file: string; kept: boolean; distance?: number; representative: string }>;
    };
    const items = report.decisions.map((d) => ({
      file: d.file,
      url: `endoseg-frame://frame/${encodeURIComponent(projectId)}/raw/${encodeURIComponent(d.file)}`,
      kept: d.kept,
      distance: d.distance,
      representative: d.representative,
    }));
    return { items, kept: report.kept, dropped: report.dropped, total: report.total };
  } catch {
    return null;
  }
}

const ANNOTATIONS_FILE = "annotations.leus";

/** Read back a previously saved annotation snapshot, or null if none exists. */
export async function loadSegmentationSnapshot(
  baseDir: string,
  projectId: string,
): Promise<unknown | null> {
  try {
    const text = await fs.readFile(path.join(segDir(baseDir, projectId), ANNOTATIONS_FILE), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "frame";
}

function decodePngDataUrl(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return Buffer.from(m[1], "base64");
}

/**
 * Persist the annotator snapshot into 02_segmentation/:
 *  - annotations.leus  — the full snapshot (re-loadable on reopen)
 *  - masks/<frame>__class<labelId>.png — one PNG per painted class per frame
 * The masks/ folder is rebuilt from scratch each save so it mirrors current state.
 *
 * Crash/network-safe: the snapshot is written atomically (previous copy kept as
 * annotations.leus.bak), and masks are built in a sibling temp folder that is
 * only swapped in once complete — a failed save never leaves a half-written file.
 */
export async function saveSegmentationSnapshot(
  baseDir: string,
  projectId: string,
  snapshot: unknown,
): Promise<SegSaveResult> {
  const dir = segDir(baseDir, projectId);
  const finalMasksDir = path.join(dir, "masks");
  const masksDir = path.join(dir, `masks.tmp-${process.pid}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(masksDir, { recursive: true, force: true });
  await fs.mkdir(masksDir, { recursive: true });

  const annFile = path.join(dir, ANNOTATIONS_FILE);
  await fs.copyFile(annFile, `${annFile}.bak`).catch(() => { /* first save */ });
  await writeFileAtomic(annFile, JSON.stringify(snapshot, null, 2));

  let frameCount = 0;
  let maskCount = 0;
  const frames = (snapshot as { frames?: unknown }).frames;
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      frameCount += 1;
      const name = sanitizeForFile(String((frame as { name?: unknown }).name ?? `frame_${frameCount}`));
      const labelMasks = (frame as { label_masks?: unknown }).label_masks;
      if (labelMasks && typeof labelMasks === "object") {
        for (const [labelId, dataUrl] of Object.entries(labelMasks as Record<string, unknown>)) {
          const buf = decodePngDataUrl(dataUrl);
          if (!buf) continue;
          await fs.writeFile(path.join(masksDir, `${name}__class${sanitizeForFile(labelId)}.png`), buf);
          maskCount += 1;
        }
      }
    }
  }
  // Swap the freshly built masks in (rebuilt each save so deleted classes/frames don't linger).
  await fs.rm(finalMasksDir, { recursive: true, force: true });
  await renameWithRetry(masksDir, finalMasksDir);
  return { frameCount, maskCount };
}
