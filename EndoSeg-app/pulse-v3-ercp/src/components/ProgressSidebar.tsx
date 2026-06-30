/**
 * ProgressSidebar — project-wide counters: per-class instance count, frame counts
 * by usable_for_* flags, and empty/partial/complete frame state.
 */

import type { AnnotationInstance, KeypointInstance, FrameMetadata } from "../ercpClasses";
import { ERCP_CLASSES, ERCP_CLASS_BY_ID } from "../ercpClasses";

export type FrameSummary = {
  annotations: AnnotationInstance[];
  keypoints: KeypointInstance[];
  metadata: FrameMetadata;
};

export type CompletionState = "empty" | "partial" | "complete";

export function completionStateFor(frame: FrameSummary): CompletionState {
  const hasAnno = frame.annotations.length > 0;
  const hasFourKp = frame.keypoints.length >= 4;
  const hasProcState = frame.metadata.procedural_state !== "";
  if (!hasAnno && !hasFourKp && !hasProcState && frame.keypoints.length === 0) return "empty";
  if (hasAnno && hasFourKp && hasProcState) return "complete";
  return "partial";
}

export function completionRingColor(state: CompletionState): string {
  return state === "complete" ? "#22c55e" : state === "partial" ? "#eab308" : "#6b7280";
}

interface ProgressSidebarProps {
  frames: FrameSummary[];
  onClose?: () => void;
}

export function ProgressSidebar({ frames, onClose }: ProgressSidebarProps) {
  // Per-class instance count
  const classCounts = new Map<number, number>();
  let totalDepthUsable = 0;
  let totalSegUsable = 0;
  let empty = 0, partial = 0, complete = 0;
  for (const f of frames) {
    for (const a of f.annotations) {
      classCounts.set(a.classId, (classCounts.get(a.classId) ?? 0) + 1);
    }
    if (f.metadata.usable_for_depth_training) totalDepthUsable++;
    if (f.metadata.usable_for_segmentation_training) totalSegUsable++;
    const s = completionStateFor(f);
    if (s === "empty") empty++;
    else if (s === "partial") partial++;
    else complete++;
  }
  const totalFrames = frames.length;

  return (
    <div style={{
      padding: 12,
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: 6,
      background: "rgba(15,23,42,0.92)",
      color: "#fff",
      display: "flex", flexDirection: "column", gap: 10,
      minWidth: 280, maxWidth: 320,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Project progress</div>
        {onClose && (
          <button onClick={onClose} style={{
            padding: "2px 8px", fontSize: 11, color: "#94a3b8",
            background: "transparent", border: "1px solid #334155", borderRadius: 4, cursor: "pointer",
          }}>Close</button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
        {totalFrames} frame{totalFrames === 1 ? "" : "s"} loaded
      </div>

      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", marginBottom: 4 }}>
          Annotations by class
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {ERCP_CLASSES.map(cls => {
            const n = classCounts.get(cls.id) ?? 0;
            return (
              <div key={cls.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: cls.color }} />
                <span style={{ flex: 1, color: n > 0 ? "#fff" : "rgba(255,255,255,0.5)" }}>{cls.name}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{n}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.7)", textTransform: "uppercase" }}>
          Frame usability
        </div>
        <div style={{ fontSize: 11, display: "flex", justifyContent: "space-between" }}>
          <span>Depth training</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{totalDepthUsable} / {totalFrames}</span>
        </div>
        <div style={{ fontSize: 11, display: "flex", justifyContent: "space-between" }}>
          <span>Segmentation training</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{totalSegUsable} / {totalFrames}</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.7)", textTransform: "uppercase" }}>
          Completion
        </div>
        <div style={{ display: "flex", gap: 8, fontSize: 11 }}>
          <span style={{ color: completionRingColor("empty") }}>● empty {empty}</span>
          <span style={{ color: completionRingColor("partial") }}>● partial {partial}</span>
          <span style={{ color: completionRingColor("complete") }}>● complete {complete}</span>
        </div>
      </div>
    </div>
  );
}

// Re-exported for App.tsx to color the per-frame thumbnail rings.
export function frameCompletionColor(frame: FrameSummary): string {
  return completionRingColor(completionStateFor(frame));
}

// Hoisted small utility — caller hands in a class id, gets a label color back.
export function classColor(classId: number): string | undefined {
  return ERCP_CLASS_BY_ID.get(classId)?.color;
}
