import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  HASH_SIZE,
  HASH_W,
  dHash,
  hamming,
  planDedup,
  runDedup,
  type FrameHash,
} from "./dedup.js";
import { run } from "./proc.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string = require("ffmpeg-static");

/** Build a 9x8 grayscale thumbnail from a (row,col) -> value function. */
function thumb(fn: (r: number, c: number) => number): Uint8Array {
  const buf = new Uint8Array(HASH_W * HASH_SIZE);
  for (let r = 0; r < HASH_SIZE; r++) {
    for (let c = 0; c < HASH_W; c++) buf[r * HASH_W + c] = fn(r, c) & 0xff;
  }
  return buf;
}

describe("dHash", () => {
  it("sets every bit for a left-to-right increasing gradient", () => {
    // Each pixel is brighter than its left neighbour → all 64 comparisons true.
    expect(dHash(thumb((_r, c) => c * 10))).toBe((1n << 64n) - 1n);
  });

  it("sets no bit for a decreasing gradient", () => {
    expect(dHash(thumb((_r, c) => 200 - c * 10))).toBe(0n);
  });

  it("sets no bit for a flat (uniform) thumbnail", () => {
    // Neighbours equal → `left < right` is never true.
    expect(dHash(thumb(() => 128))).toBe(0n);
  });
});

describe("hamming", () => {
  it("counts differing bits", () => {
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0n, (1n << 64n) - 1n)).toBe(64);
    expect(hamming(0b1011n, 0b1001n)).toBe(1);
    expect(hamming(0b1111n, 0b0000n)).toBe(4);
  });
});

describe("planDedup", () => {
  const frames: FrameHash[] = [
    { file: "frame_000001.png", hash: 0n },
    { file: "frame_000002.png", hash: 1n }, // dist 1 from rep -> dropped at thr 1
    { file: "frame_000003.png", hash: 0xffn }, // dist 8 from rep -> kept
    { file: "frame_000004.png", hash: 0xffn }, // dist 0 from new rep -> dropped
  ];

  it("keeps frames that exceed the threshold and drops the rest", () => {
    const plan = planDedup(frames, 1);
    expect(plan.kept).toEqual(["frame_000001.png", "frame_000003.png"]);
    expect(plan.dropped).toEqual(["frame_000002.png", "frame_000004.png"]);
    expect(plan.decisions).toHaveLength(4);
    expect(plan.decisions[1]).toMatchObject({ kept: false, representative: "frame_000001.png", distance: 1 });
    expect(plan.decisions[2]).toMatchObject({ kept: true, representative: "frame_000003.png", distance: 8 });
  });

  it("always keeps the first frame and records its hex hash", () => {
    const plan = planDedup([{ file: "frame_000001.png", hash: 0xabcdn }], 8);
    expect(plan.kept).toEqual(["frame_000001.png"]);
    expect(plan.decisions[0]).toMatchObject({ kept: true, hash: "000000000000abcd" });
    expect(plan.decisions[0].distance).toBeUndefined();
  });

  it("drops nothing at threshold 0 unless hashes are identical", () => {
    const plan = planDedup(
      [
        { file: "a", hash: 5n },
        { file: "b", hash: 5n },
        { file: "c", hash: 6n },
      ],
      0,
    );
    expect(plan.kept).toEqual(["a", "c"]);
    expect(plan.dropped).toEqual(["b"]);
  });

  it("handles an empty frame list", () => {
    expect(planDedup([], 8)).toEqual({ kept: [], dropped: [], decisions: [] });
  });
});

describe("runDedup (real ffmpeg integration)", () => {
  let base: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-dedup-"));
  });
  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("hashes raw frames, drops duplicates, copies representatives, writes a report", async () => {
    const rawDir = path.join(base, "projects", "case-d", "01_frames", "raw");
    await fs.mkdir(rawDir, { recursive: true });

    // Synthesize a clip, then pull two visually distinct frames (n=0 and n=40).
    const src = path.join(base, "clip.mp4");
    const gen = await run(ffmpegPath, [
      "-hide_banner", "-f", "lavfi",
      "-i", "testsrc=duration=2:size=64x64:rate=30",
      "-pix_fmt", "yuv420p", "-y", src,
    ]);
    expect(gen.code).toBe(0);

    const a = path.join(base, "A.png");
    const b = path.join(base, "B.png");
    for (const [n, out] of [["0", a], ["40", b]] as const) {
      const r = await run(ffmpegPath, [
        "-hide_banner", "-i", src, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-y", out,
      ]);
      expect(r.code).toBe(0);
    }

    // Contiguous sequence A, A, B, B so ffmpeg's image2 demuxer reads all four.
    await fs.copyFile(a, path.join(rawDir, "Clip_f0000001.png"));
    await fs.copyFile(a, path.join(rawDir, "Clip_f0000002.png"));
    await fs.copyFile(b, path.join(rawDir, "Clip_f0000003.png"));
    await fs.copyFile(b, path.join(rawDir, "Clip_f0000004.png"));

    const res = await runDedup({
      baseDir: base,
      projectId: "case-d",
      ffmpegPath,
      threshold: 0, // only exact-hash duplicates dropped
      now: "2026-06-13T10:00:00.000Z",
    });

    expect(res).toEqual({ total: 4, kept: 2, dropped: 2 });

    const keptDir = path.join(base, "projects", "case-d", "01_frames", "kept");
    const kept = (await fs.readdir(keptDir)).sort();
    expect(kept).toEqual(["Clip_f0000001.png", "Clip_f0000003.png"]);

    const report = JSON.parse(
      await fs.readFile(path.join(base, "projects", "case-d", "01_frames", "dedup-report.json"), "utf8"),
    );
    expect(report).toMatchObject({ schemaVersion: 1, threshold: 0, total: 4, kept: 2, dropped: 2 });
    expect(report.decisions).toHaveLength(4);

    // Re-running is idempotent: kept/ is rebuilt, not appended to.
    const again = await runDedup({
      baseDir: base,
      projectId: "case-d",
      ffmpegPath,
      threshold: 0,
      now: "2026-06-13T10:05:00.000Z",
    });
    expect(again).toEqual({ total: 4, kept: 2, dropped: 2 });
    expect((await fs.readdir(keptDir)).sort()).toEqual(["Clip_f0000001.png", "Clip_f0000003.png"]);
  }, 30000);
});
