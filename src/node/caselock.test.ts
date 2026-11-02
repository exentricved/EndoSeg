import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLock,
  heartbeat,
  releaseLock,
  foreignLock,
  readLock,
  isStale,
  lockPath,
  holderLabel,
  resetLockObservations,
  STALE_MS,
  CLOCK_SKEW_MS,
  type LockInfo,
} from "./caselock.js";

const A = { sessionId: "sess-a", computer: "PC-A", user: "ua" };
const B = { sessionId: "sess-b", computer: "PC-B", user: "ub" };
const T = Date.parse("2026-11-01T10:00:00.000Z");
const LONG_AGO = STALE_MS + CLOCK_SKEW_MS + 1;
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-lock-"));
  resetLockObservations();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function lockOf(me: typeof A, at: number): Promise<LockInfo> {
  const r = await acquireLock(dir, me, at);
  if (!r.ok) throw new Error("expected the lock");
  return r.lock;
}

describe("case lock", () => {
  it("gives a free case to the first opener and shows them to others", async () => {
    await lockOf(A, T);
    const r = await acquireLock(dir, B, T + 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(holderLabel(r.holder)).toBe("PC-A (ua)");
    expect(await foreignLock(dir, B.sessionId, T + 1000)).toMatchObject({ computer: "PC-A" });
    expect(await foreignLock(dir, A.sessionId, T + 1000)).toBeNull();
  });

  it("re-opening by the same app keeps the lock and refreshes it", async () => {
    await lockOf(A, T);
    expect((await acquireLock(dir, A, T + 5000)).ok).toBe(true);
    expect((await readLock(dir))!.heartbeatAt).toBe(new Date(T + 5000).toISOString());
  });

  it("lets only one of two simultaneous openers win", async () => {
    const rs = await Promise.all([acquireLock(dir, A, T), acquireLock(dir, B, T)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("takes over a lock whose timestamp is too old for any clock difference", async () => {
    await lockOf(A, T);
    expect(isStale((await readLock(dir))!, T + LONG_AGO)).toBe(true);
    expect((await acquireLock(dir, B, T + LONG_AGO)).ok).toBe(true);
    expect((await readLock(dir))!.sessionId).toBe("sess-b");
  });

  it("clock differences: a lock that looks old is only stale once we've watched it not change", async () => {
    await lockOf(A, T);
    // B's clock is 5 minutes ahead: A's live lock looks 5 minutes old to B.
    const skewed = T + 5 * 60_000;
    expect((await acquireLock(dir, B, skewed)).ok).toBe(false);
    // A keeps heartbeating (by its own clock): B keeps seeing a live lock.
    const held = await heartbeat(dir, await lockOf(A, T), T + 30_000);
    expect(held).not.toBeNull();
    expect((await acquireLock(dir, B, skewed + STALE_MS + 1)).ok).toBe(false);
    // A crashes: once B has watched the same lock for STALE_MS, B may take it.
    expect((await acquireLock(dir, B, skewed + 2 * STALE_MS + 2)).ok).toBe(true);
  });

  it("two PCs taking over the same stale lock at once: exactly one gets it", async () => {
    const C = { sessionId: "sess-c", computer: "PC-C", user: "uc" };
    for (let i = 0; i < 25; i++) {
      await fs.rm(lockPath(dir), { force: true });
      await lockOf(A, T);
      const later = T + LONG_AGO;
      const rs = await Promise.all([acquireLock(dir, B, later), acquireLock(dir, C, later)]);
      const winners = rs.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
      const w = winners[0] as { ok: true; lock: { sessionId: string } };
      expect((await readLock(dir))!.sessionId).toBe(w.lock.sessionId);
      expect((await fs.readdir(dir)).filter((n) => n !== ".open.lock")).toEqual([]);
    }
  });

  it("heartbeats keep a lock live", async () => {
    const l = await lockOf(A, T);
    expect(await heartbeat(dir, l, T + STALE_MS)).not.toBeNull();
    expect((await acquireLock(dir, B, T + STALE_MS + 10)).ok).toBe(false);
  });

  it("take over: the old holder's heartbeat reports the loss and doesn't overwrite", async () => {
    const l = await lockOf(A, T);
    expect((await acquireLock(dir, B, T + 1000, true)).ok).toBe(true);
    expect(await heartbeat(dir, l, T + 2000)).toBeNull();
    expect((await readLock(dir))!.sessionId).toBe("sess-b");
    expect(await foreignLock(dir, A.sessionId, T + 2000)).toMatchObject({ computer: "PC-B" });
  });

  it("heartbeat recreates a lock file that vanished, unless someone else got it", async () => {
    const l = await lockOf(A, T);
    await fs.rm(lockPath(dir));
    expect(await heartbeat(dir, l, T + 1000)).not.toBeNull();
    expect((await readLock(dir))!.sessionId).toBe("sess-a");
    await fs.rm(lockPath(dir));
    await lockOf(B, T + 1500);
    expect(await heartbeat(dir, l, T + 2000)).toBeNull();
  });

  it("heartbeat throws on a read error instead of reporting a takeover", async () => {
    const l = await lockOf(A, T);
    await fs.rm(lockPath(dir));
    await fs.mkdir(lockPath(dir)); // reading a folder fails with EISDIR
    await expect(heartbeat(dir, l, T + 1000)).rejects.toThrow();
  });

  it("release removes only our own lock", async () => {
    await lockOf(A, T);
    await releaseLock(dir, B.sessionId);
    expect(existsSync(lockPath(dir))).toBe(true);
    await releaseLock(dir, A.sessionId);
    expect(existsSync(lockPath(dir))).toBe(false);
    expect((await acquireLock(dir, B, T)).ok).toBe(true);
  });

  it("treats an unreadable lock file as someone else's live lock until the file is old", async () => {
    await fs.writeFile(lockPath(dir), "garbage");
    const now = Date.now();
    expect(await foreignLock(dir, B.sessionId, now)).toMatchObject({ computer: "another computer" });
    expect((await acquireLock(dir, B, now)).ok).toBe(false);
    expect((await acquireLock(dir, B, now + LONG_AGO)).ok).toBe(true);
  });

  it("writes leave no temp files behind", async () => {
    const l = await lockOf(A, T);
    await heartbeat(dir, l, T + 1000);
    await acquireLock(dir, A, T + 2000);
    expect(await fs.readdir(dir)).toEqual([".open.lock"]);
  });

  it("release never throws when the folder is gone", async () => {
    await expect(releaseLock(path.join(dir, "missing"), A.sessionId)).resolves.toBeUndefined();
  });
});
