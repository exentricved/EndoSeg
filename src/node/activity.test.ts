import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logActivity, readActivity, activityDir, currentIdentity } from "./activity.js";

describe("activity log", () => {
  let base: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-activity-"));
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("returns nothing when no log exists", async () => {
    expect(await readActivity(base)).toEqual([]);
  });

  it("writes one file per user and merges them newest first", async () => {
    const alice = { user: "alice", host: "ws1" };
    const bob = { user: "DOMAIN\\bob", host: "ws2" };
    await logActivity(base, { at: "2026-10-22T09:00:00Z", action: "intake_started", projectId: "p1", file: "a.mp4" }, alice);
    await logActivity(base, { at: "2026-10-22T10:00:00Z", action: "intake_started", projectId: "p2", file: "b.mp4" }, bob);
    await logActivity(base, { at: "2026-10-22T11:00:00Z", action: "intake_completed", projectId: "p1", detail: "40 frames" }, alice);

    expect((await fs.readdir(activityDir(base))).sort()).toEqual(["DOMAIN_bob.jsonl", "alice.jsonl"]);
    const events = await readActivity(base);
    expect(events.map((e) => [e.user, e.action, e.projectId])).toEqual([
      ["alice", "intake_completed", "p1"],
      ["DOMAIN\\bob", "intake_started", "p2"],
      ["alice", "intake_started", "p1"],
    ]);
    expect(events[1].host).toBe("ws2");
  });

  it("skips malformed or partial lines", async () => {
    await fs.mkdir(activityDir(base), { recursive: true });
    await fs.writeFile(
      path.join(activityDir(base), "x.jsonl"),
      '{"at":"2026-10-22T09:00:00Z","user":"x","action":"intake_started","projectId":"p"}\n{"at":"2026-10-2\nnot json\n{"user":"no-at"}\n',
    );
    const events = await readActivity(base);
    expect(events).toHaveLength(1);
    expect(events[0].user).toBe("x");
  });

  it("identifies the current OS user", () => {
    const id = currentIdentity();
    expect(id.user.length).toBeGreaterThan(0);
    expect(id.host.length).toBeGreaterThan(0);
  });
});
