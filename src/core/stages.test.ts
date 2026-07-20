import { describe, it, expect } from "vitest";
import {
  createProject,
  setStage,
  currentStage,
  needsAttention,
  completion,
  STAGES,
} from "./stages.js";

const T0 = "2026-06-13T10:00:00.000Z";
const T1 = "2026-06-13T11:00:00.000Z";

describe("createProject", () => {
  it("starts with every stage pending", () => {
    const p = createProject("case12", "Case 12", T0);
    expect(p.schemaVersion).toBe(1);
    expect(p.createdAt).toBe(T0);
    for (const s of STAGES) expect(p.stages[s].status).toBe("pending");
  });

  it("a fresh project sits at intake and is 0% complete", () => {
    const p = createProject("c", "C", T0);
    expect(currentStage(p)).toBe("intake");
    expect(completion(p)).toBe(0);
    expect(needsAttention(p)).toBe(false);
  });
});

describe("setStage", () => {
  it("updates status, stamps time, and bumps updatedAt", () => {
    let p = createProject("c", "C", T0);
    p = setStage(p, "intake", { status: "done", counts: { sources: 1 } }, T1);
    expect(p.stages.intake.status).toBe("done");
    expect(p.stages.intake.at).toBe(T1);
    expect(p.stages.intake.counts).toEqual({ sources: 1 });
    expect(p.updatedAt).toBe(T1);
    // does not mutate the original
    expect(currentStage(createProject("c", "C", T0))).toBe("intake");
  });

  it("advances currentStage as stages complete in order", () => {
    let p = createProject("c", "C", T0);
    p = setStage(p, "intake", { status: "done" }, T1);
    expect(currentStage(p)).toBe("dedup");
    p = setStage(p, "dedup", { status: "done" }, T1);
    expect(currentStage(p)).toBe("segmentation");
    p = setStage(p, "segmentation", { status: "done" }, T1);
    p = setStage(p, "export", { status: "done" }, T1);
    expect(currentStage(p)).toBe("export");
    expect(completion(p)).toBe(1);
  });

  it("currentStage returns the first non-done stage even with a later gap", () => {
    let p = createProject("c", "C", T0);
    // export marked done out of order should not skip the earlier pending stages
    p = setStage(p, "export", { status: "done" }, T1);
    expect(currentStage(p)).toBe("intake");
  });
});

describe("needsAttention", () => {
  it("is true when any stage errors or needs review", () => {
    let p = createProject("c", "C", T0);
    p = setStage(p, "segmentation", { status: "error", error: "boom" }, T1);
    expect(needsAttention(p)).toBe(true);
    p = setStage(p, "segmentation", { status: "needs_review" }, T1);
    expect(needsAttention(p)).toBe(true);
    p = setStage(p, "segmentation", { status: "done" }, T1);
    expect(needsAttention(p)).toBe(false);
  });
});
