// Phases stage IO: persist a video's phase and maneuver labels, then export
// them — one re-encoded clip per span into <exportRoot>/<case>_<label>/, and
// 1 fps frames of the endoscopic phases and maneuvers into 01_frames/raw/ for
// the annotator.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { run } from "./proc.js";
import { projectDir, renameWithRetry, writeFileAtomic, writeJsonAtomic } from "./library.js";
import type { IntakeRecord } from "./intake.js";
import {
  type LabelId,
  type ManeuverId,
  type PhaseLabels,
  type PhaseSpan,
  PHASES,
  MANEUVERS,
  labelById,
  isManeuver,
  maneuversAt,
  successfulAttempt,
  frameTimeKey,
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
  /** Phase the frame was sampled from, or a maneuver for maneuver time outside any phase. */
  phase: LabelId;
  /** Which span of that phase (1-based, time order) — matches the clip's _NN. */
  span?: number;
  /** Seconds from the start of the source video. */
  timeSec: number;
  /** Maneuvers under way at this moment. */
  maneuvers?: ManeuverId[];
  /** Sampled from the cannulation attempt that succeeded. */
  success?: true;
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
  phase: LabelId;
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
  phase: LabelId;
  span: number;
  /** The cannulation attempt that succeeded. */
  success?: true;
  /** Seconds from the start of the source video. */
  startSec: number;
  endSec: number;
}

/** Our own clips from a previous export (other files in the folder are left alone). Older exports had no _t suffix. */
function isOwnClip(file: string, folder: string): boolean {
  return file.startsWith(`${folder}_`) && /_\d{2}(_[a-z-]+)*(_t\d{8}-\d{8})?\.mp4$/.test(file);
}

/** Folders of every label we export, plus cannulation success, which older versions exported as a phase. */
const CLIP_FOLDER_IDS = [...PHASES.map((p) => p.id), ...MANEUVERS.map((m) => m.id), "cannulation-success"];

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

  const success = labels.cannulationSuccess;
  const winner = successfulAttempt(labels.spans, success);
  const round = (sec: number) => Math.round(sec * 1000) / 1000;

  // 1. Clips. Clear previous clips first so a deleted span doesn't leave its clip behind.
  for (const id of CLIP_FOLDER_IDS) {
    const folder = phaseFolderName(caseName, id);
    const folderPath = path.join(opts.exportRoot, folder);
    let names: string[] = [];
    try { names = await fs.readdir(folderPath); } catch { /* not created yet */ }
    for (const n of names) if (isOwnClip(n, folder)) await fs.rm(path.join(folderPath, n), { force: true });
    // Older versions' cannulation-success folder: drop it once it's empty.
    if (id === "cannulation-success") await fs.rmdir(folderPath).catch(() => { /* absent or has other files */ });
  }
  const clipIndex: ClipIndexEntry[] = [];
  for (const { span, index } of numbered) {
    opts.onProgress?.({ step: "clip", phase: span.phase, done: clipIndex.length, total: numbered.length });
    const folder = phaseFolderName(caseName, span.phase);
    const folderPath = path.join(opts.exportRoot, folder);
    await fs.mkdir(folderPath, { recursive: true });
    const won = span === winner;
    const clipName = phaseClipName(caseName, span.phase, index, span.start, span.end, { success: won });
    const res = await run(opts.ffmpegPath, buildClipArgs(source, path.join(folderPath, clipName), span.start, span.end, crop));
    if (res.code !== 0) throw fail("clip", res);
    clipIndex.push({
      file: `${folder}/${clipName}`, phase: span.phase, span: index,
      ...(won ? { success: true as const } : {}),
      startSec: round(span.start), endSec: round(span.end),
    });
  }
  const clips = clipIndex.length;

  // 2. Frames for segmentation. raw/ is rebuilt from scratch. Phase frames are
  // tagged with the maneuvers under way; maneuver time outside every sampled
  // phase gets frames of its own, so each moment is sampled once.
  const rawDir = path.join(dir, "01_frames", "raw");
  const tmpDir = path.join(dir, "01_frames", `extract.tmp-${process.pid}`);
  await fs.rm(rawDir, { recursive: true, force: true });
  await fs.mkdir(rawDir, { recursive: true });
  const index: Record<string, FrameIndexEntry> = {};
  // Frames an annotator removed stay removed. Matched by source time, since the tags in a name can change.
  const removed = new Set<string>();
  try {
    for (const n of await fs.readdir(path.join(dir, "01_frames", "removed"))) removed.add(frameTimeKey(n) ?? n);
  } catch { /* none removed */ }
  const sampled = numbered.filter(({ span }) => labelById(span.phase)?.frames);
  const phaseSampled = sampled.filter(({ span }) => !isManeuver(span.phase)).map(({ span }) => span);
  const doneManeuvers: PhaseSpan[] = [];
  const inside = (list: PhaseSpan[], t: number) => list.some((s) => t >= s.start && t < s.end);
  for (let i = 0; i < sampled.length; i++) {
    const { span, index: spanIndex } = sampled[i]!;
    opts.onProgress?.({ step: "frames", phase: span.phase, done: i, total: sampled.length });
    const maneuver = isManeuver(span.phase);
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
      // Already sampled as part of a phase (or an earlier overlapping maneuver).
      if (maneuver && (inside(phaseSampled, timeSec) || inside(doneManeuvers, timeSec))) continue;
      const tags = {
        success: span === winner,
        maneuvers: maneuversAt(labels.spans, timeSec).filter((m) => m !== span.phase),
      };
      const name = phaseFrameName(caseName, span.phase, spanIndex, timeSec, tags);
      if (removed.has(frameTimeKey(name) ?? name) || removed.has(name)) continue;
      await fs.rename(path.join(tmpDir, files[k]!), path.join(rawDir, name));
      index[name] = {
        phase: span.phase, span: spanIndex, timeSec: round(timeSec),
        ...(tags.maneuvers.length ? { maneuvers: tags.maneuvers } : {}),
        ...(tags.success ? { success: true as const } : {}),
      };
    }
    if (maneuver) doneManeuvers.push(span);
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  await carryAnnotationsOver(dir, Object.keys(index));
  await writeJsonAtomic(frameIndexFile(opts.baseDir, opts.projectId), {
    version: 1,
    caseName,
    fps: opts.fps,
    crop,
    cannulationSuccessSec: success === undefined ? null : round(success),
    clips: clipIndex,
    frames: index,
  });

  return { caseName, exportRoot: opts.exportRoot, clips, frames: Object.keys(index).length };
}

