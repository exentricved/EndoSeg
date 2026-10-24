import { useCallback, useEffect, useRef, useState } from "react";
import {
  PHASES,
  MANEUVERS,
  SUCCESS_KEY,
  SUCCESS_COLOR,
  type PhaseId,
  type ManeuverId,
  type LabelId,
  type PhaseSpan,
  labelById,
  isManeuver,
  successfulAttempt,
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
// Marking: press a phase key (1–3, 5–6) to start that phase at the playhead;
// press it again to end it there. Pressing a different phase key ends the open
// span and starts the next one, so back-to-back phases take one key press each.
// Maneuvers (7–9) start and end the same way but run independently, so they can
// overlap each other and the phases. 4 marks the moment cannulation succeeded.

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
  /** Maneuvers being recorded → where each started. */
  const [openMan, setOpenMan] = useState<Partial<Record<ManeuverId, number>>>({});
  const [success, setSuccess] = useState<number | undefined>(undefined);
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
  /** The labels as loaded from disk — not saved back unless they change. */
  const loadedSpans = useRef<PhaseSpan[] | null>(null);
  const loadedSuccess = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void window.endoseg.loadPhases(projectId).then((s) => {
      if (cancelled || !s) return;
      setState(s);
      loadedSpans.current = s.labels.spans;
      loadedSuccess.current = s.labels.cannulationSuccess;
      setSpans(s.labels.spans);
      setSuccess(s.labels.cannulationSuccess);
      setDuration(s.durationSec);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  const labelsOf = (list: PhaseSpan[], cs: number | undefined) =>
    ({ version: 1 as const, spans: list, ...(cs !== undefined ? { cannulationSuccess: cs } : {}) });

  // Autosave (debounced) whenever the labels are edited.
  useEffect(() => {
    if (!loadedSpans.current) return;
    if (spans === loadedSpans.current && success === loadedSuccess.current) return;
    setSaveState("pending");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      window.endoseg.savePhases(projectId, labelsOf(spans, success))
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, SAVE_DELAY_MS);
  }, [projectId, spans, success]);

  // Flush a pending save when leaving the view.
  const labelsRef = useRef(labelsOf(spans, success));
  labelsRef.current = labelsOf(spans, success);
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      void window.endoseg.savePhases(projectId, labelsRef.current);
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

  /** Start a maneuver at the playhead, or end it there if it's being recorded. Other spans are untouched. */
  const markManeuver = useCallback((m: ManeuverId) => {
    const t = now();
    const started = openMan[m];
    if (started === undefined) {
      setOpenMan((o) => ({ ...o, [m]: t }));
      return;
    }
    setOpenMan((o) => { const next = { ...o }; delete next[m]; return next; });
    const start = Math.min(started, t);
    const end = Math.max(started, t);
    if (end - start < 0.05) return;
    const span = { id: uid(), phase: m, start, end };
    setSelected(span.id);
    setSpans((list) => sortSpans([...list, span]));
  }, [openMan]);

  const markSuccess = useCallback(() => setSuccess(now()), []);

  const cancelOpen = useCallback(() => { setOpen(null); setOpenMan({}); }, []);

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
      const m = MANEUVERS.find((mn) => mn.key === e.key);
      if (m) { e.preventDefault(); markManeuver(m.id); return; }
      if (e.key === SUCCESS_KEY) { e.preventDefault(); markSuccess(); return; }
      switch (e.key) {
        case " ": e.preventDefault(); togglePlay(); break;
        case "ArrowLeft": e.preventDefault(); seek(now() - (e.shiftKey ? 10 : 1)); break;
        case "ArrowRight": e.preventDefault(); seek(now() + (e.shiftKey ? 10 : 1)); break;
        case ",": seek(now() - frameStep); break;
        case ".": seek(now() + frameStep); break;
        case "Escape": cancelOpen(); break;
        case "Delete": if (selected) deleteSpan(selected); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [markPhase, markManeuver, markSuccess, cancelOpen, togglePlay, seek, frameStep, selected, deleteSpan]);

  const runExport = useCallback(async () => {
    setConfirmExport(false);
    setMessage(null);
    // Make sure the latest labels are on disk before exporting from them.
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    await window.endoseg.savePhases(projectId, labelsOf(spans, success));
    loadedSpans.current = spans;
    loadedSuccess.current = success;
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
  }, [projectId, spans, success, onExported]);

  if (!state) return <div className="phases"><p className="muted" style={{ padding: 16 }}>Loading…</p></div>;

  const len = duration || 1;
  const pct = (t: number) => `${(t / len) * 100}%`;
  const hasSegmentation = manifest?.stages.segmentation.status === "done";
  const numbered = numberSpans(spans);
  const openManeuvers = MANEUVERS.filter((m) => openMan[m.id] !== undefined);
  const recording = !!open || openManeuvers.length > 0;
  const winner = successfulAttempt(spans, success);
  const color = (id: string) => labelById(id)?.color;
  /** Top of a span's bar: phases share the top row, each maneuver has a thin row below. */
  const laneTop = (id: LabelId) => (isManeuver(id) ? 29 + MANEUVERS.findIndex((m) => m.id === id) * 7 : 4);
  const exportLabel = exporting === "starting" ? "Starting…"
    : exporting
      ? `${exporting.step === "clip" ? "Cutting clip" : "Extracting frames"} ${exporting.done + 1}/${exporting.total} (${labelById(exporting.phase)?.label})`
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
                  className={`seg ${isManeuver(s.phase) ? "man" : ""} ${s.id === selected ? "selected" : ""}`}
                  title={`${labelById(s.phase)?.label} ${formatTimecode(s.start)}–${formatTimecode(s.end)}`}
                  style={{ left: pct(s.start), width: pct(s.end - s.start), top: laneTop(s.phase), background: color(s.phase) }}
                />
              ))}
              {open && (
                <div
                  className="seg open"
                  style={{
                    left: pct(Math.min(open.start, time)),
                    width: pct(Math.abs(time - open.start)),
                    background: color(open.phase),
                  }}
                />
              )}
              {openManeuvers.map((m) => {
                const start = openMan[m.id]!;
                return (
                  <div
                    key={m.id}
                    className="seg man open"
                    style={{ left: pct(Math.min(start, time)), width: pct(Math.abs(time - start)), top: laneTop(m.id), background: m.color }}
                  />
                );
              })}
              {success !== undefined && (
                <div
                  className="mark"
                  title={`Cannulation success ${formatTimecode(success)}`}
                  style={{ left: pct(success), background: SUCCESS_COLOR, ["--c" as string]: SUCCESS_COLOR }}
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
              <button
                className="phase-btn"
                style={{ ["--c" as string]: SUCCESS_COLOR }}
                onClick={markSuccess}
                title="Mark the moment cannulation succeeded (end of the last attempt) at the playhead"
              >
                <kbd>{SUCCESS_KEY}</kbd> {success === undefined ? "Cannulation success ✓" : "Move success ✓ here"}
              </button>
              {recording && <button className="secondary" onClick={cancelOpen}>Cancel (Esc)</button>}
            </div>
            <div className="phases-buttons">
              <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Maneuvers</span>
              {MANEUVERS.map((m) => {
                const on = openMan[m.id] !== undefined;
                return (
                  <button
                    key={m.id}
                    className={`phase-btn ${on ? "active" : ""}`}
                    style={{ ["--c" as string]: m.color }}
                    onClick={() => markManeuver(m.id)}
                    title={on ? "End this maneuver here" : "Start this maneuver here (may overlap other labels)"}
                  >
                    <kbd>{m.key}</kbd> {on ? `End ${m.label}` : m.label}
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="phases-side">
            <h3>Spans ({spans.length})</h3>
            <p className="muted hint">
              Press a phase key (1–3, 5–6) to start it at the playhead, and press it again to end it. Pressing another
              phase key ends the current one there. Maneuver keys (7–9) work the same way but can overlap anything.
              Press 4 at the end of the last cannulation attempt to mark success. Space plays and pauses; ←/→ move 1 s,
              Shift for 10 s; , and . step one frame.
            </p>
            <div className="span-row" style={{ ["--c" as string]: SUCCESS_COLOR }} onClick={() => success !== undefined && seek(success)}>
              <div><strong>Cannulation success</strong></div>
              <div className="times">
                {success === undefined ? <span className="muted">not marked (4)</span> : formatTimecode(success)}
              </div>
              {success !== undefined && (
                <div className="acts" onClick={(e) => e.stopPropagation()}>
                  <button className="secondary" onClick={markSuccess} title="Move to playhead">Move ← here</button>
                  <button className="secondary" onClick={() => setSuccess(undefined)} title="Remove">✕</button>
                  <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
                    {winner ? `ends attempt #${numbered.find((n) => n.span === winner)?.index}` : "⚠ no attempt before it"}
                  </span>
                </div>
              )}
            </div>
            {open && (
              <div className="span-row selected" style={{ ["--c" as string]: color(open.phase) }}>
                <div><strong>{labelById(open.phase)?.label}</strong> <span className="muted">recording…</span></div>
                <div className="times">{formatTimecode(open.start)} →</div>
              </div>
            )}
            {openManeuvers.map((m) => (
              <div key={m.id} className="span-row selected" style={{ ["--c" as string]: m.color }}>
                <div><strong>{m.label}</strong> <span className="muted">recording…</span></div>
                <div className="times">{formatTimecode(openMan[m.id]!)} →</div>
              </div>
            ))}
            {numbered.map(({ span: s, index }) => (
              <div
                key={s.id}
                className={`span-row ${s.id === selected ? "selected" : ""}`}
                style={{ ["--c" as string]: color(s.phase) }}
                onClick={() => { setSelected(s.id); seek(s.start); }}
              >
                <div>
                  <select
                    value={s.phase}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateSpan(s.id, { phase: e.target.value as LabelId })}
                  >
                    {(isManeuver(s.phase) ? MANEUVERS : PHASES).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>{" "}
                  <span className="muted">#{index}{s === winner ? " · success ✓" : ""}</span>
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
                the matching folders for the other phases and maneuvers. Every phase except fluoroscopy, and every maneuver, is
                also sampled into frames for segmentation; frame names carry the maneuvers under way and "success" on the
                attempt that succeeded.
              </span>
              <span className="muted hint">
                {state.crop
                  ? `Cropped to ${state.crop.w}×${state.crop.h} of ${state.width}×${state.height} (change it with Crop… on the Intake stage).`
                  : "Whole picture — no crop set (Crop… on the Intake stage)."}
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
                  disabled={!!exporting || !spans.length || recording}
                  title={recording ? "End the open phase or maneuver first" : ""}
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
