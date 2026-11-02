// Second review: copy a whole case from Annotated 1 into Annotated 2.
// Pure Node (no Electron) so it can be tested against temp dirs.
//
// The copy is self-contained (video included). Every file is hashed while it is
// copied, the copy is re-read and hashed again, and the file list with hashes is
// written as provenance.json in the Annotated 2 case (and as sent-to-review.json
// in the Annotated 1 case, as a second record).
//
// The Annotated 2 folder is born holding a .review-copying.json marker (it is
// made under a temporary name and renamed into place, which is also the claim:
// only one person can start the review). The marker is refreshed while the copy
// runs and removed once provenance.json is written. So the Annotated 2 folder is:
//   provenance.json            → done: the Annotated 1 case is read-only
//   fresh marker               → copying: read-only too
//   stale marker, no provenance→ abandoned (app crashed mid-copy): Annotated 1 is
//                                editable again and Second review can be retried
//   neither (made by hand)     → treated as in review, never removed automatically

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AlreadyExistsError, projectDir, readManifest, writeJsonAtomic } from "./library.js";
import { copyAndHash, sha256File } from "./intake.js";

/** Written in the Annotated 2 case: where it came from and what was copied. */
export const PROVENANCE_FILE = "provenance.json";
/** Written in the Annotated 1 case once the copy is verified. */
export const SENT_FILE = "sent-to-review.json";
/** In the Annotated 2 case while the copy runs. */
export const COPYING_FILE = ".review-copying.json";
/** How often the copying marker is refreshed, and when it counts as abandoned. */
export const COPY_TOUCH_MS = 30_000;
export const COPY_STALE_MS = 10 * 60_000;

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

/** Whether a path exists. Errors other than "not found" (NAS trouble) are thrown. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export type ReviewState = "none" | "copying" | "done" | "abandoned" | "unknown";

interface Marker {
  /** Random id of the review copy that made the folder. */
  claim: string | null;
  /** Last refresh (ms). */
  touched: number;
}

