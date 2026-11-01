import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { claimProjectOnDisk, updateStageOnDisk, listProjects, AlreadyExistsError } from "./library.js";
import { startSecondReview, isInReview, planCaseCopy, PROVENANCE_FILE, SENT_FILE, type Provenance } from "./review.js";

const T0 = "2026-11-01T10:00:00.000Z";
let root: string;
let a1: string;
let a2: string;

const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** A case in Annotated 1 with intake done, a video, labels, clips and scratch files. */
async function makeCase(id: string, video = "VIDEO-BYTES".repeat(1000)): Promise<string> {
  await claimProjectOnDisk(a1, id, id, T0);
  const dir = path.join(a1, id);
  await fs.writeFile(path.join(dir, "00_intake", "source", "case.mp4"), video);
  await fs.writeFile(
    path.join(dir, "00_intake", "intake.json"),
    JSON.stringify({ sourceFile: "case.mp4", sha256: sha(video), playbackFile: "source/case.mp4" }),
  );
  await fs.writeFile(path.join(dir, "00_intake", "phases.json"), '{"spans":[]}');
  await fs.mkdir(path.join(dir, "clips", `${id}_duodenum`), { recursive: true });
  await fs.writeFile(path.join(dir, "clips", `${id}_duodenum`, "clip.mp4"), "CLIP");
  await fs.writeFile(path.join(dir, "01_frames", "raw", "f1.png"), "PNG1");
  await fs.writeFile(path.join(dir, "autosave", "scratch.json"), "{}");
  await fs.writeFile(path.join(dir, "logs", "crash", "x.log"), "log");
  await fs.writeFile(path.join(dir, "00_intake", "half.mp4.partial"), "junk");
  await updateStageOnDisk(a1, id, "intake", { status: "done" }, T0);
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-review-"));
  a1 = path.join(root, "Annotated 1");
  a2 = path.join(root, "Annotated 2");
  await fs.mkdir(a1);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("startSecondReview", () => {
  it("copies the whole case, video included, and records hashes", async () => {
    const src = await makeCase("DEMO_01");
    const progress: string[] = [];
    const prov = await startSecondReview({
      a1Dir: a1, a2Dir: a2, id: "DEMO_01", now: T0, appVersion: "0.3.0",
      onProgress: (p) => progress.push(`${p.phase}:${p.percent}`),
    });
    const dest = path.join(a2, "DEMO_01");
    for (const f of ["00_intake/source/case.mp4", "00_intake/phases.json", "clips/DEMO_01_duodenum/clip.mp4", "01_frames/raw/f1.png", "project.json"]) {
      expect(await fs.readFile(path.join(dest, f))).toEqual(await fs.readFile(path.join(src, f)));
    }
    // Scratch and half-written files stay behind; the skeleton folders exist.
    expect(existsSync(path.join(dest, "autosave", "scratch.json"))).toBe(false);
    expect(existsSync(path.join(dest, "logs", "crash", "x.log"))).toBe(false);
    expect(existsSync(path.join(dest, "logs", "crash"))).toBe(true);
    expect(existsSync(path.join(dest, "00_intake", "half.mp4.partial"))).toBe(false);
    expect(existsSync(path.join(dest, "02_segmentation", "masks"))).toBe(true);

    const onDisk = JSON.parse(await fs.readFile(path.join(dest, PROVENANCE_FILE), "utf8")) as Provenance;
    expect(onDisk).toEqual(prov);
    expect(JSON.parse(await fs.readFile(path.join(src, SENT_FILE), "utf8"))).toEqual(prov);
    expect(prov.files.map((f) => f.path)).toContain("00_intake/source/case.mp4");
    const vid = prov.files.find((f) => f.path === "00_intake/source/case.mp4")!;
    expect(vid.sha256).toBe(prov.intakeSha256);
    expect(prov.totalBytes).toBe(prov.files.reduce((s, f) => s + f.bytes, 0));
    expect(progress.at(-1)).toBe("verify:100");

    expect((await listProjects(a2)).map((p) => p.id)).toEqual(["DEMO_01"]);
    expect(isInReview(a2, "DEMO_01")).toBe(true);
  });

  it("lets only one of two simultaneous starts win", async () => {
    await makeCase("DEMO_02");
    const opts = { a1Dir: a1, a2Dir: a2, id: "DEMO_02", now: T0, appVersion: "t" };
    const r = await Promise.allSettled([startSecondReview(opts), startSecondReview(opts)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AlreadyExistsError);
    // The loser must not have removed the winner's folder.
    expect(existsSync(path.join(a2, "DEMO_02", PROVENANCE_FILE))).toBe(true);
  });

  it("refuses a case whose intake isn't done, without creating anything", async () => {
    await claimProjectOnDisk(a1, "DEMO_03", "DEMO_03", T0);
    await expect(startSecondReview({ a1Dir: a1, a2Dir: a2, id: "DEMO_03", now: T0, appVersion: "t" })).rejects.toThrow(/intake/i);
    expect(isInReview(a2, "DEMO_03")).toBe(false);
  });

  it("removes the partial copy when the video no longer matches its intake hash", async () => {
    const src = await makeCase("DEMO_04");
    await fs.writeFile(path.join(src, "00_intake", "source", "case.mp4"), "CHANGED");
    await expect(startSecondReview({ a1Dir: a1, a2Dir: a2, id: "DEMO_04", now: T0, appVersion: "t" })).rejects.toThrow(/hash/);
    expect(isInReview(a2, "DEMO_04")).toBe(false);
    expect(existsSync(path.join(src, SENT_FILE))).toBe(false);
    // Fixing it lets the review be retried.
    await fs.writeFile(path.join(src, "00_intake", "source", "case.mp4"), "VIDEO-BYTES".repeat(1000));
    await startSecondReview({ a1Dir: a1, a2Dir: a2, id: "DEMO_04", now: T0, appVersion: "t" });
    expect(isInReview(a2, "DEMO_04")).toBe(true);
  });

  it("rejects an unknown case", async () => {
    await expect(startSecondReview({ a1Dir: a1, a2Dir: a2, id: "NOPE", now: T0, appVersion: "t" })).rejects.toThrow(/not a case/);
  });
});

describe("planCaseCopy", () => {
  it("skips scratch folders, temp files and earlier review records", async () => {
    const dir = await makeCase("DEMO_05");
    await fs.writeFile(path.join(dir, SENT_FILE), "{}");
    await fs.writeFile(path.join(dir, "project.json.tmp-123"), "{}");
    await fs.writeFile(path.join(dir, ".open.lock"), "{}");
    const { files } = await planCaseCopy(dir);
    const names = files.map((f) => f.rel);
    expect(names).toContain("project.json");
    expect(names.some((n) => n.startsWith("autosave") || n.startsWith("logs"))).toBe(false);
    expect(names).not.toContain(SENT_FILE);
    expect(names).not.toContain(".open.lock");
    expect(names.some((n) => n.endsWith(".partial") || n.includes(".tmp-"))).toBe(false);
  });
});
