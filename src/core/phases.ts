// Procedure phases: the catalog, the labelled time spans of one video, and the
// pure naming/arg-building helpers used to export them. Dependency-free so the
// renderer (labelling UI, annotator) and main process (ffmpeg export) share it.

export const PHASES = [
  { id: "duodenum",            label: "Duodenum",            color: "#4ade80", key: "1", frames: true },
  { id: "pre-cannulation",     label: "Pre-cannulation",     color: "#94a3b8", key: "2", frames: true },
  { id: "cannulation-attempt", label: "Cannulation attempt", color: "#f59e0b", key: "3", frames: true },
  { id: "post-cannulation",    label: "Post-cannulation",    color: "#a78bfa", key: "5", frames: true },
  { id: "fluoroscopy",         label: "Fluoroscopy",         color: "#f43f5e", key: "6", frames: false },
] as const;

/**
 * Post-cannulation maneuvers (PEP-related). Unlike phases they may overlap each
 * other and the phase spans; their frames go to the annotator too.
 */
export const MANEUVERS = [
  { id: "sphincterotomy",   label: "Sphincterotomy",   abbr: "EST",  color: "#ef4444", key: "7", frames: true },
  { id: "balloon-dilation", label: "Balloon dilation", abbr: "EPBD", color: "#22d3ee", key: "8", frames: true },
  { id: "pancreatic-stent", label: "Pancreatic stent", abbr: "PS",   color: "#e879f9", key: "9", frames: true },
] as const;

/** Cannulation success is a single moment (end of the last attempt), marked with this key. */
export const SUCCESS_KEY = "4";
export const SUCCESS_COLOR = "#3b82f6";

export type PhaseId = (typeof PHASES)[number]["id"];
export type PhaseDef = (typeof PHASES)[number];
export type ManeuverId = (typeof MANEUVERS)[number]["id"];
/** What a span is labelled with: a phase or a maneuver. */
export type LabelId = PhaseId | ManeuverId;
export type LabelDef = PhaseDef | (typeof MANEUVERS)[number];

export function phaseById(id: string): PhaseDef | undefined {
  return PHASES.find((p) => p.id === id);
}

export function maneuverById(id: string): (typeof MANEUVERS)[number] | undefined {
  return MANEUVERS.find((m) => m.id === id);
}

/** A phase or maneuver by id. */
export function labelById(id: string): LabelDef | undefined {
  return phaseById(id) ?? maneuverById(id);
}

export function isManeuver(id: string): id is ManeuverId {
  return !!maneuverById(id);
}

/** One labelled stretch of the video, in seconds from the start. */
export interface PhaseSpan {
  id: string;
  /** Phase or maneuver id. */
  phase: LabelId;
  start: number;
  end: number;
}

