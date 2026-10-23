// Disk layer for the EndoSeg project library. Pure Node (fs/path) only — no
// Electron — so it can be unit-tested against a temp dir. The Electron main
// process supplies the library base directory (under userData by default).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  type ProjectManifest,
  type StageId,
  type StageState,
  type StageStatus,
  createProject,
  setStage,
} from "../core/stages.js";
import {
  type ProjectSummary,
  parseManifest,
  summarize,
  sortSummaries,
} from "../core/manifest.js";

/** Stage sub-folders created for every project (see EndoSeg.md §3). */
const STAGE_DIRS = [
  "00_intake/source",
  "01_frames/raw",
  "02_segmentation/masks",
  "03_export",
  "autosave",
  "logs/crash",
];

export function projectsRoot(baseDir: string): string {
  return path.join(baseDir, "projects");
}

export function projectDir(baseDir: string, id: string): string {
  return path.join(projectsRoot(baseDir), id);
}

function manifestPath(baseDir: string, id: string): string {
  return path.join(projectDir(baseDir, id), "project.json");
}

export interface LibraryCheck {
  writable: boolean;
  /** Why the folder can't be used (unreachable share, no permission, ...). */
  error?: string;
}

/**
 * Create the library skeleton and prove we can write to it by creating and
 * deleting a probe file. Never throws: an unmapped/offline network drive must
 * not stop the app from opening.
 */
export async function checkLibrary(baseDir: string): Promise<LibraryCheck> {
  const probe = path.join(baseDir, `.endoseg-write-test-${process.pid}`);
  try {
    await fs.mkdir(projectsRoot(baseDir), { recursive: true });
    await fs.writeFile(probe, "ok", "utf8");
    await fs.rm(probe, { force: true });
    return { writable: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const why =
      e.code === "ENOENT" ? "folder or drive not found — is the network drive connected?"
      : e.code === "EACCES" || e.code === "EPERM" ? "no permission to write here"
      : e.message;
    return { writable: false, error: `Cannot write to ${baseDir}: ${why}` };
  }
}

/** Slugify a user-entered name into a filesystem-safe project id. */
export function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "project";
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * fs.rename with retries. On Windows — especially SMB/NAS shares — antivirus,
 * the indexer or the file server can briefly hold a handle on the target.
 */
export async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts - 1 || !RETRYABLE.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
}

/** Write a file atomically: temp file in the same dir, then rename over the target. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data, typeof data === "string" ? "utf8" : undefined);
  await renameWithRetry(tmp, file);
}

/** Write JSON atomically: temp file in the same dir, then rename. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

async function pickUniqueId(baseDir: string, desired: string): Promise<string> {
  let id = desired;
  let n = 2;
  while (await exists(projectDir(baseDir, id))) {
    id = `${desired}-${n++}`;
  }
  return id;
}

export interface NewProjectResult {
  id: string;
  manifest: ProjectManifest;
  dir: string;
}

/** Create a project folder with the full stage directory skeleton + manifest. */
export async function createProjectOnDisk(
  baseDir: string,
  name: string,
  now: string,
): Promise<NewProjectResult> {
  const id = await pickUniqueId(baseDir, slugifyId(name));
  const dir = projectDir(baseDir, id);
  for (const sub of STAGE_DIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  const manifest = createProject(id, name, now);
  await writeJsonAtomic(manifestPath(baseDir, id), manifest);
  return { id, manifest, dir };
}

/** Read + validate one project's manifest. Returns null if invalid/missing. */
export async function readManifest(
  baseDir: string,
  id: string,
): Promise<ProjectManifest | null> {
  const file = manifestPath(baseDir, id);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const r = parseManifest(parsed);
  return r.ok ? r.value : null;
}

export async function writeManifest(
  baseDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  await writeJsonAtomic(manifestPath(baseDir, manifest.id), manifest);
}

/** Update one stage of a project and persist it. */
export async function updateStageOnDisk(
  baseDir: string,
  id: string,
  stage: StageId,
  patch: Partial<StageState> & { status: StageStatus },
  now: string,
): Promise<ProjectManifest | null> {
  const m = await readManifest(baseDir, id);
  if (!m) return null;
  const next = setStage(m, stage, patch, now);
  await writeManifest(baseDir, next);
  return next;
}

/** Where deleted projects are moved: <library>/deleted/ (outside projects/, so not listed). */
export function deletedRoot(baseDir: string): string {
  return path.join(baseDir, "deleted");
}

/**
 * Remove a project from the library by moving its folder to
 * deleted/<id>__<timestamp> — recoverable by moving it back into projects/.
 * Resolves to the new location, or null if there is no such project.
 */
export async function deleteProjectOnDisk(baseDir: string, id: string, now: string): Promise<string | null> {
  if (!id || id !== path.basename(id) || id === "." || id === "..") return null;
  const dir = projectDir(baseDir, id);
  if (!(await exists(path.join(dir, "project.json")))) return null;
  await fs.mkdir(deletedRoot(baseDir), { recursive: true });
  const dest = path.join(deletedRoot(baseDir), `${id}__${now.replace(/[:.]/g, "-")}`);
  await renameWithRetry(dir, dest);
  return dest;
}

/** List every valid project, summarized and sorted for the hub. */
export async function listProjects(baseDir: string): Promise<ProjectSummary[]> {
  const root = projectsRoot(baseDir);
  let entries: string[];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const summaries: ProjectSummary[] = [];
  for (const id of entries) {
    const m = await readManifest(baseDir, id);
    if (m) summaries.push(summarize(m));
  }
  return sortSummaries(summaries);
}
