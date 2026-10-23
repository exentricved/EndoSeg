import { useCallback, useEffect, useRef, useState } from "react";
import {
  PHASES,
  type PhaseId,
  type PhaseSpan,
  phaseById,
  sortSpans,
  numberSpans,
  formatTimecode,
  phaseFolderName,
} from "../core/phases.js";
import type { ProjectManifest } from "../core/stages.js";
import type { PhasesState, PhaseExportProgress } from "../shared/ipc.js";

// Label procedure phases on the intake video, then export one clip per span
// (<case>_<phase>/) and 1 fps frames of the endoscopic phases for segmentation.
//
// Marking: press a phase key (1–6) to start that phase at the playhead; press
// it again to end it there. Pressing a different phase key ends the open span
// and starts the next one, so back-to-back phases take one key press each.

const uid = () => Math.random().toString(36).slice(2, 10);
const SAVE_DELAY_MS = 600;

export function PhasesView({
  projectId,
  manifest,
  onBack,
  onExported,
}: {
  projectId: string;
  manifest: ProjectManifest | null;
  onBack: () => void;
  onExported: (m: ProjectManifest) => void;
}) {
  const [state, setState] = useState<PhasesState | null>(null);
  const [spans, setSpans] = useState<PhaseSpan[]>([]);
  const [open, setOpen] = useState<{ phase: PhaseId; start: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "error">("saved");
  const [exporting, setExporting] = useState<PhaseExportProgress | "starting" | null>(null);
  const [confirmExport, setConfirmExport] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The spans as loaded from disk — not saved back unless they change. */
  const loadedSpans = useRef<PhaseSpan[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.endoseg.loadPhases(projectId).then((s) => {
      if (cancelled || !s) return;
      setState(s);
      loadedSpans.current = s.labels.spans;
      setSpans(s.labels.spans);
      setDuration(s.durationSec);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  // Autosave (debounced) whenever the spans are edited.
  useEffect(() => {
    if (!loadedSpans.current || spans === loadedSpans.current) return;
    setSaveState("pending");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      window.endoseg.savePhases(projectId, { version: 1, spans })
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, SAVE_DELAY_MS);
  }, [projectId, spans]);

  // Flush a pending save when leaving the view.
  const spansRef = useRef(spans);
  spansRef.current = spans;
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      void window.endoseg.savePhases(projectId, { version: 1, spans: spansRef.current });
    }
  }, [projectId]);

  const now = () => videoRef.current?.currentTime ?? 0;
  const frameStep = 1 / (state?.fps || 30);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || duration || t));
    setTime(v.currentTime);
  }, [duration]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play(); else v.pause();
  }, []);

  /** Close the open span at `t` (if it has positive length) and return the new list. */
  const closeOpen = useCallback((list: PhaseSpan[], t: number): PhaseSpan[] => {
    if (!open) return list;
    const start = Math.min(open.start, t);
    const end = Math.max(open.start, t);
    if (end - start < 0.05) return list;
    const span = { id: uid(), phase: open.phase, start, end };
    setSelected(span.id);
    return sortSpans([...list, span]);
  }, [open]);

  const markPhase = useCallback((phase: PhaseId) => {
    const t = now();
    if (open?.phase === phase) {
      setSpans((s) => closeOpen(s, t));
      setOpen(null);
      return;
    }
    if (open) setSpans((s) => closeOpen(s, t));
    setOpen({ phase, start: t });
  }, [open, closeOpen]);

  const updateSpan = useCallback((id: string, patch: Partial<PhaseSpan>) => {
    setSpans((list) => sortSpans(list.map((s) => {
      if (s.id !== id) return s;
      const next = { ...s, ...patch };
      return next.end > next.start ? next : s; // ignore edits that would invert the span
    })));
  }, []);

  const deleteSpan = useCallback((id: string) => {
    setSpans((list) => list.filter((s) => s.id !== id));
    setSelected((sel) => (sel === id ? null : sel));
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const p = PHASES.find((ph) => ph.key === e.key);
      if (p) { e.preventDefault(); markPhase(p.id); return; }
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": e.preventDefault(); seek(now() - (e.shiftKey ? 10 : 1)); break;
        case "ArrowRight": e.preventDefault(); seek(now() + (e.shiftKey ? 10 : 1)); break;
        case ",": seek(now() - frameStep); break;
        case ".": seek(now() + frameStep); break;
        case "Escape": setOpen(null); break;
        case "Delete": if (selected) deleteSpan(selected); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markPhase, togglePlay, seek, frameStep, selected, deleteSpan]);

  const runExport = useCallback(async () => {
    setConfirmExport(false);
    setMessage(null);
    // Make sure the latest labels are on disk before exporting from them.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    await window.endoseg.savePhases(projectId, { version: 1, spans });
    loadedSpans.current = spans;
    setSaveState("saved");
    setExporting("starting");
    const unsub = window.endoseg.onPhasesProgress((p) => setExporting(p));
    try {
      const m = await window.endoseg.exportPhases(projectId);
      if (m) {
        onExported(m);
        const st = m.stages.phases;
        setMessage(st.status === "error"
          ? `Export failed: ${st.error ?? "unknown error"}`
          : `Exported ${st.counts?.clips ?? 0} clips and ${st.counts?.frames ?? 0} frames for segmentation.`);
      }
    } finally {
      unsub();
      setExporting(null);
    }
  }, [projectId, spans, onExported]);

  if (!state) return <div className="phases"><p className="muted" style={{ padding: 16 }}>Loading…</p></div>;

  const len = duration || 1;
  const pct = (t: number) => `${(t / len) * 100}%`;
  const hasSegmentation = manifest?.stages.segmentation.status === "done";
  const numbered = numberSpans(spans);
  const exportLabel = exporting === "starting" ? "Starting…"
    : exporting
      ? `${exporting.step === "clip" ? "Cutting clip" : "Extracting frames"} ${exporting.done + 1}/${exporting.total} (${phaseById(exporting.phase)?.label})`
      : null;

  return (
    <div className="phases">
      <div className="phases-bar">
        <button className="secondary" onClick={onBack} disabled={!!exporting}>← Back to project</button>
        <strong>Phases</strong>
        <span className="muted" style={{ fontSize: 12 }}>{state.caseName ?? projectId}</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {saveState === "pending" ? "Saving…" : saveState === "error" ? "⚠ Not saved" : "Saved"}
        </span>
      </div>

      {!state.videoUrl ? (
        <div className="empty"><p>No video yet — add one on the Intake stage first.</p></div>
      ) : (
        <div className="phases-body">
          <div className="phases-main">
            <video
              ref={videoRef}
              className="phases-video"
              src={state.videoUrl}
              preload="auto"
              onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }}
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onSeeked={(e) => setTime(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onClick={togglePlay}
            />

            <div
              className="phases-timeline"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                seek(((e.clientX - r.left) / r.width) * len);
              }}
            >
              {spans.map((s) => (
                <div
                  key={s.id}
                  className={`seg ${s.id === selected ? "selected" : ""}`}
                  title={`${phaseById(s.phase)?.label} ${formatTimecode(s.start)}–${formatTimecode(s.end)}`}
                  style={{ left: pct(s.start), width: pct(s.end - s.start), background: phaseById(s.phase)?.color }}
                />
              ))}
              {open && (
                <div
                  className="seg open"
                  style={{
                    left: pct(Math.min(open.start, time)),
                    width: pct(Math.abs(time - open.start)),
                    background: phaseById(open.phase)?.color,
                  }}
                />
              )}
              <div className="head" style={{ left: pct(time) }} />
            </div>

            <div className="phases-controls">
              <button className="secondary" onClick={() => seek(time - 10)} title="Shift+←">−10s</button>
              <button className="secondary" onClick={() => seek(time - 1)} title="←">−1s</button>
              <button className="secondary" onClick={() => seek(time - frameStep)} title=",">−1f</button>
              <button onClick={togglePlay} title="Space" style={{ minWidth: 70 }}>{playing ? "Pause" : "Play"}</button>
              <button className="secondary" onClick={() => seek(time + frameStep)} title=".">+1f</button>
              <button className="secondary" onClick={() => seek(time + 1)} title="→">+1s</button>
              <button className="secondary" onClick={() => seek(time + 10)} title="Shift+→">+10s</button>
              <select
                value={rate}
                onChange={(e) => {
                  const r = Number(e.target.value);
                  setRate(r);
                  if (videoRef.current) videoRef.current.playbackRate = r;
                }}
              >
                {[0.25, 0.5, 1, 2, 4, 8].map((r) => <option key={r} value={r}>{r}×</option>)}
              </select>
              <span className="time">{formatTimecode(time)} / {formatTimecode(duration)}</span>
            </div>

            <div className="phases-buttons">
              {PHASES.map((p) => (
                <button
                  key={p.id}
                  className={`phase-btn ${open?.phase === p.id ? "active" : ""}`}
                  style={{ ["--c" as string]: p.color }}
                  onClick={() => markPhase(p.id)}
                  title={open?.phase === p.id ? "End this phase here" : "Start this phase here"}
                >
                  <kbd>{p.key}</kbd> {open?.phase === p.id ? `End ${p.label}` : p.label}
                </button>
              ))}
              {open && <button className="secondary" onClick={() => setOpen(null)}>Cancel (Esc)</button>}
            </div>
          </div>

          <aside className="phases-side">
            <h3>Spans ({spans.length})</h3>
            <p className="muted hint">
              Press a phase key (1–6) to start it at the playhead, and press it again to end it. Pressing another
              phase key ends the current one there. Space plays and pauses; ←/→ move 1 s, Shift for 10 s; , and . step one frame.
            </p>
            {open && (
              <div className="span-row selected" style={{ ["--c" as string]: phaseById(open.phase)?.color }}>
                <div><strong>{phaseById(open.phase)?.label}</strong> <span className="muted">recording…</span></div>
                <div className="times">{formatTimecode(open.start)} →</div>
              </div>
            )}
            {numbered.map(({ span: s, index }) => (
              <div
                key={s.id}
                className={`span-row ${s.id === selected ? "selected" : ""}`}
                style={{ ["--c" as string]: phaseById(s.phase)?.color }}
                onClick={() => { setSelected(s.id); seek(s.start); }}
              >
                <div>
                  <select
                    value={s.phase}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateSpan(s.id, { phase: e.target.value as PhaseId })}
                  >
                    {PHASES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>{" "}
                  <span className="muted">#{index}</span>
                </div>
                <div className="times">
                  {formatTimecode(s.start)}–{formatTimecode(s.end)}
                  <span className="muted"> ({(s.end - s.start).toFixed(1)}s)</span>
                </div>
                <div className="acts" onClick={(e) => e.stopPropagation()}>
                  <button className="secondary" onClick={() => updateSpan(s.id, { start: time })} title="Set start to playhead">Start ← here</button>
                  <button className="secondary" onClick={() => updateSpan(s.id, { end: time })} title="Set end to playhead">End ← here</button>
                  <button className="secondary" onClick={() => seek(s.end)}>Go to end</button>
                  <button className="secondary" onClick={() => deleteSpan(s.id)} title="Delete">✕</button>
                </div>
              </div>
            ))}

            <div className="phases-export">
              <strong>Export</strong>
              <span className="muted hint">
                One clip per span goes to <code>{state.exportRoot}\{phaseFolderName(state.caseName ?? "case", "duodenum")}</code> and
                the matching folders for the other phases. Every phase except fluoroscopy is also sampled into frames for segmentation.
              </span>
              {hasSegmentation && (
                <span className="warn">
                  ⚠ This project already has saved annotations. Exporting rebuilds the frame set, so annotations on frames
                  that no longer exist will no longer be shown.
                </span>
              )}
              {confirmExport ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => void runExport()}>Yes, export</button>
                  <button className="secondary" onClick={() => setConfirmExport(false)}>Cancel</button>
                </div>
              ) : (
                <button
                  onClick={() => (hasSegmentation ? setConfirmExport(true) : void runExport())}
                  disabled={!!exporting || !spans.length || !!open}
                  title={open ? "End the open phase first" : ""}
                >
                  {exportLabel ?? "Export clips + frames"}
                </button>
              )}
              {message && <span className={message.startsWith("Export failed") ? "warn" : "muted hint"}>{message}</span>}
              <button className="secondary" onClick={() => void window.endoseg.revealPhases(projectId)}>Open export folder</button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
