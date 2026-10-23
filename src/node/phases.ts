// Phases stage IO: persist a video's phase labels, then export them — one
// re-encoded clip per span into <exportRoot>/<case>_<phase>/, and 1 fps frames
// of the endoscopic phases into 01_frames/raw/ for the annotator.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { run } from "./proc.js";
import { projectDir, writeJsonAtomic } from "./library.js";
import type { IntakeRecord } from "./intake.js";
import {
  type PhaseId,
  type PhaseLabels,
  PHASES,
  phaseById,
  parsePhaseLabels,
  numberSpans,
  caseNameFromSource,
  phaseFolderName,
  phaseClipName,
  phaseFrameName,
  buildClipArgs,
  buildPhaseFrameArgs,
  normalizeCrop,
  type CropRect,
} from "../core/phases.js";

function phasesFile(baseDir: string, projectId: string): string {
  return path.join(projectDir(baseDir, projectId), "00_intake", "phases.json");
}

/** Index of extracted frames → phase/time, read back by the annotator. */
export function frameIndexFile(baseDir: string, projectId: string): string {
  return path.join(projectDir(baseDir, projectId), "01_frames", "frames.json");
}

export async function loadPhaseLabels(baseDir: string, projectId: string): Promise<PhaseLabels> {
  try {
    return parsePhaseLabels(JSON.parse(await fs.readFile(phasesFile(baseDir, projectId), "utf8")));
  } catch {
    return { version: 1, spans: [] };
  }
}

export async function savePhaseLabels(baseDir: string, projectId: string, raw: unknown): Promise<PhaseLabels> {
  const labels = parsePhaseLabels(raw);
  await writeJsonAtomic(phasesFile(baseDir, projectId), labels);
  return labels;
}

export async function readIntakeRecord(baseDir: string, projectId: string): Promise<IntakeRecord | null> {
  try {
    const file = path.join(projectDir(baseDir, projectId), "00_intake", "intake.json");
    return JSON.parse(await fs.readFile(file, "utf8")) as IntakeRecord;
  } catch {
    return null;
  }
}

/** Spatial crop applied to clips and frames on export (00_intake/crop.json); null = whole picture. */
function cropFile(baseDir: string, projectId: string): string {
  return path.join(projectDir(baseDir, projectId), "00_intake", "crop.json");
}

export async function loadCrop(baseDir: string, projectId: string, intake?: IntakeRecord | null): Promise<CropRect | null> {
  const rec = intake ?? (await readIntakeRecord(baseDir, projectId));
  if (!rec) return null;
  try {
    const raw: unknown = JSON.parse(await fs.readFile(cropFile(baseDir, projectId), "utf8"));
    return normalizeCrop(raw, rec.meta.width, rec.meta.height);
  } catch {
    return null;
  }
}

/** Save (or with null/whole-frame, clear) the crop; resolves to what was stored. */
export async function saveCrop(baseDir: string, projectId: string, raw: unknown): Promise<CropRect | null> {
  const rec = await readIntakeRecord(baseDir, projectId);
  if (!rec) throw new Error("No video taken in yet");
  const crop = normalizeCrop(raw, rec.meta.width, rec.meta.height);
  if (crop) await writeJsonAtomic(cropFile(baseDir, projectId), crop);
  else await fs.rm(cropFile(baseDir, projectId), { force: true });
  return crop;
}

export interface FrameIndexEntry {
  phase: PhaseId;
  /** Which span of that phase (1-based, time order) — matches the clip's _NN. */
  span?: number;
  /** Seconds from the start of the source video. */
  timeSec: number;
}

/** frame file name → phase/time; empty when frames came from the old every-Nth intake. */
export async function loadFrameIndex(baseDir: string, projectId: string): Promise<Record<string, FrameIndexEntry>> {
  try {
    const raw = JSON.parse(await fs.readFile(frameIndexFile(baseDir, projectId), "utf8")) as { frames?: unknown };
    return raw.frames && typeof raw.frames === "object" ? (raw.frames as Record<string, FrameIndexEntry>) : {};
  } catch {
    return {};
  }
}

export interface PhaseExportProgress {
  step: "clip" | "frames";
  phase: PhaseId;
  done: number;
  total: number;
}

export interface PhaseExportResult {
  caseName: string;
  exportRoot: string;
  clips: number;
  frames: number;
}

export interface RunPhaseExportOptions {
  baseDir: string;
  projectId: string;
  ffmpegPath: string;
  /** Root the <case>_<phase> folders are created in. */
  exportRoot: string;
  /** Frames per second extracted from the endoscopic phases. */
  fps: number;
  onProgress?: (p: PhaseExportProgress) => void;
}

export interface ClipIndexEntry {
  /** Path relative to the export root: <case>_<phase>/<clip>.mp4 */
  file: string;
  phase: PhaseId;
  span: number;
  /** Seconds from the start of the source video. */
  startSec: number;
  endSec: number;
}

