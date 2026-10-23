// Intake: copy a source video into a project, hash it, read its metadata, and
// make a browser-playable preview when needed for phase labelling. Frames are
// extracted later, per phase (see phases.ts). Uses bundled ffmpeg/ffprobe.
//
// Pure helpers (parsing, arg building, sanitizing) are separated from the
// spawn-based orchestrators so the former can be unit-tested cheaply and the
// latter exercised by a real-ffmpeg integration test.

import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { run } from "./proc.js";
import { projectDir, writeJsonAtomic } from "./library.js";
import { buildPreviewArgs, isBrowserPlayable } from "../core/phases.js";

export interface VideoMeta {
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  codec: string;
  bytes: number;
}

export interface IntakeRecord {
  schemaVersion: 1;
  sourceFile: string;
  /** Full original path of the video that was taken in. */
  sourcePath: string;
  importedAt: string;
  sha256: string;
  /** File the labelling player streams, relative to 00_intake/ (the source copy or preview.mp4). */
  playbackFile: string;
  meta: VideoMeta;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Parse an ffprobe rational frame-rate string like "30000/1001" → 29.97. */
export function parseFps(value: unknown): number {
  if (typeof value !== "string") return 0;
  const m = value.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (den === 0) return 0;
    return Math.round((num / den) * 100) / 100;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Parse `ffprobe -print_format json -show_format -show_streams` output. */
export function parseFfprobe(raw: unknown): VideoMeta {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const format = (obj.format ?? {}) as Record<string, unknown>;
  const streams = Array.isArray(obj.streams) ? (obj.streams as Record<string, unknown>[]) : [];
  const video = streams.find((s) => s.codec_type === "video") ?? {};
  return {
    durationSec: Number(format.duration) || 0,
    bytes: Number(format.size) || 0,
    fps: parseFps(video.r_frame_rate ?? video.avg_frame_rate),
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    codec: typeof video.codec_name === "string" ? video.codec_name : "unknown",
  };
}

/** Strip a filename to a safe basename (no directory traversal, no odd chars). */
export function safeBasename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base.replace(/^[._]+/, "") || "video";
}

export function buildProbeArgs(input: string): string[] {
  return ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", input];
}

// ── Filesystem + spawn orchestrators ─────────────────────────────────────────

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function probeVideo(ffprobePath: string, input: string): Promise<VideoMeta> {
  const res = await run(ffprobePath, buildProbeArgs(input));
  if (res.code !== 0) throw new Error(`ffprobe failed (${res.code}): ${res.stderr.slice(-400)}`);
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  return parseFfprobe(json);
}

/** Parse ffmpeg's "time=hh:mm:ss.xx" progress field into seconds, or null. */
export function parseProgressTime(line: string): number | null {
  const m = line.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export interface RunIntakeOptions {
  baseDir: string;
  projectId: string;
  sourcePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  now: string;
  onProgress?: (p: { phase: "copy" | "probe" | "preview"; percent?: number }) => void;
}

/** Full intake: copy → hash → probe → (preview) → write intake.json. */
export async function runIntake(opts: RunIntakeOptions): Promise<IntakeRecord> {
  const dir = projectDir(opts.baseDir, opts.projectId);
  const intakeDir = path.join(dir, "00_intake");
  const sourceDir = path.join(intakeDir, "source");
  // A re-import replaces the previous video rather than sitting beside it.
  await fs.rm(sourceDir, { recursive: true, force: true });
  await fs.mkdir(sourceDir, { recursive: true });

  const destName = safeBasename(opts.sourcePath);
  const dest = path.join(sourceDir, destName);

  opts.onProgress?.({ phase: "copy" });
  await fs.copyFile(opts.sourcePath, dest);
  const sha256 = await sha256File(dest);

  opts.onProgress?.({ phase: "probe" });
  const meta = await probeVideo(opts.ffprobePath, dest);

  const previewPath = path.join(intakeDir, "preview.mp4");
  await fs.rm(previewPath, { force: true });
  let playbackFile = `source/${destName}`;
  if (!isBrowserPlayable(destName, meta.codec)) {
    opts.onProgress?.({ phase: "preview", percent: 0 });
    const res = await run(opts.ffmpegPath, buildPreviewArgs(dest, previewPath), {
      onStderrLine: (line) => {
        const sec = parseProgressTime(line);
        if (sec != null && meta.durationSec > 0) {
          opts.onProgress?.({ phase: "preview", percent: Math.min(100, Math.round((sec / meta.durationSec) * 100)) });
        }
      },
    });
    if (res.code !== 0) throw new Error(`ffmpeg preview failed (${res.code}): ${res.stderr.slice(-400)}`);
    playbackFile = "preview.mp4";
  }

  const record: IntakeRecord = {
    schemaVersion: 1,
    sourceFile: destName,
    sourcePath: opts.sourcePath,
    importedAt: opts.now,
    sha256,
    playbackFile,
    meta,
  };
  await writeJsonAtomic(path.join(intakeDir, "intake.json"), record);
  return record;
}
