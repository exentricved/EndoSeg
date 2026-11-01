// Open-case lock: <case>\.open.lock says which computer has the case open.
// Pure Node (no Electron) so it can be tested against temp dirs.
//
// The holder rewrites the lock every HEARTBEAT_MS. A lock whose heartbeat is
// older than STALE_MS (app crashed, PC asleep, NAS dropped) no longer counts and
// is taken over by the next person to open the case. Creating the lock uses an
// exclusive create, so when two people open a free case at once only one gets it.
// Nothing is kept once the case is closed: the lock is deleted.

import { promises as fs } from "node:fs";
import * as path from "node:path";

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

export function lockPath(caseDir: string): string {
  return path.join(caseDir, LOCK_FILE);
}

/** True when the holder's app has stopped updating the lock. */
export function isStale(lock: LockInfo, nowMs: number): boolean {
  const t = Date.parse(lock.heartbeatAt);
  return !Number.isFinite(t) || nowMs - t > STALE_MS;
}

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.sessionId !== "string" || typeof v.heartbeatAt !== "string") return null;
    return {
      schema: 1,
      sessionId: v.sessionId,
      computer: typeof v.computer === "string" ? v.computer : "another computer",
      user: typeof v.user === "string" ? v.user : "",
      openedAt: typeof v.openedAt === "string" ? v.openedAt : v.heartbeatAt,
      heartbeatAt: v.heartbeatAt,
    };
  } catch {
    return null;
  }
}

/** The current lock, or null if there is none (or it is unreadable). */
export async function readLock(caseDir: string): Promise<LockInfo | null> {
  try {
    return parseLock(await fs.readFile(lockPath(caseDir), "utf8"));
  } catch {
    return null;
  }
}

export interface Me {
  sessionId: string;
  computer: string;
  user: string;
}

export type AcquireResult =
  | { ok: true; lock: LockInfo }
  /** Someone else has the case open (their lock is live). */
  | { ok: false; holder: LockInfo };

async function createExclusive(caseDir: string, lock: LockInfo): Promise<boolean> {
  try {
    await fs.writeFile(lockPath(caseDir), JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Take the lock for `me`. Succeeds when the case is free, when the lock is
 * already ours, when the existing lock is stale, or when `force` is set
 * (Take over). Otherwise reports who holds it.
 */
export async function acquireLock(caseDir: string, me: Me, nowMs: number, force = false): Promise<AcquireResult> {
  const now = new Date(nowMs).toISOString();
  const mine: LockInfo = { schema: 1, ...me, openedAt: now, heartbeatAt: now };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(caseDir, mine)) return { ok: true, lock: mine };
    const cur = await readLock(caseDir);
    if (cur && cur.sessionId === me.sessionId) {
      const renewed = { ...cur, heartbeatAt: now };
      await fs.writeFile(lockPath(caseDir), JSON.stringify(renewed, null, 2), "utf8");
      return { ok: true, lock: renewed };
    }
    if (cur && !force && !isStale(cur, nowMs)) return { ok: false, holder: cur };
    // Stale, unreadable or taken over: remove it and race for a fresh create.
    await fs.rm(lockPath(caseDir), { force: true });
  }
  const holder = await readLock(caseDir);
  return holder ? { ok: false, holder } : { ok: false, holder: { schema: 1, sessionId: "?", computer: "another computer", user: "", openedAt: now, heartbeatAt: now } };
}

/**
 * Refresh our heartbeat. Returns false (and writes nothing) if the lock is no
 * longer ours — someone took the case over — so the caller can go read-only.
 */
export async function heartbeat(caseDir: string, sessionId: string, nowMs: number): Promise<boolean> {
  const cur = await readLock(caseDir);
  if (!cur || cur.sessionId !== sessionId) return false;
  const next = { ...cur, heartbeatAt: new Date(nowMs).toISOString() };
  await fs.writeFile(lockPath(caseDir), JSON.stringify(next, null, 2), "utf8");
  return true;
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

/** A live lock held by someone else, or null when we may edit. */
export async function foreignLock(caseDir: string, sessionId: string, nowMs: number): Promise<LockInfo | null> {
  const cur = await readLock(caseDir);
  return cur && cur.sessionId !== sessionId && !isStale(cur, nowMs) ? cur : null;
}

/** "PC-123 (jdoe)" */
export function holderLabel(l: LockInfo): string {
  return l.user ? `${l.computer} (${l.user})` : l.computer;
}
