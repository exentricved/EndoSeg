import React, { useCallback, useEffect, useState } from "react";
import type { OpenPackageResult, FrameDecision, SegFrame } from "../shared/ipc";
import { AnnotatorCanvas } from "./AnnotatorCanvas";
import FrameList from "./FrameList";
import DecisionBar from "./DecisionBar";

interface Props {
  pkg: OpenPackageResult;
  onClose(): void;
}

export default function ReviewView({ pkg, onClose }: Props): React.ReactElement {
  const [frames] = useState<SegFrame[]>(pkg.frames);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, FrameDecision>>(pkg.decisions ?? {});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [projectId] = useState(() => "__reviewer__");

  // Summary counts
  const approved = Object.values(decisions).filter((d) => d.status === "approved").length;
  const rejected = Object.values(decisions).filter((d) => d.status === "rejected").length;
  const edited = Object.values(decisions).filter((d) => d.status === "edited").length;
  const total = frames.length;

  const currentFrame = frames[currentIndex];

  const refreshDecisions = useCallback(async () => {
    const d = await window.reviewerApi.getDecisions();
    setDecisions(d);
  }, []);

  useEffect(() => {
    void refreshDecisions();
  }, [refreshDecisions]);

  async function handleDecision(
    frameId: string,
    status: "approved" | "rejected",
    comment?: string,
  ) {
    await window.reviewerApi.setDecision(frameId, status, comment);
    await refreshDecisions();
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg("");
    try {
      const outPath = await window.reviewerApi.savePackage();
      if (outPath) setSaveMsg(`Saved → ${outPath}`);
    } finally {
      setSaving(false);
    }
  }

  // Keyboard nav for the frame list
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't steal keys while typing in an input
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "ArrowRight" || e.key === "d") {
        setCurrentIndex((i) => Math.min(i + 1, frames.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "a") {
        setCurrentIndex((i) => Math.max(i - 1, 0));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frames.length]);

  return (
    <div className="review-layout">
      {/* ── Top bar ── */}
      <header className="review-topbar">
        <div className="review-topbar__left">
          <button className="btn-ghost" onClick={onClose} title="Close package">
            ← Close
          </button>
          <span className="review-topbar__title">{pkg.zipPath.split(/[\\/]/).pop()}</span>
        </div>
        <div className="review-topbar__center">
          <span className="summary-chip summary-chip--approved">✓ {approved}</span>
          <span className="summary-chip summary-chip--rejected">✗ {rejected}</span>
          {edited > 0 && <span className="summary-chip summary-chip--edited">✎ {edited}</span>}
          <span className="summary-chip summary-chip--pending">· {total - approved - rejected - edited} pending</span>
        </div>
        <div className="review-topbar__right">
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save & Export"}
          </button>
        </div>
      </header>

      {saveMsg && <div className="save-notice">{saveMsg}</div>}

      {/* ── Main layout: frame list | annotator ── */}
      <div className="review-body">
        <FrameList
          frames={frames}
          currentIndex={currentIndex}
          decisions={decisions}
          onSelect={setCurrentIndex}
        />

        <div className="review-canvas-col">
          {frames.length > 0 ? (
            <>
              {/* Annotator manages its own frame nav — mounted once for the session */}
              <AnnotatorCanvas projectId={projectId} />
              {currentFrame && (
                <DecisionBar
                  frameId={currentFrame.frameId}
                  decision={decisions[currentFrame.frameId]}
                  onDecision={handleDecision}
                />
              )}
            </>
          ) : (
            <div className="review-empty">No frames in package.</div>
          )}
        </div>
      </div>
    </div>
  );
}
