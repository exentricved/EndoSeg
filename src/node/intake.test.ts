import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  parseFps,
  parseFfprobe,
  safeBasename,
  parseProgressTime,
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

describe("parseProgressTime", () => {
  it("reads ffmpeg's time= field", () => {
    expect(parseProgressTime("frame=  120 fps=60 time=00:01:02.50 bitrate=1kbits/s")).toBe(62.5);
    expect(parseProgressTime("no progress here")).toBeNull();
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

  const synth = async (file: string, codec: string[] = ["-pix_fmt", "yuv420p"]) => {
    const gen = await run(ffmpegPath, [
      "-hide_banner", "-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=30", ...codec, "-y", file,
    ]);
    expect(gen.code).toBe(0);
  };

  it("copies, hashes and probes an mp4, which the player streams directly", async () => {
    const src = path.join(base, "Test Clip.mp4");
    await synth(src);
    const record = await runIntake({
      baseDir: base, projectId: "case-x", sourcePath: src, ffmpegPath, ffprobePath, now: "2026-06-13T10:00:00.000Z",
    });

    expect(record.sourceFile).toBe("Test_Clip.mp4");
    const intakeDir = path.join(base, "projects", "case-x", "00_intake");
    expect((await fs.stat(path.join(intakeDir, "source", "Test_Clip.mp4"))).isFile()).toBe(true);
    expect(record.meta).toMatchObject({ width: 64, height: 64, fps: 30, codec: "h264" });
    expect(Math.round(record.meta.durationSec)).toBe(2);
    expect(record.sha256).toHaveLength(64);
    expect(record.playbackFile).toBe("source/Test_Clip.mp4");
    const onDisk = JSON.parse(await fs.readFile(path.join(intakeDir, "intake.json"), "utf8"));
    expect(onDisk.playbackFile).toBe("source/Test_Clip.mp4");
  }, 30000);

  it("makes an H.264 preview for an AVI, and a re-import replaces the old source", async () => {
    const avi = path.join(base, "video.avi");
    await synth(avi, ["-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p"]);
    const opts = { baseDir: base, projectId: "case-y", ffmpegPath, ffprobePath, now: "x" };
    const progress: string[] = [];
    const record = await runIntake({ ...opts, sourcePath: avi, onProgress: (p) => progress.push(p.phase) });
    expect(record.playbackFile).toBe("preview.mp4");
    expect(progress).toContain("preview");
    const intakeDir = path.join(base, "projects", "case-y", "00_intake");
    const { stdout } = await run(ffprobePath, ["-v", "quiet", "-print_format", "json", "-show_streams", path.join(intakeDir, "preview.mp4")]);
    expect(JSON.parse(stdout).streams[0].codec_name).toBe("h264");

    const mp4 = path.join(base, "other.mp4");
    await synth(mp4);
    const second = await runIntake({ ...opts, sourcePath: mp4 });
    expect(second.playbackFile).toBe("source/other.mp4");
    expect(await fs.readdir(path.join(intakeDir, "source"))).toEqual(["other.mp4"]);
    await expect(fs.stat(path.join(intakeDir, "preview.mp4"))).rejects.toThrow();
  }, 60000);
});
