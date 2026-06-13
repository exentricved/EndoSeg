// Application settings, persisted as JSON. Pure Node so it is unit-testable.
// Untrusted on read (file may be hand-edited) → always normalized to defaults.

import { promises as fs } from "node:fs";
import { writeJsonAtomic } from "./library.js";

export type GpuMode = "auto" | "cpu" | "gpu";

export interface Settings {
  /** Library location; null means "use the default under Documents". */
  libraryDir: string | null;
  /** Keep 1 of every N extracted frames on intake. */
  frameSampleEvery: number;
  /** Compute preference for the segmentation pipeline. */
  gpu: GpuMode;
}

export const DEFAULT_SETTINGS: Settings = {
  libraryDir: null,
  frameSampleEvery: 6,
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
