import { describe, it, expect } from "vitest";
import { parseRef, makeRef, isSafeCaseId, isVideoFile, rawRows, rawRowStatus, formatBytes, type RawCase } from "./workspaces.js";
import { summarize } from "./manifest.js";
import { createProject, setStage } from "./stages.js";

const T0 = "2026-11-01T10:00:00.000Z";

describe("project refs", () => {
  it("round-trips workspace + case id", () => {
    expect(parseRef(makeRef("a1", "Case 12 2024-01-05"))).toEqual({ ws: "a1", id: "Case 12 2024-01-05" });
    expect(parseRef("a2:x")).toEqual({ ws: "a2", id: "x" });
  });

  it("rejects unknown workspaces and unsafe ids", () => {
    for (const bad of [null, 3, "x", "a3:case", "a1:", "a1:..", "a1:.", "a1:a/b", "a1:a\b", "a1:_deleted", "a1:.git", "a1:x:y", "a1:trailing. "]) {
      expect(parseRef(bad)).toBeNull();
    }
  });

  it("isSafeCaseId accepts ordinary case folder names", () => {
    expect(isSafeCaseId("ABC123 01-02-2024")).toBe(true);
    expect(isSafeCaseId("a".repeat(201))).toBe(false);
  });
});

describe("isVideoFile", () => {
  it("matches video extensions case-insensitively and skips temp/hidden files", () => {
    expect(isVideoFile("video.MP4")).toBe(true);
    expect(isVideoFile("clip.avi")).toBe(true);
    expect(isVideoFile("notes.txt")).toBe(false);
    expect(isVideoFile(".video.mp4")).toBe(false);
    expect(isVideoFile("~$video.mp4")).toBe(false);
    expect(isVideoFile("mp4")).toBe(false);
  });
});

describe("rawRows", () => {
  const raw: RawCase[] = [
    { name: "A", caseId: "A", videos: [{ file: "v.mp4", path: "R/A/v.mp4", bytes: 10 }] },
    { name: "B", caseId: "B", videos: [{ file: "v.mp4", path: "R/B/v.mp4", bytes: 10 }] },
    { name: "C", caseId: "C", videos: [{ file: "v.mp4", path: "R/C/v.mp4", bytes: 10 }] },
    { name: "D", caseId: "D", videos: [] },
    { name: "E", caseId: "E", videos: [{ file: "v.mp4", path: "R/E/v.mp4", bytes: 10 }] },
  ];
  const b = summarize(setStage(createProject("B", "B", T0), "intake", { status: "done" }, T0));
  const c = summarize(setStage(createProject("C", "C", T0), "intake", { status: "done" }, T0));
  const e = summarize(setStage(createProject("E", "E", T0), "intake", { status: "error", error: "x" }, T0));
  const rows = rawRows(raw, [b, c, e], [summarize(createProject("C", "C", T0))]);

  it("derives each case's place in the pipeline from what exists on disk", () => {
    expect(rows.map(rawRowStatus)).toEqual([
      "Not started",
      "In Annotated 1",
      "In Annotated 2",
      "No video in folder",
      "Annotated 1 · intake failed",
    ]);
    expect(rows[1].a1).toEqual({ currentStage: "phases", currentStatus: "pending", intakeStatus: "done" });
    expect(rows[0].a1).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3.2 * 1024 ** 3)).toBe("3.2 GB");
  });
});
