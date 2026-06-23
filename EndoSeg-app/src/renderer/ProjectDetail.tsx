import { useCallback, useEffect, useRef, useState } from "react";
import {
  STAGES,
  STAGE_LABELS,
  type ProjectManifest,
  type StageId,
} from "../core/stages.js";
import type { IntakeProgress, DedupProgress } from "../shared/ipc.js";
import { StageBadge, formatTime } from "./ui.js";

const STAGE_HINT: Record<StageId, string> = {
  intake: "Upload a sphincterotomy video — copied into the project, hashed, and frames sampled.",
  dedup: "Filter near-duplicate frames (perceptual hash).",
  segmentation: "Run ML segmentation, then review/correct masks in the annotator.",
  export: "Export a folder of NRRD masks + a packaged project.json.",
};

const INTAKE_LABEL: Record<IntakeProgress["phase"], string> = {
  copy: "Copying & hashing video…",
  probe: "Reading video metadata…",
  extract: "Extracting frames…",
};

const DEDUP_LABEL: Record<DedupProgress["phase"], string> = {
  hash: "Hashing frames…",
  copy: "Copying kept frames…",
};

export function ProjectDetail({
  id,
  onBack,
  onOpenAnnotator,
}: {
  id: string;
  onBack: () => void;
  onOpenAnnotator: (id: string) => void;
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

  const runIntake = useCallback(async () => {
    const sourcePath = await window.endoseg.pickVideo();
    if (!sourcePath) return;
    setRunning("intake");
    setStatusLine(INTAKE_LABEL.copy);
    unsub.current = window.endoseg.onIntakeProgress((p) =>
      setStatusLine(INTAKE_LABEL[p.phase] + (p.frames != null ? ` (${p.frames} frames)` : "")),
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

  const runDedup = useCallback(async () => {
    setRunning("dedup");
    setStatusLine(DEDUP_LABEL.hash);
    unsub.current = window.endoseg.onDedupProgress((p) =>
      setStatusLine(DEDUP_LABEL[p.phase] + (p.frames != null ? ` (${p.frames} frames)` : "")),
    );
    try {
      const updated = await window.endoseg.runDedup(id);
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
  const intakeDone = manifest.stages.intake.status === "done";

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
                ) : stage === "dedup" ? (
                  <button
                    onClick={() => void runDedup()}
                    disabled={busy || !intakeDone}
                    title={intakeDone ? "" : "Run intake first"}
                  >
                    {running === "dedup" ? "Working…" : st.status === "done" ? "Re-run…" : "Run dedup"}
                  </button>
                ) : stage === "segmentation" ? (
                  <button
                    onClick={() => onOpenAnnotator(id)}
                    disabled={busy}
                    title="Open the annotator (Phase 1: load frames manually; auto-load from intake comes next)"
                  >
                    Open annotator
                  </button>
                ) : (
                  <button disabled title="Coming in a later phase">Run…</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
