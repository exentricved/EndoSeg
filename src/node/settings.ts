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
  /** Max perceptual-hash Hamming distance (0-64) to treat frames as duplicates. */
  dedupThreshold: number;
}

export const DEFAULT_SETTINGS: Settings = {
  libraryDir: null,
  exportDir: null,
  frameSampleEvery: 15, // ~2 fps at 30 fps source — standard for endoscopy annotation
  gpu: "auto",
  dedupThreshold: 8,
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

  if (
    typeof raw.dedupThreshold === "number" &&
    Number.isInteger(raw.dedupThreshold) &&
    raw.dedupThreshold >= 0 &&
    raw.dedupThreshold <= 64
  ) {
    out.dedupThreshold = raw.dedupThreshold;
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
