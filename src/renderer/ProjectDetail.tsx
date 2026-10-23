import { useCallback, useEffect, useRef, useState } from "react";
import {
  STAGES,
  STAGE_LABELS,
  type ProjectManifest,
  type StageId,
} from "../core/stages.js";
import type { IntakeProgress, ExportProgress } from "../shared/ipc.js";
import { StageBadge, formatTime } from "./ui.js";

const STAGE_HINT: Record<StageId, string> = {
  intake: "Add the ERCP video — copied into the project and hashed (videos the player can't open, e.g. AVI, also get a preview copy).",
  phases: "Label the procedure phases on the video, then export one clip per phase span and 1 fps frames for segmentation.",
  segmentation: "Annotate the 1 fps frames in the annotator.",
  export: "Package annotated frames + multi-class label maps (pixel = class ID) + metadata.json into 03_export/.",
};

const INTAKE_LABEL: Record<IntakeProgress["phase"], string> = {
  copy: "Copying & hashing video…",
  probe: "Reading video metadata…",
  preview: "Making a preview copy for the player…",
};

const EXPORT_LABEL: Record<ExportProgress["phase"], string> = {
  frames: "Copying frames & generating label maps…",
  metadata: "Writing metadata…",
};

export function ProjectDetail({
  id,
  intakePath,
  onBack,
  onOpenAnnotator,
  onOpenPhases,
}: {
  id: string;
  /** Start intake on this video as soon as the project opens (from "New project from video"). */
  intakePath?: string;
  onBack: () => void;
  onOpenAnnotator: (id: string) => void;
  onOpenPhases: (id: string, manifest: ProjectManifest) => void;
}) {
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [missing, setMissing] = useState(false);
  const [running, setRunning] = useState<StageId | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const unsub = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    const m = await window.endoseg.getProject(id);
    if (!m) setMissing(true);
    else setManifest(m);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => unsub.current?.(), []);

  const runIntake = useCallback(async (picked?: string) => {
    const sourcePath = picked ?? (await window.endoseg.pickVideo());
    if (!sourcePath) return;
    setRunning("intake");
    setStatusLine(INTAKE_LABEL.copy);
    unsub.current = window.endoseg.onIntakeProgress((p) =>
      setStatusLine(INTAKE_LABEL[p.phase] + (p.percent != null ? ` ${p.percent}%` : "")),
    );
    try {
      const updated = await window.endoseg.runIntake(id, sourcePath);
      if (updated) setManifest(updated);
    } finally {
      unsub.current?.();
      unsub.current = null;
      setRunning(null);
      setStatusLine(null);
    }
  }, [id]);

  // Run once per picked video (StrictMode re-runs effects; the ref keeps it single).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!intakePath || autoStarted.current) return;
    autoStarted.current = true;
    void runIntake(intakePath);
  }, [intakePath, runIntake]);

  const runExportStage = useCallback(async () => {
    setRunning("export");
    setStatusLine(EXPORT_LABEL.frames);
    unsub.current = window.endoseg.onExportProgress((p) =>
      setStatusLine(EXPORT_LABEL[p.phase] + (p.total > 0 ? ` (${p.done}/${p.total})` : "")),
    );
    try {
      const updated = await window.endoseg.runExport(id);
      if (updated) setManifest(updated);
    } finally {
      unsub.current?.();
      unsub.current = null;
      setRunning(null);
      setStatusLine(null);
    }
  }, [id]);

  if (missing) {
    return (
      <main className="detail">
        <button className="secondary" onClick={onBack}>← Back</button>
        <div className="empty"><p>Project not found.</p></div>
      </main>
    );
  }
  if (!manifest) return <main className="detail"><p className="muted">Loading…</p></main>;

  const busy = running !== null;

  return (
    <main className="detail">
      <div className="detail-head">
        <button className="secondary" onClick={onBack}>← Back</button>
        <div className="detail-title">
          <h2>{manifest.name}</h2>
          <span className="proj-id muted">{manifest.id}</span>
        </div>
        <button className="secondary" onClick={() => void window.endoseg.revealProject(id)}>
          Open folder
        </button>
      </div>

      <div className="stage-list">
        {STAGES.map((stage, i) => {
          const st = manifest.stages[stage];
          return (
            <div key={stage} className={`stage-card status-${st.status}`}>
              <div className="stage-num">{i + 1}</div>
              <div className="stage-main">
                <div className="stage-card-head">
                  <strong>{STAGE_LABELS[stage]}</strong>
                  <StageBadge status={st.status} />
                </div>
                <div className="stage-meta muted">
                  {st.at ? `Updated ${formatTime(st.at)}` : "Not started"}
                  {st.counts && Object.keys(st.counts).length > 0 && (
                    <> · {Object.entries(st.counts).map(([k, v]) => `${k}: ${v}`).join(" · ")}</>
                  )}
                </div>
                {st.error && <div className="stage-error">⚠ {st.error}</div>}
                <div className="stage-hint muted">{STAGE_HINT[stage]}</div>
                {running === stage && (
                  <div className="intake-progress">{statusLine ?? "Starting…"}</div>
                )}
              </div>
              <div className="stage-action">
                {stage === "intake" ? (
                  <button onClick={() => void runIntake()} disabled={busy}>
                    {running === "intake" ? "Working…" : st.status === "done" ? "Re-import…" : "Add video…"}
                  </button>
                ) : stage === "phases" ? (
                  <button
                    onClick={() => onOpenPhases(id, manifest)}
                    disabled={busy || manifest.stages.intake.status !== "done"}
                    title={manifest.stages.intake.status === "done" ? "" : "Add the video first"}
                  >
                    Label phases
                  </button>
                ) : stage === "segmentation" ? (
                  <button
                    onClick={() => onOpenAnnotator(id)}
                    disabled={busy}
                    title="Annotate the frames extracted on the Phases stage"
                  >
                    Open annotator
                  </button>
                ) : stage === "export" ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                    <button
                      onClick={() => void runExportStage()}
                      disabled={busy || manifest.stages.segmentation.status !== "done"}
                      title={manifest.stages.segmentation.status === "done" ? "" : "Save annotations first"}
                    >
                      {running === "export" ? "Exporting…" : st.status === "done" ? "Re-export" : "Run export"}
                    </button>
                    {st.status === "done" && (
                      <button
                        className="secondary"
                        onClick={() => void window.endoseg.revealExport(id)}
                        disabled={busy}
                      >
                        Open folder
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
