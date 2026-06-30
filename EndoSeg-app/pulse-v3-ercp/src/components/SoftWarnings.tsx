/**
 * SoftWarnings — non-blocking yellow chips listing per-frame annotation issues.
 *
 * Rules (per spec § Soft Warnings):
 *  - PAPILLA_ORIFICE present but surface_normal_clock unset
 *  - PAPILLA_BODY present with haraldsson_type === "unknown"
 *  - usable_for_depth_training === true but no keypoints annotated
 */

import type { AnnotationInstance, KeypointInstance, FrameMetadata } from "../ercpClasses";
import { ERCP_CLASS_BY_ID } from "../ercpClasses";

interface SoftWarningsProps {
  annotations: AnnotationInstance[];
  keypoints: KeypointInstance[];
  metadata: FrameMetadata;
}

export function computeWarnings(args: SoftWarningsProps): string[] {
  const out: string[] = [];
  const orificesMissingClock: number = args.annotations.filter(a => {
    const cls = ERCP_CLASS_BY_ID.get(a.classId);
    if (cls?.name !== "PAPILLA_ORIFICE") return false;
    const c = a.attributes.surface_normal_clock;
    return !(typeof c === "number" && c >= 1 && c <= 12);
  }).length;
  if (orificesMissingClock > 0) {
    out.push(
      orificesMissingClock === 1
        ? "Orifice missing clock direction"
        : `${orificesMissingClock} orifices missing clock direction`,
    );
  }
  const bodiesUnknown: number = args.annotations.filter(a => {
    const cls = ERCP_CLASS_BY_ID.get(a.classId);
    if (cls?.name !== "PAPILLA_BODY") return false;
    return a.attributes.haraldsson_type === "unknown";
  }).length;
  if (bodiesUnknown > 0) {
    out.push(
      bodiesUnknown === 1
        ? "Haraldsson type unset"
        : `${bodiesUnknown} papilla bodies with haraldsson_type=unknown`,
    );
  }
  if (args.metadata.usable_for_depth_training && args.keypoints.length === 0) {
    out.push("Marked depth-usable but no keypoints");
  }
  return out;
}

export function SoftWarnings(props: SoftWarningsProps) {
  const warnings = computeWarnings(props);
  if (warnings.length === 0) return null;
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: 8,
      border: "1px solid #ca8a04",
      borderRadius: 4,
      background: "rgba(202,138,4,0.08)",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#fde68a", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Warnings
      </div>
      {warnings.map((w, i) => (
        <div key={i} style={{
          fontSize: 11, color: "#fde68a",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          <span>⚠</span><span>{w}</span>
        </div>
      ))}
    </div>
  );
}
