// Application settings, persisted as JSON. Pure Node so it is unit-testable.
// Untrusted on read (file may be hand-edited) → always normalized to defaults.

import { promises as fs } from "node:fs";
import { writeJsonAtomic } from "./library.js";

export type GpuMode = "auto" | "cpu" | "gpu";

export interface Settings {
  /**
   * The shared NAS folder that holds "Raw ERCP Videos", "Annotated 1" and
   * "Annotated 2"; null means the team default (R:kshin-ercp-nas).
   */
  nasRoot: string | null;
  /** Export location; null means "inside each project's 03_export folder". */
  exportDir: string | null;
  /** Frames per second extracted from the endoscopic phases for segmentation. */
  phaseFps: number;
  /** Compute preference for the segmentation pipeline. */
  gpu: GpuMode;
}

export const DEFAULT_SETTINGS: Settings = {
  nasRoot: null,
  exportDir: null,
  phaseFps: 1,
  gpu: "auto",
};

const GPU_MODES: GpuMode[] = ["auto", "cpu", "gpu"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge untrusted input over defaults, coercing/validating each field. */
export function normalizeSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!isObject(raw)) return out;

  // Older versions' libraryDir / rawVideosDir / phaseExportDir are dropped:
  // every folder now derives from the NAS root.
  for (const k of ["nasRoot", "exportDir"] as const) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
    else if (v === null) out[k] = null;
  }

  if (typeof raw.phaseFps === "number" && Number.isFinite(raw.phaseFps) && raw.phaseFps > 0 && raw.phaseFps <= 30) {
    out.phaseFps = raw.phaseFps;
  }

  if (typeof raw.gpu === "string" && GPU_MODES.includes(raw.gpu as GpuMode)) {
    out.gpu = raw.gpu as GpuMode;
  }

  return out;
}

export async function loadSettings(file: string): Promise<Settings> {
  try {
    const txt = await fs.readFile(file, "utf8");
    return normalizeSettings(JSON.parse(txt));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await writeJsonAtomic(file, normalizeSettings(settings));
}

/** Apply a partial patch over current settings, normalized. */
export function applySettings(current: Settings, patch: unknown): Settings {
  if (!isObject(patch)) return current;
  return normalizeSettings({ ...current, ...patch });
}
