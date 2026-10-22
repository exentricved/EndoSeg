// Application settings, persisted as JSON. Pure Node so it is unit-testable.
// Untrusted on read (file may be hand-edited) → always normalized to defaults.

import { promises as fs } from "node:fs";
import { writeJsonAtomic } from "./library.js";

export type GpuMode = "auto" | "cpu" | "gpu";

export interface Settings {
  /** Library location; null means "use the default under Documents". */
  libraryDir: string | null;
  /** Export location; null means "inside each project's 03_export folder". */
  exportDir: string | null;
  /** Keep 1 of every N extracted frames on intake. */
  frameSampleEvery: number;
  /** Compute preference for the segmentation pipeline. */
  gpu: GpuMode;
}

export const DEFAULT_SETTINGS: Settings = {
  libraryDir: null,
  exportDir: null,
  frameSampleEvery: 4, // ~7.5 fps at 30 fps source — dense enough for frame-to-frame tracking
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

  if (typeof raw.libraryDir === "string" && raw.libraryDir.trim()) {
    out.libraryDir = raw.libraryDir;
  } else if (raw.libraryDir === null) {
    out.libraryDir = null;
  }

  if (typeof raw.exportDir === "string" && raw.exportDir.trim()) {
    out.exportDir = raw.exportDir;
  } else if (raw.exportDir === null) {
    out.exportDir = null;
  }

  if (
    typeof raw.frameSampleEvery === "number" &&
    Number.isInteger(raw.frameSampleEvery) &&
    raw.frameSampleEvery >= 1 &&
    raw.frameSampleEvery <= 1000
  ) {
    out.frameSampleEvery = raw.frameSampleEvery;
  }

  if (typeof raw.gpu === "string" && GPU_MODES.includes(raw.gpu as GpuMode)) {
    out.gpu = raw.gpu as GpuMode;
  }

  return out;
}

/** Old default sampling, superseded by every-4th-frame when dedup was removed. */
const LEGACY_SAMPLE_DEFAULT = 15;

export async function loadSettings(file: string): Promise<Settings> {
  try {
    const txt = await fs.readFile(file, "utf8");
    const raw: unknown = JSON.parse(txt);
    // Files from the dedup era always contain dedupThreshold; if they still hold
    // the old default sampling, move them to the new default.
    if (isObject(raw) && "dedupThreshold" in raw && raw.frameSampleEvery === LEGACY_SAMPLE_DEFAULT) {
      raw.frameSampleEvery = DEFAULT_SETTINGS.frameSampleEvery;
    }
    return normalizeSettings(raw);
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
