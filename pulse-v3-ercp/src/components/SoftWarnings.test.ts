import { describe, it, expect } from "vitest";
import { computeWarnings } from "./SoftWarnings";
import { ERCP_CLASS_BY_NAME, makeDefaultFrameMetadata, type AnnotationInstance } from "../ercpClasses";

function annotPolygon(className: string, attributes: Record<string, string | number> = {}): AnnotationInstance {
  const cls = ERCP_CLASS_BY_NAME.get(className)!;
  return {
    id: `${className}-1`,
    classId: cls.id,
    geometry: { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }] },
    depth_rank: cls.depthRank.mode === "fixed" ? cls.depthRank.value : cls.depthRank.default,
    depth_rank_fixed: cls.depthRank.mode === "fixed",
    attributes,
  };
}

describe("computeWarnings", () => {
  it("returns empty when frame is clean", () => {
    const w = computeWarnings({
      annotations: [annotPolygon("PAPILLA_ORIFICE", { surface_normal_clock: 11 })],
      keypoints: [{ id: "k", name: "ORIFICE_RIM_TOP", x: 1, y: 1, visibility: "visible" }],
      metadata: { ...makeDefaultFrameMetadata(), usable_for_depth_training: false },
    });
    expect(w).toEqual([]);
  });

  it("flags orifice missing clock direction", () => {
    const w = computeWarnings({
      annotations: [annotPolygon("PAPILLA_ORIFICE", {})],
      keypoints: [],
      metadata: makeDefaultFrameMetadata(),
    });
    expect(w.some(m => m.toLowerCase().includes("clock"))).toBe(true);
  });

  it("flags haraldsson_type=unknown", () => {
    const w = computeWarnings({
      annotations: [annotPolygon("PAPILLA_BODY", { haraldsson_type: "unknown" })],
      keypoints: [],
      metadata: makeDefaultFrameMetadata(),
    });
    expect(w.some(m => m.toLowerCase().includes("haraldsson"))).toBe(true);
  });

  it("flags depth-usable frame with zero keypoints", () => {
    const w = computeWarnings({
      annotations: [],
      keypoints: [],
      metadata: { ...makeDefaultFrameMetadata(), usable_for_depth_training: true },
    });
    expect(w.some(m => m.toLowerCase().includes("depth-usable"))).toBe(true);
  });

  it("does not flag depth-usable=false even without keypoints", () => {
    const w = computeWarnings({
      annotations: [],
      keypoints: [],
      metadata: { ...makeDefaultFrameMetadata(), usable_for_depth_training: false },
    });
    expect(w.length).toBe(0);
  });
});
