// Native canvas-based segmentation annotator for EndoSeg.
// Reads frames via the endoseg-frame:// protocol (IPC), saves masks + polygons to 02_segmentation/.
// No pulse-v3-ercp dependency.

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { SegFrame } from "../shared/ipc.js";

// ---- Class catalog ----
const CLASSES = [
  { id: 1, name: "PAPILLA_BODY",               abbr: "PB",  color: "#F472B6" },
  { id: 2, name: "PAPILLA_ORIFICE",            abbr: "PO",  color: "#A78BFA" },
  { id: 3, name: "HOODING_FOLD",               abbr: "HF",  color: "#FB923C" },
  { id: 4, name: "PERIAMPULLARY_DIVERTICULUM", abbr: "PAD", color: "#7C3AED" },
  { id: 5, name: "DUODENAL_WALL",              abbr: "DW",  color: "#FBBF24" },
  { id: 6, name: "INSTRUMENT_MASK",            abbr: "INS", color: "#9CA3AF" },
  { id: 7, name: "SPECULAR_HIGHLIGHT",         abbr: "SH",  color: "#FDE68A" },
  { id: 8, name: "FLUID_POOL",                abbr: "FP",  color: "#22D3EE" },
] as const;

type ClassDef = typeof CLASSES[number];

// ---- Types ----
type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Polygon = { id: string; classId: number; points: Pt[] };
type Tool = "polygon" | "select" | "crop";

// Snapshot stored in 02_segmentation/annotations.leus.
// The node-side writer reads `frames[].name` and `frames[].label_masks`; everything else is
// extra metadata for future restores.
interface NativeSnapshot {
  version: 1;
  frames: Array<{
    frameId: string;
    name: string;
    polygons: Polygon[];
    label_masks: Record<string, string>;
  }>;
}

// ---- Pure helpers ----
let _uid = 0;
const uid = () => `p${++_uid}`;

function clsById(id: number): ClassDef | undefined {
  return CLASSES.find((c) => c.id === id);
}

