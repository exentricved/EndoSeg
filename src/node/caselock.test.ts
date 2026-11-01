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
  STALE_MS,
} from "./caselock.js";

const A = { sessionId: "sess-a", computer: "PC-A", user: "ua" };
const B = { sessionId: "sess-b", computer: "PC-B", user: "ub" };
const T = Date.parse("2026-11-01T10:00:00.000Z");
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-lock-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("case lock", () => {
  it("gives a free case to the first opener and shows them to others", async () => {
    expect((await acquireLock(dir, A, T)).ok).toBe(true);
    const r = await acquireLock(dir, B, T + 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(holderLabel(r.holder)).toBe("PC-A (ua)");
    expect(await foreignLock(dir, B.sessionId, T + 1000)).toMatchObject({ computer: "PC-A" });
    expect(await foreignLock(dir, A.sessionId, T + 1000)).toBeNull();
  });

  it("re-opening by the same app keeps the lock and refreshes it", async () => {
    await acquireLock(dir, A, T);
    const r = await acquireLock(dir, A, T + 5000);
    expect(r.ok).toBe(true);
    expect((await readLock(dir))!.heartbeatAt).toBe(new Date(T + 5000).toISOString());
  });

  it("lets only one of two simultaneous openers win", async () => {
    const rs = await Promise.all([acquireLock(dir, A, T), acquireLock(dir, B, T)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("takes over a stale lock (holder crashed) automatically", async () => {
    await acquireLock(dir, A, T);
    expect(isStale((await readLock(dir))!, T + STALE_MS + 1)).toBe(true);
    const r = await acquireLock(dir, B, T + STALE_MS + 1);
    expect(r.ok).toBe(true);
    expect((await readLock(dir))!.sessionId).toBe("sess-b");
  });

  it("heartbeats keep a lock live", async () => {
    await acquireLock(dir, A, T);
    expect(await heartbeat(dir, A.sessionId, T + STALE_MS)).toBe(true);
    expect((await acquireLock(dir, B, T + STALE_MS + 10)).ok).toBe(false);
  });

  it("take over: the old holder's heartbeat reports the loss and doesn't overwrite", async () => {
    await acquireLock(dir, A, T);
    expect((await acquireLock(dir, B, T + 1000, true)).ok).toBe(true);
    expect(await heartbeat(dir, A.sessionId, T + 2000)).toBe(false);
    expect((await readLock(dir))!.sessionId).toBe("sess-b");
    expect(await foreignLock(dir, A.sessionId, T + 2000)).toMatchObject({ computer: "PC-B" });
  });

  it("release removes only our own lock", async () => {
    await acquireLock(dir, A, T);
    await releaseLock(dir, B.sessionId);
    expect(existsSync(lockPath(dir))).toBe(true);
    await releaseLock(dir, A.sessionId);
    expect(existsSync(lockPath(dir))).toBe(false);
    expect((await acquireLock(dir, B, T)).ok).toBe(true);
  });

  it("treats an unreadable lock file as free", async () => {
    await fs.writeFile(lockPath(dir), "garbage");
    expect(await foreignLock(dir, B.sessionId, T)).toBeNull();
    expect((await acquireLock(dir, B, T)).ok).toBe(true);
  });

  it("release never throws when the folder is gone", async () => {
    await expect(releaseLock(path.join(dir, "missing"), A.sessionId)).resolves.toBeUndefined();
  });
});
