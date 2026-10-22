import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProjectOnDisk } from "./library.js";
import { listSegFrames, removeFrames } from "./segmentation.js";

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-seg-"));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("removeFrames", () => {
  it("moves marked frames to 01_frames/removed and drops them from the frame list", async () => {
    const { id, dir } = await createProjectOnDisk(base, "Split", "2026-10-22T00:00:00Z");
    const raw = path.join(dir, "01_frames", "raw");
    for (const n of ["v_f0000000.png", "v_f0000004.png", "v_f0000008.png"]) {
      await fs.writeFile(path.join(raw, n), "png");
    }
    const moved = await removeFrames(base, id, ["v_f0000004.png", "missing.png", "../project.json"]);
    expect(moved).toEqual(["v_f0000004.png"]);
    expect(await fs.readdir(path.join(dir, "01_frames", "removed"))).toEqual(["v_f0000004.png"]);
    expect((await fs.readdir(raw)).sort()).toEqual(["v_f0000000.png", "v_f0000008.png"]);
    // Path-traversal names are refused, so project.json is untouched.
    expect((await fs.stat(path.join(dir, "project.json"))).isFile()).toBe(true);
    const listed = await listSegFrames(base, id);
    expect(listed.frames.map((f) => f.frameId)).toEqual(["v_f0000000.png", "v_f0000008.png"]);
  });
});
