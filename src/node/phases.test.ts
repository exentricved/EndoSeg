import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { runIntake } from "./intake.js";
import { run } from "./proc.js";
import { savePhaseLabels, loadPhaseLabels, loadFrameIndex, runPhaseExport } from "./phases.js";
import { listSegFrames } from "./segmentation.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");
const ffprobePath: string = require("ffprobe-static").path;

describe("phase export (real ffmpeg integration)", () => {
  let base: string;
  let out: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-phases-"));
    out = path.join(base, "Annotated Videos");
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("writes clips into <case>_<phase> folders and 1 fps frames for the endoscopic phases", async () => {
    // A 10 s video at <raw>/CASE_01/video.avi, as on the NAS.
    const caseDir = path.join(base, "Raw", "CASE_01");
    await fs.mkdir(caseDir, { recursive: true });
    const src = path.join(caseDir, "video.avi");
    const gen = await run(ffmpegPath, [
      "-hide_banner", "-f", "lavfi", "-i", "testsrc=duration=10:size=64x64:rate=30",
      "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p", "-y", src,
    ]);
    expect(gen.code).toBe(0);
    await runIntake({ baseDir: base, projectId: "p", sourcePath: src, ffmpegPath, ffprobePath, now: "x" });

    await savePhaseLabels(base, "p", {
      version: 1,
      spans: [
        { id: "a", phase: "duodenum", start: 0, end: 2 },
        { id: "b", phase: "cannulation-attempt", start: 2, end: 4 },
        { id: "c", phase: "cannulation-attempt", start: 5, end: 6 },
        { id: "d", phase: "fluoroscopy", start: 6, end: 9 },
      ],
    });
    expect((await loadPhaseLabels(base, "p")).spans).toHaveLength(4);

    const steps: string[] = [];
    const r = await runPhaseExport({
      baseDir: base, projectId: "p", ffmpegPath, exportRoot: out, fps: 1,
      onProgress: (p) => steps.push(p.step),
    });
    expect(r).toMatchObject({ caseName: "CASE_01", clips: 4 });
    expect(steps).toContain("clip");
    expect(steps).toContain("frames");

    expect((await fs.readdir(out)).sort()).toEqual([
      "CASE_01_cannulation-attempt",
      "CASE_01_duodenum",
      "CASE_01_fluoroscopy",
    ]);
    expect((await fs.readdir(path.join(out, "CASE_01_cannulation-attempt"))).sort()).toEqual([
      "CASE_01_cannulation-attempt_01.mp4",
      "CASE_01_cannulation-attempt_02.mp4",
    ]);
    const probe = await run(ffprobePath, [
      "-v", "quiet", "-print_format", "json", "-show_format",
      path.join(out, "CASE_01_fluoroscopy", "CASE_01_fluoroscopy_01.mp4"),
    ]);
    expect(Number(JSON.parse(probe.stdout).format.duration)).toBeCloseTo(3, 0);

    // 1 fps over 2 + 2 + 1 s of endoscopic phases; none from fluoroscopy.
    const raw = (await fs.readdir(path.join(base, "projects", "p", "01_frames", "raw"))).sort();
    expect(raw).toEqual([
      "CASE_01_t00000000_duodenum.png",
      "CASE_01_t00001000_duodenum.png",
      "CASE_01_t00002000_cannulation-attempt.png",
      "CASE_01_t00003000_cannulation-attempt.png",
      "CASE_01_t00005000_cannulation-attempt.png",
    ]);
    expect(r.frames).toBe(5);
    expect((await loadFrameIndex(base, "p"))["CASE_01_t00003000_cannulation-attempt.png"]).toEqual({
      phase: "cannulation-attempt",
      timeSec: 3,
    });
    // The annotator sees each frame's phase.
    const seg = await listSegFrames(base, "p");
    expect(seg.frames.map((f) => f.phase)).toEqual([
      "duodenum", "duodenum", "cannulation-attempt", "cannulation-attempt", "cannulation-attempt",
    ]);

    // Re-export after deleting a span removes its clip and frames, but not other files in the folder.
    await fs.writeFile(path.join(out, "CASE_01_cannulation-attempt", "notes.txt"), "keep me");
    await savePhaseLabels(base, "p", {
      version: 1,
      spans: [{ id: "b", phase: "cannulation-attempt", start: 2, end: 4 }],
    });
    const r2 = await runPhaseExport({ baseDir: base, projectId: "p", ffmpegPath, exportRoot: out, fps: 1 });
    expect(r2).toMatchObject({ clips: 1, frames: 2 });
    expect((await fs.readdir(path.join(out, "CASE_01_cannulation-attempt"))).sort()).toEqual([
      "CASE_01_cannulation-attempt_01.mp4",
      "notes.txt",
    ]);
    expect(await fs.readdir(path.join(out, "CASE_01_duodenum"))).toEqual([]);
  }, 120000);

  it("refuses to export without a video or without labels", async () => {
    await expect(runPhaseExport({ baseDir: base, projectId: "none", ffmpegPath, exportRoot: out, fps: 1 }))
      .rejects.toThrow(/No video/);
  });
});
