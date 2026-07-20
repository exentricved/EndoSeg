import { describe, it, expect } from "vitest";
import { createProject, setStage } from "./stages.js";
import { parseManifest, summarize, sortSummaries } from "./manifest.js";

const T0 = "2026-06-13T10:00:00.000Z";
const T1 = "2026-06-13T11:00:00.000Z";

describe("parseManifest", () => {
  it("round-trips a manifest created by createProject", () => {
    const p = createProject("c", "C", T0);
    const json = JSON.parse(JSON.stringify(p));
    const r = parseManifest(json);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(p);
  });

  it("rejects wrong schema version", () => {
    const r = parseManifest({ schemaVersion: 2, id: "c", name: "C", stages: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing stage", () => {
    const p = createProject("c", "C", T0) as unknown as Record<string, unknown>;
    delete (p.stages as Record<string, unknown>).export;
    const r = parseManifest(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("export");
  });

  it("rejects an invalid stage status", () => {
    const p = createProject("c", "C", T0) as any;
    p.stages.intake.status = "bogus";
    const r = parseManifest(p);
    expect(r.ok).toBe(false);
  });

  it("drops non-numeric counts but keeps numeric ones", () => {
    const p = createProject("c", "C", T0) as any;
    p.stages.dedup.counts = { kept: 10, dropped: "lots" };
    const r = parseManifest(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stages.dedup.counts).toEqual({ kept: 10 });
  });

  it("rejects non-object input", () => {
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest("nope").ok).toBe(false);
    expect(parseManifest([]).ok).toBe(false);
  });
});

describe("summarize", () => {
  it("reports current stage, status and completion", () => {
    let p = createProject("c", "Case C", T0);
    p = setStage(p, "intake", { status: "done" }, T1);
    p = setStage(p, "dedup", { status: "in_progress" }, T1);
    const s = summarize(p);
    expect(s.currentStage).toBe("dedup");
    expect(s.currentStatus).toBe("in_progress");
    expect(s.completion).toBe(0.25);
    expect(s.stageStatuses.map((x) => x.status)).toEqual([
      "done",
      "in_progress",
      "pending",
      "pending",
    ]);
  });
});

describe("sortSummaries", () => {
  it("puts attention-needed first, then newest", () => {
    const a = summarize(setStage(createProject("a", "A", T0), "intake", { status: "done" }, T0));
    const b = summarize(setStage(createProject("b", "B", T0), "segmentation", { status: "error" }, T1));
    const c = summarize(setStage(createProject("c", "C", T0), "intake", { status: "done" }, T1));
    const sorted = sortSummaries([a, b, c]);
    expect(sorted[0].id).toBe("b"); // needs attention
    expect(sorted[1].id).toBe("c"); // newer of the two clean ones
    expect(sorted[2].id).toBe("a");
  });
});