/** The copying marker in a case folder, or null if there is none. Throws on NAS errors. */
async function readMarker(caseFolder: string): Promise<Marker | null> {
  const file = path.join(caseFolder, COPYING_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let claim: string | null = null;
  let t = NaN;
  try {
    const m = JSON.parse(text) as { claim?: unknown; touchedAt?: unknown };
    if (typeof m.claim === "string") claim = m.claim;
    if (typeof m.touchedAt === "string") t = Date.parse(m.touchedAt);
  } catch {
    // Unreadable marker: go by the file's age instead.
  }
  if (!Number.isFinite(t)) t = (await fs.stat(file)).mtimeMs;
  return { claim, touched: t };
}

function writeMarker(caseFolder: string, claim: string, touchedMs: number): Promise<void> {
  return writeJsonAtomic(path.join(caseFolder, COPYING_FILE), { claim, touchedAt: new Date(touchedMs).toISOString() });
}

/** Where the second review of `id` stands (see the top of this file). */
export async function reviewState(a2Dir: string, id: string, nowMs: number): Promise<ReviewState> {
  const dest = projectDir(a2Dir, id);
  if (!(await exists(dest))) return "none";
  if (await exists(path.join(dest, PROVENANCE_FILE))) return "done";
  const m = await readMarker(dest);
  if (!m) return (await exists(dest)) ? "unknown" : "none";
  return nowMs - m.touched <= COPY_STALE_MS ? "copying" : "abandoned";
}

/** True while the Annotated 1 copy of `id` must stay read-only. Throws on NAS errors. */
export async function isInReview(a2Dir: string, id: string, nowMs: number): Promise<boolean> {
  const s = await reviewState(a2Dir, id, nowMs);
  return s === "done" || s === "copying" || s === "unknown";
}

export interface SecondReviewOptions {
  a1Dir: string;
  a2Dir: string;
  id: string;
  now: string;
  appVersion: string;
  onProgress?: (p: ReviewProgress) => void;
  /** Clock for the copying marker (tests). */
  nowMs?: () => number;
}

/**
 * Remove the review copy made by `claim` (only that one: if the folder now
 * belongs to another copy, it is left alone).
 *
 * Normally the folder is renamed aside in one step, checked, then deleted. If
 * it can't be renamed (a file in it is open — antivirus, the indexer), it is
 * deleted in place: the marker is first backdated and deleted last, so a
 * delete that stops partway still reads as abandoned, never as a hand-made
 * folder that would keep Annotated 1 read-only.
 */
async function discard(a2Dir: string, dir: string, id: string, claim: string | null): Promise<void> {
  const ours = async (folder: string) => {
    const m = await readMarker(folder).catch(() => null);
    return !!m && m.claim === claim;
  };
  const aside = path.join(a2Dir, `.discard-${id}-${randomUUID()}`);
  try {
    await fs.rename(dir, aside);
  } catch {
    if (!(await ours(dir))) return;
    await writeMarker(dir, claim ?? "discarded", 0).catch(() => undefined);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (n !== COPYING_FILE) await fs.rm(path.join(dir, n), { recursive: true, force: true }).catch(() => undefined);
    }
    // Only drop the marker once nothing else is left; otherwise the backdated
    // marker keeps the leftovers reading as abandoned, so a retry clears them.
    const left = await fs.readdir(dir).catch(() => [COPYING_FILE, "?"]);
    if (left.every((n) => n === COPYING_FILE)) {
      await fs.rm(path.join(dir, COPYING_FILE), { force: true }).catch(() => undefined);
      await fs.rmdir(dir).catch(() => undefined);
    }
    return;
  }
  if (!(await ours(aside))) {
    // Someone else's copy took the place meanwhile: put it back. If its owner
    // has already recreated the folder, give it back its marker (so that copy
    // can still finish or be cleared) and drop what was moved aside.
    try {
      await fs.rename(aside, dir);
    } catch {
      const m = await readMarker(aside).catch(() => null);
      if (m?.claim) await writeMarker(dir, m.claim, m.touched).catch(() => undefined);
      await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }
  await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Claim Annotated 2\<id>: make it under a temporary name with the copying
 * marker inside, then rename it into place. The rename fails if the folder
 * exists, so only one person wins. An abandoned copy is cleared first.
 * Resolves to this copy's claim id.
 */
async function claimReviewFolder(a2Dir: string, id: string, clock: () => number): Promise<string> {
  const dest = projectDir(a2Dir, id);
  const claim = randomUUID();
  await fs.mkdir(a2Dir, { recursive: true });
  const staging = path.join(a2Dir, `.claim-${id}-${claim}`);
  await fs.mkdir(staging);
  await writeMarker(staging, claim, clock());
  const giveUp = () => fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(staging, dest);
      return claim;
    } catch (err) {
      if (!(await exists(dest).catch(() => true))) {
        await giveUp();
        throw err;
      }
      const state = await reviewState(a2Dir, id, clock()).catch(() => "unknown" as const);
      if (state !== "abandoned" || attempt > 0) {
        await giveUp();
        throw new AlreadyExistsError(id, "is already in Annotated 2 (someone started its second review).");
      }
      const old = await readMarker(dest).catch(() => null);
      await discard(a2Dir, dest, id, old?.claim ?? null);
    }
  }
}

/**
 * Copy Annotated 1\<id> to Annotated 2\<id> and verify it. On any failure the
 * partial Annotated 2 folder is removed, so the Annotated 1 case is editable
 * again and the review can be retried.
 */
