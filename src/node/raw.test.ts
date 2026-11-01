import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listRawCases, isInside } from "./raw.js";

let raw: string;
beforeEach(async () => {
  raw = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-raw-"));
});
afterEach(async () => {
  await fs.rm(raw, { recursive: true, force: true });
});

describe("listRawCases", () => {
  it("lists case folders with the videos inside, plus loose videos, sorted naturally", async () => {
    await fs.mkdir(path.join(raw, "Case 10"));
    await fs.writeFile(path.join(raw, "Case 10", "video.mp4"), "12345");
    await fs.writeFile(path.join(raw, "Case 10", "notes.txt"), "x");
    await fs.mkdir(path.join(raw, "Case 2"));
    await fs.writeFile(path.join(raw, "Case 2", "b.avi"), "1");
    await fs.writeFile(path.join(raw, "Case 2", "a.mp4"), "1");
    await fs.mkdir(path.join(raw, "Empty case"));
    await fs.writeFile(path.join(raw, "loose clip.mov"), "1");
    await fs.writeFile(path.join(raw, "readme.txt"), "1");
    await fs.mkdir(path.join(raw, ".hidden"));

    const cases = await listRawCases(raw);
    expect(cases.map((c) => c.name)).toEqual(["Case 2", "Case 10", "Empty case", "loose clip.mov"]);
    expect(cases[0].videos.map((v) => v.file)).toEqual(["a.mp4", "b.avi"]);
    expect(cases[1]).toMatchObject({ caseId: "Case 10", videos: [{ file: "video.mp4", bytes: 5 }] });
    expect(cases[1].videos[0].path).toBe(path.join(raw, "Case 10", "video.mp4"));
    expect(cases[2].videos).toEqual([]);
    expect(cases[3].caseId).toBe("loose clip");
  });

  it("never writes to the Raw folder", async () => {
    await fs.mkdir(path.join(raw, "Case 1"));
    await fs.writeFile(path.join(raw, "Case 1", "v.mp4"), "1");
    const before = await fs.readdir(raw, { recursive: true });
    await listRawCases(raw);
    expect(await fs.readdir(raw, { recursive: true })).toEqual(before);
  });

  it("returns nothing (rather than throwing) when the folder is missing", async () => {
    expect(await listRawCases(path.join(raw, "nope"))).toEqual([]);
  });
});

describe("isInside", () => {
  it("only accepts paths below the folder", () => {
    expect(isInside(raw, path.join(raw, "Case 1", "v.mp4"))).toBe(true);
    expect(isInside(raw, raw)).toBe(false);
    expect(isInside(raw, path.join(raw, "..", "elsewhere.mp4"))).toBe(false);
    expect(isInside(raw, path.join(os.tmpdir(), "x.mp4"))).toBe(false);
  });
});