/**
 * Frame names carry tags (success, maneuvers) that can change between exports
 * while the moment they show doesn't. Point saved annotations, ticks and masks
 * at the frame now holding the same source time, so relabelling keeps work.
 */
async function carryAnnotationsOver(dir: string, names: string[]): Promise<void> {
  const segDir = path.join(dir, "02_segmentation");
  const annFile = path.join(segDir, "annotations.leus");
  let snap: {
    frames?: { frameId?: unknown; name?: unknown; phase?: unknown }[];
    splitScreen?: unknown;
    completed?: unknown;
  };
  try {
    snap = JSON.parse(await fs.readFile(annFile, "utf8"));
  } catch {
    return; // nothing annotated yet
  }
  const current = new Set(names);
  const byKey = new Map<string, string | null>();
  for (const n of names) {
    const k = frameTimeKey(n);
    if (k) byKey.set(k, byKey.has(k) ? null : n); // null = ambiguous, leave alone
  }
  const renamed = new Map<string, string>();
  const mapId = (id: unknown): unknown => {
    if (typeof id !== "string" || current.has(id)) return id;
    const k = frameTimeKey(id);
    const to = k ? byKey.get(k) : undefined;
    if (!to) return id;
    renamed.set(id, to);
    return to;
  };
  const stem = (n: string) => n.replace(/\.(png|jpg|jpeg)$/i, "");
  let retagged = false;
  for (const f of Array.isArray(snap.frames) ? snap.frames : []) {
    const before = f.frameId;
    f.frameId = mapId(before);
    if (f.frameId !== before) {
      f.name = stem(String(f.frameId));
      delete f.phase; // the frame's phase comes from the new export
    } else if (f.phase === "cannulation-success") {
      delete f.phase; // no longer a phase
      retagged = true;
    }
  }
  if (Array.isArray(snap.splitScreen)) snap.splitScreen = snap.splitScreen.map(mapId);
  if (Array.isArray(snap.completed)) snap.completed = snap.completed.map(mapId);
  if (!renamed.size && !retagged) return;
  await fs.copyFile(annFile, `${annFile}.bak`).catch(() => { /* best effort */ });
  await writeFileAtomic(annFile, JSON.stringify(snap, null, 2));
  // Masks are saved as <frame name>__class<id>.png.
  const masksDir = path.join(segDir, "masks");
  const stems = new Map([...renamed].map(([a, b]) => [stem(a), stem(b)]));
  let files: string[] = [];
  try { files = await fs.readdir(masksDir); } catch { /* no masks */ }
  for (const file of files) {
    const at = file.indexOf("__class");
    const to = at > 0 ? stems.get(file.slice(0, at)) : undefined;
    if (to) await renameWithRetry(path.join(masksDir, file), path.join(masksDir, to + file.slice(at)));
  }
}
