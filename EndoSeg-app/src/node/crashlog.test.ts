import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CrashLogger, formatIncident } from "./crashlog.js";

const ENV = { appVersion: "0.1.0", os: "Windows 11", electron: "33.2.0" };
const T = "2026-06-13T10:00:00.000Z";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "endoseg-log-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("formatIncident", () => {
  it("produces a readable, paste-friendly report", () => {
    const text = formatIncident(
      { id: "crash-x", timestamp: T, source: "uncaughtException", message: "boom", detail: "at foo()" },
      ENV,
    );
    expect(text).toContain("EndoSeg crash report");
    expect(text).toContain("boom");
    expect(text).toContain("at foo()");
    expect(text).toContain("App version: 0.1.0");
  });

  it("omits optional lines when absent", () => {
    const text = formatIncident(
      { id: "y", timestamp: T, source: "s", message: "m" },
      { appVersion: "0.1.0", os: "win" },
    );
    expect(text).not.toContain("Detail:");
    expect(text).not.toContain("Project:");
    expect(text).not.toContain("Electron:");
  });
});

describe("CrashLogger", () => {
  it("records incidents to both the rolling log and per-incident files", async () => {
    const logger = new CrashLogger(dir, ENV);
    const a = await logger.record({ source: "uncaughtException", message: "first" }, T);
    const b = await logger.record({ source: "python:segment", message: "second" }, T);
    expect(a.id).not.toBe(b.id);

    const rolling = await fs.readFile(path.join(dir, "endoseg.log"), "utf8");
    expect(rolling).toContain("first");
    expect(rolling).toContain("second");

    const list = await logger.list();
    expect(list).toHaveLength(2);

    const text = await logger.read(list[0]);
    expect(text).toBeTruthy();
  });

  it("refuses path traversal in read()", async () => {
    const logger = new CrashLogger(dir, ENV);
    expect(await logger.read("../../etc/passwd")).toBeNull();
    expect(await logger.read("..\\secret.txt")).toBeNull();
  });

  it("list() is empty when nothing has been recorded", async () => {
    const logger = new CrashLogger(dir, ENV);
    expect(await logger.list()).toEqual([]);
  });
});
