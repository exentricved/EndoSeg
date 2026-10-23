// Procedure phases: the catalog, the labelled time spans of one video, and the
// pure naming/arg-building helpers used to export them. Dependency-free so the
// renderer (labelling UI, annotator) and main process (ffmpeg export) share it.

export const PHASES = [
  { id: "duodenum",            label: "Duodenum",            color: "#4ade80", key: "1", frames: true },
  { id: "pre-cannulation",     label: "Pre-cannulation",     color: "#94a3b8", key: "2", frames: true },
  { id: "cannulation-attempt", label: "Cannulation attempt", color: "#f59e0b", key: "3", frames: true },
  { id: "cannulation-success", label: "Cannulation success", color: "#3b82f6", key: "4", frames: true },
  { id: "post-cannulation",    label: "Post-cannulation",    color: "#a78bfa", key: "5", frames: true },
  { id: "fluoroscopy",         label: "Fluoroscopy",         color: "#f43f5e", key: "6", frames: false },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"];
export type PhaseDef = (typeof PHASES)[number];

export function phaseById(id: string): PhaseDef | undefined {
  return PHASES.find((p) => p.id === id);
}

/** One labelled stretch of the video, in seconds from the start. */
export interface PhaseSpan {
  id: string;
  phase: PhaseId;
  start: number;
  end: number;
}

export interface PhaseLabels {
  version: 1;
  spans: PhaseSpan[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate untrusted phases.json; malformed spans are dropped, the rest sorted by start. */
export function parsePhaseLabels(raw: unknown): PhaseLabels {
  const spans: PhaseSpan[] = [];
  if (isObject(raw) && Array.isArray(raw.spans)) {
    for (const s of raw.spans) {
      if (!isObject(s) || !phaseById(String(s.phase))) continue;
      const start = Number(s.start);
      const end = Number(s.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
      spans.push({
        id: typeof s.id === "string" && s.id ? s.id : `span-${spans.length + 1}`,
        phase: s.phase as PhaseId,
        start,
        end,
      });
    }
  }
  return { version: 1, spans: sortSpans(spans) };
}

export function sortSpans(spans: PhaseSpan[]): PhaseSpan[] {
  return [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The phase covering time `t`, preferring the latest-starting span when spans overlap. */
export function phaseAt(spans: PhaseSpan[], t: number): PhaseSpan | undefined {
  let hit: PhaseSpan | undefined;
  for (const s of spans) if (t >= s.start && t < s.end && (!hit || s.start >= hit.start)) hit = s;
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

/** <case>_<phase> — the export folder for one phase. */
export function phaseFolderName(caseName: string, phase: PhaseId): string {
  return `${caseName}_${phase}`;
}

/** <case>_<phase>_NN.mp4 — one clip per span, numbered in time order. */
export function phaseClipName(caseName: string, phase: PhaseId, index: number): string {
  return `${phaseFolderName(caseName, phase)}_${String(index).padStart(2, "0")}.mp4`;
}

/** Frame file named by its time in the source so a sorted listing is chronological. */
export function phaseFrameName(caseName: string, phase: PhaseId, timeSec: number): string {
  const ms = Math.max(0, Math.round(timeSec * 1000));
  return `${safeFolderName(caseName).replace(/\s+/g, "_")}_t${String(ms).padStart(8, "0")}_${phase}.png`;
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

// ── ffmpeg args ──────────────────────────────────────────────────────────────

const t = (sec: number) => sec.toFixed(3);

/** Frame-accurate re-encoded clip of [start, end). Audio is kept if present. */
export function buildClipArgs(input: string, out: string, start: number, end: number): string[] {
  return [
    "-hide_banner", "-ss", t(start), "-i", input, "-t", t(end - start),
    "-map", "0:v:0", "-map", "0:a?",
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
): string[] {
  return [
    "-hide_banner", "-ss", t(start), "-i", input, "-t", t(end - start),
    "-map", "0:v:0", "-vf", `select=gte(t\\,selected_n/${fps})`, "-fps_mode", "vfr",
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
