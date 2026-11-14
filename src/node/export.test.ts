import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { inflateSync } from "node:zlib";
import * as os from "node:os";
import * as path from "node:path";
import { createProjectOnDisk } from "./library.js";
import { runExport, writePng } from "./export.js";

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-export-"));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

/** Read back an unfiltered (filter 0) 8-bit PNG written by writePng. */
async function readPng(file: string): Promise<{ w: number; h: number; ch: number; px: Uint8Array }> {
  const data = await fs.readFile(file);
  const w = data.readUInt32BE(16), h = data.readUInt32BE(20);
  const ch = data[25] === 2 ? 3 : 1;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString("ascii", pos + 4, pos + 8);
    if (type === "IDAT") idat.push(data.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w * ch + 1) + 1, (y + 1) * (w * ch + 1)), y * w * ch);
  return { w, h, ch, px };
}

const W = 20, H = 20;
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

describe("runExport", () => {
  it("writes per-class binary masks that keep overlaps, plus label map, preview and metadata", async () => {
    const { id, dir } = await createProjectOnDisk(base, "Exp", "2026-11-13T00:00:00Z");
    await fs.writeFile(path.join(dir, "01_frames", "raw", "v_f0000000.png"), writePng(new Uint8Array(W * H), W, H));

    const seg = path.join(dir, "02_segmentation");
    await fs.mkdir(path.join(seg, "masks"), { recursive: true });
    // Papilla body (1) covers the left half; sphincterotome (10) overlaps it in the middle.
    await fs.writeFile(path.join(seg, "annotations.leus"), JSON.stringify({
      version: 1,
      frames: [
        { frameId: "v_f0000000.png", name: "v_f0000000", phase: "cannulation", polygons: [
          { id: "a", classId: 1, points: rect(0, 0, 10, 20) },
          { id: "b", classId: 10, points: rect(5, 5, 15, 15) },
        ] },
        { frameId: "v_f0000001.png", name: "v_f0000001", phase: "cannulation", polygons: [] },
      ],
    }));
    // Specular highlight (7) painted only with the brush: a single pixel at (2,2).
    const brush = new Uint8Array(W * H); brush[2 * W + 2] = 255;
    await fs.writeFile(path.join(seg, "masks", "v_f0000000__class7.png"), writePng(brush, W, H));

    const res = await runExport(base, id, () => {});
    expect(res.frameCount).toBe(1);
    expect(res.labelMapCount).toBe(1);

    const pb = await readPng(path.join(res.exportDir, "masks", "PAPILLA_BODY", "v_f0000000.png"));
    const sph = await readPng(path.join(res.exportDir, "masks", "SPHINCTEROTOME", "v_f0000000.png"));
    const sh = await readPng(path.join(res.exportDir, "masks", "SPECULAR_HIGHLIGHT", "v_f0000000.png"));
    const fp = await readPng(path.join(res.exportDir, "masks", "FLUID_POOL", "v_f0000000.png"));
    const at = (p: Uint8Array, x: number, y: number) => p[y * W + x];

    // Overlap at (7,10): both the papilla and the sphincterotome masks keep it.
    expect(at(pb.px, 7, 10)).toBe(255);
    expect(at(sph.px, 7, 10)).toBe(255);
    expect(at(pb.px, 12, 10)).toBe(0);
    expect(at(sh.px, 2, 2)).toBe(255);
    // Absent class still gets an all-black mask.
    expect(fp.px.every((v) => v === 0)).toBe(true);

    // Label map: one class per pixel, higher id wins.
    const lm = await readPng(path.join(res.exportDir, "label_maps", "v_f0000000.png"));
    expect(at(lm.px, 7, 10)).toBe(10);
    expect(at(lm.px, 2, 10)).toBe(1);
    expect(at(lm.px, 2, 2)).toBe(7);
    expect(at(lm.px, 18, 18)).toBe(0);

    const pv = await readPng(path.join(res.exportDir, "previews", "v_f0000000.png"));
    expect(pv.ch).toBe(3);
    const i = (10 * W + 7) * 3;
    expect([...pv.px.subarray(i, i + 3)]).toEqual([0xef, 0x44, 0x44]); // SPHINCTEROTOME red

    const meta = JSON.parse(await fs.readFile(path.join(res.exportDir, "metadata.json"), "utf8"));
    expect(meta.version).toBe(2);
    const f = meta.frames[0];
    expect(f.classIds).toEqual([1, 7, 10]); // brush-only class 7 included
    expect(f.classPixels["7"]).toBe(1);
    expect(f.masks.SPHINCTEROTOME).toBe("masks/SPHINCTEROTOME/v_f0000000.png");
    expect(Object.keys(f.masks)).toHaveLength(10);
    expect(f.preview).toBe("previews/v_f0000000.png");
  });
});
