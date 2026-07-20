import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  parseFps,
  parseFfprobe,
  safeBasename,
  buildExtractArgs,
  buildProbeArgs,
  sha256File,
  runIntake,
} from "./intake.js";
import { run } from "./proc.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");
const ffprobePath: string = require("ffprobe-static").path;

describe("parseFps", () => {
  it("handles rationals, integers, and junk", () => {
    expect(parseFps("30000/1001")).toBe(29.97);
    expect(parseFps("25/1")).toBe(25);
    expect(parseFps("0/0")).toBe(0);
    expect(parseFps("24")).toBe(24);
    expect(parseFps(undefined)).toBe(0);
  });
});

describe("parseFfprobe", () => {
  it("extracts video metadata and ignores audio streams", () => {
    const meta = parseFfprobe({
      format: { duration: "2.0", size: "12345" },
      streams: [
        { codec_type: "audio", codec_name: "aac" },
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" },
      ],
    });
    expect(meta).toEqual({
      durationSec: 2,
      bytes: 12345,
      fps: 30,
      width: 1920,
      height: 1080,
      codec: "h264",
    });
  });

  it("is safe on empty/garbage input", () => {
    expect(parseFfprobe(null).width).toBe(0);
    expect(parseFfprobe({}).codec).toBe("unknown");
  });
});

describe("safeBasename", () => {
  it("strips paths and unsafe characters", () => {
    expect(safeBasename("C:/tmp/case 12.mp4")).toBe("case_12.mp4");
    expect(safeBasename("../../evil.mp4")).toBe("evil.mp4");
    expect(safeBasename("")).toBe("video");
  });
});

describe("buildExtractArgs", () => {
  it("escapes the comma inside mod() and honours sampleEvery", () => {
    const args = buildExtractArgs("in.mp4", "out/frame_%06d.png", 6);
    expect(args).toContain("select=not(mod(n\\,6))");
    expect(args).toContain("-i");
    expect(args).toContain("out/frame_%06d.png");
  });
  it("clamps sampleEvery to >= 1", () => {
    expect(buildExtractArgs("in", "out", 0)).toContain("select=not(mod(n\\,1))");
  });
});

describe("buildProbeArgs", () => {
  it("requests json format and streams", () => {
    const args = buildProbeArgs("in.mp4");
    expect(args).toContain("json");
    expect(args).toContain("-show_streams");
    expect(args[args.length - 1]).toBe("in.mp4");
  });
});

describe("sha256File", () => {
  it("hashes file contents", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-hash-"));
    const f = path.join(dir, "a.txt");
    await fs.writeFile(f, "hello");
    // sha256("hello")
    expect(await sha256File(f)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("runIntake (real ffmpeg integration)", () => {
  let base: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-intake-"));
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("copies, probes, and extracts every 6th frame of a synthesized clip", async () => {
    // Synthesize a 2s, 30fps, 64x64 test clip → 60 frames total.
    const src = path.join(base, "Test Clip.mp4");
    const gen = await run(ffmpegPath, [
      "-hide_banner", "-f", "lavfi",
      "-i", "testsrc=duration=2:size=64x64:rate=30",
      "-pix_fmt", "yuv420p", "-y", src,
    ]);
    expect(gen.code).toBe(0);

    const record = await runIntake({
      baseDir: base,
      projectId: "case-x",
      sourcePath: src,
      ffmpegPath,
      ffprobePath,
      sampleEvery: 6,
      now: "2026-06-13T10:00:00.000Z",
    });

    // Source copied with a sanitized name.
    expect(record.sourceFile).toBe("Test_Clip.mp4");
    const copied = path.join(base, "projects", "case-x", "00_intake", "source", "Test_Clip.mp4");
    expect((await fs.stat(copied)).isFile()).toBe(true);

    // Metadata read correctly.
    expect(record.meta.width).toBe(64);
    expect(record.meta.height).toBe(64);
    expect(record.meta.fps).toBe(30);
    expect(Math.round(record.meta.durationSec)).toBe(2);
    expect(record.sha256).toHaveLength(64);

    // 60 frames, keeping every 6th (n=0,6,...,54) → 10 frames.
    expect(record.framesExtracted).toBe(10);
    const rawDir = path.join(base, "projects", "case-x", "01_frames", "raw");
    const frames = (await fs.readdir(rawDir)).filter((f) => f.endsWith(".png"));
    expect(frames).toHaveLength(10);

    // intake.json written.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(base, "projects", "case-x", "00_intake", "intake.json"), "utf8"),
    );
    expect(onDisk.framesExtracted).toBe(10);
  }, 30000);
});