/** Our own clips from a previous export (other files in the folder are left alone). Older exports had no _t suffix. */
function isOwnClip(file: string, folder: string): boolean {
  return file.startsWith(`${folder}_`) && /_\d{2}(_t\d{8}-\d{8})?\.mp4$/.test(file);
}

export async function runPhaseExport(opts: RunPhaseExportOptions): Promise<PhaseExportResult> {
  const intake = await readIntakeRecord(opts.baseDir, opts.projectId);
  if (!intake) throw new Error("No video taken in yet");
  const labels = await loadPhaseLabels(opts.baseDir, opts.projectId);
  if (!labels.spans.length) throw new Error("No phases labelled yet");

  const dir = projectDir(opts.baseDir, opts.projectId);
  const source = path.join(dir, "00_intake", "source", intake.sourceFile);
  const caseName = caseNameFromSource(intake.sourcePath);
  const numbered = numberSpans(labels.spans);
  const crop = await loadCrop(opts.baseDir, opts.projectId, intake);
  const fail = (what: string, res: { code: number; stderr: string }) =>
    new Error(`ffmpeg ${what} failed (${res.code}): ${res.stderr.slice(-400)}`);

  // 1. Clips. Clear previous clips first so a deleted span doesn't leave its clip behind.
  for (const p of PHASES) {
    const folder = phaseFolderName(caseName, p.id);
    const folderPath = path.join(opts.exportRoot, folder);
    let names: string[] = [];
    try { names = await fs.readdir(folderPath); } catch { /* not created yet */ }
    for (const n of names) if (isOwnClip(n, folder)) await fs.rm(path.join(folderPath, n), { force: true });
  }
  const clipIndex: ClipIndexEntry[] = [];
  for (const { span, index } of numbered) {
    opts.onProgress?.({ step: "clip", phase: span.phase, done: clipIndex.length, total: numbered.length });
    const folder = phaseFolderName(caseName, span.phase);
    const folderPath = path.join(opts.exportRoot, folder);
    await fs.mkdir(folderPath, { recursive: true });
    const clipName = phaseClipName(caseName, span.phase, index, span.start, span.end);
    const res = await run(opts.ffmpegPath, buildClipArgs(source, path.join(folderPath, clipName), span.start, span.end, crop));
    if (res.code !== 0) throw fail("clip", res);
    const round = (s: number) => Math.round(s * 1000) / 1000;
    clipIndex.push({ file: `${folder}/${clipName}`, phase: span.phase, span: index, startSec: round(span.start), endSec: round(span.end) });
  }
  const clips = clipIndex.length;

  // 2. Frames for segmentation, endoscopic phases only. raw/ is rebuilt from scratch.
  const rawDir = path.join(dir, "01_frames", "raw");
  const tmpDir = path.join(dir, "01_frames", `extract.tmp-${process.pid}`);
  await fs.rm(rawDir, { recursive: true, force: true });
  await fs.mkdir(rawDir, { recursive: true });
  const index: Record<string, FrameIndexEntry> = {};
  // Frames an annotator removed stay removed: names are time-based, so a re-export reproduces them exactly.
  let removed = new Set<string>();
  try { removed = new Set(await fs.readdir(path.join(dir, "01_frames", "removed"))); } catch { /* none removed */ }
  const frameSpans = numbered.filter(({ span }) => phaseById(span.phase)?.frames);
  for (let i = 0; i < frameSpans.length; i++) {
    const { span, index: spanIndex } = frameSpans[i]!;
    opts.onProgress?.({ step: "frames", phase: span.phase, done: i, total: frameSpans.length });
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });
    const res = await run(
      opts.ffmpegPath,
      buildPhaseFrameArgs(source, path.join(tmpDir, "f_%06d.png"), span.start, span.end, opts.fps, crop),
    );
    if (res.code !== 0) throw fail("frame extraction", res);
    const files = (await fs.readdir(tmpDir)).filter((f) => /^f_\d{6}\.png$/.test(f)).sort();
    for (let k = 0; k < files.length; k++) {
      const timeSec = span.start + k / opts.fps;
      const name = phaseFrameName(caseName, span.phase, spanIndex, timeSec);
      if (removed.has(name)) continue;
      await fs.rename(path.join(tmpDir, files[k]!), path.join(rawDir, name));
      index[name] = { phase: span.phase, span: spanIndex, timeSec: Math.round(timeSec * 1000) / 1000 };
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  await writeJsonAtomic(frameIndexFile(opts.baseDir, opts.projectId), {
    version: 1,
    caseName,
    fps: opts.fps,
    crop,
    clips: clipIndex,
    frames: index,
  });

  return { caseName, exportRoot: opts.exportRoot, clips, frames: Object.keys(index).length };
}
