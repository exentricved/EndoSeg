import { useCallback, useEffect, useRef, useState } from "react";
import { type CropRect, formatTimecode, normalizeCrop } from "../core/phases.js";
import type { PhasesState } from "../shared/ipc.js";

// Pick the part of the picture to keep (drop black borders, on-screen text,
// the fluoroscopy half of a split screen...). Non-destructive: the rectangle
// is stored in source pixels and applied when phase clips and frames are exported.

export function CropView({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [state, setState] = useState<PhasesState | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [saving, setSaving] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void window.endoseg.loadPhases(projectId).then((s) => {
      if (!s) return;
      setState(s);
      setCrop(s.crop);
      setDuration(s.durationSec);
    });
  }, [projectId]);

  // Fit the picture into the available area, keeping the source aspect ratio.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !state?.width || !state.height) return;
    const fit = () => {
      const k = Math.min(el.clientWidth / state.width, el.clientHeight / state.height);
      setBox({ w: Math.floor(state.width * k), h: Math.floor(state.height * k) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [state]);

  /** Source pixels per displayed pixel. */
  const scale = state && box.w ? state.width / box.w : 1;

  const toSource = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - r.left), r.width) * scale,
      y: Math.min(Math.max(0, e.clientY - r.top), r.height) * scale,
    };
  }, [scale]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = toSource(e);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const p = toSource(e);
    const a = drag.current;
    setCrop({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) });
  };
  const onPointerUp = () => {
    drag.current = null;
    // Snap to what will actually be stored (clamped, even); a stray click clears it.
    setCrop((c) => (state ? normalizeCrop(c, state.width, state.height) : c));
  };

  const save = useCallback(async (value: CropRect | null) => {
    setSaving(true);
    try {
      await window.endoseg.saveCrop(projectId, value);
      onDone();
    } finally {
      setSaving(false);
    }
  }, [projectId, onDone]);

  if (!state) return <div className="phases"><p className="muted" style={{ padding: 16 }}>Loading…</p></div>;

  const shown = crop && { left: crop.x / scale, top: crop.y / scale, width: crop.w / scale, height: crop.h / scale };

  return (
    <div className="phases">
      <div className="phases-bar">
        <button className="secondary" onClick={onDone} disabled={saving}>← Back to project</button>
        <strong>Crop</strong>
        <span className="muted" style={{ fontSize: 12 }}>{state.caseName ?? projectId}</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {crop ? `Keeping ${crop.w}×${crop.h} at (${crop.x}, ${crop.y})` : "Whole picture"} of {state.width}×{state.height}
        </span>
      </div>

      {!state.videoUrl ? (
        <div className="empty"><p>No video yet — add one on the Intake stage first.</p></div>
      ) : (
        <div className="phases-main" style={{ flex: 1 }}>
          <p className="muted hint" style={{ margin: 0 }}>
            Drag a rectangle over the part of the picture to keep. Exported phase clips and segmentation frames are
            cropped to it; the copy of the video in the project stays whole. Use the slider to check a few points in the video.
          </p>
          <div ref={stageRef} className="crop-stage">
            <div className="crop-box" style={{ width: box.w, height: box.h }}>
              <video
                ref={videoRef}
                src={state.videoUrl}
                preload="auto"
                muted
                onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }}
                onSeeked={(e) => setTime(e.currentTarget.currentTime)}
              />
              <div
                className="crop-overlay"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                {shown && <div className="crop-rect" style={shown} />}
              </div>
            </div>
          </div>
          <div className="phases-controls">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={time}
              style={{ flex: 1 }}
              onChange={(e) => {
                const t = Number(e.target.value);
                setTime(t);
                if (videoRef.current) videoRef.current.currentTime = t;
              }}
            />
            <span className="time">{formatTimecode(time)} / {formatTimecode(duration)}</span>
          </div>
          <div className="phases-controls">
            <button onClick={() => void save(crop)} disabled={saving || !crop}>Save crop</button>
            <button className="secondary" onClick={() => void save(null)} disabled={saving}>No crop (whole picture)</button>
            {crop && <button className="secondary" onClick={() => setCrop(null)} disabled={saving}>Clear rectangle</button>}
          </div>
        </div>
      )}
    </div>
  );
}
