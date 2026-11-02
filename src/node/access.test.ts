import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { caseAccess } from "./access.js";
import { acquireLock, lockPath, resetLockObservations } from "./caselock.js";
import { PROVENANCE_FILE } from "./review.js";

let root: string;
let a1Case: string;
let a2: string;
const B = { sessionId: "sess-b", computer: "PC-B", user: "ub" };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-access-"));
  a1Case = path.join(root, "Annotated 1", "DEMO_01");
  a2 = path.join(root, "Annotated 2");
  await fs.mkdir(a1Case, { recursive: true });
  await fs.mkdir(a2, { recursive: true });
  resetLockObservations();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const q = () => ({ ws: "a1" as const, id: "DEMO_01", caseDir: a1Case, a2Dir: a2, sessionId: "sess-a", nowMs: Date.now() });

describe("caseAccess", () => {
  it("a free case is editable", async () => {
    expect(await caseAccess(q())).toEqual({ readOnly: false });
  });

  it("a case open elsewhere is read-only and says who has it", async () => {
    await acquireLock(a1Case, B, Date.now());
    expect(await caseAccess(q())).toMatchObject({ readOnly: true, lockedBy: "PC-B (ub)" });
  });

  it("an Annotated 1 case with a finished review copy is read-only and points at it", async () => {
    await fs.mkdir(path.join(a2, "DEMO_01"));
    await fs.writeFile(path.join(a2, "DEMO_01", PROVENANCE_FILE), "{}");
    expect(await caseAccess(q())).toMatchObject({ readOnly: true, reviewRef: "a2:DEMO_01" });
  });

  it("a lock that can't be read (NAS trouble) makes the case read-only, never free", async () => {
    await fs.mkdir(lockPath(a1Case)); // reading it fails
    expect((await caseAccess(q())).readOnly).toBe(true);
  });
});
