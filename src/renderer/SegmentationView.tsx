// Native canvas-based segmentation annotator for EndoSeg.
// Reads frames via the endoseg-frame:// protocol (IPC), saves masks + polygons to 02_segmentation/.

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { SegFrame } from "../shared/ipc.js";
import { PHASES, MANEUVERS, labelById, maneuverById, formatTimecode, SUCCESS_COLOR } from "../core/phases.js";
import {
  type Gray,
  type Similarity,
  toGray,
  globalMotion,
  trackPolygon,
  trackRegion,
  sampleMask,
} from "../core/optflow.js";

// ---- Class catalog ----
const CLASSES = [
  { id: 1,  name: "PAPILLA_BODY",               abbr: "PB",  color: "#F472B6" },
  { id: 2,  name: "PAPILLA_ORIFICE",            abbr: "PO",  color: "#A78BFA" },
  { id: 3,  name: "HOODING_FOLD",               abbr: "HF",  color: "#FB923C" },
  { id: 4,  name: "PERIAMPULLARY_DIVERTICULUM", abbr: "PAD", color: "#7C3AED" },
  { id: 5,  name: "DUODENAL_WALL",              abbr: "DW",  color: "#4ADE80" },
  { id: 6,  name: "INSTRUMENT_MASK",            abbr: "INS", color: "#9CA3AF" },
  { id: 7,  name: "SPECULAR_HIGHLIGHT",         abbr: "SH",  color: "#FDE68A" },
  { id: 8,  name: "FLUID_POOL",                 abbr: "FP",  color: "#22D3EE" },
  { id: 9,  name: "ENDOSCOPE",                  abbr: "ENS", color: "#0EA5E9" },
  { id: 10, name: "SPHINCTEROTOME",             abbr: "SPH", color: "#EF4444" },
] as const;

// Hue ranges that match duodenal mucosa (reddish/pinkish/salmon).
const DW_HUE_HIGH = 35;    // degrees
const DW_HUE_WRAP = 325;  // also match 325–360
const DW_SAT_MIN  = 0.12;
const DW_LIG_MIN  = 0.15;
const DW_LIG_MAX  = 0.88;

/** A phase id from core/phases, an older free-form phase from a saved snapshot, or "". */
type ProcedurePhase = string;
type ClassDef = typeof CLASSES[number];

// ---- Types ----
type Pt   = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Polygon = { id: string; classId: number; points: Pt[] };
type Tool = "polygon" | "select" | "crop" | "brush" | "eraser" | "lasso";

interface NativeSnapshot {
  version: 1;
  frames: Array<{
    frameId: string;
    name: string;
    polygons: Polygon[];
    phase?: string;
    pixelMasks?: Record<string, string>;
    label_masks: Record<string, string>;
  }>;
  /** Frames marked split-screen (endoscopy + fluoroscopy) — skipped by export. */
  splitScreen?: string[];
  /** Frames the annotator ticked as fully annotated. */
  completed?: string[];
}

// ---- Pure helpers ----
let _uid = 0;
/** Max width frames are downscaled to for optical-flow tracking. */
const TRACK_MAX_W = 960;
const uid = () => `p${++_uid}`;

