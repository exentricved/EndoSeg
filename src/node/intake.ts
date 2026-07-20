// Intake: copy a source video into a project, hash it, read its metadata, and
// extract a sampled set of frames. Uses bundled ffmpeg/ffprobe (no Python).
//
// Pure helpers (parsing, arg building, sanitizing) are separated from the
// spawn-based orchestrators so the former can be unit-tested cheaply and the
// latter exercised by a real-ffmpeg integration test.

import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { run } from "./proc.js";
import { projectDir } from "./library.js";

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
  importedAt: string;
  sha256: string;
  frameSampleEvery: number;
  framesExtracted: number;
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

/** ffmpeg args to keep 1 of every `sampleEvery` frames as a PNG sequence. */
export function buildExtractArgs(
  input: string,
  outPattern: string,
  sampleEvery: number,
): string[] {
  const n = Math.max(1, Math.floor(sampleEvery));
  // The comma inside mod() must be escaped so ffmpeg does not read it as a
  // filtergraph separator.
  const filter = `select=not(mod(n\\,${n}))`;
  return ["-hide_banner", "-i", input, "-vf", filter, "-vsync", "vfr", "-y", outPattern];
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

export interface ExtractProgress {
  frames: number;
}

export async function extractFrames(
  ffmpegPath: string,
  input: string,
  outDir: string,
  sampleEvery: number,
  onProgress?: (p: ExtractProgress) => void,
): Promise<number> {
  await fs.mkdir(outDir, { recursive: true });
  const outPattern = path.join(outDir, "frame_%06d.png");
  const res = await run(ffmpegPath, buildExtractArgs(input, outPattern, sampleEvery), {
    onStderrLine: (line) => {
      const m = line.match(/frame=\s*(\d+)/);
      if (m && onProgress) onProgress({ frames: Number(m[1]) });
    },
  });
  if (res.code !== 0) throw new Error(`ffmpeg failed (${res.code}): ${res.stderr.slice(-400)}`);
  const files = await fs.readdir(outDir);
  return files.filter((f) => f.endsWith(".png")).length;
}

export interface RunIntakeOptions {
  baseDir: string;
  projectId: string;
  sourcePath: string;
  ffmpegPath: string;
  ffprobePath: string;
  sampleEvery: number;
  now: string;
  onProgress?: (p: { phase: "copy" | "probe" | "extract"; frames?: number }) => void;
}

/** Full intake: copy → hash → probe → extract → write intake.json. */
export async function runIntake(opts: RunIntakeOptions): Promise<IntakeRecord> {
  const dir = projectDir(opts.baseDir, opts.projectId);
  const sourceDir = path.join(dir, "00_intake", "source");
  const rawDir = path.join(dir, "01_frames", "raw");
  await fs.mkdir(sourceDir, { recursive: true });

  const destName = safeBasename(opts.sourcePath);
  const dest = path.join(sourceDir, destName);

  opts.onProgress?.({ phase: "copy" });
  await fs.copyFile(opts.sourcePath, dest);
  const sha256 = await sha256File(dest);

  opts.onProgress?.({ phase: "probe" });
  const meta = await probeVideo(opts.ffprobePath, dest);

  opts.onProgress?.({ phase: "extract" });
  const framesExtracted = await extractFrames(
    opts.ffmpegPath,
    dest,
    rawDir,
    opts.sampleEvery,
    (p) => opts.onProgress?.({ phase: "extract", frames: p.frames }),
  );

  const record: IntakeRecord = {
    schemaVersion: 1,
    sourceFile: destName,
    importedAt: opts.now,
    sha256,
    frameSampleEvery: opts.sampleEvery,
    framesExtracted,
    meta,
  };
  await fs.writeFile(
    path.join(dir, "00_intake", "intake.json"),
    JSON.stringify(record, null, 2),
    "utf8",
  );
  return record;
}