export interface PhaseLabels {
  version: 1;
  spans: PhaseSpan[];
  /** Moment cannulation succeeded (end of the last attempt), seconds from the start. */
  cannulationSuccess?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate untrusted phases.json; malformed spans are dropped, the rest sorted by start.
 * Older files labelled cannulation success as a span: its start becomes the success
 * moment and the span itself post-cannulation, so its frames stay labelled.
 */
export function parsePhaseLabels(raw: unknown): PhaseLabels {
  const spans: PhaseSpan[] = [];
  let success: number | undefined;
  if (isObject(raw) && raw.cannulationSuccess != null) {
    const cs = Number(raw.cannulationSuccess);
    if (Number.isFinite(cs) && cs >= 0) success = cs;
  }
  if (isObject(raw) && Array.isArray(raw.spans)) {
    const legacySuccess: number[] = [];
    for (const s of raw.spans) {
      if (!isObject(s)) continue;
      const start = Number(s.start);
      const end = Number(s.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
      const legacy = s.phase === "cannulation-success";
      if (legacy) legacySuccess.push(start);
      else if (!labelById(String(s.phase))) continue;
      spans.push({
        id: typeof s.id === "string" && s.id ? s.id : `span-${spans.length + 1}`,
        phase: legacy ? "post-cannulation" : (s.phase as LabelId),
        start,
        end,
      });
    }
    if (success === undefined && legacySuccess.length) success = Math.min(...legacySuccess);
  }
  return { version: 1, spans: sortSpans(spans), ...(success !== undefined ? { cannulationSuccess: success } : {}) };
}

export function sortSpans(spans: PhaseSpan[]): PhaseSpan[] {
  return [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The phase covering time `t`, preferring the latest-starting span when spans overlap. Maneuvers are ignored. */
export function phaseAt(spans: PhaseSpan[], t: number): PhaseSpan | undefined {
  let hit: PhaseSpan | undefined;
  for (const s of spans) {
    if (isManeuver(s.phase)) continue;
    if (t >= s.start && t < s.end && (!hit || s.start >= hit.start)) hit = s;
  }
  return hit;
}

/** Maneuvers under way at time `t`, in catalog order. */
export function maneuversAt(spans: PhaseSpan[], t: number): ManeuverId[] {
  return MANEUVERS.filter((m) => spans.some((s) => s.phase === m.id && t >= s.start && t < s.end)).map((m) => m.id);
}

/** The attempt that succeeded: the last cannulation attempt starting at or before the success moment. */
export function successfulAttempt(spans: PhaseSpan[], success: number | undefined): PhaseSpan | undefined {
  if (success === undefined) return undefined;
  let hit: PhaseSpan | undefined;
  for (const s of spans) {
    if (s.phase === "cannulation-attempt" && s.start <= success && (!hit || s.start >= hit.start)) hit = s;
  }
  return hit;
}

// ── Naming ───────────────────────────────────────────────────────────────────

/** Make a string safe as a Windows folder/file name, keeping it readable. */
export function safeFolderName(name: string): string {
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/[. ]+$/g, "").trim();
  return s || "video";
}

/**
 * Name of the case a video belongs to: the folder it was in
 * (…\Raw ERCP Videos\<case>\video.mp4 → <case>), or the file name when the
 * video sits at a drive root.
 */
export function caseNameFromSource(sourcePath: string): string {
  const parts = sourcePath.split(/[\\/]+/).filter(Boolean);
  const file = parts.pop() ?? "";
  const folder = parts.pop();
  if (folder && !/^[a-zA-Z]:$/.test(folder)) return safeFolderName(folder);
  return safeFolderName(file.replace(/\.[^.]+$/, ""));
}

/** <case>_<phase> — the export folder for one phase or maneuver. */
export function phaseFolderName(caseName: string, phase: string): string {
  return `${caseName}_${phase}`;
}

/** Milliseconds into the source video, zero-padded to 8 digits (sorts chronologically up to ~27 h). */
export function msStamp(timeSec: number): string {
  return String(Math.max(0, Math.round(timeSec * 1000))).padStart(8, "0");
}

/** Extra name parts: "success" on the attempt that succeeded, then the maneuvers under way. */
export interface NameTags {
  success?: boolean;
  maneuvers?: readonly string[];
}

function tagSuffix(tags?: NameTags): string {
  return [...(tags?.success ? ["success"] : []), ...(tags?.maneuvers ?? [])].map((x) => `_${x}`).join("");
}

/**
 * <case>_<phase>_NN[_success]_t<startMs>-<endMs>.mp4 — one clip per span,
 * numbered in time order, carrying where it was cut from in the source video.
 */
export function phaseClipName(caseName: string, phase: string, index: number, start: number, end: number, tags?: NameTags): string {
  const nn = String(index).padStart(2, "0");
  return `${phaseFolderName(caseName, phase)}_${nn}${tagSuffix(tags)}_t${msStamp(start)}-${msStamp(end)}.mp4`;
}

/**
 * <case>_t<ms>_<phase>_NN[_success][_<maneuver>…].png — named by time in the
 * source (so a sorted listing is chronological) plus the span number, matching
 * that span's clip, then whether it's the successful attempt and any maneuvers
 * under way at that moment.
 */
export function phaseFrameName(caseName: string, phase: string, index: number, timeSec: number, tags?: NameTags): string {
  const nn = String(index).padStart(2, "0");
  return `${safeFolderName(caseName).replace(/\s+/g, "_")}_t${msStamp(timeSec)}_${phase}_${nn}${tagSuffix(tags)}.png`;
}

/** The _t<ms> part of a frame name, which stays put when the tags after it change. */
export function frameTimeKey(name: string): string | null {
  return /_t(\d{8})_/.exec(name)?.[1] ?? null;
}

/** Number each span within its phase (1-based, in time order). */
export function numberSpans(spans: PhaseSpan[]): { span: PhaseSpan; index: number }[] {
  const seen = new Map<string, number>();
  return sortSpans(spans).map((span) => {
    const index = (seen.get(span.phase) ?? 0) + 1;
    seen.set(span.phase, index);
    return { span, index };
  });
}

/** h:mm:ss.s for display. */
export function formatTimecode(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = (s % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

// ── Crop ─────────────────────────────────────────────────────────────────────

/** Region of the source picture to keep, in source pixels. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest crop side accepted, in source pixels. */
export const MIN_CROP = 32;

const even = (n: number) => Math.floor(n / 2) * 2;

/**
 * Validate an untrusted crop against the source size: clamp it inside the
 * frame and round to even numbers (H.264 4:2:0 needs even dimensions).
 * Null when absent, too small, or covering the whole frame (= no crop).
 */
export function normalizeCrop(raw: unknown, width: number, height: number): CropRect | null {
  if (typeof raw !== "object" || raw === null || width <= 0 || height <= 0) return null;
  const r = raw as Record<string, unknown>;
  const [x0, y0, w0, h0] = [r.x, r.y, r.w, r.h].map(Number) as [number, number, number, number];
  if (![x0, y0, w0, h0].every(Number.isFinite)) return null;
  const x = even(Math.min(Math.max(0, x0), width));
  const y = even(Math.min(Math.max(0, y0), height));
  const w = even(Math.min(w0, width - x));
  const h = even(Math.min(h0, height - y));
  if (w < MIN_CROP || h < MIN_CROP) return null;
  if (x === 0 && y === 0 && w >= even(width) && h >= even(height)) return null;
  return { x, y, w, h };
}

function cropFilter(c: CropRect | null | undefined): string[] {
  return c ? [`crop=${c.w}:${c.h}:${c.x}:${c.y}`] : [];
}

// ── ffmpeg args ──────────────────────────────────────────────────────────────

const t = (sec: number) => sec.toFixed(3);

/** Frame-accurate re-encoded clip of [start, end), optionally cropped. Audio is kept if present. */
export function buildClipArgs(
  input: string,
  out: string,
  start: number,
  end: number,
  crop?: CropRect | null,
): string[] {
  const vf = cropFilter(crop);
  return [
    "-hide_banner", "-ss", t(start), "-i", input, "-t", t(end - start),
    "-map", "0:v:0", "-map", "0:a?",
    ...(vf.length ? ["-vf", vf.join(",")] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart", "-y", out,
  ];
}

/**
 * Frames of [start, end) at `fps`, written as <outPattern> (printf-style %06d, 0-based).
 * Output k is the first source frame at or after start + k/fps, so a frame's
 * time is known to within one source frame. (The fps filter would instead
 * sample from mid-interval, about half a second late at 1 fps.)
 */
export function buildPhaseFrameArgs(
  input: string,
  outPattern: string,
  start: number,
  end: number,
  fps: number,
  crop?: CropRect | null,
): string[] {
  const vf = [`select=gte(t\\,selected_n/${fps})`, ...cropFilter(crop)].join(",");
  return [
    "-hide_banner", "-ss", t(start), "-i", input, "-t", t(end - start),
    "-map", "0:v:0", "-vf", vf, "-fps_mode", "vfr",
    "-start_number", "0", "-y", outPattern,
  ];
}

/** Light H.264 proxy for scrubbing in the labelling player (dense keyframes for seeking). */
export function buildPreviewArgs(input: string, out: string): string[] {
  return [
    "-hide_banner", "-i", input, "-map", "0:v:0",
    "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
    "-g", "15", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", "-y", out,
  ];
}

/** Whether Chromium's <video> can play this file directly (else a preview proxy is made). */
export function isBrowserPlayable(fileName: string, codec: string): boolean {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  return ["mp4", "m4v", "mov", "webm"].includes(ext) && ["h264", "vp8", "vp9", "av1"].includes(codec);
}
