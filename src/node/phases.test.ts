import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { runIntake } from "./intake.js";
import { run } from "./proc.js";
import { savePhaseLabels, loadPhaseLabels, loadFrameIndex, runPhaseExport, saveCrop, loadCrop } from "./phases.js";
import { listSegFrames, removeFrames } from "./segmentation.js";

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
      "CASE_01_cannulation-attempt_01_t00002000-00004000.mp4",
      "CASE_01_cannulation-attempt_02_t00005000-00006000.mp4",
    ]);
    const probe = await run(ffprobePath, [
      "-v", "quiet", "-print_format", "json", "-show_format",
      path.join(out, "CASE_01_fluoroscopy", "CASE_01_fluoroscopy_01_t00006000-00009000.mp4"),
    ]);
    expect(Number(JSON.parse(probe.stdout).format.duration)).toBeCloseTo(3, 0);

    // 1 fps over 2 + 2 + 1 s of endoscopic phases; none from fluoroscopy.
    const raw = (await fs.readdir(path.join(base, "projects", "p", "01_frames", "raw"))).sort();
    // The second attempt's frames carry _02, matching its clip.
    expect(raw).toEqual([
      "CASE_01_t00000000_duodenum_01.png",
      "CASE_01_t00001000_duodenum_01.png",
      "CASE_01_t00002000_cannulation-attempt_01.png",
      "CASE_01_t00003000_cannulation-attempt_01.png",
      "CASE_01_t00005000_cannulation-attempt_02.png",
    ]);
    expect(r.frames).toBe(5);
    expect((await loadFrameIndex(base, "p"))["CASE_01_t00005000_cannulation-attempt_02.png"]).toEqual({
      phase: "cannulation-attempt",
      span: 2,
      timeSec: 5,
    });
    // frames.json also indexes the clips with their source times, for training.
    const idx = JSON.parse(await fs.readFile(path.join(base, "projects", "p", "01_frames", "frames.json"), "utf8"));
    expect(idx.clips[1]).toEqual({
      file: "CASE_01_cannulation-attempt/CASE_01_cannulation-attempt_01_t00002000-00004000.mp4",
      phase: "cannulation-attempt", span: 1, startSec: 2, endSec: 4,
    });
    // The annotator sees each frame's phase.
    const seg = await listSegFrames(base, "p");
    expect(seg.frames.map((f) => f.phase)).toEqual([
      "duodenum", "duodenum", "cannulation-attempt", "cannulation-attempt", "cannulation-attempt",
    ]);

    // A frame the annotator removed stays out on re-export.
    expect(await removeFrames(base, "p", ["CASE_01_t00003000_cannulation-attempt_01.png"])).toHaveLength(1);

    // Re-export after deleting a span removes its clip and frames, but not other files in the folder.
    await fs.writeFile(path.join(out, "CASE_01_cannulation-attempt", "notes.txt"), "keep me");
    await savePhaseLabels(base, "p", {
      version: 1,
      spans: [{ id: "b", phase: "cannulation-attempt", start: 2, end: 4 }],
    });
    // ...and a crop applies to both clips and frames (odd values are rounded to even).
    expect(await saveCrop(base, "p", { x: 9, y: 8, w: 41, h: 32 })).toEqual({ x: 8, y: 8, w: 40, h: 32 });
    const r2 = await runPhaseExport({ baseDir: base, projectId: "p", ffmpegPath, exportRoot: out, fps: 1 });
    expect(r2).toMatchObject({ clips: 1, frames: 1 });
    const size = async (file: string) => {
      const res = await run(ffprobePath, ["-v", "quiet", "-print_format", "json", "-show_streams", file]);
      const s = JSON.parse(res.stdout).streams[0];
      return `${s.width}x${s.height}`;
    };
    expect(await size(path.join(out, "CASE_01_cannulation-attempt", "CASE_01_cannulation-attempt_01_t00002000-00004000.mp4"))).toBe("40x32");
    expect(await size(path.join(base, "projects", "p", "01_frames", "raw", "CASE_01_t00002000_cannulation-attempt_01.png"))).toBe("40x32");
    // Clearing the crop goes back to the whole picture.
    expect(await saveCrop(base, "p", null)).toBeNull();
    expect(await loadCrop(base, "p")).toBeNull();
    expect((await fs.readdir(path.join(out, "CASE_01_cannulation-attempt"))).sort()).toEqual([
      "CASE_01_cannulation-attempt_01_t00002000-00004000.mp4",
      "notes.txt",
    ]);
    expect(await fs.readdir(path.join(out, "CASE_01_duodenum"))).toEqual([]);
  }, 120000);

  it("refuses to export without a video or without labels", async () => {
    await expect(runPhaseExport({ baseDir: base, projectId: "none", ffmpegPath, exportRoot: out, fps: 1 }))
      .rejects.toThrow(/No video/);
  });
});
