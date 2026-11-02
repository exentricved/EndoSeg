// Read-only listing of the NAS "Raw ERCP Videos" folder for the Raw tab.
// Nothing here writes to the Raw folder.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { safeFolderName } from "../core/phases.js";
import { isVideoFile, type RawCase, type RawVideo } from "../core/workspaces.js";

async function videoAt(dir: string, file: string): Promise<RawVideo | null> {
  const p = path.join(dir, file);
  try {
    const st = await fs.stat(p);
    return st.isFile() ? { file, path: p, bytes: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * Every case in the Raw folder: each sub-folder (with the videos directly inside
 * it) and each loose video at the root. Unreadable entries are skipped.
 */
export async function listRawCases(rawDir: string): Promise<RawCase[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(rawDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cases: RawCase[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith(".") || e.name.startsWith("$")) return;
      if (e.isDirectory()) {
        const dir = path.join(rawDir, e.name);
        let files: string[] = [];
        try {
          files = (await fs.readdir(dir)).filter(isVideoFile).sort();
        } catch {
          return;
        }
        const videos = (await Promise.all(files.map((f) => videoAt(dir, f)))).filter((v): v is RawVideo => !!v);
        cases.push({ name: e.name, caseId: safeFolderName(e.name), videos });
      } else if (e.isFile() && isVideoFile(e.name)) {
        const v = await videoAt(rawDir, e.name);
        if (v) cases.push({ name: e.name, caseId: looseVideoCaseId(e.name), videos: [v] });
      }
    }),
  );
  return cases.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** A loose video at the root of the Raw folder is a case named after the file. */
function looseVideoCaseId(file: string): string {
  return safeFolderName(file.replace(/\.[^.]+$/, ""));
}

/**
 * The case id (Annotated folder name) for a video in the Raw folder: its
 * sub-folder's name, or the file name for a loose video at the root. The same
 * rule the Raw tab lists cases by.
 */
export function rawCaseId(rawDir: string, videoPath: string): string {
  const parent = path.dirname(path.resolve(videoPath));
  return parent === path.resolve(rawDir) ? looseVideoCaseId(path.basename(videoPath)) : safeFolderName(path.basename(parent));
}

/** True if `p` is inside `dir` (after normalizing), so a renderer can't point intake elsewhere. */
export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}
