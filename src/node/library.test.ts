import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createProjectOnDisk,
  listProjects,
  readManifest,
  updateStageOnDisk,
  checkLibrary,
  slugifyId,
  projectsRoot,
  deleteProjectOnDisk,
  deletedRoot,
  claimProjectOnDisk,
  AlreadyExistsError,
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

describe("deleteProjectOnDisk", () => {
  it("moves the project to _deleted/ so it leaves the list but can be restored", async () => {
    const { id } = await createProjectOnDisk(base, "Case D", T0);
    const keep = await createProjectOnDisk(base, "Case K", T0);
    const dest = await deleteProjectOnDisk(base, id, T1);
    expect(dest).toBe(path.join(deletedRoot(base), `${id}__2026-06-13T11-00-00-000Z`));
    expect((await fs.stat(path.join(dest!, "project.json"))).isFile()).toBe(true);
    expect((await listProjects(base)).map((p) => p.id)).toEqual([keep.id]);
  });

  it("refuses unknown ids and path tricks", async () => {
    await createProjectOnDisk(base, "Case X", T0);
    expect(await deleteProjectOnDisk(base, "nope", T1)).toBeNull();
    expect(await deleteProjectOnDisk(base, "..", T1)).toBeNull();
    expect(await deleteProjectOnDisk(base, "../projects", T1)).toBeNull();
    expect(await listProjects(base)).toHaveLength(1);
  });
});

describe("claimProjectOnDisk", () => {
  it("creates the case folder directly in the workspace under its exact name", async () => {
    const { id, dir } = await claimProjectOnDisk(base, "Case 12 2024-01-05", "Case 12 2024-01-05", T0);
    expect(id).toBe("Case 12 2024-01-05");
    expect(dir).toBe(path.join(base, "Case 12 2024-01-05"));
    expect((await fs.stat(path.join(dir, "00_intake", "source"))).isDirectory()).toBe(true);
    expect((await listProjects(base)).map((p) => p.id)).toEqual(["Case 12 2024-01-05"]);
  });

  it("lets only one of two simultaneous starts win", async () => {
    const results = await Promise.allSettled([
      claimProjectOnDisk(base, "Case R", "Case R", T0),
      claimProjectOnDisk(base, "Case R", "Case R", T0),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(AlreadyExistsError);
  });

  it("does not list reserved _ and . folders, so _deleted never shows up", async () => {
    const { id } = await claimProjectOnDisk(base, "Case Z", "Case Z", T0);
    await deleteProjectOnDisk(base, id, T1);
    await fs.mkdir(path.join(base, ".hidden"), { recursive: true });
    expect(await listProjects(base)).toEqual([]);
    // A deleted case can be started again.
    await claimProjectOnDisk(base, "Case Z", "Case Z", T1);
    expect((await listProjects(base)).map((p) => p.id)).toEqual(["Case Z"]);
  });
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
    expect(list[0].currentStage).toBe("phases");
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

describe("checkLibrary", () => {
  it("creates the skeleton and reports a writable folder, leaving no probe behind", async () => {
    const lib = path.join(base, "lib");
    expect(await checkLibrary(lib)).toEqual({ writable: true });
    expect(await fs.readdir(lib)).toEqual([]);
  });

  it("reports (rather than throws) when the drive is missing", async () => {
    // A plain file where a folder should be: the library can't be created under it.
    await fs.writeFile(path.join(base, "not-a-folder"), "x");
    const r = await checkLibrary(path.join(base, "not-a-folder", "lib"));
    expect(r.writable).toBe(false);
    expect(r.error).toMatch(/Cannot write to/);
  });
});
