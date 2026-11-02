// Open-case lock: <case>\.open.lock says which computer has the case open.
// Pure Node (no Electron) so it can be tested against temp dirs.
//
// The holder rewrites the lock every HEARTBEAT_MS. A lock whose heartbeat is
// older than STALE_MS (app crashed, PC asleep, NAS dropped) no longer counts and
// is taken over by the next person to open the case. Nothing is kept once the
// case is closed: the lock is deleted.
//
// On a shared (SMB) folder:
//  - A fresh lock is made with an exclusive create, so when two people open a
//    free case at once only one gets it.
//  - Rewrites (heartbeat, renew) go to a temp file that is renamed over the lock,
//    so nobody ever reads a half-written lock.
//  - A lock that can't be parsed counts as someone else's live lock until its
//    file is older than STALE_MS: the safe direction.
//  - A read error (NAS blip) is thrown, never mistaken for "no lock".

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { renameWithRetry } from "./library.js";

export const LOCK_FILE = ".open.lock";
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;

export interface LockInfo {
  schema: 1;
  /** Random id of one app run, so a computer can tell its own lock apart. */
  sessionId: string;
  computer: string;
  user: string;
  openedAt: string;
  heartbeatAt: string;
}

export interface Me {
  sessionId: string;
  computer: string;
  user: string;
}

export function lockPath(caseDir: string): string {
  return path.join(caseDir, LOCK_FILE);
}

/**
 * PCs' clocks can differ, so the holder's own timestamp is only trusted once it
 * is older than STALE_MS plus this much. Before that, a lock is stale only if
 * this computer has watched it stay unchanged for STALE_MS by its own clock.
 */
export const CLOCK_SKEW_MS = 10 * 60_000;

/** Lock contents last seen per case folder, and since when (our clock). */
const seen = new Map<string, { key: string; since: number }>();

/** Record what we read; returns how long (our clock) it has been unchanged. */
function unchangedFor(caseDir: string, lock: LockInfo, nowMs: number): number {
  const key = `${lock.sessionId}|${lock.heartbeatAt}`;
  const s = seen.get(caseDir);
  if (!s || s.key !== key) {
    seen.set(caseDir, { key, since: nowMs });
    return 0;
  }
  return nowMs - s.since;
}

/** Forget what was seen (tests). */
export function resetLockObservations(): void {
  seen.clear();
}

/**
 * True when the holder's app has stopped updating the lock: we have watched it
 * not change for STALE_MS, or its timestamp is so old that no clock difference
 * explains it.
 */
export function isStale(lock: LockInfo, nowMs: number, caseDir?: string): boolean {
  const t = Date.parse(lock.heartbeatAt);
  if (!Number.isFinite(t) || nowMs - t > STALE_MS + CLOCK_SKEW_MS) return true;
  return caseDir !== undefined && unchangedFor(caseDir, lock, nowMs) > STALE_MS;
}

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.sessionId !== "string" || !v.sessionId || typeof v.heartbeatAt !== "string") return null;
    return {
      schema: 1,
      sessionId: v.sessionId,
      computer: typeof v.computer === "string" && v.computer ? v.computer : "another computer",
      user: typeof v.user === "string" ? v.user : "",
      openedAt: typeof v.openedAt === "string" ? v.openedAt : v.heartbeatAt,
      heartbeatAt: v.heartbeatAt,
    };
  } catch {
    return null;
  }
}

/**
 * The current lock, or null if there is none. Throws if the folder can't be
 * read (so a NAS blip is never taken as "free"). A lock file that can't be
 * parsed is reported as an unknown holder, live until the file is stale.
 */
export async function readLock(caseDir: string): Promise<LockInfo | null> {
  const file = lockPath(caseDir);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const lock = parseLock(text);
  if (lock) return lock;
  let mtime: string;
  try {
    mtime = (await fs.stat(file)).mtime.toISOString();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return { schema: 1, sessionId: "unreadable-lock", computer: "another computer", user: "", openedAt: mtime, heartbeatAt: mtime };
}

function sameLock(a: LockInfo | null, b: LockInfo | null): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.heartbeatAt === b.heartbeatAt;
}

