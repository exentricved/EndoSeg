// Dedup: collapse near-duplicate frames using a perceptual difference-hash
// (dHash). Non-destructive — raw frames are untouched; surviving representatives
// are copied into 01_frames/kept/ and every decision is recorded in
// dedup-report.json.
//
// Pure helpers (dHash, hamming, planDedup) are separated from the ffmpeg/fs
// orchestrator so the decision logic is cheap to unit-test.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runBinary } from "./proc.js";
import { projectDir } from "./library.js";

// dHash works on a tiny grayscale thumbnail: (HASH_W = HASH_SIZE+1) x HASH_SIZE,
// comparing each pixel to its right neighbour → HASH_SIZE*HASH_SIZE = 64 bits.
export const HASH_SIZE = 8;
export const HASH_W = HASH_SIZE + 1; // 9
const BYTES_PER_THUMB = HASH_W * HASH_SIZE; // 72

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Compute a 64-bit difference hash from a 9x8 grayscale byte thumbnail. */
export function dHash(gray: Uint8Array | Buffer): bigint {
  let hash = 0n;
  let bit = 0n;
  for (let r = 0; r < HASH_SIZE; r++) {
    for (let c = 0; c < HASH_SIZE; c++) {
      const left = gray[r * HASH_W + c];
      const right = gray[r * HASH_W + c + 1];
      if (left < right) hash |= 1n << bit;
      bit++;
    }
  }
  return hash;
}

/** Hamming distance between two 64-bit hashes. */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export interface FrameHash {
  file: string;
  hash: bigint;
}

export interface DedupDecision {
  file: string;
  hash: string;
  kept: boolean;
  /** The representative this frame maps to (itself if kept). */
  representative: string;
  /** Hamming distance to the previous representative (undefined for the first). */
  distance?: number;
}

export interface DedupPlan {
  kept: string[];
  dropped: string[];
  decisions: DedupDecision[];
}

/**
 * Walk frames in order, keeping a frame whenever it differs from the last kept
 * representative by more than `threshold`; otherwise drop it as a near-duplicate.
 */
export function planDedup(frames: FrameHash[], threshold: number): DedupPlan {
  const kept: string[] = [];
  const dropped: string[] = [];
  const decisions: DedupDecision[] = [];
  let repFile: string | null = null;
  let repHash = 0n;

  for (const frame of frames) {
    const hex = frame.hash.toString(16).padStart(16, "0");
    if (repFile === null) {
      repFile = frame.file;
      repHash = frame.hash;
      kept.push(frame.file);
      decisions.push({ file: frame.file, hash: hex, kept: true, representative: frame.file });
      continue;
    }
    const d = hamming(frame.hash, repHash);
    if (d <= threshold) {
      dropped.push(frame.file);
      decisions.push({ file: frame.file, hash: hex, kept: false, representative: repFile, distance: d });
    } else {
      repFile = frame.file;
      repHash = frame.hash;
      kept.push(frame.file);
      decisions.push({ file: frame.file, hash: hex, kept: true, representative: frame.file, distance: d });
    }
  }
  return { kept, dropped, decisions };
}

// ── ffmpeg + fs orchestrator ─────────────────────────────────────────────────

function listFrames(files: string[]): string[] {
  return files.filter((f) => /^frame_\d+\.png$/.test(f)).sort();
}

/** Hash every raw frame via a single ffmpeg pass producing 9x8 gray thumbnails. */
export async function hashFrames(
  ffmpegPath: string,
  rawDir: string,
  onProgress?: (done: number) => void,
): Promise<FrameHash[]> {
  const files = listFrames(await fs.readdir(rawDir));
  if (files.length === 0) return [];

  const pattern = path.join(rawDir, "frame_%06d.png");
  const res = await runBinary(
    ffmpegPath,
    [
      "-hide_banner",
      "-start_number", "1",
      "-i", pattern,
      "-vf", `scale=${HASH_W}:${HASH_SIZE}:flags=area,format=gray`,
      "-f", "rawvideo",
      "-",
    ],
    {
      onStderrLine: (line) => {
        const m = line.match(/frame=\s*(\d+)/);
        if (m && onProgress) onProgress(Number(m[1]));
      },
    },
  );
  if (res.code !== 0) throw new Error(`ffmpeg hashing failed (${res.code}): ${res.stderr.slice(-400)}`);

  const total = Math.floor(res.stdout.length / BYTES_PER_THUMB);
  const count = Math.min(total, files.length);
  const out: FrameHash[] = [];
  for (let i = 0; i < count; i++) {
    const slice = res.stdout.subarray(i * BYTES_PER_THUMB, (i + 1) * BYTES_PER_THUMB);
    out.push({ file: files[i], hash: dHash(slice) });
  }
  return out;
}

export interface DedupReport {
  schemaVersion: 1;
  at: string;
  threshold: number;
  total: number;
  kept: number;
  dropped: number;
  decisions: DedupDecision[];
}

export interface DedupResult {
  total: number;
  kept: number;
  dropped: number;
}

export interface RunDedupOptions {
  baseDir: string;
  projectId: string;
  ffmpegPath: string;
  threshold: number;
  now: string;
  onProgress?: (done: number) => void;
}

/** Full dedup: hash raw frames → plan → copy kept frames → write report. */
export async function runDedup(opts: RunDedupOptions): Promise<DedupResult> {
  const dir = projectDir(opts.baseDir, opts.projectId);
  const rawDir = path.join(dir, "01_frames", "raw");
  const keptDir = path.join(dir, "01_frames", "kept");

  const hashes = await hashFrames(opts.ffmpegPath, rawDir, opts.onProgress);
  if (hashes.length === 0) throw new Error("No extracted frames found — run intake first.");

  const plan = planDedup(hashes, opts.threshold);

  // Rebuild kept/ from scratch so re-running is idempotent.
  await fs.rm(keptDir, { recursive: true, force: true });
  await fs.mkdir(keptDir, { recursive: true });
  for (const file of plan.kept) {
    await fs.copyFile(path.join(rawDir, file), path.join(keptDir, file));
  }

  const report: DedupReport = {
    schemaVersion: 1,
    at: opts.now,
    threshold: opts.threshold,
    total: hashes.length,
    kept: plan.kept.length,
    dropped: plan.dropped.length,
    decisions: plan.decisions,
  };
  await fs.writeFile(
    path.join(dir, "01_frames", "dedup-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );

  return { total: hashes.length, kept: plan.kept.length, dropped: plan.dropped.length };
}