function clsById(id: number): ClassDef | undefined {
  return CLASSES.find((c) => c.id === id);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hexRgba(cls: ClassDef, a: number): string {
  const [r, g, b] = hexToRgb(cls.color);
  return `rgba(${r},${g},${b},${a})`;
}

function clsLuminance(cls: ClassDef): number {
  const [r, g, b] = hexToRgb(cls.color);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else                 h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function isDuodenalWallPixel(r: number, g: number, b: number): boolean {
  const { h, s, l } = rgbToHsl(r, g, b);
  if (s < DW_SAT_MIN || l < DW_LIG_MIN || l > DW_LIG_MAX) return false;
  return h <= DW_HUE_HIGH || h >= DW_HUE_WRAP;
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

// Rasterize polygons + pixel masks to per-class binary PNG masks.
function rasterizeAllMasks(
  polygons: Polygon[],
  pixelMasks: Map<number, HTMLCanvasElement> | undefined,
  w: number,
  h: number,
): Record<string, string> {
  if (!w || !h) return {};
  const byClass = new Map<number, Polygon[]>();
  for (const p of polygons) {
    if (!byClass.has(p.classId)) byClass.set(p.classId, []);
    byClass.get(p.classId)!.push(p);
  }
  const classIds = new Set<number>([...byClass.keys(), ...(pixelMasks?.keys() ?? [])]);
  const out: Record<string, string> = {};
  for (const classId of classIds) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "white";
    for (const poly of byClass.get(classId) ?? []) {
      if (poly.points.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(poly.points[0].x, poly.points[0].y);
      for (let i = 1; i < poly.points.length; i++) ctx.lineTo(poly.points[i].x, poly.points[i].y);
      ctx.closePath();
      ctx.fill();
    }
    const maskCv = pixelMasks?.get(classId);
    if (maskCv && maskCv.width === w && maskCv.height === h) {
      // Merge: any painted pixel → white in output
      const src = maskCv.getContext("2d")!.getImageData(0, 0, w, h);
      const dst = ctx.getImageData(0, 0, w, h);
      for (let i = 0; i < src.data.length; i += 4) {
        if (src.data[i + 3] > 0) {
          dst.data[i] = 255; dst.data[i + 1] = 255; dst.data[i + 2] = 255; dst.data[i + 3] = 255;
        }
      }
      ctx.putImageData(dst, 0, 0);
    }
    out[String(classId)] = cv.toDataURL("image/png");
  }
  return out;
}

// ---- Component ----
export function SegmentationView({ projectId }: { projectId: string }) {
  const [frames, setFrames]             = useState<SegFrame[]>([]);
  const [frameIdx, setFrameIdx]         = useState(0);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);
  const [saveMsg, setSaveMsg]           = useState<string | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [tool, setTool]                 = useState<Tool>("polygon");
  const [classId, setClassId]           = useState(1);
  const [hasCrop, setHasCrop]           = useState(false);
  const [cropZoom, setCropZoom]         = useState(false);
  const [zoomPct, setZoomPct]           = useState(100);
  const [annCount, setAnnCount]         = useState(0);
  const [inProgressLen, setInProgressLen] = useState(0);
  const [hasSelection, setHasSelection] = useState(false);
  const [currentPhase, setCurrentPhase] = useState<ProcedurePhase>("");
  const [brushRadius, setBrushRadius]   = useState(20);
  const [copyFromInput, setCopyFromInput] = useState("");
  const [autoDwBusy, setAutoDwBusy]     = useState(false);
  const [showMasks, setShowMasks]       = useState(true);
  const [trackBusy, setTrackBusy]       = useState(false);
  const [trackMsg, setTrackMsg]         = useState<string | null>(null);
  // Split-screen marks live in a ref (like annotations); the counter re-renders the UI.
  const splitRef                        = useRef<Set<string>>(new Set());
  const [splitCount, setSplitCount]     = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRemoveOne, setConfirmRemoveOne] = useState(false);
  const [removing, setRemoving]         = useState(false);
  // Frames ticked "annotation complete" — same ref + counter pattern as split-screen marks.
  const completedRef                    = useRef<Set<string>>(new Set());
  const [completedCount, setCompletedCount] = useState(0);
  const sidebarRef                      = useRef<HTMLDivElement>(null);

  // Refs mirrored from state for use inside stable callbacks.
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const imageRef        = useRef<HTMLImageElement | null>(null);
  const framesRef       = useRef<SegFrame[]>([]);
  const frameIdxRef     = useRef(0);
  const toolRef         = useRef<Tool>("polygon");
  const classIdRef      = useRef(1);
  const zoomRef         = useRef(1);
  const panRef          = useRef<Pt>({ x: 0, y: 0 });
  const annsRef         = useRef<Map<string, Polygon[]>>(new Map());
  const phasesRef       = useRef<Map<string, string>>(new Map());
  const cropRectRef     = useRef<Rect | null>(null);
  const cropZoomRef     = useRef(false);
  const inProgressRef   = useRef<Pt[]>([]);
  const selectedPolyIdRef = useRef<string | null>(null);
  const frameSizesRef   = useRef<Map<string, { w: number; h: number }>>(new Map());
  const dprRef          = useRef(window.devicePixelRatio || 1);
  const brushRadiusRef  = useRef(20);
  const showMasksRef    = useRef(true);
  const isBrushingRef   = useRef(false);
  // Per-frame pixel masks: frameId → classId → canvas at natural image resolution.
  const pixelMasksRef   = useRef<Map<string, Map<number, HTMLCanvasElement>>>(new Map());

  const isPanningRef    = useRef(false);
  const lastMouseRef    = useRef<Pt>({ x: 0, y: 0 });
  const isCropDraggingRef  = useRef(false);
  const cropDragStartRef   = useRef<Pt | null>(null);
  const handleSaveRef      = useRef<() => Promise<void>>(async () => {});
  const lassoPathRef       = useRef<Pt[]>([]);

  // Undo stack: max 20 entries, one per discrete action.
  type UndoEntry =
    | { kind: "poly-add";    frameId: string; polyId: string }
    | { kind: "poly-remove"; frameId: string; poly: Polygon }
    | { kind: "mask"; frameId: string; classId: number; w: number; h: number; data: Uint8ClampedArray | null }
    | { kind: "batch"; entries: UndoEntry[] };
  const undoStackRef = useRef<UndoEntry[]>([] as UndoEntry[]);

  // ---- Synced setters ----
  const setFrames_ = useCallback((fs: SegFrame[]) => {
    framesRef.current = fs; setFrames(fs);
  }, []);

  const setTool_ = useCallback((t: Tool) => {
    toolRef.current = t; setTool(t);
    inProgressRef.current = []; setInProgressLen(0);
  }, []);

  const setClassId_ = useCallback((id: number) => {
    classIdRef.current = id; setClassId(id);
  }, []);

  // ---- Undo helpers ----
  const snapshotMask = useCallback((frameId: string, classId: number): UndoEntry => {
    const fm = pixelMasksRef.current.get(frameId);
    const cv = fm?.get(classId);
    if (!cv || !cv.width || !cv.height) return { kind: "mask", frameId, classId, w: 0, h: 0, data: null };
    const id = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height);
    return { kind: "mask", frameId, classId, w: cv.width, h: cv.height, data: new Uint8ClampedArray(id.data) };
  }, []);

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStackRef.current.push(entry);
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
  }, []);

  const setPhase_ = useCallback((phase: string) => {
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) return;
    if (phase) phasesRef.current.set(frame.frameId, phase);
    else phasesRef.current.delete(frame.frameId);
    setCurrentPhase(phase);
  }, []);

  // ---- drawScene — stable ----
  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = dprRef.current;
    // Keep canvas buffer in sync with CSS size (ResizeObserver can fire too early).
    const aw = Math.round(canvas.offsetWidth  * dpr);
    const ah = Math.round(canvas.offsetHeight * dpr);
    if (aw > 0 && ah > 0 && (canvas.width !== aw || canvas.height !== ah)) {
      canvas.width  = aw;
      canvas.height = ah;
    }

    const img  = imageRef.current;
    const z    = zoomRef.current;
    const pan  = panRef.current;
    const frame    = framesRef.current[frameIdxRef.current];
    const polygons = frame ? (annsRef.current.get(frame.frameId) ?? []) : [];
    const inPts    = inProgressRef.current;
    const selId    = selectedPolyIdRef.current;
    const cr       = cropRectRef.current;
    const cz       = cropZoomRef.current;
    const activeCls = classIdRef.current;

    // Clear physical buffer first, then scale to CSS pixel space.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0d1520";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr); // everything below is in CSS pixel coordinates

    const cssW = canvas.width  / dpr;
    const cssH = canvas.height / dpr;

    if (img) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(z, z);
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      // Pixel masks (painted with brush / auto-annotate).
      const frameMasks = frame ? pixelMasksRef.current.get(frame.frameId) : undefined;
      if (frameMasks && showMasksRef.current) {
        for (const [, maskCv] of frameMasks) {
          if (!maskCv.width || !maskCv.height) continue;
          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(z, z);
          ctx.globalAlpha = 0.5;
          ctx.drawImage(maskCv, 0, 0);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }

      // Existing polygons.
      if (showMasksRef.current) for (const poly of polygons) {
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

      // In-progress polygon.
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
          ctx.fillStyle = hexRgba(cls, 1);
          for (const pt of inPts) {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 6 / z, 0, Math.PI * 2);
            ctx.fill();
          }
          if (inPts.length >= 3) {
            ctx.beginPath();
            ctx.arc(inPts[0].x, inPts[0].y, 12 / z, 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(255,255,255,0.55)";
            ctx.lineWidth = 1 / z;
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      // In-progress lasso.
      if (lassoPathRef.current.length > 1) {
        const cls = clsById(activeCls);
        if (cls) {
          const lpts = lassoPathRef.current;
          ctx.save();
          ctx.translate(pan.x, pan.y);
          ctx.scale(z, z);
          ctx.beginPath();
          ctx.moveTo(lpts[0].x, lpts[0].y);
          for (let i = 1; i < lpts.length; i++) ctx.lineTo(lpts[i].x, lpts[i].y);
          ctx.closePath();
          ctx.fillStyle = hexRgba(cls, 0.25);
          ctx.fill();
          ctx.strokeStyle = hexRgba(cls, 0.9);
          ctx.lineWidth = 1.5 / z;
          ctx.setLineDash([4 / z, 3 / z]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }
    }

    // Crop overlay.
    if (cr && !cz) {
      const sx = cr.x * z + pan.x;
      const sy = cr.y * z + pan.y;
      const sw = cr.w * z;
      const sh = cr.h * z;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.48)";
      ctx.beginPath();
      ctx.rect(0, 0, cssW, cssH);
      ctx.rect(sx, sy, sw, sh);
      ctx.fill("evenodd");
      ctx.strokeStyle = "#22D3EE";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore(); // undo dpr scale
  }, []);

  // ---- fitToView — stable ----
  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const img    = imageRef.current;
    if (!canvas || !img) return;
    const dpr = dprRef.current;
    // Sync canvas buffer before reading dimensions.
    const aw = Math.round(canvas.offsetWidth  * dpr);
    const ah = Math.round(canvas.offsetHeight * dpr);
    if (aw > 0 && ah > 0 && (canvas.width !== aw || canvas.height !== ah)) {
      canvas.width  = aw;
      canvas.height = ah;
    }
    const cw  = canvas.width  / dpr;
    const ch  = canvas.height / dpr;
    const pad = 24;
    const cr  = cropRectRef.current;
    if (cr && cropZoomRef.current) {
      const z = Math.min((cw - pad * 2) / cr.w, (ch - pad * 2) / cr.h);
      zoomRef.current = z;
      panRef.current  = { x: (cw - cr.w * z) / 2 - cr.x * z, y: (ch - cr.h * z) / 2 - cr.y * z };
    } else {
      const z = Math.min((cw - pad * 2) / img.naturalWidth, (ch - pad * 2) / img.naturalHeight);
      zoomRef.current = z;
      panRef.current  = { x: (cw - img.naturalWidth * z) / 2, y: (ch - img.naturalHeight * z) / 2 };
    }
    setZoomPct(Math.round(zoomRef.current * 100));
  }, []);

  const refreshAnnCount = useCallback(() => {
    const f = framesRef.current[frameIdxRef.current];
    setAnnCount(f ? (annsRef.current.get(f.frameId)?.length ?? 0) : 0);
  }, []);

  const undo = useCallback(() => {
    const top = undoStackRef.current.pop();
    if (!top) return;
    // A batch (e.g. one tracking step) is undone as a unit, newest change first.
    const entries = top.kind === "batch" ? [...top.entries].reverse() : [top];
    for (const entry of entries) {
    if (entry.kind === "poly-add") {
      const list = annsRef.current.get(entry.frameId);
      if (list) annsRef.current.set(entry.frameId, list.filter((p) => p.id !== entry.polyId));
      refreshAnnCount();
    } else if (entry.kind === "poly-remove") {
      if (!annsRef.current.has(entry.frameId)) annsRef.current.set(entry.frameId, []);
      annsRef.current.get(entry.frameId)!.push(entry.poly);
      refreshAnnCount();
    } else if (entry.kind === "mask") {
      let cv = pixelMasksRef.current.get(entry.frameId)?.get(entry.classId);
      if (!entry.data || !entry.w || !entry.h) {
        if (cv) cv.getContext("2d")!.clearRect(0, 0, cv.width, cv.height);
      } else {
        if (!cv || cv.width !== entry.w || cv.height !== entry.h) {
          if (!pixelMasksRef.current.has(entry.frameId)) pixelMasksRef.current.set(entry.frameId, new Map());
          cv = document.createElement("canvas");
          cv.width = entry.w; cv.height = entry.h;
          pixelMasksRef.current.get(entry.frameId)!.set(entry.classId, cv);
        }
        cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(entry.data), entry.w, entry.h), 0, 0);
      }
    }
    }
    drawScene();
  }, [drawScene, refreshAnnCount]);

  // ---- Load frames + snapshot ----
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
        // Frames carry the phase they were extracted from; a phase saved in the snapshot overrides it.
        for (const f of framesRes.frames) if (f.phase) phasesRef.current.set(f.frameId, f.phase);
        if (snapshot && typeof snapshot === "object") {
          const s = snapshot as NativeSnapshot;
          if (s.version === 1 && Array.isArray(s.splitScreen)) {
            splitRef.current = new Set(s.splitScreen.filter((id) => typeof id === "string"));
            setSplitCount(splitRef.current.size);
          }
          if (s.version === 1 && Array.isArray(s.completed)) {
            completedRef.current = new Set(s.completed.filter((id) => typeof id === "string"));
            setCompletedCount(completedRef.current.size);
          }
          if (s.version === 1 && Array.isArray(s.frames)) {
            for (const f of s.frames) {
              if (f.frameId && Array.isArray(f.polygons) && f.polygons.length) {
                annsRef.current.set(f.frameId, [...f.polygons]);
              }
              // Cannulation success is no longer a phase; older snapshots may still carry it.
              if (f.frameId && f.phase && f.phase !== "cannulation-success") {
                phasesRef.current.set(f.frameId, f.phase);
              }
              // Restore pixel masks from saved data URLs.
              if (f.frameId && f.pixelMasks && typeof f.pixelMasks === "object") {
                for (const [classIdStr, dataUrl] of Object.entries(f.pixelMasks)) {
                  if (typeof dataUrl !== "string") continue;
                  const cid = Number(classIdStr);
                  const frameId = f.frameId;
                  const img = new Image();
                  img.onload = () => {
                    const cv = document.createElement("canvas");
                    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
                    cv.getContext("2d")!.drawImage(img, 0, 0);
                    if (!pixelMasksRef.current.has(frameId)) pixelMasksRef.current.set(frameId, new Map());
                    pixelMasksRef.current.get(frameId)!.set(cid, cv);
                  };
                  img.src = dataUrl;
                }
              }
            }
          }
        }
        const firstId = framesRes.frames[0]?.frameId;
        if (firstId) setCurrentPhase(phasesRef.current.get(firstId) ?? "");
        setLoading(false);
      })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [projectId, setFrames_]);

  // ---- Load image on frame change ----
  useEffect(() => {
    const frame = framesRef.current[frameIdx];
    if (!frame) { imageRef.current = null; drawScene(); return; }
    imageRef.current = null;
    drawScene();
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      frameSizesRef.current.set(frame.frameId, { w: img.naturalWidth, h: img.naturalHeight });
      fitToView();
      drawScene();
    };
    img.onerror = () => { imageRef.current = null; drawScene(); };
    img.src = frame.url;
    return () => { img.onload = null; img.onerror = null; };
  }, [frameIdx, frames, drawScene, fitToView]);

  useEffect(() => { refreshAnnCount(); }, [frameIdx, refreshAnnCount]);

  // ---- Canvas resize (DPR-aware) ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      fitToView();
      drawScene();
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  }, [fitToView, drawScene]);

  // ---- Navigate ----
  const navigateTo = useCallback((idx: number) => {
    const n = Math.max(0, Math.min(idx, framesRef.current.length - 1));
    frameIdxRef.current = n;
    setFrameIdx(n);
    inProgressRef.current = []; setInProgressLen(0);
    selectedPolyIdRef.current = null; setHasSelection(false);
    setConfirmRemoveOne(false);
    const newFrame = framesRef.current[n];
    setCurrentPhase((newFrame ? (phasesRef.current.get(newFrame.frameId) ?? "") : ""));
  }, []);

  // ---- Finish polygon ----
  const finishPolygon = useCallback(() => {
    const pts = inProgressRef.current;
    if (pts.length < 3) { inProgressRef.current = []; setInProgressLen(0); drawScene(); return; }
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) { inProgressRef.current = []; setInProgressLen(0); return; }
    const poly: Polygon = { id: uid(), classId: classIdRef.current, points: [...pts] };
    if (!annsRef.current.has(frame.frameId)) annsRef.current.set(frame.frameId, []);
    annsRef.current.get(frame.frameId)!.push(poly);
    pushUndo({ kind: "poly-add", frameId: frame.frameId, polyId: poly.id });
    inProgressRef.current = []; setInProgressLen(0);
    refreshAnnCount(); drawScene();
  }, [drawScene, pushUndo, refreshAnnCount]);

  // ---- Save ----
  const handleSave = useCallback(async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const frameIds = new Set<string>();
      for (const [id, polys] of annsRef.current) if (polys.length) frameIds.add(id);
      for (const [id] of phasesRef.current) frameIds.add(id);
      for (const [id, masks] of pixelMasksRef.current) if (masks.size) frameIds.add(id);

      const frameItems: NativeSnapshot["frames"] = [];
      for (const frameId of frameIds) {
        const frame = framesRef.current.find((f) => f.frameId === frameId);
        if (!frame) continue;
        const polys = annsRef.current.get(frameId) ?? [];
        const phase = phasesRef.current.get(frameId);
        const sz    = frameSizesRef.current.get(frameId);
        const w = frame.width  || sz?.w || 0;
        const h = frame.height || sz?.h || 0;
        const frameMasks = pixelMasksRef.current.get(frameId);
        const label_masks = rasterizeAllMasks(polys, frameMasks, w, h);
        // Serialize pixel masks as data URLs for snapshot restore.
        const pixelMasksData: Record<string, string> = {};
        if (frameMasks) {
          for (const [cid, cv] of frameMasks) {
            if (cv.width && cv.height) pixelMasksData[String(cid)] = cv.toDataURL("image/png");
          }
        }
        frameItems.push({ frameId, name: frame.name, polygons: polys, phase, pixelMasks: pixelMasksData, label_masks });
      }
      const live = new Set(framesRef.current.map((f) => f.frameId));
      const splitScreen = [...splitRef.current].filter((id) => live.has(id));
      const completed = [...completedRef.current].filter((id) => live.has(id));
      const snapshot: NativeSnapshot = { version: 1, frames: frameItems, splitScreen, completed };
      await window.endoseg.saveSegmentation(projectId, snapshot);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (e) {
      setSaveMsg(`Error: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  useEffect(() => { handleSaveRef.current = handleSave; }, [handleSave]);

  const toggleMasks = useCallback(() => {
    const next = !showMasksRef.current;
    showMasksRef.current = next; setShowMasks(next); drawScene();
  }, [drawScene]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "Escape") { inProgressRef.current = []; setInProgressLen(0); drawScene(); return; }
      if (e.key === "Enter" && toolRef.current === "polygon") { finishPolygon(); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedPolyIdRef.current) {
        const frame = framesRef.current[frameIdxRef.current];
        if (frame) {
          const list = annsRef.current.get(frame.frameId);
          if (list) annsRef.current.set(frame.frameId, list.filter((p) => p.id !== selectedPolyIdRef.current));
        }
        selectedPolyIdRef.current = null; setHasSelection(false);
        refreshAnnCount(); drawScene(); return;
      }
      if (e.key === "ArrowRight" || e.key === "d") { navigateTo(frameIdxRef.current + 1); return; }
      if (e.key === "ArrowLeft"  || e.key === "a") { navigateTo(frameIdxRef.current - 1); return; }
      if (e.key === "f" || e.key === "F") { fitToView(); drawScene(); return; }
      if (e.key === "p" || e.key === "P") { setTool_("polygon"); return; }
      if (e.key === "s" || e.key === "S") { setTool_("select");  return; }
      if (e.key === "b" || e.key === "B") { setTool_("brush");   return; }
      if (e.key === "e" || e.key === "E") { setTool_("eraser");  return; }
      if (e.key === "l" || e.key === "L") { setTool_("lasso");   return; }
      if (e.key === "m" || e.key === "M") { toggleMasks(); return; }
      if (e.key === "t" || e.key === "T") { void trackForwardRef.current(); return; }
      if (e.key === "x" || e.key === "X") { toggleSplitRef.current(); return; }
      if (e.key === "c" || e.key === "C") { toggleCompletedRef.current(); return; }
      // Brush size with [ ]
      if (e.key === "[") {
        const next = Math.max(1, brushRadiusRef.current - 5);
        brushRadiusRef.current = next; setBrushRadius(next); return;
      }
      if (e.key === "]") {
        const next = Math.min(200, brushRadiusRef.current + 5);
        brushRadiusRef.current = next; setBrushRadius(next); return;
      }
      if (e.ctrlKey && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); return; }
      if (e.ctrlKey && e.key === "s") { e.preventDefault(); void handleSaveRef.current(); return; }
      if (e.key === "0") { setClassId_(10); return; }
      const n = parseInt(e.key);
      if (n >= 1 && n <= 9) { setClassId_(n); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawScene, finishPolygon, fitToView, navigateTo, refreshAnnCount, setTool_, setClassId_, undo, toggleMasks]);

  // ---- Coordinate helpers ----
  const screenToImage = useCallback((sx: number, sy: number): Pt => ({
    x: (sx - panRef.current.x) / zoomRef.current,
    y: (sy - panRef.current.y) / zoomRef.current,
  }), []);

  // ---- Pixel mask helpers ----
  const ensureMaskCanvas = useCallback((frameId: string, cid: number, w: number, h: number): HTMLCanvasElement => {
    if (!pixelMasksRef.current.has(frameId)) pixelMasksRef.current.set(frameId, new Map());
    const fm = pixelMasksRef.current.get(frameId)!;
    if (!fm.has(cid)) {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      fm.set(cid, cv);
    }
    return fm.get(cid)!;
  }, []);

  const stampBrush = useCallback((imgPt: Pt, erase: boolean) => {
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) return;
    const sz = frameSizesRef.current.get(frame.frameId);
    const w  = sz?.w || frame.width;
    const h  = sz?.h || frame.height;
    if (!w || !h) return;
    const cid = classIdRef.current;
    const cls = clsById(cid);
    if (!cls) return;
    const maskCv = ensureMaskCanvas(frame.frameId, cid, w, h);
    const ctx    = maskCv.getContext("2d")!;
    const r      = brushRadiusRef.current;
    if (erase) {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(imgPt.x, imgPt.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      const [cr, cg, cb] = hexToRgb(cls.color);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
      ctx.beginPath();
      ctx.arc(imgPt.x, imgPt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [ensureMaskCanvas]);

  // ---- Pointer events ----
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

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
        cropDragStartRef.current  = imgPt;
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      if (toolRef.current === "brush") {
        isBrushingRef.current = true;
        canvas.setPointerCapture(e.pointerId);
        const frame = framesRef.current[frameIdxRef.current];
        if (frame) pushUndo(snapshotMask(frame.frameId, classIdRef.current));
        stampBrush(imgPt, false);
        drawScene();
        return;
      }

      if (toolRef.current === "lasso") {
        isBrushingRef.current = true;
        canvas.setPointerCapture(e.pointerId);
        const frame = framesRef.current[frameIdxRef.current];
        if (frame) pushUndo(snapshotMask(frame.frameId, classIdRef.current));
        lassoPathRef.current = [imgPt];
        drawScene();
        return;
      }

      if (toolRef.current === "eraser") {
        isBrushingRef.current = true;
        canvas.setPointerCapture(e.pointerId);
        // Eraser: erase from pixel mask, or if clicking a polygon — delete it.
        const frame = framesRef.current[frameIdxRef.current];
        const polygons = frame ? (annsRef.current.get(frame.frameId) ?? []) : [];
        let hit: string | null = null;
        for (let i = polygons.length - 1; i >= 0; i--) {
          if (pointInPoly(polygons[i], imgPt)) { hit = polygons[i].id; break; }
        }
        if (hit) {
          // Clicked inside a polygon — erase (delete) it.
          if (frame) {
            const list = annsRef.current.get(frame.frameId);
            const poly = list?.find((p) => p.id === hit);
            if (poly) pushUndo({ kind: "poly-remove", frameId: frame.frameId, poly: { ...poly, points: [...poly.points] } });
            if (list) annsRef.current.set(frame.frameId, list.filter((p) => p.id !== hit));
          }
          selectedPolyIdRef.current = null; setHasSelection(false);
          refreshAnnCount();
        } else {
          // Brush-erase from pixel mask.
          if (frame) pushUndo(snapshotMask(frame.frameId, classIdRef.current));
          stampBrush(imgPt, true);
        }
        drawScene();
        return;
      }

      if (toolRef.current === "polygon") {
        if (inProgressRef.current.length >= 3) {
          const first = inProgressRef.current[0];
          const fsx = first.x * zoomRef.current + panRef.current.x;
          const fsy = first.y * zoomRef.current + panRef.current.y;
          if (Math.hypot(sx - fsx, sy - fsy) < 14) { finishPolygon(); return; }
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
          if (pointInPoly(polygons[i], imgPt)) { hit = polygons[i].id; break; }
        }
        selectedPolyIdRef.current = hit; setHasSelection(hit !== null);
        drawScene();
        return;
      }
    },
    [drawScene, finishPolygon, pushUndo, refreshAnnCount, screenToImage, snapshotMask, stampBrush],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (isPanningRef.current) {
        panRef.current = { x: panRef.current.x + sx - lastMouseRef.current.x, y: panRef.current.y + sy - lastMouseRef.current.y };
        lastMouseRef.current = { x: sx, y: sy };
        drawScene(); return;
      }

      if (isCropDraggingRef.current && cropDragStartRef.current) {
        const imgPt = screenToImage(sx, sy);
        const s = cropDragStartRef.current;
        cropRectRef.current = { x: Math.min(s.x, imgPt.x), y: Math.min(s.y, imgPt.y), w: Math.max(1, Math.abs(imgPt.x - s.x)), h: Math.max(1, Math.abs(imgPt.y - s.y)) };
        setHasCrop(true); drawScene(); return;
      }

      if (isBrushingRef.current) {
        const imgPt = screenToImage(sx, sy);
        if (toolRef.current === "lasso") {
          const lastPt = lassoPathRef.current[lassoPathRef.current.length - 1];
          if (!lastPt || Math.hypot(imgPt.x - lastPt.x, imgPt.y - lastPt.y) > 2) {
            lassoPathRef.current.push(imgPt);
          }
          drawScene(); return;
        }
        const erase = toolRef.current === "eraser";
        // Don't delete polygons while dragging — only the click does that.
        stampBrush(imgPt, erase);
        drawScene(); return;
      }
    },
    [drawScene, screenToImage, stampBrush],
  );

  const handlePointerUp = useCallback(() => {
    isPanningRef.current    = false;
    isCropDraggingRef.current = false;
    cropDragStartRef.current  = null;

    if (toolRef.current === "lasso" && isBrushingRef.current && lassoPathRef.current.length >= 3) {
      const frame = framesRef.current[frameIdxRef.current];
      if (frame) {
        const sz = frameSizesRef.current.get(frame.frameId);
        const w = sz?.w || frame.width;
        const h = sz?.h || frame.height;
        if (w && h) {
          const cid = classIdRef.current;
          const cls = clsById(cid);
          if (cls) {
            const maskCv = ensureMaskCanvas(frame.frameId, cid, w, h);
            const mctx = maskCv.getContext("2d")!;
            const [cr, cg, cb] = hexToRgb(cls.color);
            mctx.fillStyle = `rgba(${cr},${cg},${cb},0.85)`;
            mctx.beginPath();
            const pts = lassoPathRef.current;
            mctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i].x, pts[i].y);
            mctx.closePath();
            mctx.fill();
          }
        }
      }
      lassoPathRef.current = [];
      drawScene();
    }

    isBrushingRef.current = false;
  }, [drawScene, ensureMaskCanvas]);

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
      const newZ   = Math.max(0.04, Math.min(32, zoomRef.current * factor));
      panRef.current = { x: sx - (sx - panRef.current.x) * (newZ / zoomRef.current), y: sy - (sy - panRef.current.y) * (newZ / zoomRef.current) };
      zoomRef.current = newZ;
      setZoomPct(Math.round(newZ * 100));
      drawScene();
    },
    [drawScene],
  );

  // ---- Crop actions ----
  const clearCrop = useCallback(() => {
    cropRectRef.current = null; cropZoomRef.current = false;
    setHasCrop(false); setCropZoom(false); fitToView(); drawScene();
  }, [fitToView, drawScene]);

  const toggleCropZoom = useCallback(() => {
    const next = !cropZoomRef.current;
    cropZoomRef.current = next; setCropZoom(next); fitToView(); drawScene();
  }, [fitToView, drawScene]);


  // ---- Delete selected polygon ----
  const deleteSelected = useCallback(() => {
    const frame = framesRef.current[frameIdxRef.current];
    if (frame) {
      const list = annsRef.current.get(frame.frameId);
      const poly = list?.find((p) => p.id === selectedPolyIdRef.current);
      if (poly) pushUndo({ kind: "poly-remove", frameId: frame.frameId, poly: { ...poly, points: [...poly.points] } });
      if (list) annsRef.current.set(frame.frameId, list.filter((p) => p.id !== selectedPolyIdRef.current));
    }
    selectedPolyIdRef.current = null; setHasSelection(false);
    refreshAnnCount(); drawScene();
  }, [drawScene, pushUndo, refreshAnnCount]);

  // ---- Copy annotations from any frame index ----
  const copyFromFrame = useCallback((srcIdx: number) => {
    const currIdx  = frameIdxRef.current;
    const srcFrame = framesRef.current[srcIdx];
    const currFrame = framesRef.current[currIdx];
    if (!srcFrame || !currFrame || srcIdx === currIdx) return;

    const srcPolys = annsRef.current.get(srcFrame.frameId) ?? [];
    if (srcPolys.length) {
      const cloned = srcPolys.map((p) => ({ ...p, id: uid(), points: [...p.points] }));
      annsRef.current.set(currFrame.frameId, cloned);
    }

    const srcMasks = pixelMasksRef.current.get(srcFrame.frameId);
    if (srcMasks) {
      const newMasks = new Map<number, HTMLCanvasElement>();
      for (const [cid, srcCv] of srcMasks) {
        const cv = document.createElement("canvas");
        cv.width = srcCv.width; cv.height = srcCv.height;
        cv.getContext("2d")!.drawImage(srcCv, 0, 0);
        newMasks.set(cid, cv);
      }
      pixelMasksRef.current.set(currFrame.frameId, newMasks);
    }

    refreshAnnCount(); drawScene();
  }, [drawScene, refreshAnnCount]);

  // ---- Optical-flow tracking: carry annotations from one frame to another ----
  // Frames are tracked at <= TRACK_MAX_W px wide for speed; results are mapped
  // back to full resolution. Grayscale frames are cached for the next step.
  const grayCacheRef = useRef<Map<string, Gray>>(new Map());

  const loadTrackGray = useCallback(async (frame: SegFrame): Promise<{ gray: Gray; k: number }> => {
    const sz = frameSizesRef.current.get(frame.frameId);
    const w = sz?.w || frame.width;
    const h = sz?.h || frame.height;
    const k = Math.min(1, TRACK_MAX_W / Math.max(1, w));
    const cached = grayCacheRef.current.get(frame.frameId);
    if (cached) return { gray: cached, k };
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Frame load failed"));
      img.src = frame.url;
    });
    const tw = Math.max(1, Math.round(w * k));
    const th = Math.max(1, Math.round(h * k));
    const cv = document.createElement("canvas");
    cv.width = tw; cv.height = th;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0, tw, th);
    const gray = toGray(ctx.getImageData(0, 0, tw, th).data, tw, th);
    const cache = grayCacheRef.current;
    cache.set(frame.frameId, gray);
    while (cache.size > 4) cache.delete(cache.keys().next().value!);
    return { gray, k };
  }, []);

  const trackFrame = useCallback(async (srcIdx: number, dstIdx: number) => {
    const srcFrame = framesRef.current[srcIdx];
    const dstFrame = framesRef.current[dstIdx];
    if (!srcFrame || !dstFrame || srcIdx === dstIdx) return;
    const srcPolys = annsRef.current.get(srcFrame.frameId) ?? [];
    const srcMasks = pixelMasksRef.current.get(srcFrame.frameId);
    if (!srcPolys.length && !srcMasks?.size) {
      setTrackMsg(`Frame ${srcIdx + 1} has no annotations to track`);
      return;
    }
    setTrackBusy(true); setTrackMsg(null);
    try {
      const [{ gray: prev, k }, { gray: next }] = await Promise.all([loadTrackGray(srcFrame), loadTrackGray(dstFrame)]);
      const toS = (p: Pt): Pt => ({ x: p.x * k, y: p.y * k });
      const fromS = (p: Pt): Pt => ({ x: p.x / k, y: p.y / k });
      const fallback = globalMotion(prev, next);
      const undoEntries: UndoEntry[] = [];

      // Polygons: tracked copies are added alongside whatever the frame already has.
      let tracked = 0;
      if (srcPolys.length) {
        const moved: Polygon[] = srcPolys.map((p) => {
          const r = trackPolygon(prev, next, p.points.map(toS), fallback);
          if (r.trackedFraction >= 0.5) tracked++;
          return { id: uid(), classId: p.classId, points: r.points.map(fromS) };
        });
        annsRef.current.set(dstFrame.frameId, [...(annsRef.current.get(dstFrame.frameId) ?? []), ...moved]);
        for (const p of moved) undoEntries.push({ kind: "poly-add", frameId: dstFrame.frameId, polyId: p.id });
      }

      // Pixel masks: paint each moved class mask on top of the frame's existing mask.
      let masksMoved = 0;
      if (srcMasks) {
        for (const [cid, srcCv] of srcMasks) {
          if (!srcCv.width || !srcCv.height) continue;
          const alpha = srcCv.getContext("2d")!.getImageData(0, 0, srcCv.width, srcCv.height).data;
          const pts = sampleMask(alpha, srcCv.width, srcCv.height).map(toS);
          if (!pts.length) continue;
          const { transform: t } = trackRegion(prev, next, pts, fallback);
          const full: Similarity = { a: t.a, b: t.b, tx: t.tx / k, ty: t.ty / k };
          undoEntries.push(snapshotMask(dstFrame.frameId, cid));
          const dst = ensureMaskCanvas(dstFrame.frameId, cid, srcCv.width, srcCv.height);
          const dctx = dst.getContext("2d")!;
          dctx.save();
          dctx.globalCompositeOperation = "source-over";
          dctx.imageSmoothingEnabled = false;
          dctx.setTransform(full.a, full.b, -full.b, full.a, full.tx, full.ty);
          dctx.drawImage(srcCv, 0, 0);
          dctx.restore();
          masksMoved++;
        }
      }

      if (undoEntries.length) pushUndo({ kind: "batch", entries: undoEntries });
      const parts: string[] = [];
      if (srcPolys.length) parts.push(`${tracked}/${srcPolys.length} polygons tracked`);
      if (masksMoved) parts.push(`${masksMoved} mask${masksMoved > 1 ? "s" : ""} moved`);
      setTrackMsg(`Added from frame ${srcIdx + 1}: ${parts.join(", ")} — review before saving`);
      refreshAnnCount(); drawScene();
    } catch (e) {
      setTrackMsg(`Tracking failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTrackBusy(false);
    }
  }, [drawScene, ensureMaskCanvas, loadTrackGray, pushUndo, refreshAnnCount, snapshotMask]);

  /** Track the current frame's annotations onto the next frame and move there. */
  const trackForward = useCallback(async () => {
    const i = frameIdxRef.current;
    if (i >= framesRef.current.length - 1) return;
    navigateTo(i + 1);
    await trackFrame(i, i + 1);
  }, [navigateTo, trackFrame]);
  const trackForwardRef = useRef(trackForward);
  useEffect(() => { trackForwardRef.current = trackForward; }, [trackForward]);

  // ---- Split-screen (endoscopy + fluoroscopy) frames: mark, then remove ----
  const toggleSplit = useCallback(() => {
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) return;
    const set = splitRef.current;
    if (set.has(frame.frameId)) set.delete(frame.frameId);
    else set.add(frame.frameId);
    setSplitCount(set.size);
    setConfirmRemove(false);
    drawScene();
  }, [drawScene]);
  const toggleSplitRef = useRef(toggleSplit);
  useEffect(() => { toggleSplitRef.current = toggleSplit; }, [toggleSplit]);

  // ---- "Annotation complete" tick ----
  const toggleCompleted = useCallback(() => {
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) return;
    const set = completedRef.current;
    if (set.has(frame.frameId)) set.delete(frame.frameId);
    else set.add(frame.frameId);
    setCompletedCount(set.size);
  }, []);
  const toggleCompletedRef = useRef(toggleCompleted);
  useEffect(() => { toggleCompletedRef.current = toggleCompleted; }, [toggleCompleted]);

  // Take frames out of the project (split-screen, or not worth annotating).
  const removeFrameIds = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    setRemoving(true);
    try {
      const moved = new Set(await window.endoseg.removeFrames(projectId, ids));
      if (!moved.size) return;
      const curId = framesRef.current[frameIdxRef.current]?.frameId;
      const before = framesRef.current;
      // Land on the nearest surviving frame at or after the current one.
      let landing = before.findIndex((f, i) => i >= frameIdxRef.current && !moved.has(f.frameId));
      if (landing < 0) landing = before.length - 1;
      while (landing > 0 && moved.has(before[landing].frameId)) landing--;
      const landingId = before[landing]?.frameId;
      for (const id of moved) {
        annsRef.current.delete(id);
        pixelMasksRef.current.delete(id);
        phasesRef.current.delete(id);
        frameSizesRef.current.delete(id);
        grayCacheRef.current.delete(id);
        splitRef.current.delete(id);
        completedRef.current.delete(id);
      }
      undoStackRef.current = undoStackRef.current.filter((e) => !("frameId" in e) || !moved.has(e.frameId));
      const after = before.filter((f) => !moved.has(f.frameId));
      setFrames_(after);
      setSplitCount(splitRef.current.size);
      setCompletedCount(completedRef.current.size);
      const idx = Math.max(0, after.findIndex((f) => f.frameId === (moved.has(curId ?? "") ? landingId : curId)));
      navigateTo(idx);
      // Persist right away so the saved annotations never point at removed frames.
      await handleSaveRef.current();
    } catch (e) {
      setSaveMsg(`Error: ${String(e)}`);
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
      setConfirmRemoveOne(false);
    }
  }, [navigateTo, projectId, setFrames_]);
  const removeMarked = useCallback(() => removeFrameIds([...splitRef.current]), [removeFrameIds]);

  // Keep the current frame in view in the frame list.
  useEffect(() => {
    sidebarRef.current?.querySelector(`[data-idx="${frameIdx}"]`)?.scrollIntoView({ block: "center" });
  }, [frameIdx, frames]);

  // ---- Auto-annotate duodenal wall by color range ----
  const autoDuodenalWall = useCallback(async () => {
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) return;
    const sz = frameSizesRef.current.get(frame.frameId);
    const w  = sz?.w || frame.width;
    const h  = sz?.h || frame.height;
    if (!w || !h) return;
    setAutoDwBusy(true);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((res, rej) => {
        img.onload  = () => res();
        img.onerror = () => rej(new Error("Frame load failed"));
        img.src = frame.url;
      });
      const offscreen = document.createElement("canvas");
      offscreen.width = w; offscreen.height = h;
      const octx = offscreen.getContext("2d")!;
      octx.drawImage(img, 0, 0, w, h);
      const imageData = octx.getImageData(0, 0, w, h);
      const data = imageData.data;

      const dwCls   = CLASSES.find((c) => c.name === "DUODENAL_WALL")!;
      const [dr, dg, db] = hexToRgb(dwCls.color);
      const maskCv  = ensureMaskCanvas(frame.frameId, dwCls.id, w, h);
      const mctx    = maskCv.getContext("2d")!;
      const maskImg = mctx.createImageData(w, h);
      const md      = maskImg.data;

      for (let i = 0; i < data.length; i += 4) {
        if (isDuodenalWallPixel(data[i], data[i + 1], data[i + 2])) {
          md[i] = dr; md[i + 1] = dg; md[i + 2] = db; md[i + 3] = 217;
        }
      }
      mctx.putImageData(maskImg, 0, 0);
      drawScene();
    } catch {
      // Silently ignore (crossOrigin or canvas taint issues)
    } finally {
      setAutoDwBusy(false);
    }
  }, [drawScene, ensureMaskCanvas]);


  // ---- Clear current class pixel mask on current frame ----
  const clearCurrentClassMask = useCallback(() => {
    const frame = framesRef.current[frameIdxRef.current];
    if (!frame) return;
    const fm = pixelMasksRef.current.get(frame.frameId);
    if (!fm) return;
    const cv = fm.get(classIdRef.current);
    if (cv) {
      pushUndo(snapshotMask(frame.frameId, classIdRef.current));
      cv.getContext("2d")!.clearRect(0, 0, cv.width, cv.height);
    }
    drawScene();
  }, [drawScene, pushUndo, snapshotMask]);

  // ---- Render ----
  if (loading) {
    return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#e4e9f0" }}>Loading frames…</div>;
  }
  if (error) {
    return <div style={{ padding: 20, color: "#f87171" }}>Error loading frames: {error}</div>;
  }

  const currentFrame = framesRef.current[frameIdx];
  const cursorStyle  = (tool === "polygon" || tool === "crop" || tool === "brush" || tool === "eraser" || tool === "lasso") ? "crosshair" : "default";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0d1520", color: "#e4e9f0" }}>

      {/* ---- Upper toolbar (fixed, not floating) ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", borderBottom: "1px solid #1e2d40", flexShrink: 0, fontSize: 11 }}>
        <button
          onClick={() => void autoDuodenalWall()}
          disabled={autoDwBusy || !currentFrame}
          title="Auto-annotate reddish/pinkish pixels as Duodenal Wall (editable with brush/eraser)"
          style={{ fontSize: 11, padding: "2px 10px", background: autoDwBusy ? "#1a2a1a" : undefined }}
        >
          {autoDwBusy ? "Auto DW…" : "Auto DW"}
        </button>
        <span style={{ color: "#2d3f57", fontSize: 10 }}>
          Paints reddish-hued pixels as DW class mask · refine with Brush / Eraser tools
        </span>
      </div>

      {/* ---- Main area ---- */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Frame list sidebar (left) */}
        <div ref={sidebarRef} style={{ width: 200, flexShrink: 0, borderRight: "1px solid #1e2d40", overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column" }}>
          {frames.length === 0 ? (
            <div style={{ padding: 12, color: "#475569", fontSize: 12, lineHeight: 1.5 }}>No frames found.<br />Run Intake first.</div>
          ) : (
            frames.map((f, i) => {
              const hasAnns   = (annsRef.current.get(f.frameId)?.length ?? 0) > 0;
              const hasMasks  = (pixelMasksRef.current.get(f.frameId)?.size ?? 0) > 0;
              const framePhase = phasesRef.current.get(f.frameId);
              const isSplit = splitRef.current.has(f.frameId);
              const isDone = completedRef.current.has(f.frameId);
              const active = i === frameIdx;
              return (
                <button key={f.frameId} data-idx={i} title={f.name} onClick={() => navigateTo(i)} style={{ display: "flex", flexDirection: "column", width: "100%", minWidth: 0, padding: 0, textAlign: "left", background: active ? "#1d3a60" : "transparent", border: "none", borderLeft: `4px solid ${active ? "#38bdf8" : "transparent"}`, borderBottom: `1px solid ${active ? "#2a4a70" : "#111a26"}`, outline: active ? "2px solid #38bdf8" : "none", outlineOffset: -2, color: active ? "#f1f5f9" : "#6b7e94", cursor: "pointer", flexShrink: 0 }}>
                  <div style={{ position: "relative", width: "100%" }}>
                    <img src={f.url} loading="lazy" style={{ width: "100%", height: 52, objectFit: "cover", borderRadius: "2px 2px 0 0", display: "block", opacity: isSplit ? 0.35 : 1 }} />
                    {(f.success || !!f.maneuvers?.length) && (
                      <div style={{ position: "absolute", left: 3, bottom: 3, display: "flex", gap: 2, flexWrap: "wrap" }}>
                        {f.success && <span title="Successful cannulation attempt" style={{ ...tagStyle, background: SUCCESS_COLOR }}>SUCCESS</span>}
                        {f.maneuvers?.map((m) => {
                          const def = maneuverById(m);
                          return <span key={m} title={def?.label ?? m} style={{ ...tagStyle, background: def?.color ?? "#475569" }}>{def?.abbr ?? m}</span>;
                        })}
                      </div>
                    )}
                    {isDone && (
                      <span title="Annotation complete" style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 9, background: "#16a34a", color: "#fff", fontSize: 12, fontWeight: 700, lineHeight: "18px", textAlign: "center", boxShadow: "0 0 0 2px #0d1520" }}>✓</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", fontSize: 11 }}>
                    <span style={{ color: "#2d3f57", width: 30, textAlign: "right", flexShrink: 0 }}>{i + 1}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.timeSec != null ? `${formatTimecode(f.timeSec)} · ${labelById(f.phase ?? "")?.label ?? f.phase ?? ""}` : f.name}
                    </span>
                    {framePhase && <span title={framePhase} style={{ color: phaseColor(framePhase), fontSize: 7, flexShrink: 0 }}>◆</span>}
                    {(hasAnns || hasMasks) && <span style={{ color: "#4ade80", fontSize: 8, flexShrink: 0 }}>●</span>}
                    {isSplit && <span title="Marked for removal" style={{ color: "#f87171", fontSize: 10, flexShrink: 0 }}>⊘</span>}
                    {isDone && <span title="Annotation complete" style={{ color: "#4ade80", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>✓</span>}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Canvas (middle — full canvas, no overlapping elements) */}
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
          {splitCount > 0 && frames[frameIdx] && splitRef.current.has(frames[frameIdx].frameId) && (
            <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", background: "rgba(127,29,29,0.88)", color: "#fecaca", border: "1px solid #f87171", padding: "4px 12px", borderRadius: 6, fontSize: 11, pointerEvents: "none", whiteSpace: "nowrap" }}>
              ⊘ Marked for removal (X to unmark)
            </div>
          )}
          {inProgressLen > 0 && (
            <div style={{ position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.78)", color: "#e4e9f0", padding: "5px 14px", borderRadius: 8, fontSize: 11, pointerEvents: "none", whiteSpace: "nowrap" }}>
              {inProgressLen} pts · click near start or double-click to close · Esc to cancel
            </div>
          )}
        </div>

        {/* Annotation panel (right sidebar — fixed, never overlaps canvas) */}
        <div style={{ width: 210, flexShrink: 0, borderLeft: "1px solid #1e2d40", overflowY: "auto", display: "flex", flexDirection: "column", background: "#0a121c" }}>
          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
            {/* Per-frame "done" tick */}
            {(() => {
              const done = !!currentFrame && completedRef.current.has(currentFrame.frameId);
              return (
                <label
                  title="Tick when every structure on this frame is annotated [C]"
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 6, cursor: currentFrame ? "pointer" : "default", border: `1.5px solid ${done ? "#4ade80" : "#1e2d40"}`, background: done ? "rgba(74,222,128,0.12)" : "transparent", color: done ? "#bbf7d0" : "#94a3b8", fontSize: 12, fontWeight: 600 }}
                >
                  <input type="checkbox" checked={done} disabled={!currentFrame} onChange={toggleCompleted} style={{ width: 16, height: 16, accentColor: "#4ade80", cursor: "inherit" }} />
                  Annotation complete [C]
                </label>
              );
            })()}
            <div style={{ fontSize: 10, color: "#475569" }}>{completedCount} / {frames.length} frames complete</div>

            <PanelDivider />

            {/* Tool buttons — Draw section */}
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Draw</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 }}>
              <ToolBtn active={tool === "polygon"} onClick={() => setTool_("polygon")} icon="◇" label="Polygon" title="Polygon — click to add points, double-click to close [P]" />
              <ToolBtn active={tool === "brush"}   onClick={() => setTool_("brush")}   icon="⬤" label="Brush"   title="Brush — click-drag to paint [B]" />
              <ToolBtn active={tool === "lasso"}   onClick={() => setTool_("lasso")}   icon="⊂" label="Lasso"   title="Lasso — drag to draw freehand fill region [L]" />
            </div>

            {/* Polygon hint (under Draw section) */}
            {tool === "polygon" && (
              <div style={{ fontSize: 10, color: "#334155", lineHeight: 1.4 }}>
                Click to add points · double-click or click first point to close
              </div>
            )}

            {/* Brush/lasso size (under Draw section) */}
            {(tool === "brush" || tool === "lasso") && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#64748b", flexShrink: 0 }}>Size</span>
                <input
                  type="range" min={1} max={200} value={brushRadius}
                  onChange={(ev) => { const v = Number(ev.target.value); brushRadiusRef.current = v; setBrushRadius(v); }}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 10, color: "#94a3b8", minWidth: 24 }}>{brushRadius}</span>
              </div>
            )}

            {/* Tool buttons — Erase section */}
            <div style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4, marginTop: 6 }}>Erase</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              <ToolBtn active={tool === "eraser"} onClick={() => setTool_("eraser")} icon="○" label="Circle" title="Eraser — drag to erase brush strokes [E]" />
              <ToolBtn active={false} onClick={clearCurrentClassMask} icon="✕" label="Clear" title="Clear all brush strokes for current class on this frame" danger />
            </div>

            {/* Eraser size (under Erase section) */}
            {tool === "eraser" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#64748b", flexShrink: 0 }}>Size</span>
                <input
                  type="range" min={1} max={200} value={brushRadius}
                  onChange={(ev) => { const v = Number(ev.target.value); brushRadiusRef.current = v; setBrushRadius(v); }}
                  style={{ flex: 1 }}
                />
                <span style={{ fontSize: 10, color: "#94a3b8", minWidth: 24 }}>{brushRadius}</span>
              </div>
            )}

            {/* Other tools — Select + Crop */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
              <ToolBtn active={tool === "select"} onClick={() => setTool_("select")} icon="↖" label="Select" title="Select polygon [S]" />
              <ToolBtn active={tool === "crop"}   onClick={() => setTool_("crop")}   icon="▣" label="Crop"   title="Drag to set crop region" />
            </div>

            {hasCrop && (
              <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <Btn active={cropZoom} onClick={toggleCropZoom} title="Zoom to crop">Zoom crop</Btn>
                <Btn active={false} onClick={clearCrop} title="Clear crop">✕ crop</Btn>
              </div>
            )}

            <div style={{ marginTop: 6 }}>
              <Btn active={showMasks} onClick={toggleMasks} title="Toggle mask visibility [M]">👁 Masks</Btn>
            </div>

            <PanelDivider />

            {/* Class grid — 5 per row */}
            <div style={{ fontSize: 10, color: "#475569", marginBottom: 2 }}>Class</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 3 }}>
              {CLASSES.map((c) => {
                const active = classId === c.id;
                const light  = clsLuminance(c) > 140;
                return (
                  <button key={c.id} title={`${c.name} [${c.id === 10 ? 0 : c.id}]`} onClick={() => setClassId_(c.id)} style={{ padding: "3px 2px", background: active ? c.color : "transparent", border: `1.5px solid ${c.color}`, color: active ? (light ? "#000" : "#fff") : c.color, borderRadius: 4, cursor: "pointer", fontWeight: 700, fontSize: 10, textAlign: "center" }}>
                    {c.abbr}
                  </button>
                );
              })}
            </div>

            <PanelDivider />

            {/* Phase selector */}
            <div style={{ fontSize: 10, color: "#475569", marginBottom: 2 }}>Phase</div>
            <select value={currentPhase} onChange={(e) => setPhase_(e.target.value)} style={{ fontSize: 11, padding: "3px 6px", background: "#0d1a2a", color: currentPhase ? "#e4e9f0" : "#475569", border: "1px solid #1e2d40", borderRadius: 4, cursor: "pointer", width: "100%" }}>
              <option value="">— phase —</option>
              {PHASES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              <optgroup label="Maneuver (outside a phase)">
                {MANEUVERS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </optgroup>
              {currentPhase && !labelById(currentPhase) && <option value={currentPhase}>{currentPhase}</option>}
            </select>
            {(frames[frameIdx]?.success || !!frames[frameIdx]?.maneuvers?.length) && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 5 }}>
                {frames[frameIdx]?.success && <span style={{ ...tagStyle, background: SUCCESS_COLOR, fontSize: 10 }}>Successful attempt</span>}
                {frames[frameIdx]?.maneuvers?.map((m) => (
                  <span key={m} style={{ ...tagStyle, background: maneuverById(m)?.color ?? "#475569", fontSize: 10 }}>
                    {maneuverById(m)?.label ?? m}
                  </span>
                ))}
              </div>
            )}

            <PanelDivider />

            {/* Copy from frame # */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#64748b" }}>Copy annotations from frame</span>
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  type="number" min={1} max={frames.length}
                  value={copyFromInput}
                  onChange={(ev) => setCopyFromInput(ev.target.value)}
                  placeholder={`1–${frames.length}`}
                  style={{ flex: 1, fontSize: 11, padding: "2px 6px", background: "#0d1a2a", color: "#e4e9f0", border: "1px solid #1e2d40", borderRadius: 4 }}
                />
                <Btn
                  active={false}
                  onClick={() => {
                    const n = parseInt(copyFromInput);
                    if (!isNaN(n) && n >= 1 && n <= frames.length) copyFromFrame(n - 1);
                  }}
                  title="Copy polygons + masks from that frame into this one"
                >
                  Copy
                </Btn>
              </div>
              {frameIdx > 0 && (
                <button className="secondary" onClick={() => copyFromFrame(frameIdx - 1)} style={{ fontSize: 11, padding: "2px 8px" }} title="Quick-copy from previous frame">
                  ← Copy prev
                </button>
              )}
            </div>

            <PanelDivider />

            {/* Optical-flow tracking */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#64748b" }}>Optical tracking</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className="secondary"
                  disabled={trackBusy || frameIdx === 0}
                  onClick={() => void trackFrame(frameIdx - 1, frameIdx)}
                  style={{ flex: 1, fontSize: 11, padding: "2px 8px" }}
                  title="Add the previous frame's polygons + masks to this frame, moved by optical flow"
                >
                  ← Track prev
                </button>
                <button
                  className="secondary"
                  disabled={trackBusy || frameIdx >= frames.length - 1}
                  onClick={() => void trackForward()}
                  style={{ flex: 1, fontSize: 11, padding: "2px 8px" }}
                  title="Add this frame's annotations to the next frame (moved by optical flow) and go there [T]"
                >
                  Track next → [T]
                </button>
              </div>
              {(trackBusy || trackMsg) && (
                <span style={{ fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>{trackBusy ? "Tracking…" : trackMsg}</span>
              )}
            </div>

            <PanelDivider />

            {/* Split-screen (endoscopy + fluoroscopy) frames */}
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 10, color: "#64748b" }}>Remove frames</span>
              {confirmRemoveOne ? (
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    disabled={removing}
                    onClick={() => currentFrame && void removeFrameIds([currentFrame.frameId])}
                    style={{ flex: 1, fontSize: 11, padding: "2px 8px", background: "#450a0a", borderColor: "#f87171", color: "#fca5a5" }}
                  >
                    {removing ? "Removing…" : "Remove it"}
                  </button>
                  <button className="secondary" disabled={removing} onClick={() => setConfirmRemoveOne(false)} style={{ fontSize: 11, padding: "2px 8px" }}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  disabled={!currentFrame || removing}
                  onClick={() => setConfirmRemoveOne(true)}
                  style={{ fontSize: 11, padding: "2px 8px", background: "#2a0d0d", borderColor: "#7f1d1d", color: "#fca5a5" }}
                  title="Take this frame out of the annotation set (not significant, blurry, split-screen…). Moved to 01_frames/removed, recoverable."
                >
                  Remove this frame…
                </button>
              )}
              <button
                className="secondary"
                disabled={!frames.length}
                onClick={toggleSplit}
                style={{ fontSize: 11, padding: "2px 8px" }}
                title="Mark/unmark this frame for removal (e.g. split-screen endoscopy + fluoroscopy), then remove all marked frames at once [X]"
              >
                {frames[frameIdx] && splitRef.current.has(frames[frameIdx].frameId) ? "Unmark [X]" : "Mark for removal [X]"}
              </button>
              {splitCount > 0 && (
                confirmRemove ? (
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      disabled={removing}
                      onClick={() => void removeMarked()}
                      style={{ flex: 1, fontSize: 11, padding: "2px 8px", background: "#450a0a", borderColor: "#f87171", color: "#fca5a5" }}
                    >
                      {removing ? "Removing…" : `Remove ${splitCount}`}
                    </button>
                    <button className="secondary" disabled={removing} onClick={() => setConfirmRemove(false)} style={{ fontSize: 11, padding: "2px 8px" }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmRemove(true)}
                    style={{ fontSize: 11, padding: "2px 8px", background: "#2a0d0d", borderColor: "#7f1d1d", color: "#fca5a5" }}
                    title="Take marked frames out of this project (moved to 01_frames/removed) and save"
                  >
                    Remove {splitCount} marked frame{splitCount > 1 ? "s" : ""}…
                  </button>
                )
              )}
              {(confirmRemove || confirmRemoveOne) && (
                <span style={{ fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
                  Their annotations are discarded and the project is saved. Files go to 01_frames/removed.
                </span>
              )}
            </div>

            {/* Delete selected */}
            {hasSelection && (
              <>
                <PanelDivider />
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, color: "#94a3b8" }}>1 selected</span>
                  <button style={{ fontSize: 11, padding: "2px 8px", background: "#450a0a", borderColor: "#f87171", color: "#fca5a5" }} onClick={deleteSelected} title="Delete selected polygon [Del]">Delete</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ---- Status bar ---- */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 10px", borderTop: "1px solid #1e2d40", flexShrink: 0, fontSize: 11, color: "#3d5068" }}>
        {saveMsg && <span style={{ color: saveMsg.startsWith("Error") ? "#f87171" : "#4ade80" }}>{saveMsg}</span>}
        <button onClick={() => void handleSave()} disabled={saving} title="Save annotations [Ctrl+S]" style={{ fontSize: 11, padding: "2px 8px" }}>
          {saving ? "Saving…" : "Save"}
        </button>

        <div style={{ width: 1, height: 16, background: "#1e2d40", flexShrink: 0 }} />

        {currentFrame && <span>{currentFrame.name}</span>}
        {currentFrame && completedRef.current.has(currentFrame.frameId) && <span style={{ color: "#4ade80" }}>✓ complete</span>}
        {currentFrame && currentFrame.width > 0 && <span style={{ color: "#2d3f57" }}>{currentFrame.width}×{currentFrame.height}</span>}
        <span>{annCount} polygon{annCount !== 1 ? "s" : ""}</span>

        <div style={{ flex: 1 }} />

        <span style={{ color: "#475569" }}>{zoomPct}%</span>
        <button className="secondary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => { fitToView(); drawScene(); }} title="Fit to window [F]">Fit</button>
        <button className="secondary" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => {
          const canvas = canvasRef.current; const img = imageRef.current;
          if (!canvas || !img) return;
          const dpr = dprRef.current;
          zoomRef.current = 1;
          panRef.current = { x: (canvas.width / dpr - img.naturalWidth) / 2, y: (canvas.height / dpr - img.naturalHeight) / 2 };
          setZoomPct(100); drawScene();
        }} title="Zoom to actual pixels (1:1)">1:1</button>
        <span style={{ color: "#2d3f57" }}>{frames.length > 0 ? `${frameIdx + 1} / ${frames.length}` : "—"}</span>

        <div style={{ width: 1, height: 16, background: "#1e2d40", flexShrink: 0 }} />
        <span style={{ color: "#1e2d40" }}>P=poly · B=brush · L=lasso · E=erase · S=sel · M=masks · C=complete · X=mark · 1–9,0=class · A/D/←→=nav · [/]=size · F=fit · Ctrl+Z=undo · Ctrl+S=save</span>
      </div>
    </div>
  );
}

function Btn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button className={active ? "" : "secondary"} onClick={onClick} title={title} style={{ fontSize: 11, padding: "2px 8px" }}>
      {children}
    </button>
  );
}

function PanelDivider() {
  return <div style={{ height: 1, background: "#1e2d40", margin: "1px 0" }} />;
}

function ToolBtn({ active, onClick, icon, label, title, danger }: { active: boolean; onClick: () => void; icon: string; label: string; title?: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        flex: 1,
        padding: "10px 4px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        background: active ? "#1a3050" : danger ? "rgba(180,30,30,0.2)" : "transparent",
        border: `1.5px solid ${active ? "#3b6fa8" : danger ? "#9f1239" : "#1e2d40"}`,
        borderRadius: 6,
        color: active ? "#e4e9f0" : danger ? "#fca5a5" : "#6b7e94",
        cursor: "pointer",
        outline: active ? "1.5px solid #3b6fa8" : "none",
        outlineOffset: -1,
      }}
    >
      <span style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 500 }}>{label}</span>
    </button>
  );
}

/** Small label on a frame for its maneuvers / successful attempt. */
const tagStyle: React.CSSProperties = {
  color: "#0b1220", fontSize: 8, fontWeight: 700, lineHeight: "12px", padding: "0 3px", borderRadius: 3,
};

function phaseColor(phase: string): string {
  return labelById(phase)?.color ?? "#475569";
}
