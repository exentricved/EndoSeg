import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CaseSession, CaseLockedError } from "./session.js";
import { acquireLock, readLock, lockPath, resetLockObservations } from "./caselock.js";

const A = { sessionId: "sess-a", computer: "PC-A", user: "ua" };
const B = { sessionId: "sess-b", computer: "PC-B", user: "ub" };
let root: string;
let c1: string;
let c2: string;
let lost: string[];
let clock: number;

function session(): CaseSession {
  return new CaseSession(A, { onLost: (r) => lost.push(r), now: () => clock, heartbeatMs: 1e9 });
}
const owner = async (dir: string) => (await readLock(dir))?.sessionId ?? null;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-session-"));
  c1 = path.join(root, "c1");
  c2 = path.join(root, "c2");
  await fs.mkdir(c1);
  await fs.mkdir(c2);
  lost = [];
  clock = Date.now();
  resetLockObservations();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("CaseSession", () => {
  it("opening a case takes its lock; opening another releases the first; close releases", async () => {
    const s = session();
    expect((await s.open("a1:c1", c1)).ok).toBe(true);
    expect(await owner(c1)).toBe("sess-a");
    await s.open("a1:c2", c2);
    expect(existsSync(lockPath(c1))).toBe(false);
    expect(await owner(c2)).toBe("sess-a");
    await s.close();
    expect(existsSync(lockPath(c2))).toBe(false);
    expect(s.holds("a1:c2")).toBe(false);
  });

  it("a quick open then close (Back while opening) leaves no lock behind", async () => {
    const s = session();
    const opening = s.open("a1:c1", c1);
    const closing = s.close();
    await Promise.all([opening, closing]);
    expect(existsSync(lockPath(c1))).toBe(false);
    expect(s.holds("a1:c1")).toBe(false);
  });

  it("a write in progress keeps the lock after Back, and releases it when done", async () => {
    const s = session();
    await s.open("a1:c1", c1);
    let finish!: () => void;
    const write = s.run("a1:c1", c1, () => new Promise<void>((r) => (finish = r)));
    await s.settled();
    await s.close();
    expect(await owner(c1)).toBe("sess-a"); // still held for the write
    expect((await acquireLock(c1, B, clock)).ok).toBe(false);
    finish();
    await write;
    await s.settled();
    expect(existsSync(lockPath(c1))).toBe(false);
  });

  it("a write on a case that isn't open takes the lock for its duration", async () => {
    const s = session();
    let during: string | null = null;
    await s.run("a1:c1", c1, async () => {
      during = await owner(c1);
    });
    await s.settled();
    expect(during).toBe("sess-a");
    expect(existsSync(lockPath(c1))).toBe(false);
  });

  it("a write is refused when someone else has the case open", async () => {
    await acquireLock(c1, B, clock);
    const s = session();
    await expect(s.run("a1:c1", c1, async () => "x")).rejects.toBeInstanceOf(CaseLockedError);
    expect(await owner(c1)).toBe("sess-b");
  });

  it("a write sent right after open waits for the open (intake autostart)", async () => {
    const s = session();
    const opening = s.open("a1:c1", c1);
    const w = s.run("a1:c1", c1, async () => owner(c1));
    await opening;
    expect(await w).toBe("sess-a");
    expect(s.holds("a1:c1")).toBe(true); // still open after the write
  });

  it("reports a takeover, and stops renewing", async () => {
    const s = session();
    await s.open("a1:c1", c1);
    await acquireLock(c1, B, clock + 1000, true);
    await s.beat();
    expect(lost).toEqual(["a1:c1"]);
    expect(s.holds("a1:c1")).toBe(false);
    expect(await owner(c1)).toBe("sess-b");
  });

  it("a NAS read error during a heartbeat keeps the case (no false takeover)", async () => {
    const s = session();
    await s.open("a1:c1", c1);
    await fs.rm(lockPath(c1));
    await fs.mkdir(lockPath(c1)); // reading it now fails
    await s.beat();
    expect(lost).toEqual([]);
    expect(s.holds("a1:c1")).toBe(true);
    await fs.rm(lockPath(c1), { recursive: true });
    await s.beat(); // NAS back: the lock is recreated
    expect(await owner(c1)).toBe("sess-a");
  });

  it("a heartbeat queued behind a close does not recreate the released lock", async () => {
    const s = session();
    await s.open("a1:c1", c1);
    const closing = s.close();
    const beating = s.beat();
    await Promise.all([closing, beating]);
    expect(existsSync(lockPath(c1))).toBe(false);
  });

  it("releaseAll frees every case", async () => {
    const s = session();
    await s.open("a1:c1", c1);
    let finish!: () => void;
    const w = s.run("a1:c2", c2, () => new Promise<void>((r) => (finish = r)));
    await s.settled();
    await s.releaseAll();
    expect(existsSync(lockPath(c1))).toBe(false);
    expect(existsSync(lockPath(c2))).toBe(false);
    finish();
    await w;
  });
});