export async function startSecondReview(opts: SecondReviewOptions): Promise<Provenance> {
  const { a1Dir, a2Dir, id, now } = opts;
  const clock = opts.nowMs ?? Date.now;
  const src = projectDir(a1Dir, id);
  const dest = projectDir(a2Dir, id);
  const manifest = await readManifest(a1Dir, id);
  if (!manifest) throw new Error(`"${id}" is not a case in Annotated 1.`);
  if (manifest.stages.intake.status !== "done") {
    throw new Error("Finish intake (copy the video in) before sending the case to second review.");
  }

  const claim = await claimReviewFolder(a2Dir, id, clock);

  // Keep the marker fresh while copying, so others see a copy in progress.
  const marker = path.join(dest, COPYING_FILE);
  let lastTouch = clock();
  let touching: Promise<void> | null = null;
  const touch = () => {
    if (touching || clock() - lastTouch < COPY_TOUCH_MS) return;
    lastTouch = clock();
    touching = writeMarker(dest, claim, lastTouch)
      .catch(() => undefined)
      .finally(() => (touching = null));
  };

  try {
    // Planned after the claim, so nothing changes in Annotated 1 between plan and copy.
    const plan = await planCaseCopy(src);
    for (const d of [...plan.dirs, ...EMPTY_DIRS]) await fs.mkdir(path.join(dest, d), { recursive: true });

    const plannedBytes = plan.files.reduce((s, f) => s + f.bytes, 0);
    const report = (phase: ReviewProgress["phase"], done: number) => {
      touch();
      opts.onProgress?.({ phase, percent: plannedBytes > 0 ? Math.min(100, Math.floor((done / plannedBytes) * 100)) : 100 });
    };

    // Copy, hashing the source as it is read, then re-read every copy from
    // Annotated 2 and check it. project.json is copied and checked last, so the
    // case only lists in Annotated 2 once everything else is verified.
    const copied: CopiedFile[] = [];
    let done = 0;
    const copyOne = async (f: PlannedFile) => {
      const to = path.join(dest, f.rel);
      const sha256 = await copyAndHash(path.join(src, f.rel), to, (pct) => report("copy", done + (f.bytes * pct) / 100));
      done += f.bytes;
      const c = { path: f.rel, bytes: (await fs.stat(to)).size, sha256 };
      copied.push(c);
      return c;
    };
    const verify = async (f: CopiedFile) => {
      const again = await sha256File(path.join(dest, f.path));
      if (again !== f.sha256) throw new Error(`Copy check failed for ${f.path}: the file in Annotated 2 differs from the original.`);
    };
    const manifestFile = plan.files.find((f) => f.rel === "project.json");
    for (const f of plan.files) if (f !== manifestFile) await copyOne(f);
    let checked = 0;
    for (const f of [...copied]) {
      await verify(f);
      checked += f.bytes;
      report("verify", checked);
    }
    if (manifestFile) await verify(await copyOne(manifestFile));
    report("verify", plannedBytes);

    const intake = await readIntakeSha(src);
    const intakeSha256 = intake?.sha256 ?? null;
    const files = copied.sort((a, b) => a.path.localeCompare(b.path));
    const video = intake && files.find((f) => f.path === `00_intake/source/${intake.sourceFile}`);
    if (intakeSha256 && video && video.sha256 !== intakeSha256) {
      throw new Error("The case video no longer matches the hash recorded at intake. Check the Annotated 1 case before reviewing it.");
    }
    const prov: Provenance = {
      schema: 1,
      kind: "second-review",
      caseId: id,
      from: src,
      to: dest,
      copiedAt: now,
      appVersion: opts.appVersion,
      intakeSha256,
      totalBytes: files.reduce((s, f) => s + f.bytes, 0),
      files,
    };
    if (touching) await touching;
    await writeJsonAtomic(path.join(dest, PROVENANCE_FILE), prov);
    await fs.rm(marker, { force: true }).catch(() => undefined);
    await writeJsonAtomic(path.join(src, SENT_FILE), prov).catch(() => undefined); // second record only
    return prov;
  } catch (err) {
    if (touching) await touching;
    await discard(a2Dir, dest, id, claim);
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