async function createExclusive(caseDir: string, lock: LockInfo): Promise<boolean> {
  try {
    await fs.writeFile(lockPath(caseDir), JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** Replace the lock in one step (temp file + rename), so readers never see half of it. */
async function rewrite(caseDir: string, lock: LockInfo): Promise<void> {
  const tmp = path.join(caseDir, `${LOCK_FILE}.${lock.sessionId}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(lock, null, 2), "utf8");
  try {
    await renameWithRetry(tmp, lockPath(caseDir));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export type AcquireResult =
  | { ok: true; lock: LockInfo }
  /** Someone else has the case open (their lock is live). */
  | { ok: false; holder: LockInfo };

/**
 * Take the lock for `me`. Succeeds when the case is free, when the lock is
 * already ours, when the existing lock is stale, or when `force` is set
 * (Take over). Otherwise reports who holds it. Throws if the NAS can't be read.
 */
export async function acquireLock(caseDir: string, me: Me, nowMs: number, force = false): Promise<AcquireResult> {
  const now = new Date(nowMs).toISOString();
  const mine: LockInfo = { schema: 1, ...me, openedAt: now, heartbeatAt: now };
  let last: LockInfo | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await createExclusive(caseDir, mine)) return { ok: true, lock: mine };
    const cur = await readLock(caseDir);
    if (!cur) continue; // released in between: try the create again
    last = cur;
    if (cur.sessionId === me.sessionId) {
      const renewed = { ...cur, heartbeatAt: now };
      await rewrite(caseDir, renewed);
      return { ok: true, lock: renewed };
    }
    if (!force && !isStale(cur, nowMs, caseDir)) return { ok: false, holder: cur };
    // Stale or taken over. Move it aside under a name only we use (one rename
    // wins), then check that what we moved is the lock we judged. If it is a
    // fresh lock someone else made meanwhile, put it back.
    const tomb = path.join(caseDir, `${LOCK_FILE}.${me.sessionId}.old`);
    try {
      await fs.rename(lockPath(caseDir), tomb);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // someone else moved it first
      throw err;
    }
    const moved = parseLock(await fs.readFile(tomb, "utf8").catch(() => ""));
    if (moved && !sameLock(moved, cur) && moved.sessionId !== me.sessionId) {
      await createExclusive(caseDir, moved).catch(() => false);
      await fs.rm(tomb, { force: true });
      const now2 = await readLock(caseDir);
      if (now2 && now2.sessionId !== me.sessionId) return { ok: false, holder: now2 };
      continue;
    }
    await fs.rm(tomb, { force: true });
  }
  const holder = (await readLock(caseDir)) ?? last;
  return { ok: false, holder: holder ?? { ...mine, sessionId: "unknown", computer: "another computer", user: "" } };
}

/**
 * Refresh our heartbeat. Resolves to the renewed lock, or null if the lock is
 * no longer ours (someone took the case over). If the lock file has vanished
 * (deleted by hand, or a takeover race) it is recreated, unless someone else
 * got there first. Throws on a read/write error, so a NAS blip is retried by
 * the caller instead of being taken as a takeover.
 */
export async function heartbeat(caseDir: string, held: LockInfo, nowMs: number): Promise<LockInfo | null> {
  const next: LockInfo = { ...held, heartbeatAt: new Date(nowMs).toISOString() };
  const cur = await readLock(caseDir);
  if (!cur) return (await createExclusive(caseDir, next)) ? next : null;
  if (cur.sessionId !== held.sessionId) return null;
  await rewrite(caseDir, next);
  return next;
}

/** Delete the lock if it is ours. Never throws. */
export async function releaseLock(caseDir: string, sessionId: string): Promise<void> {
  try {
    const cur = await readLock(caseDir);
    if (cur && cur.sessionId === sessionId) await fs.rm(lockPath(caseDir), { force: true });
  } catch {
    // The NAS may be gone; the lock goes stale on its own.
  }
}

/** A live lock held by someone else, or null when we may edit. Throws if the NAS can't be read. */
export async function foreignLock(caseDir: string, sessionId: string, nowMs: number): Promise<LockInfo | null> {
  const cur = await readLock(caseDir);
  return cur && cur.sessionId !== sessionId && !isStale(cur, nowMs, caseDir) ? cur : null;
}

/** "PC-123 (jdoe)" */
export function holderLabel(l: LockInfo): string {
  return l.user ? `${l.computer} (${l.user})` : l.computer;
}
