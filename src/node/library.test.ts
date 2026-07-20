import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createProjectOnDisk,
  listProjects,
  readManifest,
  updateStageOnDisk,
  slugifyId,
  projectsRoot,
} from "./library.js";

const T0 = "2026-06-13T10:00:00.000Z";
const T1 = "2026-06-13T11:00:00.000Z";

let base: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-test-"));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("slugifyId", () => {
  it("makes filesystem-safe ids", () => {
    expect(slugifyId("Case 12 — sphincterotomy")).toBe("case-12-sphincterotomy");
    expect(slugifyId("???")).toBe("project");
  });
});

describe("createProjectOnDisk", () => {
  it("creates the full stage directory skeleton + manifest", async () => {
    const { id, dir } = await createProjectOnDisk(base, "Case 12", T0);
    expect(id).toBe("case-12");
    for (const sub of [
      "00_intake/source",
      "01_frames/raw",
      "01_frames/kept",
      "02_segmentation/masks",
      "03_export",
      "autosave",
      "logs/crash",
    ]) {
      const st = await fs.stat(path.join(dir, sub));
      expect(st.isDirectory()).toBe(true);
    }
    const m = await readManifest(base, id);
    expect(m?.name).toBe("Case 12");
    expect(m?.stages.intake.status).toBe("pending");
  });

  it("avoids id collisions", async () => {
    const a = await createProjectOnDisk(base, "Case 12", T0);
    const b = await createProjectOnDisk(base, "Case 12", T0);
    expect(a.id).toBe("case-12");
    expect(b.id).toBe("case-12-2");
  });
});

describe("updateStageOnDisk + listProjects", () => {
  it("persists stage changes and lists summaries", async () => {
    const { id } = await createProjectOnDisk(base, "Case A", T0);
    const updated = await updateStageOnDisk(
      base,
      id,
      "intake",
      { status: "done", counts: { sources: 1 } },
      T1,
    );
    expect(updated?.stages.intake.status).toBe("done");

    const reread = await readManifest(base, id);
    expect(reread?.stages.intake.status).toBe("done");
    expect(reread?.stages.intake.counts).toEqual({ sources: 1 });

    const list = await listProjects(base);
    expect(list).toHaveLength(1);
    expect(list[0].currentStage).toBe("dedup");
  });

  it("ignores non-project junk in the projects dir", async () => {
    await createProjectOnDisk(base, "Real", T0);
    await fs.mkdir(path.join(projectsRoot(base), "not-a-project"), { recursive: true });
    await fs.writeFile(
      path.join(projectsRoot(base), "not-a-project", "project.json"),
      "{ broken json",
    );
    const list = await listProjects(base);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Real");
  });

  it("returns empty list when library has no projects dir yet", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-empty-"));
    expect(await listProjects(empty)).toEqual([]);
    await fs.rm(empty, { recursive: true, force: true });
  });

  it("atomic write leaves no .tmp files behind", async () => {
    const { id } = await createProjectOnDisk(base, "Clean", T0);
    const dir = path.join(projectsRoot(base), id);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });
});
