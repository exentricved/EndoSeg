import { useCallback, useEffect, useRef, useState } from "react";
import {
  STAGES,
  STAGE_LABELS,
  type ProjectManifest,
  type StageId,
} from "../core/stages.js";
import type { IntakeProgress, ExportProgress, CaseAccess } from "../shared/ipc.js";
import { StageBadge, formatTime, errorText } from "./ui.js";
import { WORKSPACE_LABELS, parseRef } from "../core/workspaces.js";

const STAGE_HINT: Record<StageId, string> = {
  intake: "The case's video from Raw ERCP Videos — copied into the case folder and hashed (videos the player can't open, e.g. AVI, also get a preview copy). Then optionally crop the picture; the crop applies to exported clips and frames.",
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
  onOpenCrop,
  onOpenCase,
}: {
  id: string;
  /** Start intake on this video as soon as the project opens (from "New project from video"). */
  intakePath?: string;
  onBack: () => void;
  onOpenAnnotator: (id: string) => void;
  onOpenPhases: (id: string, manifest: ProjectManifest) => void;
  onOpenCrop: (id: string) => void;
  /** Open another case (the Annotated 2 copy of a read-only case). */
  onOpenCase: (id: string) => void;
}) {
  const [manifest, setManifest] = useState<ProjectManifest | null>(null);
  const [missing, setMissing] = useState(false);
  const [running, setRunning] = useState<StageId | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  // null until the case has been opened (its lock taken, or found read-only).
  const [access, setAccess] = useState<CaseAccess | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const unsub = useRef<(() => void) | null>(null);

  const load = useCallback(async (takeOver = false) => {
    // Opening the case takes its lock (read-only if someone else has it open).
    const [m, a] = await Promise.all([window.endoseg.getProject(id), window.endoseg.openCase(id, takeOver)]);
    setAccess(a);
    if (!m) setMissing(true);
    else setManifest(m);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => unsub.current?.(), []);

  // Someone took the case over while it was open here.
  useEffect(
    () => window.endoseg.onCaseAccessChanged((c) => c.ref === id && setAccess(c.access)),
    [id],
  );

  // While someone else has the case open, look again every 30 s: it becomes
  // editable here on its own once they close it.
  const lockedBy = access?.lockedBy;
  useEffect(() => {
    if (!lockedBy) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [lockedBy, load]);

  const [takeOverArmed, setTakeOverArmed] = useState(false);
  const takeOver = useCallback(async () => {
    setTakeOverArmed(false);
    await load(true);
  }, [load]);

  const runIntake = useCallback(async (picked?: string) => {
    const sourcePath = picked ?? (await window.endoseg.pickVideo());
    if (!sourcePath) return;
    setRunning("intake");
    setActionError(null);
    setStatusLine(INTAKE_LABEL.copy);
    unsub.current = window.endoseg.onIntakeProgress((p) =>
      setStatusLine(INTAKE_LABEL[p.phase] + (p.percent != null ? ` ${p.percent}%` : "")),
    );
    let ok = false;
    try {
      const updated = await window.endoseg.runIntake(id, sourcePath);
      if (updated) setManifest(updated);
      ok = updated?.stages.intake.status === "done";
    } catch (err) {
      setActionError(`Intake not started: ${errorText(err)}`);
    } finally {
      unsub.current?.();
      unsub.current = null;
      setRunning(null);
      setStatusLine(null);
    }
    // Crop is part of taking a video in: go straight to it (it can be skipped).
    if (ok) onOpenCrop(id);
  }, [id, onOpenCrop]);

  // Run once per picked video (StrictMode re-runs effects; the ref keeps it
  // single), and only if the case opened editable the first time: a case that
  // was busy elsewhere never starts intake later on its own.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!intakePath || autoStarted.current || access === null) return;
    autoStarted.current = true;
    if (!access.readOnly) void runIntake(intakePath);
  }, [intakePath, runIntake, access]);

  const runExportStage = useCallback(async () => {
    setRunning("export");
    setActionError(null);
    setStatusLine(EXPORT_LABEL.frames);
    unsub.current = window.endoseg.onExportProgress((p) =>
      setStatusLine(EXPORT_LABEL[p.phase] + (p.total > 0 ? ` (${p.done}/${p.total})` : "")),
    );
    try {
      const updated = await window.endoseg.runExport(id);
      if (updated) setManifest(updated);
    } catch (err) {
      setActionError(`Export not started: ${errorText(err)}`);
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
  if (!manifest || !access) return <main className="detail"><p className="muted">Loading…</p></main>;

  // Read-only cases (Annotated 1 once in second review) only offer Open folder.
  const busy = running !== null || access.readOnly;

  return (
    <main className="detail">
      <div className="detail-head">
        <button className="secondary" onClick={onBack}>← Back</button>
        <div className="detail-title">
          <h2>
            {manifest.name}
            {parseRef(id) && <span className="ws-chip">{WORKSPACE_LABELS[parseRef(id)!.ws]}</span>}
          </h2>
        </div>
        <button className="secondary" onClick={() => void window.endoseg.revealProject(id)}>
          Open folder
        </button>
      </div>

      {actionError && (
        <div className="library-error" role="alert">
          ⚠ {actionError}{" "}
          <button className="link" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {access.readOnly && (
        <div className="readonly-banner" role="status">
          <span>
            🔒 Read-only. {access.reason}
            {access.lockedSince && <> Opened {formatTime(access.lockedSince)}.</>}
          </span>
          {access.reviewRef && (
            <button onClick={() => onOpenCase(access.reviewRef!)}>Open the Annotated 2 copy</button>
          )}
          {access.lockedBy &&
            (takeOverArmed ? (
              <span className="delete-confirm">
                <button className="danger" onClick={() => void takeOver()}>
                  Take over (their unsaved changes are lost)
                </button>
                <button className="secondary" onClick={() => setTakeOverArmed(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <span className="delete-confirm">
                <button className="secondary" onClick={() => void load()}>
                  Check again
                </button>
                <button className="secondary" onClick={() => setTakeOverArmed(true)}>
                  Take over…
                </button>
              </span>
            ))}
        </div>
      )}

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
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "stretch" }}>
                    <button onClick={() => void runIntake()} disabled={busy}>
                      {running === "intake" ? "Working…" : st.status === "done" ? "Re-import…" : "Add video…"}
                    </button>
                    {st.status === "done" && (
                      <button className="secondary" onClick={() => onOpenCrop(id)} disabled={busy}>
                        Crop…
                      </button>
                    )}
                  </div>
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
