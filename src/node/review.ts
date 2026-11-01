// Second review: copy a whole case from Annotated 1 into Annotated 2.
// Pure Node (no Electron) so it can be tested against temp dirs.
//
// The copy is self-contained (video included). Every file is hashed while it is
// copied, the copy is re-read and hashed again, and the file list with hashes is
// written as provenance.json in the Annotated 2 case (and as sent-to-review.json
// in the Annotated 1 case, as a second record). While the Annotated 2 folder
// exists, the Annotated 1 case is read-only (see isInReview).

import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import { AlreadyExistsError, projectDir, readManifest, writeJsonAtomic } from "./library.js";
import { copyAndHash, sha256File } from "./intake.js";

/** Written in the Annotated 2 case: where it came from and what was copied. */
export const PROVENANCE_FILE = "provenance.json";
/** Written in the Annotated 1 case once the copy is verified. */
export const SENT_FILE = "sent-to-review.json";

/** Top-level folders not copied: per-machine scratch, recreated empty. */
const SKIP_DIRS = new Set(["autosave", "logs"]);
const EMPTY_DIRS = ["autosave", "logs/crash"];

function skipFile(name: string): boolean {
  return (
    name === SENT_FILE ||
    name === PROVENANCE_FILE ||
    name.startsWith(".") ||
    name.endsWith(".partial") ||
    /\.tmp-\d+$/.test(name)
  );
}

export interface CopiedFile {
  /** Path inside the case folder, with "/" separators. */
  path: string;
  bytes: number;
  sha256: string;
}

export interface Provenance {
  schema: 1;
  kind: "second-review";
  caseId: string;
  from: string;
  to: string;
  copiedAt: string;
  appVersion: string;
  /** SHA-256 of the intake video as recorded at intake (00_intake/intake.json). */
  intakeSha256: string | null;
  totalBytes: number;
  files: CopiedFile[];
}

export interface ReviewProgress {
  phase: "copy" | "verify";
  percent: number;
}

interface PlannedFile {
  rel: string;
  bytes: number;
}

/** Every file to copy (sorted, "/"-separated) and every folder to recreate. */
export async function planCaseCopy(caseDir: string): Promise<{ files: PlannedFile[]; dirs: string[] }> {
  const files: PlannedFile[] = [];
  const dirs: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await fs.readdir(path.join(caseDir, rel), { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!rel && SKIP_DIRS.has(e.name)) continue;
        dirs.push(r);
        await walk(r);
      } else if (e.isFile() && !skipFile(e.name)) {
        files.push({ rel: r, bytes: (await fs.stat(path.join(caseDir, r))).size });
      }
    }
  }
  await walk("");
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  dirs.sort();
  return { files, dirs };
}

/** True while the case has a folder in Annotated 2: the Annotated 1 copy is then read-only. */
export function isInReview(a2Dir: string, id: string): boolean {
  return existsSync(projectDir(a2Dir, id));
}

export interface SecondReviewOptions {
  a1Dir: string;
  a2Dir: string;
  id: string;
  now: string;
  appVersion: string;
  onProgress?: (p: ReviewProgress) => void;
}

/**
 * Copy Annotated 1\<id> to Annotated 2\<id> and verify it. The non-recursive
 * mkdir of the Annotated 2 folder is the claim (only one person can start the
 * review). On any failure the partial Annotated 2 folder is removed, so the
 * Annotated 1 case is editable again and the review can be retried.
 */
export async function startSecondReview(opts: SecondReviewOptions): Promise<Provenance> {
  const { a1Dir, a2Dir, id, now } = opts;
  const src = projectDir(a1Dir, id);
  const dest = projectDir(a2Dir, id);
  const manifest = await readManifest(a1Dir, id);
  if (!manifest) throw new Error(`"${id}" is not a case in Annotated 1.`);
  if (manifest.stages.intake.status !== "done") {
    throw new Error("Finish intake (copy the video in) before sending the case to second review.");
  }

  const plan = await planCaseCopy(src);
  await fs.mkdir(a2Dir, { recursive: true });
  try {
    await fs.mkdir(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AlreadyExistsError(id, "is already in Annotated 2 (someone started its second review).");
    }
    throw err;
  }

  try {
    for (const d of [...plan.dirs, ...EMPTY_DIRS]) await fs.mkdir(path.join(dest, d), { recursive: true });

    const totalBytes = plan.files.reduce((s, f) => s + f.bytes, 0);
    const report = (phase: ReviewProgress["phase"], done: number) => {
      opts.onProgress?.({ phase, percent: totalBytes > 0 ? Math.min(100, Math.floor((done / totalBytes) * 100)) : 100 });
    };

    // Copy, hashing the source as it is read. project.json goes last, so the
    // case only lists in Annotated 2 once everything else is there.
    const ordered = [...plan.files.filter((f) => f.rel !== "project.json"), ...plan.files.filter((f) => f.rel === "project.json")];
    const copied: CopiedFile[] = [];
    let done = 0;
    for (const f of ordered) {
      const sha256 = await copyAndHash(path.join(src, f.rel), path.join(dest, f.rel), (pct) =>
        report("copy", done + (f.bytes * pct) / 100),
      );
      done += f.bytes;
      copied.push({ path: f.rel, bytes: f.bytes, sha256 });
    }

    // Verify: re-read every copied file from Annotated 2.
    done = 0;
    for (const f of copied) {
      const again = await sha256File(path.join(dest, f.path));
      if (again !== f.sha256) throw new Error(`Copy check failed for ${f.path}: the file in Annotated 2 differs from the original.`);
      done += f.bytes;
      report("verify", done);
    }

    const intake = await readIntakeSha(src);
    const intakeSha256 = intake?.sha256 ?? null;
    const prov: Provenance = {
      schema: 1,
      kind: "second-review",
      caseId: id,
      from: src,
      to: dest,
      copiedAt: now,
      appVersion: opts.appVersion,
      intakeSha256,
      totalBytes,
      files: copied.sort((a, b) => a.path.localeCompare(b.path)),
    };
    const video = intake && prov.files.find((f) => f.path === `00_intake/source/${intake.sourceFile}`);
    if (intakeSha256 && video && video.sha256 !== intakeSha256) {
      throw new Error("The case video no longer matches the hash recorded at intake. Check the Annotated 1 case before reviewing it.");
    }
    await writeJsonAtomic(path.join(dest, PROVENANCE_FILE), prov);
    await writeJsonAtomic(path.join(src, SENT_FILE), prov);
    return prov;
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function readIntakeSha(caseDir: string): Promise<{ sha256: string; sourceFile: string } | null> {
  try {
    const rec = JSON.parse(await fs.readFile(path.join(caseDir, "00_intake", "intake.json"), "utf8")) as { sha256?: unknown; sourceFile?: unknown };
    return typeof rec.sha256 === "string" && typeof rec.sourceFile === "string" ? { sha256: rec.sha256, sourceFile: rec.sourceFile } : null;
  } catch {
    return null;
  }
}