function hexRgba(cls: ClassDef, a: number): string {
  const h = cls.color.slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function clsLuminance(cls: ClassDef): number {
  const h = cls.color.slice(1);
  return (
    parseInt(h.slice(0, 2), 16) * 0.299 +
    parseInt(h.slice(2, 4), 16) * 0.587 +
    parseInt(h.slice(4, 6), 16) * 0.114
  );
}

function pointInPoly(poly: Polygon, pt: Pt): boolean {
  const ps = poly.points;
  let inside = false;
  for (let i = 0, j = ps.length - 1; i < ps.length; j = i++) {
    if (
      ps[i].y > pt.y !== ps[j].y > pt.y &&
      pt.x < ((ps[j].x - ps[i].x) * (pt.y - ps[i].y)) / (ps[j].y - ps[i].y) + ps[i].x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// Rasterize polygons to per-class binary PNG masks (white = mask, black = background).
// Done on a separate canvas so the display canvas (which shows the frame image) is never tainted.
function rasterizeMasks(polygons: Polygon[], w: number, h: number): Record<string, string> {
  if (!w || !h) return {};
  const byClass = new Map<number, Polygon[]>();
  for (const p of polygons) {
    if (!byClass.has(p.classId)) byClass.set(p.classId, []);
    byClass.get(p.classId)!.push(p);
  }
  const out: Record<string, string> = {};
  for (const [classId, polys] of byClass) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "white";
    for (const poly of polys) {
      if (poly.points.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(poly.points[0].x, poly.points[0].y);
      for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
      ctx.closePath();
      ctx.fill();
    }
    out[String(classId)] = cv.toDataURL("image/png");
  }
  return out;
}

// ---- Component ----
export function SegmentationView({ projectId }: { projectId: string }) {
  // React state — drives sidebar, toolbar display, and status bar.
  const [frames, setFrames] = useState<SegFrame[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("polygon");
  const [classId, setClassId] = useState(1);
  const [hasCrop, setHasCrop] = useState(false);
  const [cropZoom, setCropZoom] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [annCount, setAnnCount] = useState(0);
  const [inProgressLen, setInProgressLen] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);

  // Refs — read by drawScene (which must be stable) without stale closures.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const framesRef = useRef<SegFrame[]>([]);
  const frameIdxRef = useRef(0);
  const toolRef = useRef<Tool>("polygon");
  const classIdRef = useRef(1);
  const zoomRef = useRef(1);
  const panRef = useRef<Pt>({ x: 0, y: 0 });
  // Per-frame polygon annotations. Key = SegFrame.frameId.
  const annsRef = useRef<Map<string, Polygon[]>>(new Map());
  const cropRectRef = useRef<Rect | null>(null);
  const cropZoomRef = useRef(false);
  const inProgressRef = useRef<Pt[]>([]);
  const selectedPolyIdRef = useRef<string | null>(null);
  // Natural image dimensions populated on first load — fallback when PNG header gives 0.
  const frameSizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());

  // Mouse interaction refs.
  const isPanningRef = useRef(false);
  const lastMouseRef = useRef<Pt>({ x: 0, y: 0 });
  const isCropDraggingRef = useRef(false);
  const cropDragStartRef = useRef<Pt | null>(null);

  // A ref to handleSave so the keyboard effect doesn't need it in deps.
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});

  // ---- Wrapper setters that keep refs in sync ----
  const setFrames_ = useCallback((fs: SegFrame[]) => {
    framesRef.current = fs;
    setFrames(fs);
  }, []);

  const setTool_ = useCallback((t: Tool) => {
    toolRef.current = t;
    setTool(t);
    inProgressRef.current = [];
    setInProgressLen(0);
  }, []);

  const setClassId_ = useCallback((id: number) => {
    classIdRef.current = id;
    setClassId(id);
  }, []);

  // ---- drawScene — stable, reads refs only ----
  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = imageRef.current;
    const z = zoomRef.current;
    const pan = panRef.current;
    const frame = framesRef.current[frameIdxRef.current];
    const polygons = frame ? (annsRef.current.get(frame.frameId) ?? []) : [];
    const inPts = inProgressRef.current;
    const selId = selectedPolyIdRef.current;
    const cr = cropRectRef.current;
    const cz = cropZoomRef.current;
    const activeCls = classIdRef.current;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0d1520";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (img) {
      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(z, z);
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      // Existing polygons.
      for (const poly of polygons) {
        const cls = clsById(poly.classId);
        if (!cls || poly.points.length < 2) continue;
        const selected = poly.id === selId;
        ctx.save();
        ctx.translate(pan.x, pan.y);
        ctx.scale(z, z);
        ctx.beginPath();
        ctx.moveTo(poly.points[0].x, poly.points[0].y);
        for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
        ctx.closePath();
        ctx.fillStyle = hexRgba(cls, 0.22);
        ctx.fill();
        ctx.strokeStyle = hexRgba(cls, selected ? 1 : 0.8);
        ctx.lineWidth = (selected ? 2.5 : 1.5) / z;
        if (selected) ctx.setLineDash([6 / z, 3 / z]);
        ctx.stroke();
        if (selected) ctx.setLineDash([]);
        ctx.restore();
      }

      // In-progress polygon being drawn.
      if (inPts.length > 0) {
        const cls = clsById(activeCls);
        if (cls) {
          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(z, z);
          ctx.strokeStyle = hexRgba(cls, 1);
          ctx.lineWidth = 1.5 / z;
          ctx.setLineDash([4 / z, 3 / z]);
          ctx.beginPath();
          ctx.moveTo(inPts[0].x, inPts[0].y);
          for (let i = 1; i < inPts.length; i++) ctx.lineTo(inPts[i].x, inPts[i].y);
          ctx.stroke();
          ctx.setLineDash([]);
          // Point dots.
          ctx.fillStyle = hexRgba(cls, 1);
          for (const pt of inPts) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 4 / z, 0, Math.PI * 2);
            ctx.fill();
          }
          // Close-target halo around first point (appears when ≥3 pts).
          if (inPts.length >= 3) {
            ctx.beginPath();
            ctx.arc(inPts[0].x, inPts[0].y, 10 / z, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,0.55)";
            ctx.lineWidth = 1 / z;
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }

    // Crop overlay: dim outside the rect + cyan border.
    if (cr && !cz) {
      const sx = cr.x * z + pan.x;
      const sy = cr.y * z + pan.y;
      const sw = cr.w * z;
      const sh = cr.h * z;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.48)";
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.rect(sx, sy, sw, sh);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#22D3EE";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }, []); // stable — reads refs only, no React state deps

  // ---- fitToView — stable ----
  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const cw = canvas.width, ch = canvas.height, pad = 24;
    const cr = cropRectRef.current;
    if (cr && cropZoomRef.current) {
      const z = Math.min((cw - pad * 2) / cr.w, (ch - pad * 2) / cr.h);
      zoomRef.current = z;
      panRef.current = {
        x: (cw - cr.w * z) / 2 - cr.x * z,
        y: (ch - cr.h * z) / 2 - cr.y * z,
      };
    } else {
      const z = Math.min((cw - pad * 2) / img.naturalWidth, (ch - pad * 2) / img.naturalHeight);
      zoomRef.current = z;
      panRef.current = {
        x: (cw - img.naturalWidth * z) / 2,
        y: (ch - img.naturalHeight * z) / 2,
      };
    }
    setZoomPct(Math.round(zoomRef.current * 100));
  }, []);

  // ---- refreshAnnCount — stable ----
  const refreshAnnCount = useCallback(() => {
    const f = framesRef.current[frameIdxRef.current];
    setAnnCount(f ? (annsRef.current.get(f.frameId)?.length ?? 0) : 0);
  }, []);

  // ---- Load frames + snapshot on mount ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      window.endoseg.listSegFrames(projectId),
      window.endoseg.loadSegmentation(projectId),
    ])
      .then(([framesRes, snapshot]) => {
        if (cancelled) return;
        setFrames_(framesRes.frames);
        if (snapshot && typeof snapshot === "object") {
          const s = snapshot as NativeSnapshot;
          if (s.version === 1 && Array.isArray(s.frames)) {
            for (const f of s.frames) {
              if (f.frameId && Array.isArray(f.polygons) && f.polygons.length) {
                annsRef.current.set(f.frameId, [...f.polygons]);
              }
            }
          }
        }
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, setFrames_]);

  // ---- Load image whenever the active frame changes ----
  useEffect(() => {
    const frame = framesRef.current[frameIdx];
    if (!frame) {
      imageRef.current = null;
      drawScene();
      return;
    }
    imageRef.current = null;
    drawScene();
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      frameSizesRef.current.set(frame.frameId, {
        w: img.naturalWidth,
        h: img.naturalHeight,
      });
      fitToView();
      drawScene();
    };
    img.onerror = () => {
      imageRef.current = null;
      drawScene();
    };
    // Do NOT set crossOrigin — endoseg-frame:// is a privileged Electron protocol;
    // adding crossOrigin blocks requests and taints the display canvas unnecessarily.
    // Mask rasterization uses a separate offscreen canvas that never touches the frame image.
    img.src = frame.url;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [frameIdx, drawScene, fitToView]);

  useEffect(() => {
    refreshAnnCount();
  }, [frameIdx, refreshAnnCount]);

  // ---- Canvas resize handler ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      fitToView();
      drawScene();
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, [fitToView, drawScene]);

  // ---- Navigate to frame ----
  const navigateTo = useCallback((idx: number) => {
    const n = Math.max(0, Math.min(idx, framesRef.current.length - 1));
    frameIdxRef.current = n;
    setFrameIdx(n);
    inProgressRef.current = [];
    setInProgressLen(0);
    selectedPolyIdRef.current = null;
    setHasSelection(false);
  }, []);

  // ---- Finish in-progress polygon ----
  const finishPolygon = useCallback(() => {
    const pts = inProgressRef.current;
    if (pts.length < 3) {
      inProgressRef.current = [];
      setInProgressLen(0);
      drawScene();
      return;
    }
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) {
      inProgressRef.current = [];
      setInProgressLen(0);
      return;
    }
    const poly: Polygon = { id: uid(), classId: classIdRef.current, points: [...pts] };
    if (!annsRef.current.has(frame.frameId)) annsRef.current.set(frame.frameId, []);
    annsRef.current.get(frame.frameId)!.push(poly);
    inProgressRef.current = [];
    setInProgressLen(0);
    refreshAnnCount();
    drawScene();
  }, [drawScene, refreshAnnCount]);

  // ---- Save ----
  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const frameItems: NativeSnapshot["frames"] = [];
      for (const [frameId, polys] of annsRef.current) {
        if (!polys.length) continue;
        const frame = framesRef.current.find((f) => f.frameId === frameId);
        if (!frame) continue;
        const sz = frameSizesRef.current.get(frameId);
        const w = frame.width || sz?.w || 0;
        const h = frame.height || sz?.h || 0;
        const label_masks = rasterizeMasks(polys, w, h);
        frameItems.push({ frameId, name: frame.name, polygons: polys, label_masks });
      }
      const snapshot: NativeSnapshot = { version: 1, frames: frameItems };
      await window.endoseg.saveSegmentation(projectId, snapshot);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (e) {
      setSaveMsg(`Error: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  // Keep saveRef current so the keyboard handler can call it without being in deps.
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") {
        inProgressRef.current = [];
        setInProgressLen(0);
        drawScene();
        return;
      }
      if (e.key === "Enter" && toolRef.current === "polygon") {
        finishPolygon();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedPolyIdRef.current) {
        const frame = framesRef.current[frameIdxRef.current];
        if (frame) {
          const list = annsRef.current.get(frame.frameId);
          if (list) {
            annsRef.current.set(
              frame.frameId,
              list.filter((p) => p.id !== selectedPolyIdRef.current),
            );
          }
        }
        selectedPolyIdRef.current = null;
        setHasSelection(false);
        refreshAnnCount();
        drawScene();
        return;
      }
      if (e.key === "ArrowRight" || e.key === "d") {
        navigateTo(frameIdxRef.current + 1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "a") {
        navigateTo(frameIdxRef.current - 1);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        fitToView();
        drawScene();
        return;
      }
      if (e.key === "p" || e.key === "P") {
        setTool_("polygon");
        return;
      }
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        void handleSaveRef.current();
        return;
      }
      // Class hotkeys 1–8.
      const n = parseInt(e.key);
      if (n >= 1 && n <= 8) {
        setClassId_(n);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawScene, finishPolygon, fitToView, navigateTo, refreshAnnCount, setTool_, setClassId_]);

  // ---- Coordinate transform ----
  const screenToImage = useCallback((sx: number, sy: number): Pt => ({
    x: (sx - panRef.current.x) / zoomRef.current,
    y: (sy - panRef.current.y) / zoomRef.current,
  }), []);

  // ---- Pointer events ----
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Middle mouse or Alt+click → pan.
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        isPanningRef.current = true;
        lastMouseRef.current = { x: sx, y: sy };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0) return;

      const imgPt = screenToImage(sx, sy);

      if (toolRef.current === "crop") {
        isCropDraggingRef.current = true;
        cropDragStartRef.current = imgPt;
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      if (toolRef.current === "polygon") {
        // If near the first point (and ≥3 pts drawn), close the polygon.
        if (inProgressRef.current.length >= 3) {
          const first = inProgressRef.current[0];
          const fsx = first.x * zoomRef.current + panRef.current.x;
          const fsy = first.y * zoomRef.current + panRef.current.y;
          if (Math.hypot(sx - fsx, sy - fsy) < 14) {
            finishPolygon();
            return;
          }
        }
        inProgressRef.current = [...inProgressRef.current, imgPt];
        setInProgressLen(inProgressRef.current.length);
        drawScene();
        return;
      }

      if (toolRef.current === "select") {
        const frame = framesRef.current[frameIdxRef.current];
        const polygons = frame ? (annsRef.current.get(frame.frameId) ?? []) : [];
        let hit: string | null = null;
        for (let i = polygons.length - 1; i >= 0; i--) {
          if (pointInPoly(polygons[i], imgPt)) {
            hit = polygons[i].id;
            break;
          }
        }
        selectedPolyIdRef.current = hit;
        setHasSelection(hit !== null);
        drawScene();
        return;
      }
    },
    [drawScene, finishPolygon, screenToImage],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (isPanningRef.current) {
        panRef.current = {
          x: panRef.current.x + sx - lastMouseRef.current.x,
          y: panRef.current.y + sy - lastMouseRef.current.y,
        };
        lastMouseRef.current = { x: sx, y: sy };
        drawScene();
        return;
      }

      if (isCropDraggingRef.current && cropDragStartRef.current) {
        const imgPt = screenToImage(sx, sy);
        const s = cropDragStartRef.current;
        const x = Math.min(s.x, imgPt.x);
        const y = Math.min(s.y, imgPt.y);
        const w = Math.max(1, Math.abs(imgPt.x - s.x));
        const h = Math.max(1, Math.abs(imgPt.y - s.y));
        cropRectRef.current = { x, y, w, h };
        setHasCrop(true);
        drawScene();
        return;
      }
    },
    [drawScene, screenToImage],
  );

  const handlePointerUp = useCallback(() => {
    isPanningRef.current = false;
    isCropDraggingRef.current = false;
    cropDragStartRef.current = null;
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (toolRef.current === "polygon") finishPolygon();
  }, [finishPolygon]);

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZ = Math.max(0.04, Math.min(32, zoomRef.current * factor));
      panRef.current = {
        x: sx - (sx - panRef.current.x) * (newZ / zoomRef.current),
        y: sy - (sy - panRef.current.y) * (newZ / zoomRef.current),
      };
      zoomRef.current = newZ;
      setZoomPct(Math.round(newZ * 100));
      drawScene();
    },
    [drawScene],
  );

  // ---- Crop actions ----
  const clearCrop = useCallback(() => {
    cropRectRef.current = null;
    cropZoomRef.current = false;
    setHasCrop(false);
    setCropZoom(false);
    fitToView();
    drawScene();
  }, [fitToView, drawScene]);

  const toggleCropZoom = useCallback(() => {
    const next = !cropZoomRef.current;
    cropZoomRef.current = next;
    setCropZoom(next);
    fitToView();
    drawScene();
  }, [fitToView, drawScene]);

  // ---- Delete selected polygon (toolbar button handler) ----
  const deleteSelected = useCallback(() => {
    const frame = framesRef.current[frameIdxRef.current];
    if (frame) {
      const list = annsRef.current.get(frame.frameId);
      if (list) {
        annsRef.current.set(
          frame.frameId,
          list.filter((p) => p.id !== selectedPolyIdRef.current),
        );
      }
    }
    selectedPolyIdRef.current = null;
    setHasSelection(false);
    refreshAnnCount();
    drawScene();
  }, [drawScene, refreshAnnCount]);

  // ---- Render ----
  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#e4e9f0",
        }}
      >
        Loading frames…
      </div>
    );
  }
  if (error) {
    return <div style={{ padding: 20, color: "#f87171" }}>Error loading frames: {error}</div>;
  }

  const currentFrame = framesRef.current[frameIdx];
  const cursorStyle = tool === "crop" || tool === "polygon" ? "crosshair" : "default";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0d1520",
        color: "#e4e9f0",
      }}
    >
      {/* ---- Toolbar ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          borderBottom: "1px solid #1e2d40",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        {/* Tool buttons */}
        <div style={{ display: "flex", gap: 3 }}>
          <Btn active={tool === "polygon"} onClick={() => setTool_("polygon")} title="Polygon tool [P]">
            Poly
          </Btn>
          <Btn active={tool === "select"} onClick={() => setTool_("select")} title="Select + delete tool">
            Sel
          </Btn>
          <Btn active={tool === "crop"} onClick={() => setTool_("crop")} title="Draw crop region">
            Crop
          </Btn>
          {hasCrop && (
            <>
              <Btn active={cropZoom} onClick={toggleCropZoom} title="Zoom to crop rectangle">
                Zoom crop
              </Btn>
              <Btn active={false} onClick={clearCrop} title="Clear crop">
                ✕ crop
              </Btn>
            </>
          )}
        </div>

        <Sep />

        {/* Class selector */}
        {CLASSES.map((c) => {
          const active = classId === c.id;
          const light = clsLuminance(c) > 140;
          return (
            <button
              key={c.id}
              title={`${c.name} [${c.id}]`}
              onClick={() => setClassId_(c.id)}
              style={{
                padding: "2px 7px",
                minWidth: 32,
                background: active ? c.color : "transparent",
                border: `1.5px solid ${c.color}`,
                color: active ? (light ? "#000" : "#fff") : c.color,
                borderRadius: 4,
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              {c.abbr}
            </button>
          );
        })}

        {hasSelection && (
          <>
            <Sep />
            <span style={{ fontSize: 11, color: "#94a3b8" }}>1 selected</span>
            <button
              style={{ fontSize: 11, padding: "2px 8px", background: "#450a0a", borderColor: "#f87171", color: "#fca5a5" }}
              onClick={deleteSelected}
              title="Delete selected polygon [Del]"
            >
              Delete
            </button>
          </>
        )}

        <div style={{ flex: 1 }} />

        {/* Frame counter + zoom */}
        <span style={{ fontSize: 12, color: "#64748b" }}>
          {frames.length > 0 ? `${frameIdx + 1} / ${frames.length}` : "No frames"}
        </span>
        <span style={{ fontSize: 11, color: "#475569" }}>{zoomPct}%</span>
        <button
          className="secondary"
          style={{ fontSize: 11, padding: "2px 8px" }}
          onClick={() => {
            fitToView();
            drawScene();
          }}
          title="Fit to window [F]"
        >
          Fit
        </button>

        <Sep />

        {/* Save */}
        {saveMsg && (
          <span
            style={{
              fontSize: 12,
              color: saveMsg.startsWith("Error") ? "#f87171" : "#4ade80",
            }}
          >
            {saveMsg}
          </span>
        )}
        <button onClick={() => void handleSave()} disabled={saving} title="Save annotations [Ctrl+S]">
          {saving ? "Saving…" : "💾 Save"}
        </button>
      </div>

      {/* ---- Main area ---- */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Frame list sidebar */}
        <div
          style={{
            width: 180,
            flexShrink: 0,
            borderRight: "1px solid #1e2d40",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {frames.length === 0 ? (
            <div style={{ padding: 12, color: "#475569", fontSize: 12, lineHeight: 1.5 }}>
              No frames found.
              <br />
              Run Intake first.
            </div>
          ) : (
            frames.map((f, i) => {
              const hasAnns = (annsRef.current.get(f.frameId)?.length ?? 0) > 0;
              return (
                <button
                  key={f.frameId}
                  onClick={() => navigateTo(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "5px 8px",
                    textAlign: "left",
                    background: i === frameIdx ? "#1a3050" : "transparent",
                    border: "none",
                    borderBottom: "1px solid #111a26",
                    color: i === frameIdx ? "#e4e9f0" : "#6b7e94",
                    cursor: "pointer",
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ color: "#2d3f57", width: 30, textAlign: "right", flexShrink: 0 }}>
                    {i + 1}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.name}
                  </span>
                  {hasAnns && (
                    <span style={{ color: "#4ade80", fontSize: 8, flexShrink: 0 }}>●</span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Canvas */}
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", display: "block", cursor: cursorStyle }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
          />
          {inProgressLen > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: 14,
                left: "50%",
                transform: "translateX(-50%)",
                background: "rgba(0,0,0,0.78)",
                color: "#e4e9f0",
                padding: "5px 14px",
                borderRadius: 8,
                fontSize: 11,
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}
            >
              {inProgressLen} pts · click near start or double-click to close · Esc to cancel
            </div>
          )}
        </div>
      </div>

      {/* ---- Status bar ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "3px 10px",
          borderTop: "1px solid #1e2d40",
          flexShrink: 0,
          fontSize: 11,
          color: "#3d5068",
        }}
      >
        {currentFrame && <span>{currentFrame.name}</span>}
        {currentFrame && currentFrame.width > 0 && (
          <span>{currentFrame.width}×{currentFrame.height}</span>
        )}
        <span>
          {annCount} polygon{annCount !== 1 ? "s" : ""} on this frame
        </span>
        <div style={{ flex: 1 }} />
        <span>P=poly · S=select · 1–8=class · ←→ / AD=navigate · F=fit · Del=delete · Ctrl+S=save</span>
      </div>
    </div>
  );
}

// ---- Mini helpers for toolbar ----
function Btn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      className={active ? "" : "secondary"}
      onClick={onClick}
      title={title}
      style={{ fontSize: 11, padding: "2px 8px" }}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div style={{ width: 1, height: 20, background: "#1e2d40", flexShrink: 0 }} />;
}
