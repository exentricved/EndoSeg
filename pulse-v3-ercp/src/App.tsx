import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  HostedAnnotatorManifest,
  HostedAnnotatorOutput,
} from "./hostedReviewContract";
import { useToolHotkeys, isTypingContext } from "./useToolHotkeys";
import { buildCocoExportFrame, cocoExportBlob } from "./cocoExport";
import {
  ERCP_CLASSES,
  ERCP_CLASS_BY_ID,
  classDefaultDepthRank,
  defaultAttributesFor,
  type AnnotationInstance,
  type KeypointInstance,
  type FrameMetadata,
  type PolygonGeom,
  makeDefaultFrameMetadata,
} from "./ercpClasses";
import { findVertexHit, findPolygonHit, findEdgeHit, polygonsOverlap, polygonCentroid } from "./polygonGeom";
import { AttributePanel } from "./components/AttributePanel";
import { KeypointModal } from "./components/KeypointModal";
import { FrameMetadataPanel } from "./components/FrameMetadataPanel";
import { SoftWarnings } from "./components/SoftWarnings";
import { ProgressSidebar, frameCompletionColor } from "./components/ProgressSidebar";
import { type KeypointName } from "./ercpClasses";

/**
 * ERCP Papilla Annotator — browser-based annotation tool for ERCP endoscopic frames
 * Scope: manual annotation of papilla anatomy + instruments for monocular 3D reconstruction
 * and robotic sphincterotome guidance training data.
 *
 * Status: forked from pulse-v3-liver; under active rebuild.
 * Project format: .ercp JSON (instance-based polygons + masks + keypoints)
 * Export format: per-image COCO-style JSON
 *
 * Rendering notes:
 * - HiDPI backing store (cssSize × devicePixelRatio); consistent pointer alignment
 * - Zoom: Ctrl/Cmd + mouse wheel (zooms around cursor), toolbar +/−/reset
 * - Cached tinted fills & outlines + RAF redraw scheduler for smooth performance
 */

type ToolType = "pen" | "circle-eraser" | "stroke-eraser" | "global-eraser" | "polygon" | "keypoint" | "select";
type Pt = { x: number; y: number };

type LabelSpec = {
  id: number;
  name: string;
  color: string;
  visible: boolean;
  displayFill: boolean;
  canvas?: HTMLCanvasElement;
  ctx?: CanvasRenderingContext2D | null;
  rev?: number; // increments when mask changes
  cache?: {
    rev: number;
    color: string;
    tint?: HTMLCanvasElement;     // filled area (alpha-tinted)
    outline?: HTMLCanvasElement;  // colored outline
  };
};

type ImageItem = {
  id: string;
  name: string;
  w: number;
  h: number;
  baseURL: string;
  thumbURL?: string;
  station?: "TG" | "TD" | ""; // legacy liver field; ERCP uses metadata.procedural_state instead (transitional — task #7 will retire this)
  sourceTimestamp?: number | null; // seconds from original video (from NORM frame_XXXX_ts_Y.YYY filenames)
  labels: LabelSpec[];           // per-class binary mask canvases (pen + eraser write here)
  annotations: AnnotationInstance[]; // polygon-geom + mask-geom instances (polygon tool writes here)
  keypoints: KeypointInstance[];     // named landmark points
  metadata: FrameMetadata;           // procedural state, deformation, quality flags, usable flags
  history: HistoryEntry[];   // stroke history for undo/redo
  redo: HistoryEntry[];
};

type HistoryEntry =
  | { kind: "mask"; labelId: number; before: ImageData; after: ImageData }
  | { kind: "annotations"; before: AnnotationInstance[]; after: AnnotationInstance[] }
  | { kind: "keypoints"; before: KeypointInstance[]; after: KeypointInstance[] };

type ThemeKind = "dark" | "light";
type CompatibilityMode = null | "legacy-v1" | "restricted-v2";
type Tier2ALabelDef = {
  id: number;
  name: string;
  abbr: string;
  color: string;
};
type StrokeTransform = {
  left: number;
  top: number;
  scale: number;
  offX: number;
  offY: number;
  panX: number;
  panY: number;
  w: number;
  h: number;
};
type PreviewSegment = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};
type LoggedLabel = {
  id: number;
  name: string;
};
type AnnotationLogEventType =
  | "session_start"
  | "session_end"
  | "project_open"
  | "edit_commit"
  | "save_project"
  | "export_nrrd";
type AnnotationLogEvent = {
  ts: string;
  type: AnnotationLogEventType;
  installationId: string;
  sessionId: string;
  projectKey?: string;
  projectFilename?: string;
  caseName?: string;
  compatibilityMode?: CompatibilityMode;
  isNativeLiverProject?: boolean;
  frameCount?: number;
  stationsUsed?: string[];
  labelsUsed?: LoggedLabel[];
  frameId?: string;
  frameName?: string;
  station?: "TG" | "TD" | "";
  labelId?: number;
  labelName?: string;
  tool?: ToolType | "undo" | "redo" | "station";
  action?: "mask_edit" | "undo" | "redo" | "station_change";
  imageCount?: number;
  exportedCount?: number;
  exportScope?: "current" | "selected" | "all";
  source?: "file-picker";
};
type AnnotationLogSession = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  activeAnnotationMs: number;
  eventCount: number;
};
type AnnotationProjectSession = {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  activeAnnotationMs: number;
  eventCount: number;
};
type AnnotationProjectLog = {
  projectKey: string;
  projectFilename: string;
  caseName: string;
  compatibilityMode: CompatibilityMode;
  isNativeLiverProject: boolean;
  firstOpenTime: string | null;
  lastOpenTime: string | null;
  lastEditTime: string | null;
  lastSaveTime: string | null;
  lastExportTime: string | null;
  frameCount: number;
  stationsUsed: string[];
  labelsUsed: LoggedLabel[];
  totalActiveAnnotationMs: number;
  saveCount: number;
  exportCount: number;
  sessions: AnnotationProjectSession[];
};
type AnnotationLogStore = {
  schemaVersion: 1;
  app: "AnnotateERCP";
  installationId: string;
  createdAt: string;
  updatedAt: string;
  sessions: AnnotationLogSession[];
  projects: AnnotationProjectLog[];
  events: AnnotationLogEvent[];
};
type LogProjectContext = {
  projectKey: string;
  projectFilename: string;
  caseName: string;
  compatibilityMode: CompatibilityMode;
  isNativeLiverProject: boolean;
};
type HostedReviewConfig = {
  manifest: HostedAnnotatorManifest;
  onSubmitReview: (output: HostedAnnotatorOutput) => Promise<void> | void;
};
type AppProps = {
  hostedReview?: HostedReviewConfig;
};

const PEN_SIZE = 1;       // 1px pen
const FILL_ALPHA = 0.10;  // 10% fill opacity
const OUTLINE_THICKNESS = 2;
const ANNOTATION_LOG_STORAGE_KEY = "annotateercp.annotation_log.v1";
const ANNOTATION_ACTIVE_IDLE_MS = 30_000;
const MAX_HISTORY_PER_IMAGE = 5;
const AUTOSAVE_IDB_NAME = "annotateercp_autosave";
const AUTOSAVE_IDB_STORE = "snapshots";
const AUTOSAVE_IDB_KEY = "latest";
// const AUTOSAVE_DEBOUNCE_MS = 15_000; // restore when re-enabling auto-save

// IndexedDB helpers for auto-save
function openAutosaveDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUTOSAVE_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(AUTOSAVE_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
// @ts-ignore — preserved for when auto-save is re-enabled
async function idbPut(data: string): Promise<void> {
  const db = await openAutosaveDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_IDB_STORE, "readwrite");
    tx.objectStore(AUTOSAVE_IDB_STORE).put(data, AUTOSAVE_IDB_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
async function idbGet(): Promise<string | null> {
  const db = await openAutosaveDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_IDB_STORE, "readonly");
    const req = tx.objectStore(AUTOSAVE_IDB_STORE).get(AUTOSAVE_IDB_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
async function idbDelete(): Promise<void> {
  const db = await openAutosaveDB();
  return new Promise((resolve) => {
    const tx = db.transaction(AUTOSAVE_IDB_STORE, "readwrite");
    tx.objectStore(AUTOSAVE_IDB_STORE).delete(AUTOSAVE_IDB_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
  });
}
// Lightweight projection of ERCP_CLASSES (defined in ercpClasses.ts) into the
// id/name/abbr/color shape the existing per-class canvas UI expects.
// Once the polygon tool moves to instance-based storage (task #3) and pen/eraser
// repoint to per-instance masks (task #8), this projection collapses away.
const TIER2A_LABELS: Tier2ALabelDef[] = ERCP_CLASSES.map(c => ({
  id: c.id, name: c.name, abbr: c.abbr, color: c.color,
}));
const DISPLAY_ORDER = TIER2A_LABELS.map(l => l.id);
// TIER2A_LABEL_BY_ID — kept in scope for export bundling / legacy reference paths.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TIER2A_LABEL_BY_ID = new Map<number, Tier2ALabelDef>(TIER2A_LABELS.map(l => [l.id, l]));
void TIER2A_LABEL_BY_ID;

/* -------------------- utils -------------------- */
function uid() {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) return window.crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}
function stripExt(s: string) { return s.replace(/\.[^.]+$/, ""); }
/** Convert "#RRGGBB" + alpha [0..1] to "rgba(r,g,b,a)" for canvas fillStyle. */
function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function extractSourceTimestamp(filename: string): number | null {
  // Matches frame_XXXX_ts_Y.YYY.ext produced by the NORM extraction pipeline
  const m = filename.match(/[_\-]ts[_\-]([\d]+(?:\.[\d]+)?)/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return isFinite(v) && v >= 0 ? v : null;
}
function isoAt(ms: number) { return new Date(ms).toISOString(); }
function uniqSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort();
}
function mergeLoggedLabels(a: LoggedLabel[], b: LoggedLabel[]) {
  const byId = new Map<number, LoggedLabel>();
  for (const item of a) byId.set(item.id, item);
  for (const item of b) byId.set(item.id, item);
  return Array.from(byId.values()).sort((x, y) => x.id - y.id);
}
function imageDataEqual(a: ImageData, b: ImageData) {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
  const d1 = a.data, d2 = b.data;
  for (let i = 0; i < d1.length; i++) if (d1[i] !== d2[i]) return false;
  return true;
}
function labelHasPixels(label: LabelSpec) {
  const ctx = label.ctx;
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}
function collectUsedLabels(images: ImageItem[]): LoggedLabel[] {
  const used = new Map<string, LoggedLabel>();
  for (const im of images) {
    for (const label of im.labels) {
      if (!labelHasPixels(label)) continue;
      used.set(`${label.id}:${label.name}`, { id: label.id, name: label.name });
    }
  }
  return Array.from(used.values()).sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
}
function stationsFromImages(images: ImageItem[]) {
  return uniqSorted(images.map(im => im.station || ""));
}
function makeWorkingProjectContext(caseName: string): LogProjectContext {
  const safeCase = caseName.trim() || "project";
  return {
    projectKey: `working:${safeCase.toLowerCase()}`,
    projectFilename: "",
    caseName: safeCase,
    compatibilityMode: null,
    isNativeLiverProject: true,
  };
}
function makeOpenedProjectContext(filename: string, compatibilityMode: CompatibilityMode): LogProjectContext {
  const caseName = stripExt(filename);
  return {
    projectKey: `${compatibilityMode || "native"}:${filename.toLowerCase()}`,
    projectFilename: filename,
    caseName,
    compatibilityMode,
    isNativeLiverProject: compatibilityMode === null,
  };
}
function fileToDataURL(file: File): Promise<string> {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
}
function dataURLToImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = url; });
}
function makeThumb(img: HTMLImageElement, maxW: number) {
  const c = document.createElement("canvas");
  const s = Math.min(1, maxW / img.naturalWidth);
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}
function downloadBlob(blob: Blob, name: string) {
  const safeName = String(name).replace(/\.(json|txt)$/i, (m) => m);
  const file = new File([blob], safeName, { type: 'application/octet-stream' });

  // Legacy IE/Edge
  // @ts-ignore
  if (window.navigator && window.navigator.msSaveOrOpenBlob) {
    // @ts-ignore
    window.navigator.msSaveOrOpenBlob(file, safeName);
    return;
  }

  const ua = navigator.userAgent || '';
  const isIOS = /iP(ad|hone|od)/i.test(ua) ||
    ((navigator as any).platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);

  // iOS / iPadOS Safari path — data URL keeps the filename and avoids extra tabs
  if (isIOS) {
    const reader = new FileReader();
    reader.onload = () => {
      const a = document.createElement('a');
      a.download = safeName;
      a.href = String(reader.result);
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      try { a.click(); } catch {}
      setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 300);
    };
    reader.readAsDataURL(file);
    return;
  }

  // Modern browsers — single programmatic click only (no event duplication, no window.open fallback)
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.download = safeName;
  a.href = url;
  a.rel = 'noopener';
  a.style.position = 'fixed';
  a.style.left = '-9999px';
  document.body.appendChild(a);
  try { a.click(); } catch {}
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch {}
    try { document.body.removeChild(a); } catch {}
  }, 500);
}

// Station is a single enum value; no builder/parser needed.

/* -------------------- mask helpers -------------------- */
function ensureCanvasSize(l: LabelSpec, w: number, h: number) {
  if (!l.canvas) { l.canvas = document.createElement("canvas"); l.ctx = l.canvas.getContext("2d", { willReadFrequently: true })!; }
  if (l.canvas.width !== w || l.canvas.height !== h) {
    const old = l.ctx!.getImageData(0, 0, l.canvas.width || 0, l.canvas.height || 0);
    l.canvas.width = w; l.canvas.height = h;
    l.ctx = l.canvas.getContext("2d", { willReadFrequently: true })!;
    if (old) l.ctx.putImageData(old, 0, 0);
    l.rev = (l.rev || 0) + 1;
    if (l.cache) { l.cache.tint = undefined; l.cache.outline = undefined; }
  }
}
function tintedFromMask(mask: HTMLCanvasElement, color: string, alpha: number) {
  const w = mask.width, h = mask.height;
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return out;
}
function outlineFromMask(mask: HTMLCanvasElement, thickness = OUTLINE_THICKNESS) {
  const w = mask.width, h = mask.height;
  const src = mask.getContext("2d")!.getImageData(0, 0, w, h);
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const octx = out.getContext("2d")!;
  const dst = octx.createImageData(w, h);
  const sd = src.data, dd = dst.data;
  const r = Math.max(1, Math.round(thickness / 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 4;
    if (sd[p + 3] === 0) continue;
    let edge = false;
    for (let dy = -r; dy <= r && !edge; dy++) for (let dx = -r; dx <= r && !edge; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) { edge = true; break; }
      if (sd[(ny * w + nx) * 4 + 3] === 0) edge = true;
    }
    if (edge) dd[p] = dd[p + 1] = dd[p + 2] = 255, dd[p + 3] = 255;
  }
  octx.putImageData(dst, 0, 0);
  return out;
}
function fillHoles(label: LabelSpec) {
  const ctx = label.ctx!, w = ctx.canvas.width, h = ctx.canvas.height;
  const img = ctx.getImageData(0, 0, w, h); const data = img.data; const len = w * h;
  const alphaAt = (i: number) => data[i * 4 + 3];
  const setWhite = (i: number) => { const p = i * 4; data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 255; };
  const visited = new Uint8Array(len); const q = new Uint32Array(len); let qs = 0, qe = 0; const push = (i: number) => { visited[i] = 1; q[qe++] = i; };
  for (let x = 0; x < w; x++) { const t = x, b = (h - 1) * w + x; if (!alphaAt(t)) push(t); if (!alphaAt(b)) push(b); }
  for (let y = 0; y < h; y++) { const l = y * w, r = y * w + (w - 1); if (!alphaAt(l)) push(l); if (!alphaAt(r)) push(r); }
  const dirs = [-1, 1, -w, w];
  while (qs < qe) {
    const i = q[qs++]; const x = i % w, y = (i / w) | 0;
    for (const d of dirs) {
      const j = i + d; if (j < 0 || j >= len) continue;
      const jx = j % w, jy = (j / w) | 0;
      if (Math.abs(jx - x) + Math.abs(jy - y) !== 1) continue;
      if (visited[j]) continue;
      if (!alphaAt(j)) push(j);
    }
  }
  for (let i = 0; i < len; i++) if (!alphaAt(i) && !visited[i]) setWhite(i);
  ctx.putImageData(img, 0, 0);
}
function cleanMask(label: LabelSpec) {
  const ctx = label.ctx!, w = ctx.canvas.width, h = ctx.canvas.height;
  const src = ctx.getImageData(0, 0, w, h);
  const dil = ctx.createImageData(w, h); const erd = ctx.createImageData(w, h);
  const aS = src.data, aD = dil.data, aE = erd.data;
  const A = (x: number, y: number) => (x >= 0 && x < w && y >= 0 && y < h) ? aS[(y * w + x) * 4 + 3] > 0 : false;
  // dilate
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = false; for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) if (A(x + dx, y + dy)) on = true;
    if (on) { const p = (y * w + x) * 4; aD[p] = aD[p + 1] = aD[p + 2] = aD[p + 3] = 255; }
  }
  // erode
  const D = (x: number, y: number) => aD[(y * w + x) * 4 + 3] > 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let keep = true; for (let dy = -1; dy <= 1 && keep; dy++) for (let dx = -1; dx <= 1 && keep; dx++) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || nx >= w || ny < 0 || ny >= h || !D(nx, ny)) keep = false;
    }
    if (keep) { const p = (y * w + x) * 4; aE[p] = aE[p + 1] = aE[p + 2] = aE[p + 3] = 255; }
  }
  ctx.putImageData(erd, 0, 0);
  // spur trim
  const rounds = 6;
  for (let r = 0; r < rounds; r++) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data; let removed = 0;
    const deg = (x: number, y: number) => {
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (d[(ny * w + nx) * 4 + 3] > 0) c++;
      }
      return c;
    };
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = (y * w + x) * 4;
      if (d[p + 3] > 0 && deg(x, y) <= 1) { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; removed++; }
    }
    ctx.putImageData(img, 0, 0);
    if (!removed) break;
  }
}
function eraseConnectedComponent(label: LabelSpec, path: Pt[]) {
  const ctx = label.ctx!, w = ctx.canvas.width, h = ctx.canvas.height;
  if (!path.length) return;
  const img = ctx.getImageData(0, 0, w, h); const data = img.data;
  const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3];
  let sx = -1, sy = -1, best = Infinity;
  for (const pt of path) {
    const x = Math.max(0, Math.min(w - 1, Math.round(pt.x)));
    const y = Math.max(0, Math.min(h - 1, Math.round(pt.y)));
    const R = 4;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (alphaAt(nx, ny) > 0) { const d2 = dx * dx + dy * dy; if (d2 < best) { best = d2; sx = nx; sy = ny; } }
    }
  }
  if (sx < 0) return;
  const len = w * h; const vis = new Uint8Array(len); const q = new Uint32Array(len); let qs = 0, qe = 0; const push = (i: number) => { vis[i] = 1; q[qe++] = i; };
  push(sy * w + sx);
  const dirs = [-1, 1, -w, w];
  while (qs < qe) {
    const i = q[qs++], x = i % w, y = (i / w) | 0;
    for (const d of dirs) {
      const j = i + d; if (j < 0 || j >= len) continue;
      const jx = j % w, jy = (j / w) | 0;
      if (Math.abs(jx - x) + Math.abs(jy - y) !== 1) continue;
      if (vis[j]) continue;
      if (data[j * 4 + 3] > 0) { vis[j] = 1; q[qe++] = j; }
    }
  }
  for (let i = 0; i < len; i++) if (vis[i]) { const p = i * 4; data[p] = data[p + 1] = data[p + 2] = data[p + 3] = 0; }
  ctx.putImageData(img, 0, 0);
}

/* -------------------- App -------------------- */
export default function App({ hostedReview }: AppProps = {}) {
  const isHostedReview = Boolean(hostedReview);
  // global CSS
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      :root { --app-vh: 100dvh; }
      html, body, #root { height: ${isHostedReview ? "100%" : "calc(var(--app-vh, 100dvh))"}; width: 100%; }
      body { margin: 0; overflow: hidden; }
      * { box-sizing: border-box; }
      .no-text-select, .no-text-select *:not(input):not(textarea) {
        -webkit-user-select: none;
        user-select: none;
      }
    `;
    document.head.appendChild(style);
    // iPadOS/Viewport Height sync
    const setVH = () => {
      const vh = (window.visualViewport?.height || window.innerHeight) + 'px';
      document.documentElement.style.setProperty('--app-vh', vh);
    };
    setVH();
    // Fit layout to the exact initial viewport height
    setTimeout(() => { handleSizeChange(); }, 0);
    const onVV = () => { setVH(); handleSizeChange(); };
    window.addEventListener('resize', onVV);
    window.addEventListener('orientationchange', onVV);
    window.visualViewport?.addEventListener('resize', onVV);
    return () => {
      window.removeEventListener('resize', onVV);
      window.removeEventListener('orientationchange', onVV);
      window.visualViewport?.removeEventListener('resize', onVV);
      document.head.removeChild(style);
    };
  }, [isHostedReview]);
  // Ref for project open input (for iPadOS file picker)
  const openProjectInputRef = useRef<HTMLInputElement>(null);

  const [theme, setTheme] = useState<ThemeKind>("dark");
  const C = theme === "dark"
    ? {
        bg: "#0d1520", bg2: "#1a2436", panel: "#1a2436", panel2: "#0d1520",
        text: "#e4e9f0", sub: "#5a7898", line: "#1e2d40", line2: "#0d1520",
        accent: "#0f9297", brand: "#0f9297", chipBg: "#0d1520",
        success: "#6dcea0", successBg: "#0e2d1f",
        warn: "#e8a838",   warnBg:    "#2d1e06",
        danger: "#f08090", dangerBg:  "#2d0e14",
      }
    : {
        bg: "#f1f3f5", bg2: "#ffffff", panel: "#ffffff", panel2: "#e9ecef",
        text: "#212529", sub: "#868e96", line: "#e9ecef", line2: "#dee2e6",
        accent: "#0d7377", brand: "#0d7377", chipBg: "#ffffff",
        success: "#2b8a3e", successBg: "#d3f9d8",
        warn: "#e67700",   warnBg:    "#fff3bf",
        danger: "#c92a2a", dangerBg:  "#ffe0e0",
      };

  const [project, setProject] = useState<{ images: ImageItem[]; current: number; opened: boolean }>({ images: [], current: 0, opened: false });
  const [projectName, setProjectName] = useState<string>("project");
  const [compatibilityMode, setCompatibilityMode] = useState<CompatibilityMode>(null);
  const [showCompatibilityBanner, setShowCompatibilityBanner] = useState<boolean>(false);
  const [isPhone, setIsPhone] = useState<boolean>(false);
  const [hostedSubmitBusy, setHostedSubmitBusy] = useState<boolean>(false);
  const projectRef = useRef(project);
  const projectNameRef = useRef(projectName);
  const compatibilityModeRef = useRef<CompatibilityMode>(compatibilityMode);
  const currentLogProjectRef = useRef<LogProjectContext | null>(null);
  const sessionIdRef = useRef<string>(uid());
  const sessionStartedAtRef = useRef<number>(Date.now());
  const sessionEndedRef = useRef<boolean>(false);
  const activeBurstRef = useRef<null | { projectKey: string; startedAt: number; lastActionAt: number }>(null);
  const hostedLoadKeyRef = useRef<string | null>(null);
  // useAbbrev state removed
  useEffect(() => {
    const check = () => {
      const vw = window.visualViewport?.width || window.innerWidth;
      setIsPhone(vw <= 900);
    };
    check();
    window.addEventListener('resize', check);
    window.visualViewport?.addEventListener('resize', check);
    return () => {
      window.removeEventListener('resize', check);
      window.visualViewport?.removeEventListener('resize', check);
    };
  }, []);
  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { projectNameRef.current = projectName; }, [projectName]);
  useEffect(() => { compatibilityModeRef.current = compatibilityMode; }, [compatibilityMode]);

  function blankAnnotationLog(installationId?: string): AnnotationLogStore {
    const now = isoAt(Date.now());
    return {
      schemaVersion: 1,
      app: "AnnotateERCP",
      installationId: installationId || uid(),
      createdAt: now,
      updatedAt: now,
      sessions: [],
      projects: [],
      events: [],
    };
  }
  function readAnnotationLog(): AnnotationLogStore {
    try {
      const raw = window.localStorage.getItem(ANNOTATION_LOG_STORAGE_KEY);
      if (!raw) return blankAnnotationLog();
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schemaVersion === 1 && parsed.app === "AnnotateERCP" && typeof parsed.installationId === "string") {
        return {
          schemaVersion: 1,
          app: "AnnotateERCP",
          installationId: parsed.installationId,
          createdAt: String(parsed.createdAt || isoAt(Date.now())),
          updatedAt: String(parsed.updatedAt || isoAt(Date.now())),
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          events: Array.isArray(parsed.events) ? parsed.events : [],
        };
      }
    } catch (err) {
      console.warn("Annotation log unavailable; starting a fresh local log.", err);
    }
    return blankAnnotationLog();
  }
  function writeAnnotationLog(log: AnnotationLogStore) {
    try {
      log.updatedAt = isoAt(Date.now());
      window.localStorage.setItem(ANNOTATION_LOG_STORAGE_KEY, JSON.stringify(log));
    } catch (err) {
      console.warn("Failed to persist annotation log.", err);
    }
  }
  function updateAnnotationLog(mutator: (log: AnnotationLogStore) => void) {
    const log = readAnnotationLog();
    mutator(log);
    writeAnnotationLog(log);
  }
  function exportAnnotationLog() {
    finalizeActiveBurst(Date.now());
    const log = readAnnotationLog();
    const dateStamp = isoAt(Date.now()).slice(0, 10);
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    downloadBlob(blob, `annotation_log_${dateStamp}.json`);
  }
  function clearAnnotationLog() {
    const confirmed = window.confirm(
      "Clear the local annotation activity log stored in this browser? This only resets annotation log history. It does not change projects, masks, exports, or app settings."
    );
    if (!confirmed) return;
    const now = Date.now();
    const previous = readAnnotationLog();
    const fresh = blankAnnotationLog(previous.installationId);
    fresh.sessions.push({
      sessionId: sessionIdRef.current,
      startedAt: isoAt(now),
      endedAt: null,
      activeAnnotationMs: 0,
      eventCount: 1,
    });
    fresh.events.push({
      ts: isoAt(now),
      type: "session_start",
      installationId: fresh.installationId,
      sessionId: sessionIdRef.current,
    });
    writeAnnotationLog(fresh);
    activeBurstRef.current = null;
    alert("Local annotation log cleared.");
  }
  function ensureSessionSummary(log: AnnotationLogStore) {
    let session = log.sessions.find(s => s.sessionId === sessionIdRef.current);
    if (!session) {
      session = {
        sessionId: sessionIdRef.current,
        startedAt: isoAt(sessionStartedAtRef.current),
        endedAt: null,
        activeAnnotationMs: 0,
        eventCount: 0,
      };
      log.sessions.push(session);
    }
    return session;
  }
  function ensureProjectSummary(log: AnnotationLogStore, ctx: LogProjectContext) {
    let projectLog = log.projects.find(p => p.projectKey === ctx.projectKey);
    if (!projectLog) {
      projectLog = {
        projectKey: ctx.projectKey,
        projectFilename: ctx.projectFilename,
        caseName: ctx.caseName,
        compatibilityMode: ctx.compatibilityMode,
        isNativeLiverProject: ctx.isNativeLiverProject,
        firstOpenTime: null,
        lastOpenTime: null,
        lastEditTime: null,
        lastSaveTime: null,
        lastExportTime: null,
        frameCount: 0,
        stationsUsed: [],
        labelsUsed: [],
        totalActiveAnnotationMs: 0,
        saveCount: 0,
        exportCount: 0,
        sessions: [],
      };
      log.projects.push(projectLog);
    } else {
      projectLog.projectFilename = ctx.projectFilename;
      projectLog.caseName = ctx.caseName;
      projectLog.compatibilityMode = ctx.compatibilityMode;
      projectLog.isNativeLiverProject = ctx.isNativeLiverProject;
    }
    return projectLog;
  }
  function ensureProjectSession(projectLog: AnnotationProjectLog) {
    let session = projectLog.sessions.find(s => s.sessionId === sessionIdRef.current);
    if (!session) {
      session = {
        sessionId: sessionIdRef.current,
        startedAt: isoAt(sessionStartedAtRef.current),
        endedAt: null,
        activeAnnotationMs: 0,
        eventCount: 0,
      };
      projectLog.sessions.push(session);
    }
    return session;
  }
  function getOrCreateWorkingProjectContext() {
    if (currentLogProjectRef.current) return currentLogProjectRef.current;
    const ctx = makeWorkingProjectContext(projectNameRef.current || "project");
    currentLogProjectRef.current = ctx;
    return ctx;
  }
  function promoteProjectContext(next: LogProjectContext) {
    const prev = currentLogProjectRef.current;
    currentLogProjectRef.current = next;
    if (!prev || prev.projectKey === next.projectKey) return next;
    updateAnnotationLog(log => {
      const prevProject = log.projects.find(p => p.projectKey === prev.projectKey);
      const nextProject = log.projects.find(p => p.projectKey === next.projectKey);
      if (!prevProject && !nextProject) return;
      if (prevProject && !nextProject) {
        prevProject.projectKey = next.projectKey;
        prevProject.projectFilename = next.projectFilename;
        prevProject.caseName = next.caseName;
        prevProject.compatibilityMode = next.compatibilityMode;
        prevProject.isNativeLiverProject = next.isNativeLiverProject;
        return;
      }
      if (!prevProject || !nextProject) return;
      nextProject.firstOpenTime = prevProject.firstOpenTime && nextProject.firstOpenTime
        ? (prevProject.firstOpenTime < nextProject.firstOpenTime ? prevProject.firstOpenTime : nextProject.firstOpenTime)
        : (prevProject.firstOpenTime || nextProject.firstOpenTime);
      nextProject.lastOpenTime = prevProject.lastOpenTime || nextProject.lastOpenTime;
      nextProject.lastEditTime = prevProject.lastEditTime || nextProject.lastEditTime;
      nextProject.lastSaveTime = prevProject.lastSaveTime || nextProject.lastSaveTime;
      nextProject.lastExportTime = prevProject.lastExportTime || nextProject.lastExportTime;
      nextProject.frameCount = Math.max(nextProject.frameCount, prevProject.frameCount);
      nextProject.stationsUsed = uniqSorted([...nextProject.stationsUsed, ...prevProject.stationsUsed]);
      nextProject.labelsUsed = mergeLoggedLabels(nextProject.labelsUsed, prevProject.labelsUsed);
      nextProject.totalActiveAnnotationMs += prevProject.totalActiveAnnotationMs;
      nextProject.saveCount += prevProject.saveCount;
      nextProject.exportCount += prevProject.exportCount;
      for (const prevSession of prevProject.sessions) {
        const hit = nextProject.sessions.find(s => s.sessionId === prevSession.sessionId);
        if (!hit) nextProject.sessions.push(prevSession);
        else {
          hit.activeAnnotationMs += prevSession.activeAnnotationMs;
          hit.eventCount += prevSession.eventCount;
          hit.startedAt = prevSession.startedAt < hit.startedAt ? prevSession.startedAt : hit.startedAt;
          hit.endedAt = hit.endedAt || prevSession.endedAt;
        }
      }
      log.projects = log.projects.filter(p => p.projectKey !== prev.projectKey);
    });
    return next;
  }
  function finalizeActiveBurst(nowMs = Date.now()) {
    const burst = activeBurstRef.current;
    if (!burst) return;
    const endMs = Math.min(burst.lastActionAt + ANNOTATION_ACTIVE_IDLE_MS, nowMs);
    activeBurstRef.current = null;
    if (endMs <= burst.startedAt) return;
    const delta = endMs - burst.startedAt;
    updateAnnotationLog(log => {
      const session = ensureSessionSummary(log);
      session.activeAnnotationMs += delta;
      const projectLog = log.projects.find(p => p.projectKey === burst.projectKey);
      if (!projectLog) return;
      projectLog.totalActiveAnnotationMs += delta;
      ensureProjectSession(projectLog).activeAnnotationMs += delta;
    });
  }
  function noteQualifyingActivity(ctx: LogProjectContext, nowMs = Date.now()) {
    if (document.visibilityState === "hidden") return;
    const burst = activeBurstRef.current;
    if (!burst) {
      activeBurstRef.current = { projectKey: ctx.projectKey, startedAt: nowMs, lastActionAt: nowMs };
      return;
    }
    const timedOut = nowMs - burst.lastActionAt > ANNOTATION_ACTIVE_IDLE_MS;
    if (timedOut || burst.projectKey !== ctx.projectKey) {
      finalizeActiveBurst(nowMs);
      activeBurstRef.current = { projectKey: ctx.projectKey, startedAt: nowMs, lastActionAt: nowMs };
      return;
    }
    burst.lastActionAt = nowMs;
  }
  function recordAnnotationEvent(event: AnnotationLogEvent, ctx?: LogProjectContext, projectPatch?: Partial<Pick<AnnotationProjectLog, "frameCount" | "stationsUsed" | "labelsUsed" | "firstOpenTime" | "lastOpenTime" | "lastEditTime" | "lastSaveTime" | "lastExportTime" | "saveCount" | "exportCount">>) {
    updateAnnotationLog(log => {
      const session = ensureSessionSummary(log);
      session.eventCount += 1;
      log.events.push(event);
      if (!ctx) return;
      const projectLog = ensureProjectSummary(log, ctx);
      const projectSession = ensureProjectSession(projectLog);
      projectSession.eventCount += 1;
      if (projectPatch?.frameCount !== undefined) projectLog.frameCount = projectPatch.frameCount;
      if (projectPatch?.stationsUsed) projectLog.stationsUsed = projectPatch.stationsUsed;
      if (projectPatch?.labelsUsed) projectLog.labelsUsed = mergeLoggedLabels(projectLog.labelsUsed, projectPatch.labelsUsed);
      if (projectPatch?.firstOpenTime !== undefined) projectLog.firstOpenTime = projectPatch.firstOpenTime;
      if (projectPatch?.lastOpenTime !== undefined) projectLog.lastOpenTime = projectPatch.lastOpenTime;
      if (projectPatch?.lastEditTime !== undefined) projectLog.lastEditTime = projectPatch.lastEditTime;
      if (projectPatch?.lastSaveTime !== undefined) projectLog.lastSaveTime = projectPatch.lastSaveTime;
      if (projectPatch?.lastExportTime !== undefined) projectLog.lastExportTime = projectPatch.lastExportTime;
      if (projectPatch?.saveCount !== undefined) projectLog.saveCount = projectPatch.saveCount;
      if (projectPatch?.exportCount !== undefined) projectLog.exportCount = projectPatch.exportCount;
    });
  }
  function logProjectOpen(filename: string, mode: CompatibilityMode, images: ImageItem[]) {
    const nowMs = Date.now();
    const ctx = promoteProjectContext(makeOpenedProjectContext(filename, mode));
    const stationsUsed = stationsFromImages(images);
    const labelsUsed = collectUsedLabels(images);
    const currentLog = readAnnotationLog();
    const prior = currentLog.projects.find(p => p.projectKey === ctx.projectKey);
    recordAnnotationEvent({
      ts: isoAt(nowMs),
      type: "project_open",
      installationId: currentLog.installationId,
      sessionId: sessionIdRef.current,
      projectKey: ctx.projectKey,
      projectFilename: ctx.projectFilename,
      caseName: ctx.caseName,
      compatibilityMode: ctx.compatibilityMode,
      isNativeLiverProject: ctx.isNativeLiverProject,
      frameCount: images.length,
      stationsUsed,
      labelsUsed,
      source: "file-picker",
    }, ctx, {
      frameCount: images.length,
      stationsUsed,
      labelsUsed,
      firstOpenTime: prior?.firstOpenTime || isoAt(nowMs),
      lastOpenTime: isoAt(nowMs),
    });
  }
  function logEditCommit(details: { label?: LabelSpec; frame?: ImageItem; station?: "TG" | "TD" | ""; tool: ToolType | "undo" | "redo" | "station"; action: "mask_edit" | "undo" | "redo" | "station_change"; imagesOverride?: ImageItem[]; }) {
    const nowMs = Date.now();
    const ctx = getOrCreateWorkingProjectContext();
    const images = details.imagesOverride || projectRef.current.images;
    const stationsUsed = stationsFromImages(images);
    const labelsUsed = details.label ? [{ id: details.label.id, name: details.label.name }] : [];
    recordAnnotationEvent({
      ts: isoAt(nowMs),
      type: "edit_commit",
      installationId: readAnnotationLog().installationId,
      sessionId: sessionIdRef.current,
      projectKey: ctx.projectKey,
      projectFilename: ctx.projectFilename,
      caseName: ctx.caseName,
      compatibilityMode: ctx.compatibilityMode,
      isNativeLiverProject: ctx.isNativeLiverProject,
      frameCount: images.length,
      stationsUsed,
      labelsUsed,
      frameId: details.frame?.id,
      frameName: details.frame?.name,
      station: details.station ?? details.frame?.station ?? "",
      labelId: details.label?.id,
      labelName: details.label?.name,
      tool: details.tool,
      action: details.action,
    }, ctx, {
      frameCount: images.length,
      stationsUsed,
      labelsUsed,
      lastEditTime: isoAt(nowMs),
    });
    noteQualifyingActivity(ctx, nowMs);
  }
  function logSaveProject(savedFilename: string) {
    const nowMs = Date.now();
    const ctx = promoteProjectContext({
      projectKey: `${compatibilityModeRef.current || "native"}:${savedFilename.toLowerCase()}`,
      projectFilename: savedFilename,
      caseName: stripExt(savedFilename),
      compatibilityMode: compatibilityModeRef.current,
      isNativeLiverProject: compatibilityModeRef.current === null,
    });
    const currentLog = readAnnotationLog();
    const prior = currentLog.projects.find(p => p.projectKey === ctx.projectKey);
    recordAnnotationEvent({
      ts: isoAt(nowMs),
      type: "save_project",
      installationId: currentLog.installationId,
      sessionId: sessionIdRef.current,
      projectKey: ctx.projectKey,
      projectFilename: ctx.projectFilename,
      caseName: ctx.caseName,
      compatibilityMode: ctx.compatibilityMode,
      isNativeLiverProject: ctx.isNativeLiverProject,
      frameCount: projectRef.current.images.length,
      stationsUsed: stationsFromImages(projectRef.current.images),
    }, ctx, {
      frameCount: projectRef.current.images.length,
      stationsUsed: stationsFromImages(projectRef.current.images),
      lastSaveTime: isoAt(nowMs),
      saveCount: (prior?.saveCount || 0) + 1,
    });
  }
  function logExportNRRD(scope: "current" | "selected" | "all", imageCount: number, exportedCount: number) {
    const nowMs = Date.now();
    const ctx = getOrCreateWorkingProjectContext();
    const currentLog = readAnnotationLog();
    const prior = currentLog.projects.find(p => p.projectKey === ctx.projectKey);
    recordAnnotationEvent({
      ts: isoAt(nowMs),
      type: "export_nrrd",
      installationId: currentLog.installationId,
      sessionId: sessionIdRef.current,
      projectKey: ctx.projectKey,
      projectFilename: ctx.projectFilename,
      caseName: ctx.caseName,
      compatibilityMode: ctx.compatibilityMode,
      isNativeLiverProject: ctx.isNativeLiverProject,
      frameCount: projectRef.current.images.length,
      stationsUsed: stationsFromImages(projectRef.current.images),
      imageCount,
      exportedCount,
      exportScope: scope,
    }, ctx, {
      frameCount: projectRef.current.images.length,
      stationsUsed: stationsFromImages(projectRef.current.images),
      lastExportTime: isoAt(nowMs),
      exportCount: (prior?.exportCount || 0) + 1,
    });
  }
  useEffect(() => {
    const log = readAnnotationLog();
    recordAnnotationEvent({
      ts: isoAt(sessionStartedAtRef.current),
      type: "session_start",
      installationId: log.installationId,
      sessionId: sessionIdRef.current,
    });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") finalizeActiveBurst(Date.now());
    };
    const endSession = () => {
      if (sessionEndedRef.current) return;
      sessionEndedRef.current = true;
      const nowMs = Date.now();
      finalizeActiveBurst(nowMs);
      updateAnnotationLog(store => {
        const session = ensureSessionSummary(store);
        session.endedAt = session.endedAt || isoAt(nowMs);
        store.events.push({
          ts: isoAt(nowMs),
          type: "session_end",
          installationId: store.installationId,
          sessionId: sessionIdRef.current,
        });
        session.eventCount += 1;
        for (const projectLog of store.projects) {
          const projectSession = projectLog.sessions.find(s => s.sessionId === sessionIdRef.current);
          if (projectSession && !projectSession.endedAt) projectSession.endedAt = isoAt(nowMs);
        }
      });
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", endSession);
    window.addEventListener("beforeunload", endSession);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", endSession);
      window.removeEventListener("beforeunload", endSession);
      endSession();
    };
  }, []);
  const current = project.images[project.current] || null;

  const [activeId, setActiveId] = useState<number>(1);
  const [tool, setTool] = useState<ToolType>("pen");

  // Eraser sub-mode — persists the last chosen eraser type across tool switches
  const [eraserMode, setEraserMode] = useState<"circle-eraser" | "stroke-eraser" | "global-eraser">("circle-eraser");
  // Eraser hover flyout
  const [showEraserMenu, setShowEraserMenu] = useState(false);
  const eraserMenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function openEraserMenu() {
    if (eraserMenuCloseTimer.current) { clearTimeout(eraserMenuCloseTimer.current); eraserMenuCloseTimer.current = null; }
    setShowEraserMenu(true);
  }
  function scheduleCloseEraserMenu() {
    eraserMenuCloseTimer.current = setTimeout(() => setShowEraserMenu(false), 120);
  }
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const copyMenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function openCopyMenu() {
    if (copyMenuCloseTimer.current) { clearTimeout(copyMenuCloseTimer.current); copyMenuCloseTimer.current = null; }
    setShowCopyMenu(true);
  }
  function scheduleCloseCopyMenu() {
    copyMenuCloseTimer.current = setTimeout(() => setShowCopyMenu(false), 120);
  }
  // Draggable tool sidebar
  const [sidebarPos, setSidebarPos] = useState<{ x: number; y: number }>({ x: 0, y: 50 });
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarDragRef = useRef<{ ox: number; oy: number; mx: number; my: number } | null>(null);
  // Select tool — which mask is currently selected (by label id)
  const [selectedMaskId, setSelectedMaskId] = useState<number | null>(null);
  // Selected polygon-geom AnnotationInstance (set by the select tool).
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const selectedInstanceIdRef = useRef<string | null>(null);
  selectedInstanceIdRef.current = selectedInstanceId;
  // Active vertex drag — captures pre-drag annotations[] for undo on commit.
  const vertexDragRef = useRef<{
    instanceId: string;
    vertexIdx: number;
    beforeAnnotations: AnnotationInstance[];
  } | null>(null);
  // Hovered vertex (for highlight). Image-space hit-tested on every pointermove.
  const hoveredVertexRef = useRef<{ instanceId: string; vertexIdx: number } | null>(null);
  // Frame metadata panel visibility
  const [showFrameMetadata, setShowFrameMetadata] = useState<boolean>(false);
  // Progress sidebar visibility
  const [showProgress, setShowProgress] = useState<boolean>(false);
  // Keypoint tool state
  const [keypointPlacingAt, setKeypointPlacingAt] = useState<Pt | null>(null);
  const [selectedKeypointId, setSelectedKeypointId] = useState<string | null>(null);
  const selectedKeypointIdRef = useRef<string | null>(null);
  selectedKeypointIdRef.current = selectedKeypointId;
  const hoveredKeypointIdRef = useRef<string | null>(null);
  const keypointDragRef = useRef<{ keypointId: string; beforeKeypoints: KeypointInstance[] } | null>(null);
  // Select tool drag: start image-coordinate point
  const selectDragStartRef = useRef<Pt | null>(null);

  const [hasUnsaved, setHasUnsaved] = useState(false);
  const [autoSaveTime] = useState<Date | null>(null);
  const [autoSaveStatus] = useState<"idle" | "saving" | "error">("idle");
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  projectRef.current = project;
  projectNameRef.current = projectName;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>("");

  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showLabelPicker, setShowLabelPicker] = useState<boolean>(false);
  const [showFillActionInCards, setShowFillActionInCards] = useState<boolean>(false);
  const [showFillToggles, setShowFillToggles] = useState<boolean>(false); // hidden by default

  // selection in sidebar
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedIndex = useRef<number | null>(null);

  // resizers
  const [leftWidth, setLeftWidth] = useState<number>(300);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const currentLeftW = leftCollapsed ? 56 : leftWidth;

  // Toolbar compact mode (icon-only)
  const [toolbarCompact, setToolbarCompact] = useState<boolean>(false);
  // We only compact if the *full-text* toolbar would exceed 2 rows.
  const TOOLBAR_ICONIFY_AT_ROWS = 3;   // i.e., >= 3 rows of full-text = compact
  const TOOLBAR_DEICONIFY_AT_ROWS = 2; // return to text when full-text fits within 2 rows

  // --- Deterministic full-text toolbar width estimator (no DOM toggling) ---
  // We measure text using a canvas and account for paddings/gaps used by our button styles.
  const TOOL_FONT = '600 12px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  function measureBtn(label: string) {
    const c = document.createElement('canvas');
    const x = c.getContext('2d')!;
    x.font = TOOL_FONT;
    const textW = Math.ceil(x.measureText(label).width);
    // Base paddings + icon room + border
    // (These match the button style: padding 6-10px left/right + ~16px icon + 6px gap + borders)
    const PAD = 10 + 10;
    const ICON = 16;
    const GAP = 6;
    const BORDER = 2; // left+right border
    return textW + PAD + ICON + GAP + BORDER;
  }
  // Static widths for icon-only buttons (Zoom controls) — in full-text mode they still render icon-only.
  function fixedBtn(width: number) { return width; }

  // Safe estimator for fill toggle state for estimator (no dependency on later allFillsOn)
  const _allFillsOnForEstimator = () => {
    const cur = project.images[project.current];
    if (!cur) return true;
    return cur.labels.every(l => l.displayFill);
  };

  function estimateFullTextRows(containerW: number) {
    if (!containerW || !isFinite(containerW)) return 1;
    // Build the button sequence as it appears, using worst-case text where it varies.
    const buttons: number[] = [];
    // Global visibility: show either " Visible" or " Hidden" text; use worst case length.
    buttons.push(measureBtn(' Visible'));
    // Pen / Erasers / Fill
    buttons.push(measureBtn(' Pen'));
    buttons.push(measureBtn(' Circle Eraser'));
    buttons.push(measureBtn(' Stroke Eraser'));
    buttons.push(measureBtn(_allFillsOnForEstimator() ? ' Fill: On' : ' Fill: Off'));
    // Undo / Redo
    buttons.push(measureBtn(' Undo'));
    buttons.push(measureBtn(' Redo'));
    // Spacer occupies flexible space — ignore for wrapping calc.
    // Zoom: icon-only controls; approximate fixed button widths (icon + padding + border)
    const ICON_BTN_W = 32 + 12 + 2; // icon 16-24 + ~12 padding + borders
    buttons.push(fixedBtn(ICON_BTN_W)); // Zoom out
    buttons.push(fixedBtn(ICON_BTN_W)); // Zoom in
    buttons.push(fixedBtn(ICON_BTN_W)); // Reset
    // Settings
    buttons.push(measureBtn(' Settings'));

    let rows = 1;
    let line = 0;
    for (const w of buttons) {
      if (line === 0 ? w <= containerW : w + 8 /* inter-button gap */ <= containerW - 0) {
        // fits current row
        if (line + w + 8 <= containerW) {
          line = line + (line ? 8 : 0) + w; // add inter-button gap except before first
        } else {
          // next row
          rows++;
          line = w;
        }
      } else {
        rows++;
        line = w;
      }
    }
    return Math.max(1, rows);
  }
  const labelDisplayOrder = compatibilityMode ? [1] : DISPLAY_ORDER;
  // --- Labels layout (re-implemented for stability: no flicker, no stuck rows) ---
  const N_LABELS = labelDisplayOrder.length;
  const HYSTERESIS_PX = 64;          // wide band to prevent flip-flopping
  const GAP_FULL = 10;


  // Uniform fixed button widths (computed from text measure below)
  const [FULL_CARD_W, setFULL_CARD_W] = useState<number>(184);
  const [ABBR_CARD_W, setABBR_CARD_W] = useState<number>(76);

  // Current layout mode
  const [layoutMode, setLayoutMode] = useState<'full' | 'abbr'>('full');

  // Measure text to compute minimal fixed card widths
  function measureTextW(txt: string, font: string) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = font;
    return Math.ceil(ctx.measureText(txt).width);
  }
  useEffect(() => {
    const calc = () => {
      const fontFull = '700 13px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      const fontAbbr = '700 11px Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
      const textFull = Math.max(...TIER2A_LABELS.map(l => measureTextW(l.name, fontFull)));
      const textAbbr = Math.max(...TIER2A_LABELS.map(l => measureTextW(l.abbr, fontAbbr)));
      const dotFull = 12, dotAbbr = 9;    // colored dot (slightly larger)
      const eyeFull = 36, eyeAbbr = 26;   // eye button compact width (slightly larger)
      const padFull = 8 + 8;              // horizontal paddings
      const padAbbr = 6 + 6;
      const gapFull = 6;                  // tiny space between pieces
      const gapAbbr = 4;
      // Minimal uniform widths with a couple of extra pixels for borders
      setFULL_CARD_W(Math.max(164, dotFull + gapFull + textFull + gapFull + eyeFull + padFull + 4));
      setABBR_CARD_W(Math.max(60, dotAbbr + gapAbbr + textAbbr + gapAbbr + eyeAbbr + padAbbr + 4));
    };
    if ((document as any).fonts?.ready) { (document as any).fonts.ready.then(calc); } else { setTimeout(calc, 0); }
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, []);
  // Dynamic toolbar height
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarH, setToolbarH] = useState<number>(42);
  const resizingH = useRef<null | { startX: number; startW: number }>(null);
  // Ref for bottom labels pane (for responsive measurement)
  const bottomPaneRef = useRef<HTMLDivElement>(null);
  // Ref for labels grid container
  const labelsGridRef = useRef<HTMLDivElement>(null);
  // Measure actual grid rows to avoid math mismatch on Safari/iPad
  function getGridActualRows(): number {
    const grid = labelsGridRef.current as HTMLDivElement | null;
    if (!grid) return 1;
    const children = Array.from(grid.children) as HTMLElement[];
    let rows = 0;
    let lastTop = -1;
    for (const el of children) {
      const t = el.offsetTop;
      if (t !== lastTop) { rows++; lastTop = t; }
    }
    return Math.max(1, rows);
  }

  // Decide compact mode using deterministic full-text estimator (no DOM toggling)
  function updateToolbarCompact() {
    const el = toolbarRef.current as HTMLDivElement | null;
    if (!el) return;
    // Use the *container* width of the toolbar to estimate rows in FULL-TEXT mode.
    const containerW = el.clientWidth || el.getBoundingClientRect().width || 0;

    // Estimate how many rows the toolbar would need *if* we showed full text.
    const estRows = estimateFullTextRows(containerW);

    setToolbarCompact(prev => {
      if (prev) {
        // In compact mode, expand back to text when full-text would fit within 2 rows.
        return estRows > TOOLBAR_DEICONIFY_AT_ROWS;
      } else {
        // In text mode, only compact when full-text would require 3+ rows.
        return estRows >= TOOLBAR_ICONIFY_AT_ROWS;
      }
    });
  }

  // Decide whether we should be in 'full' or 'abbr' mode.
  function decideLayoutFromContainer() {
    const containerW = bottomPaneRef.current?.clientWidth || rightPaneRef.current?.clientWidth || 0;
    if (!containerW) return;

    const colsFull = Math.max(1, Math.floor((containerW + GAP_FULL) / (FULL_CARD_W + GAP_FULL)));
    const rowsFull = Math.ceil(N_LABELS / colsFull);

    const rowsNow = getGridActualRows();

    let nextMode: 'full' | 'abbr' = layoutMode;
    if (layoutMode === 'full') {
      // If the actual grid (or predicted full) exceeds two rows, drop to abbr.
      if (rowsNow > 2 || rowsFull > 2) nextMode = 'abbr';
    } else {
      // Only return to full when we have ample width (3+ full cards with hysteresis) and full would be ≤ 2 rows
      const needFull = FULL_CARD_W * 3 + GAP_FULL * 2 + HYSTERESIS_PX;
      if (containerW > needFull && rowsFull <= 2) nextMode = 'full';
    }
    if (nextMode !== layoutMode) setLayoutMode(nextMode);
  }
  // useAbbrevRef and effect removed

  // canvases & view transform
  const stageRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageAreaRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);

  // Fit + user zoom/pan
  const fitRef = useRef<{ baseScale: number; offX: number; offY: number }>({ baseScale: 1, offX: 0, offY: 0 });
  const zoomRef = useRef<number>(1);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 }); // in image pixels
  const stageMetricsRef = useRef<{ cssW: number; cssH: number; dpr: number }>({ cssW: 0, cssH: 0, dpr: 0 });
  const strokeTransformRef = useRef<StrokeTransform | null>(null);
  const activeStrokeLabelRef = useRef<LabelSpec | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewEnabledRef = useRef<boolean>(false);
  const previewStrokeColorRef = useRef<string>("#fff");
  const previewStrokeWidthRef = useRef<number>(OUTLINE_THICKNESS);
  const previewSegmentsRef = useRef<PreviewSegment[]>([]);
  const previewRafRef = useRef<number | null>(null);

  // redraw scheduler (coalesces multiple calls into one frame)
  const rafPendingRef = useRef(false);
  function scheduleRedraw() {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;
    requestAnimationFrame(() => { rafPendingRef.current = false; redrawToStage(); });
  }

  // drawing state
  const isDrawingRef = useRef(false);
  const lastPtRef = useRef<Pt | null>(null);
  const strokePathRef = useRef<Pt[]>([]);
  const strokeStartSnapshot = useRef<ImageData | null>(null);

  // polygon tool state
  const polygonPointsRef = useRef<Pt[]>([]);
  const polygonMousePtRef = useRef<Pt | null>(null);

  // global visibility
  const [allVisible, setAllVisible] = useState<boolean>(true);

  // labels
  function makeLabel(id: number, name: string, color: string): LabelSpec {
    return { id, name, color, visible: true, displayFill: true, rev: 0 };
  }
  function defaultLabels(): LabelSpec[] {
    return TIER2A_LABELS.map(l => makeLabel(l.id, l.name, l.color));
  }

  useEffect(() => {
    if (!hostedReview) return;
    const loadKey = `${hostedReview.manifest.caseId}:${hostedReview.manifest.assignmentId}`;
    if (hostedLoadKeyRef.current === loadKey) return;
    hostedLoadKeyRef.current = loadKey;

    let cancelled = false;
    void (async () => {
      const nextImages: ImageItem[] = [];
      const orderedFrames = [...hostedReview.manifest.frames].sort((a, b) => a.frameIndex - b.frameIndex);

      for (const frame of orderedFrames) {
        let w = frame.width;
        let h = frame.height;
        if (!w || !h) {
          const img = await dataURLToImage(frame.imageUrl);
          w = img.naturalWidth;
          h = img.naturalHeight;
        }
        const labels = defaultLabels();
        labels.forEach(label => ensureCanvasSize(label, w, h));
        const thumbURL = frame.imageUrl;
        nextImages.push({
          id: frame.frameId,
          name: stripExt(frame.sourceName),
          w,
          h,
          baseURL: frame.imageUrl,
          thumbURL,
          station: "",
          labels,
          history: [],
          redo: [],
          annotations: [],
          keypoints: [],
          metadata: makeDefaultFrameMetadata(),
        });
      }

      if (cancelled) return;
      setCompatibilityMode(null);
      setShowCompatibilityBanner(false);
      setProjectName(hostedReview.manifest.displayCaseId);
      setProject({ images: nextImages, current: 0, opened: true });
      setActiveId(1);
      setSelectedIds(new Set());
      resetView();
      scheduleRedraw();
    })();

    return () => {
      cancelled = true;
    };
  }, [hostedReview]);

  // import images
  async function onPickImages(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files; if (!files || !files.length) return;
    const newImages: ImageItem[] = [];
    for (const f of Array.from(files)) {
      const baseURL = await fileToDataURL(f);
      const img = await dataURLToImage(baseURL);
      const w = img.naturalWidth, h = img.naturalHeight;
      const labels = defaultLabels(); labels.forEach(l => ensureCanvasSize(l, w, h));
      const thumbURL = makeThumb(img, 120);
      const sourceTimestamp = extractSourceTimestamp(f.name);
      newImages.push({ id: uid(), name: stripExt(f.name), w, h, baseURL, thumbURL, labels, history: [], redo: [], station: "", sourceTimestamp, annotations: [], keypoints: [], metadata: makeDefaultFrameMetadata() });
    }
    setProject(prev => ({ images: [...prev.images, ...newImages], current: prev.images.length, opened: prev.opened }));
    setActiveId(1);
    setSelectedIds(new Set()); // clear multi-selection on add
    e.currentTarget.value = "";
  }
  function switchImage(idx: number) {
    if (idx < 0 || idx >= project.images.length) return;
    setProject(prev => ({ ...prev, current: idx }));
  }

  // load base image to offscreen canvas
  useEffect(() => {
    const imgItem = current; if (!imgItem) return;
    const img = new Image();
    img.onload = () => {
      const bc = baseCanvasRef.current!; bc.width = imgItem.w; bc.height = imgItem.h;
      const bctx = bc.getContext("2d")!;
      bctx.imageSmoothingEnabled = true;
      // @ts-ignore
      bctx.imageSmoothingQuality = "high";
      bctx.clearRect(0,0,bc.width,bc.height); bctx.drawImage(img,0,0,bc.width,bc.height);
      resetView();
      scheduleRedraw();
    };
    img.src = imgItem.baseURL;
    imgItem.labels.forEach(l => ensureCanvasSize(l, imgItem.w, imgItem.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.current, project.images.length]);

  // Reset view to fit image
  function computeContainFit(imgW: number, imgH: number, boxW: number, boxH: number) {
    const s = Math.min(boxW / imgW, boxH / imgH);
    const drawW = imgW * s, drawH = imgH * s;
    const offX = (boxW - drawW) / 2, offY = (boxH - drawH) / 2;
    return { baseScale: s, offX, offY };
  }
  function resetView() {
    if (!current || !canvasWrapRef.current) return;
    const boxW = canvasWrapRef.current.clientWidth;
    const boxH = canvasWrapRef.current.clientHeight; // already excludes toolbar
    const fit = computeContainFit(current.w, current.h, boxW, Math.max(1, boxH));
    fitRef.current = fit;
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
  }

  // Resize handling — observer + polling (keeps image perfectly aligned)
  const lastSize = useRef<{w: number; h: number}>({w: 0, h: 0});
  function handleSizeChange() {
    if (!canvasWrapRef.current || !current) {
      requestAnimationFrame(() => decideLayoutFromContainer());
      return;
    }
    const w = canvasWrapRef.current.clientWidth;
    const h = canvasWrapRef.current.clientHeight;
    const tH = Math.max(0, toolbarRef.current?.offsetHeight || 0);
    if (tH !== toolbarH) setToolbarH(tH);

    // Re-evaluate compact mode based on current layout.
    updateToolbarCompact();

    if (w !== lastSize.current.w || h !== lastSize.current.h) {
      lastSize.current = { w, h };
      resetView();
      scheduleRedraw();
    }
    // After layout settles, re-evaluate bottom pane layout
    requestAnimationFrame(() => decideLayoutFromContainer());
  }
  useLayoutEffect(() => {
    const el = canvasWrapRef.current;
    const rp = rightPaneRef.current;
    const ia = imageAreaRef.current;
    const tb = toolbarRef.current;
    const bp = bottomPaneRef.current;
    const lg = labelsGridRef.current;

    const RO = (window as any).ResizeObserver || (class { observe(){} disconnect(){} });
    const ro = new RO(() => handleSizeChange());
    el && ro.observe(el);
    rp && ro.observe(rp);
    ia && ro.observe(ia);
    tb && ro.observe(tb);
    bp && ro.observe(bp);
    lg && ro.observe(lg);

    // Observe toolbar for layout changes and update compact mode
    const roToolbar = new RO(() => updateToolbarCompact());
    tb && roToolbar.observe(tb);

    const onWin = () => handleSizeChange();
    window.addEventListener("resize", onWin);
    window.visualViewport?.addEventListener('resize', onWin);

    // periodic safety net for iOS Safari layout jitter
    const id = window.setInterval(handleSizeChange, 200);

    // initial decide
    requestAnimationFrame(() => decideLayoutFromContainer());
    requestAnimationFrame(() => updateToolbarCompact());

    return () => {
      ro.disconnect?.();
      roToolbar.disconnect?.();
      window.removeEventListener("resize", onWin);
      window.visualViewport?.removeEventListener('resize', onWin);
      window.clearInterval(id);
    };
  }, [FULL_CARD_W, ABBR_CARD_W, layoutMode]);
  useEffect(() => {
    updateToolbarCompact();
    // also re-check shortly after in case fonts load late
    const t = setTimeout(updateToolbarCompact, 80);
    return () => clearTimeout(t);
  }, [toolbarH, theme, isPhone]);

  // Initialize draggable sidebar to top-right of image area
  useEffect(() => {
    const ia = imageAreaRef.current;
    if (!ia) return;
    const { width } = ia.getBoundingClientRect();
    setSidebarPos({ x: Math.max(0, width - 52 - 8), y: 50 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    requestAnimationFrame(() => decideLayoutFromContainer());
  }, [leftWidth, project.current, project.images.length, theme, layoutMode]);

  useEffect(() => { const id = requestAnimationFrame(redrawToStage); return () => cancelAnimationFrame(id); },
    [current, tool, activeId, leftWidth, theme, showFillActionInCards, showFillToggles, allVisible, project.images.length, toolbarH]
  );

  // Warn before closing/refreshing with unsaved changes
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsaved) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsaved]);

  // Clear auto-save timer on unmount to avoid state updates on a detached component.
  useEffect(() => {
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, []);

  // Auto-save disabled — re-enable after memory profiling.
  // Infrastructure (IDB helpers, state vars) preserved for when we re-enable.
  function scheduleAutoSave() { /* no-op */ }

  // Auto-restore on first load from IndexedDB (no prompt needed)
  useEffect(() => {
    if (hostedReview) return; // don't clobber hosted review mode
    // Auto-save/restore disabled — re-enable after memory profiling.
    return;
    idbGet().then(async (data) => {
      if (!data) return;
      try {
        const parsed = JSON.parse(data);
        // v1/v2 saves embed full base image data URLs — restoring them causes OOM on large projects.
        // Discard old saves; only restore v3+ (masks-only format).
        if (!parsed.version || parsed.version < 3) {
          void idbDelete().catch(() => {});
          return;
        }
        const allImgs: ImageItem[] = [];
        let masksOnlyRestore = false;
        for (const im of parsed.images as any[]) {
          const w = im.w, h = im.h;
          // baseURL may be null in v3 auto-saves (masks-only format to avoid OOM).
          // In that case, create a gray placeholder canvas so masks are still visible.
          let baseURL: string;
          let thumbURL: string;
          if (im.baseURL) {
            const imgEl = await dataURLToImage(im.baseURL);
            baseURL = im.baseURL;
            thumbURL = makeThumb(imgEl, 120);
          } else {
            masksOnlyRestore = true;
            const ph = document.createElement("canvas"); ph.width = w; ph.height = h;
            const phCtx = ph.getContext("2d")!;
            phCtx.fillStyle = "#333333"; phCtx.fillRect(0, 0, w, h);
            phCtx.fillStyle = "#555555"; phCtx.font = `${Math.min(w, h) * 0.04}px monospace`;
            phCtx.textAlign = "center"; phCtx.fillText("Re-open project to restore image", w / 2, h / 2);
            baseURL = ph.toDataURL("image/png");
            thumbURL = ph.toDataURL("image/png");
          }
          const labels: LabelSpec[] = [];
          for (const L of im.labels) {
            const lab = makeLabel(L.id, L.name, L.color);
            ensureCanvasSize(lab, w, h);
            if (L.maskPNG) { const mimg = await dataURLToImage(L.maskPNG); lab.ctx!.drawImage(mimg, 0, 0); }
            lab.visible = L.visible; lab.displayFill = L.displayFill;
            lab.rev = (lab.rev || 0) + 1;
            labels.push(lab);
          }
          for (const def of TIER2A_LABELS) {
            if (labels.some(l => l.id === def.id)) continue;
            const lab = makeLabel(def.id, def.name, def.color);
            ensureCanvasSize(lab, w, h);
            labels.push(lab);
          }
          allImgs.push({ id: im.id || uid(), name: im.name, w, h, baseURL, thumbURL, labels, history: [], redo: [], station: im.station || "", sourceTimestamp: im.sourceTimestamp ?? null, annotations: [], keypoints: [], metadata: makeDefaultFrameMetadata() });
        }
        if (masksOnlyRestore) {
          console.warn("Auto-save restore: masks recovered but base images were not stored. Re-open the project file (.leus) to restore images.");
        }
        setProjectName(parsed._projectName || "recovered");
        setProject({ images: allImgs, current: 0, opened: true });
        setActiveId(1); setSelectedIds(new Set());
        setHasUnsaved(false); // restored from auto-save = already saved
        resetView(); scheduleRedraw();
      } catch {
        void idbDelete().catch(() => {}); // corrupted — clear it
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mapping helpers (screen <-> image)
  function currentTransforms() {
    const fit = fitRef.current;
    const zoom = zoomRef.current;
    const pan = panRef.current;
    return { scale: fit.baseScale * zoom, offX: fit.offX, offY: fit.offY, panX: pan.x, panY: pan.y };
  }
  function toImageCoordsWithTransform(clientX: number, clientY: number, tx: StrokeTransform): Pt | null {
    const xS = clientX - tx.left;
    const yS = clientY - tx.top;
    const x = (xS - tx.offX) / tx.scale - tx.panX;
    const y = (yS - tx.offY) / tx.scale - tx.panY;
    if (x < 0 || y < 0 || x >= tx.w || y >= tx.h) return null;
    return { x, y };
  }
  function toImageCoordsFromClient(clientX: number, clientY: number, rect: DOMRect): Pt | null {
    if (!current) return null;
    return toImageCoordsWithTransform(clientX, clientY, {
      left: rect.left,
      top: rect.top,
      ...currentTransforms(),
      w: current.w,
      h: current.h,
    });
  }
  function toImageCoords(evt: React.PointerEvent<HTMLCanvasElement>): Pt | null {
    const activeStrokeTransform = strokeTransformRef.current;
    if (isDrawingRef.current && activeStrokeTransform) return toImageCoordsWithTransform(evt.clientX, evt.clientY, activeStrokeTransform);
    const rect = (evt.target as HTMLCanvasElement).getBoundingClientRect();
    return toImageCoordsFromClient(evt.clientX, evt.clientY, rect);
  }
  function clearPreviewCanvas() {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }
  function flushPreviewSegments() {
    previewRafRef.current = null;
    if (!previewEnabledRef.current) {
      previewSegmentsRef.current.length = 0;
      clearPreviewCanvas();
      return;
    }
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const segments = previewSegmentsRef.current;
    if (!segments.length) return;
    const dpr = stageMetricsRef.current.dpr || window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = previewStrokeColorRef.current;
    ctx.lineWidth = previewStrokeWidthRef.current;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const seg of segments) {
      ctx.beginPath();
      ctx.moveTo(seg.x0, seg.y0);
      ctx.lineTo(seg.x1, seg.y1);
      ctx.stroke();
    }
    segments.length = 0;
  }
  function schedulePreviewFlush() {
    if (previewRafRef.current != null) return;
    previewRafRef.current = requestAnimationFrame(flushPreviewSegments);
  }
  function resetPreviewState() {
    if (previewRafRef.current != null) {
      cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
    previewSegmentsRef.current.length = 0;
    previewEnabledRef.current = false;
    clearPreviewCanvas();
  }
  function queuePreviewSegment(x0: number, y0: number, x1: number, y1: number) {
    if (!previewEnabledRef.current) return;
    previewSegmentsRef.current.push({ x0, y0, x1, y1 });
    schedulePreviewFlush();
  }

  // Caches for tinted fill and colored outline
  function getTintCanvas(l: LabelSpec): HTMLCanvasElement | null {
    if (!l.canvas) return null;
    const rev = l.rev || 0;
    if (!l.cache || l.cache.rev !== rev || l.cache.color !== l.color || !l.cache.tint) {
      l.cache = l.cache || { rev, color: l.color };
      l.cache.tint = tintedFromMask(l.canvas, l.color, FILL_ALPHA);
      l.cache.rev = rev; l.cache.color = l.color;
    }
    return l.cache.tint || null;
  }
  function getOutlineColored(l: LabelSpec): HTMLCanvasElement | null {
    if (!l.canvas) return null;
    const rev = l.rev || 0;
    if (!l.cache || l.cache.rev !== rev || l.cache.color !== l.color || !l.cache.outline) {
      // 1) compute hard outline
      const hard = outlineFromMask(l.canvas, OUTLINE_THICKNESS);
      // 2) soften edges slightly with a tiny blur, then tint
      const w = hard.width, h = hard.height;
      const soft = document.createElement("canvas"); soft.width = w; soft.height = h;
      const sctx = soft.getContext("2d")!;
      sctx.clearRect(0,0,w,h);
      // Apply a very small blur to knock down jaggies without looking fuzzy.
      // This only affects display; export uses the binary mask.
      // @ts-ignore
      sctx.filter = "blur(0.6px)";
      sctx.drawImage(hard, 0, 0);
      // reset filter
      // @ts-ignore
      sctx.filter = "none";
      const colored = tintedFromMask(soft, l.color, 1);
      l.cache = l.cache || { rev, color: l.color };
      l.cache.outline = colored;
      l.cache.rev = rev; l.cache.color = l.color;
    }
    return l.cache.outline || null;
  }

  // Stage redraw (HiDPI-aware)
  function redrawToStage() {
    if (!current || !canvasWrapRef.current) return;
    const area = canvasWrapRef.current; // the drawable region
    const stage = stageRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const cssW = area.clientWidth;
    const cssH = area.clientHeight;
    const stageMetrics = stageMetricsRef.current;
    if (stageMetrics.cssW !== cssW || stageMetrics.cssH !== cssH || stageMetrics.dpr !== dpr) {
      stage.style.width = `${cssW}px`;
      stage.style.height = `${cssH}px`;
      stage.width = Math.max(1, Math.floor(cssW * dpr));
      stage.height = Math.max(1, Math.floor(cssH * dpr));
      const preview = previewCanvasRef.current;
      if (preview) {
        preview.style.width = `${cssW}px`;
        preview.style.height = `${cssH}px`;
        preview.width = Math.max(1, Math.floor(cssW * dpr));
        preview.height = Math.max(1, Math.floor(cssH * dpr));
        clearPreviewCanvas();
      }
      stageMetricsRef.current = { cssW, cssH, dpr };
    }
    const ctx = stage.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.imageSmoothingEnabled = true;
    // @ts-ignore
    ctx.imageSmoothingQuality = "high";
    const { scale, offX, offY, panX, panY } = currentTransforms();
    // base image
    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    ctx.translate(panX, panY);
    ctx.drawImage(baseCanvasRef.current!, 0, 0, current.w, current.h);
    ctx.restore();
    // overlays (always composite in image space)
    const labelsOrdered = labelDisplayOrder.map(id => current.labels.find(l => l.id === id)!).filter(Boolean);
    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    ctx.translate(panX, panY);
    for (const l of labelsOrdered) {
      if (!l.canvas) continue;
      if (!(l.visible && allVisible)) continue;

      // LIVE draw while user is drawing on active label.
      if (isDrawingRef.current && l.id === activeId && tool !== "pen") {
        // Do NOT draw the fill for the active label while drawing.
        // This prevents the large colored overlay that obscures the image.
        const pts = strokePathRef.current;
        if (pts && pts.length > 1) {
          ctx.save();
          ctx.strokeStyle = l.color;
          ctx.lineWidth = OUTLINE_THICKNESS;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.stroke();
          ctx.restore();
        }
        // Keep the cached outline so existing edges remain visible.
        const cachedOutline = getOutlineColored(l);
        if (cachedOutline) ctx.drawImage(cachedOutline, 0, 0);
        continue;
      }

      // Normal cached rendering
      const tint = l.displayFill ? getTintCanvas(l) : null;
      const coloredOutline = getOutlineColored(l);
      if (tint) ctx.drawImage(tint, 0, 0);
      if (coloredOutline) ctx.drawImage(coloredOutline, 0, 0);
    }
    ctx.restore();

    // --- Polygon AnnotationInstance overlays (placed polygons) ---
    if (current.annotations.length > 0) {
      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      ctx.translate(panX, panY);
      const selId = selectedInstanceIdRef.current;
      const hv = hoveredVertexRef.current;
      for (const ann of current.annotations) {
        if (ann.geometry.kind !== "polygon") continue;
        const cls = ERCP_CLASS_BY_ID.get(ann.classId);
        if (!cls) continue;
        const pts = ann.geometry.points;
        if (pts.length < 3) continue;
        // Fill at 25% alpha
        ctx.fillStyle = hexWithAlpha(cls.color, 0.25);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
        // Stroke
        ctx.strokeStyle = cls.color;
        ctx.lineWidth = OUTLINE_THICKNESS / scale;
        ctx.stroke();
        // PAPILLA_ORIFICE: dashed white over the boundary for depth-discontinuity
        if (cls.exportAsDepthDiscontinuity) {
          ctx.save();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5 / scale;
          ctx.setLineDash([6 / scale, 4 / scale]);
          ctx.stroke();
          ctx.restore();
        }
        // Selection chrome: thick white outline + vertex handles
        if (selId === ann.id) {
          ctx.save();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5 / scale;
          ctx.stroke();
          // Vertex handles
          const handleR = 4 / scale;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const isHovered = hv && hv.instanceId === ann.id && hv.vertexIdx === i;
            ctx.fillStyle = isHovered ? "#ffeb3b" : "#ffffff";
            ctx.strokeStyle = cls.color;
            ctx.lineWidth = 1 / scale;
            ctx.beginPath();
            ctx.rect(p.x - handleR, p.y - handleR, handleR * 2, handleR * 2);
            ctx.fill();
            ctx.stroke();
          }
          ctx.restore();
        }
        // Class abbreviation chip at the polygon centroid (always visible,
        // size kept constant in screen-space by dividing by scale).
        const ctr = polygonCentroid(pts);
        ctx.save();
        ctx.font = `${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const text = cls.abbr;
        const padX = 4 / scale, padY = 2 / scale;
        const textW = ctx.measureText(text).width;
        const chipW = textW + padX * 2;
        const chipH = 14 / scale;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.strokeStyle = cls.color;
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.rect(ctr.x - chipW / 2, ctr.y - chipH / 2, chipW, chipH);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(text, ctr.x, ctr.y + padY * 0.25);
        ctx.restore();
      }
      ctx.restore();
    }

    // --- KeypointInstance overlays (named landmarks) ---
    if (current.keypoints.length > 0) {
      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      ctx.translate(panX, panY);
      const selKp = selectedKeypointIdRef.current;
      const hovKp = hoveredKeypointIdRef.current;
      const VIS_COLOR: Record<string, string> = {
        "visible": "#22c55e",
        "partially-occluded": "#eab308",
        "inferred": "#ef4444",
      };
      const armPx = 10 / scale;
      for (const k of current.keypoints) {
        const color = VIS_COLOR[k.visibility] || "#ffffff";
        const isSelected = selKp === k.id;
        const isHovered  = hovKp === k.id;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = (isSelected ? 2 : 1.5) / scale;
        ctx.lineCap = "round";
        // Crosshair
        ctx.beginPath();
        ctx.moveTo(k.x - armPx, k.y); ctx.lineTo(k.x + armPx, k.y);
        ctx.moveTo(k.x, k.y - armPx); ctx.lineTo(k.x, k.y + armPx);
        ctx.stroke();
        // Dot
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(k.x, k.y, 2.5 / scale, 0, Math.PI * 2);
        ctx.fill();
        // Selection ring
        if (isSelected || isHovered) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5 / scale;
          ctx.beginPath();
          ctx.arc(k.x, k.y, armPx + 2 / scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // --- Polygon tool live preview (drawn in image-space coordinates) ---
    if (tool === "polygon" && polygonPointsRef.current.length > 0) {
      const pts = polygonPointsRef.current;
      const mousePt = polygonMousePtRef.current;
      const labelColor = activeLabel()?.color ?? "#ffffff";
      const { scale, offX, offY, panX, panY } = currentTransforms();
      ctx.save();
      ctx.translate(offX, offY);
      ctx.scale(scale, scale);
      ctx.translate(panX, panY);
      // Dashed path between placed vertices + live segment to cursor
      ctx.strokeStyle = labelColor;
      ctx.lineWidth = OUTLINE_THICKNESS / scale;
      ctx.setLineDash([6 / scale, 3 / scale]);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (mousePt) ctx.lineTo(mousePt.x, mousePt.y);
      ctx.stroke();
      // Vertex dots
      ctx.setLineDash([]);
      ctx.fillStyle = labelColor;
      const dotR = 3 / scale;
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
      // Highlight first vertex to show close-polygon target when ≥ 3 pts placed
      if (pts.length >= 3) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1 / scale;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, dotR * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function activeLabel() { return current?.labels.find(l => l.id === activeId); }
  function isSegmentLabel(id: number) { return id >= 9 && id <= 16; }
  // Cached liver ImageData — only re-read when liver label revision changes
  const liverDataCacheRef = useRef<{ rev: number; data: ImageData } | null>(null);
  function clipToLiverMask(label: LabelSpec) {
    if (!current) return;
    const liver = current.labels.find(l => l.id === 1);
    if (!liver?.ctx || !label.ctx) return;
    const { w, h } = current;
    // Re-read liver only if it changed since last clip
    const liverRev = liver.rev ?? 0;
    if (!liverDataCacheRef.current || liverDataCacheRef.current.rev !== liverRev) {
      liverDataCacheRef.current = { rev: liverRev, data: liver.ctx.getImageData(0, 0, w, h) };
    }
    const liverAlpha = liverDataCacheRef.current.data.data;
    const segData = label.ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < w * h; i++) {
      if (liverAlpha[i * 4 + 3] === 0) segData.data[i * 4 + 3] = 0;
    }
    label.ctx.putImageData(segData, 0, 0);
  }

  // capture snapshots for undo/redo
  function snapshotFor(label: LabelSpec): ImageData {
    const ctx = label.ctx!;
    return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  function pushHistory(label: LabelSpec, before: ImageData, after: ImageData) {
    if (!current) return;
    current.history.push({ kind: "mask", labelId: label.id, before, after });
    if (current.history.length > MAX_HISTORY_PER_IMAGE) current.history.shift();
    current.redo.length = 0; // clear redo
    setHasUnsaved(true);
    scheduleAutoSave(); // no-op while disabled — re-enable after memory profiling
  }

  /** Snapshot the annotations[] array for undo (cheap — JSON clone). */
  function pushAnnotationsHistory(before: AnnotationInstance[], after: AnnotationInstance[]) {
    if (!current) return;
    current.history.push({ kind: "annotations", before, after });
    if (current.history.length > MAX_HISTORY_PER_IMAGE) current.history.shift();
    current.redo.length = 0;
    // Re-derive usable flags whenever annotations change (respects manual override).
    recomputeUsableFlags(current);
    setHasUnsaved(true);
    scheduleAutoSave();
  }

  /**
   * Derive the auto-computed usable_for_* flags from a frame's annotations + quality flags.
   * Used by the metadata panel display AND by recomputeUsableFlags() which writes back to
   * metadata so the exported value stays correct.
   *
   * - usable_for_depth_training = false when any quality flag is set,
   *   OR an INSTRUMENT_MASK polygon overlaps a PAPILLA_ORIFICE polygon.
   * - usable_for_segmentation_training = false only when motion-blur or lens-contamination is set.
   */
  function computeUsableFlags(frame: ImageItem): { depth: boolean; seg: boolean } {
    const flags = frame.metadata.frame_quality_flags;
    const hasBlur = flags.includes("motion-blur");
    const hasLensCont = flags.includes("lens-contamination");
    const anyQualityFlag = flags.length > 0;
    const instruments = frame.annotations.filter(a => {
      const cls = ERCP_CLASS_BY_ID.get(a.classId);
      return cls?.name === "INSTRUMENT_MASK" && a.geometry.kind === "polygon";
    });
    const orifices = frame.annotations.filter(a => {
      const cls = ERCP_CLASS_BY_ID.get(a.classId);
      return cls?.name === "PAPILLA_ORIFICE" && a.geometry.kind === "polygon";
    });
    let instrumentOverlapsOrifice = false;
    outer: for (const ins of instruments) {
      if (ins.geometry.kind !== "polygon") continue;
      for (const ori of orifices) {
        if (ori.geometry.kind !== "polygon") continue;
        if (polygonsOverlap(ins.geometry.points, ori.geometry.points)) {
          instrumentOverlapsOrifice = true;
          break outer;
        }
      }
    }
    return {
      depth: !(anyQualityFlag || instrumentOverlapsOrifice),
      seg: !(hasBlur || hasLensCont),
    };
  }

  /**
   * Recompute and persist usable_for_* fields, respecting manual_override flags.
   * Call after every change that can affect them (annotation add/remove, flag toggle).
   */
  function recomputeUsableFlags(frame: ImageItem) {
    const { depth, seg } = computeUsableFlags(frame);
    if (!frame.metadata.usable_for_depth_manual_override) {
      frame.metadata.usable_for_depth_training = depth;
    }
    if (!frame.metadata.usable_for_segmentation_manual_override) {
      frame.metadata.usable_for_segmentation_training = seg;
    }
  }

  /** Snapshot the keypoints[] array for undo. */
  function pushKeypointsHistory(before: KeypointInstance[], after: KeypointInstance[]) {
    if (!current) return;
    current.history.push({ kind: "keypoints", before, after });
    if (current.history.length > MAX_HISTORY_PER_IMAGE) current.history.shift();
    current.redo.length = 0;
    setHasUnsaved(true);
    scheduleAutoSave();
  }

  /**
   * finalizePolygon — emit a new polygon AnnotationInstance for the active class.
   *
   * Polygon is the primary tool for clean-boundaried structures (papilla body,
   * orifice, hooding fold, etc.). It writes a polygon-geom AnnotationInstance to
   * the frame's `annotations[]` rather than rasterizing into a per-class mask.
   * Pen + eraser still write to per-class label canvases — both are exported.
   */
  function finalizePolygon(label: LabelSpec, pts: Pt[]) {
    if (!current || pts.length < 3) return;
    const cls = ERCP_CLASS_BY_ID.get(label.id);
    if (!cls) return;
    const before = current.annotations.slice();
    const geometry: PolygonGeom = { kind: "polygon", points: pts.map(p => ({ x: p.x, y: p.y })) };
    const instance: AnnotationInstance = {
      id: uid(),
      classId: cls.id,
      geometry,
      depth_rank: classDefaultDepthRank(cls),
      depth_rank_fixed: cls.depthRank.mode === "fixed",
      attributes: defaultAttributesFor(cls),
    };
    current.annotations = [...current.annotations, instance];
    pushAnnotationsHistory(before, current.annotations.slice());
    scheduleRedraw();
    logEditCommit({ label, frame: current, station: current.station || "", tool: "polygon", action: "mask_edit" });
  }

  /**
   * onCanvasClick — click-to-place polygon points; double-click to fill.
   *
   * Uses e.detail to distinguish single-click (point placement, detail === 1)
   * from double-click (finalize, detail === 2) without any setTimeout hacks.
   * On detail === 2 we do NOT add an extra point: the first click of the
   * double-click (detail === 1) already placed the point at that location.
   * This guarantees no duplicate point is inserted on polygon close.
   */
  async function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!current) return;
    const label = activeLabel();
    if (!label) return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const imgPt = toImageCoordsFromClient(e.clientX, e.clientY, rect);
    if (!imgPt) return;

    if (tool === "keypoint") {
      // Snap to integer image-coords; open modal to choose name.
      setKeypointPlacingAt({ x: Math.round(imgPt.x), y: Math.round(imgPt.y) });
      return;
    }

    if (tool !== "polygon") return;

    if (e.detail === 2) {
      // Double-click: finalize polygon using already-placed points.
      // Do NOT add imgPt again — detail===1 click already placed it.
      const pts = polygonPointsRef.current;
      if (pts.length >= 3) {
        finalizePolygon(label, pts);
      }
      polygonPointsRef.current = [];
      polygonMousePtRef.current = null;
      scheduleRedraw();
      return;
    }

    // Single click (detail === 1): add vertex
    polygonPointsRef.current = [...polygonPointsRef.current, imgPt];
    scheduleRedraw();
  }

  // ----- input handlers -----
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!current) return; const label = activeLabel(); if (!label) return;
    // Polygon tool uses click events (onCanvasClick), not pointer drag events
    if (tool === "polygon") return;
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const strokeTransform: StrokeTransform = {
      left: rect.left,
      top: rect.top,
      ...currentTransforms(),
      w: current.w,
      h: current.h,
    };
    const imgPt = toImageCoordsWithTransform(e.clientX, e.clientY, strokeTransform); if (!imgPt) return;
    strokeTransformRef.current = strokeTransform;
    activeStrokeLabelRef.current = label;
    try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
    isDrawingRef.current = true; lastPtRef.current = imgPt; strokePathRef.current = [imgPt];
    strokeStartSnapshot.current = snapshotFor(label);

    if (tool === "select") {
      // Hit-test order: polygon vertex → keypoint → polygon body → empty (mask drag).
      const VERTEX_HIT_RADIUS_PX = 8;
      const KEYPOINT_HIT_RADIUS_PX = 12;
      const vradius = VERTEX_HIT_RADIUS_PX / strokeTransform.scale;
      const kradius = KEYPOINT_HIT_RADIUS_PX / strokeTransform.scale;
      // 1. Polygon vertex
      const vhit = findVertexHit(imgPt, current.annotations, vradius);
      if (vhit) {
        setSelectedInstanceId(vhit.instanceId);
        setSelectedKeypointId(null);
        vertexDragRef.current = {
          instanceId: vhit.instanceId,
          vertexIdx: vhit.vertexIdx,
          beforeAnnotations: current.annotations.map(a => ({
            ...a,
            geometry: a.geometry.kind === "polygon"
              ? { kind: "polygon", points: a.geometry.points.map(p => ({ x: p.x, y: p.y })) }
              : { ...a.geometry },
            attributes: { ...a.attributes },
          })),
        };
        scheduleRedraw();
        return;
      }
      // 2. Keypoint hit (closest within radius)
      const krsq = kradius * kradius;
      let bestKp: KeypointInstance | null = null;
      let bestKpDist = Infinity;
      for (const k of current.keypoints) {
        const dx = imgPt.x - k.x, dy = imgPt.y - k.y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= krsq && d2 < bestKpDist) { bestKp = k; bestKpDist = d2; }
      }
      if (bestKp) {
        setSelectedKeypointId(bestKp.id);
        setSelectedInstanceId(null);
        keypointDragRef.current = {
          keypointId: bestKp.id,
          beforeKeypoints: current.keypoints.map(k => ({ ...k })),
        };
        scheduleRedraw();
        return;
      }
      // 2b. Edge-click on the currently selected polygon → insert a new vertex
      //     between the two adjacent vertices and start dragging it immediately.
      const selId = selectedInstanceIdRef.current;
      if (selId) {
        const selInst = current.annotations.find(a => a.id === selId);
        if (selInst && selInst.geometry.kind === "polygon") {
          const EDGE_HIT_RADIUS_PX = 6;
          const eradius = EDGE_HIT_RADIUS_PX / strokeTransform.scale;
          const ehit = findEdgeHit(imgPt, selInst.geometry.points, eradius);
          if (ehit) {
            const before = current.annotations.map(a => ({
              ...a,
              geometry: a.geometry.kind === "polygon"
                ? { kind: "polygon" as const, points: a.geometry.points.map(p => ({ x: p.x, y: p.y })) }
                : { ...a.geometry },
              attributes: { ...a.attributes },
            }));
            const insertAt = ehit.edgeIdx + 1;
            selInst.geometry.points.splice(insertAt, 0, { x: ehit.closest.x, y: ehit.closest.y });
            vertexDragRef.current = {
              instanceId: selId,
              vertexIdx: insertAt,
              beforeAnnotations: before,
            };
            scheduleRedraw();
            return;
          }
        }
      }
      // 3. Polygon body
      const phit = findPolygonHit(imgPt, current.annotations);
      if (phit) {
        setSelectedInstanceId(phit.id);
        setSelectedKeypointId(null);
        scheduleRedraw();
        try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
        isDrawingRef.current = false;
        strokeStartSnapshot.current = null;
        return;
      }
      // 4. Empty: clear both instance + keypoint selection, fall through to mask drag.
      setSelectedInstanceId(null);
      setSelectedKeypointId(null);
      selectDragStartRef.current = imgPt;
      return;
    }

    if (tool === "pen") {
      const ctx = label.ctx!;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = PEN_SIZE;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(imgPt.x + 0.5, imgPt.y + 0.5);
      ctx.lineTo(imgPt.x + 0.5, imgPt.y + 0.5);
      ctx.stroke();
      previewEnabledRef.current = allVisible && label.visible;
      previewStrokeColorRef.current = label.color;
      previewStrokeWidthRef.current = Math.max(1, OUTLINE_THICKNESS * strokeTransform.scale);
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      queuePreviewSegment(x, y, x, y);
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    // Polygon: track mouse for live edge preview, independent of drawing state
    if (tool === "polygon" && polygonPointsRef.current.length > 0) {
      polygonMousePtRef.current = toImageCoords(e);
      scheduleRedraw();
    }
    // Vertex drag: update the dragged vertex on every move; commit on pointer up.
    if (vertexDragRef.current && current) {
      const imgPt = toImageCoords(e);
      if (!imgPt) return;
      const { instanceId, vertexIdx } = vertexDragRef.current;
      const inst = current.annotations.find(a => a.id === instanceId);
      if (inst && inst.geometry.kind === "polygon" && inst.geometry.points[vertexIdx]) {
        inst.geometry.points[vertexIdx] = { x: imgPt.x, y: imgPt.y };
        scheduleRedraw();
      }
      return;
    }
    // Keypoint drag: update keypoint position; commit on pointer up.
    if (keypointDragRef.current && current) {
      const imgPt = toImageCoords(e);
      if (!imgPt) return;
      const { keypointId } = keypointDragRef.current;
      const k = current.keypoints.find(kp => kp.id === keypointId);
      if (k) {
        k.x = imgPt.x;
        k.y = imgPt.y;
        scheduleRedraw();
      }
      return;
    }
    // Select-tool hover: track which vertex / keypoint is under the cursor.
    if (tool === "select" && current && !isDrawingRef.current) {
      const imgPt = toImageCoords(e);
      if (imgPt) {
        const tx = currentTransforms();
        const vradius = 8 / tx.scale;
        const vh = findVertexHit(imgPt, current.annotations, vradius);
        const curV = hoveredVertexRef.current;
        const vchanged = (!!curV !== !!vh)
          || (curV && vh && (curV.instanceId !== vh.instanceId || curV.vertexIdx !== vh.vertexIdx));
        if (vchanged) {
          hoveredVertexRef.current = vh ? { instanceId: vh.instanceId, vertexIdx: vh.vertexIdx } : null;
          scheduleRedraw();
        }
        // Keypoint hover
        if (!vh) {
          const krsq = (12 / tx.scale) * (12 / tx.scale);
          let bestId: string | null = null;
          let bestD2 = Infinity;
          for (const k of current.keypoints) {
            const dx = imgPt.x - k.x, dy = imgPt.y - k.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= krsq && d2 < bestD2) { bestId = k.id; bestD2 = d2; }
          }
          if (hoveredKeypointIdRef.current !== bestId) {
            hoveredKeypointIdRef.current = bestId;
            scheduleRedraw();
          }
        } else if (hoveredKeypointIdRef.current !== null) {
          hoveredKeypointIdRef.current = null;
          scheduleRedraw();
        }
      }
    }
    if (!isDrawingRef.current) return; const label = activeStrokeLabelRef.current; if (!label) return;
    const imgPt = toImageCoords(e); if (!imgPt || !lastPtRef.current) return;

    const ctx = label.ctx!;
    if (tool === "pen") {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = PEN_SIZE;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(lastPtRef.current.x + 0.5, lastPtRef.current.y + 0.5);
      ctx.lineTo(imgPt.x + 0.5, imgPt.y + 0.5);
      ctx.stroke();
      const tx = strokeTransformRef.current;
      if (tx) {
        queuePreviewSegment(
          lastPtRef.current.x * tx.scale + (tx.offX + tx.panX * tx.scale),
          lastPtRef.current.y * tx.scale + (tx.offY + tx.panY * tx.scale),
          imgPt.x * tx.scale + (tx.offX + tx.panX * tx.scale),
          imgPt.y * tx.scale + (tx.offY + tx.panY * tx.scale),
        );
      }
    } else if (tool === "select") {
      // Live drag-to-move: if we have a selected mask and have moved enough, shift it.
      const start = selectDragStartRef.current;
      if (start && selectedMaskId !== null && strokeStartSnapshot.current) {
        const dx = Math.round(imgPt.x - start.x);
        const dy = Math.round(imgPt.y - start.y);
        if (Math.abs(dx) > 0 || Math.abs(dy) > 0) {
          const ctx = label.ctx!;
          ctx.clearRect(0, 0, current!.w, current!.h);
          ctx.putImageData(strokeStartSnapshot.current, dx, dy);
          scheduleRedraw();
        }
      }
      lastPtRef.current = imgPt;
      return;
    } else if (tool === "circle-eraser" || tool === "stroke-eraser" || tool === "global-eraser") {
      // For erasers, we only record the path while moving; actual erase occurs on pointer up.
    } else { return; }

    lastPtRef.current = imgPt;
    if (tool === "pen") return;
    strokePathRef.current.push(imgPt);
    scheduleRedraw();
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    // Commit vertex drag before any other handling.
    if (vertexDragRef.current && current) {
      const { beforeAnnotations } = vertexDragRef.current;
      pushAnnotationsHistory(beforeAnnotations, current.annotations.slice());
      vertexDragRef.current = null;
      try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
      scheduleRedraw();
      return;
    }
    // Commit keypoint drag.
    if (keypointDragRef.current && current) {
      const { beforeKeypoints } = keypointDragRef.current;
      pushKeypointsHistory(beforeKeypoints, current.keypoints.slice());
      keypointDragRef.current = null;
      try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
      scheduleRedraw();
      return;
    }
    if (!isDrawingRef.current) return; isDrawingRef.current = false;
    try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
    const label = activeStrokeLabelRef.current; if (!label) return;

    if (tool === "select") {
      const start = selectDragStartRef.current;
      const hasMoved = start && lastPtRef.current && (
        Math.abs(lastPtRef.current.x - start.x) > 3 || Math.abs(lastPtRef.current.y - start.y) > 3
      );
      if (!hasMoved) {
        // Treat as a click: hit-test all labels at the pointer position
        const rect = e.currentTarget.getBoundingClientRect();
        const imgPt = toImageCoordsFromClient(e.clientX, e.clientY, rect);
        if (imgPt && current) {
          let hit: LabelSpec | null = null;
          for (const lbl of current.labels) {
            if (!lbl.ctx || !lbl.canvas) continue;
            const px = Math.floor(imgPt.x), py = Math.floor(imgPt.y);
            if (px < 0 || py < 0 || px >= current.w || py >= current.h) continue;
            const alpha = lbl.ctx.getImageData(px, py, 1, 1).data[3];
            if (alpha > 0) { hit = lbl; break; }
          }
          setSelectedMaskId(hit ? hit.id : null);
          if (hit) setActiveId(hit.id);
          // Restore the label to pre-drag state (no actual move happened)
          if (strokeStartSnapshot.current) {
            label.ctx!.putImageData(strokeStartSnapshot.current, 0, 0);
          }
        }
      } else if (selectedMaskId !== null && strokeStartSnapshot.current) {
        // Finalize drag move
        const before = strokeStartSnapshot.current;
        const after = snapshotFor(label);
        label.rev = (label.rev || 0) + 1;
        if (label.cache) { label.cache.tint = undefined; label.cache.outline = undefined; }
        pushHistory(label, before, after);
      }
      scheduleRedraw();
      selectDragStartRef.current = null;
      strokeStartSnapshot.current = null;
      lastPtRef.current = null; strokePathRef.current = [];
      strokeTransformRef.current = null; activeStrokeLabelRef.current = null;
      isDrawingRef.current = false;
      return;
    } else if (tool === "circle-eraser") {
      const pts = strokePathRef.current;
      if (pts.length > 2) {
        const ctx = label.ctx!;
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        // Close the loop to ensure a clean enclosed region
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      cleanMask(label);
    } else if (tool === "global-eraser") {
      const pts = strokePathRef.current;
      if (pts.length > 2 && current) {
        for (const lbl of current.labels) {
          if (!lbl.canvas || !lbl.ctx) continue;
          const beforeL = snapshotFor(lbl);
          const ctx = lbl.ctx;
          ctx.save();
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          cleanMask(lbl);
          lbl.rev = (lbl.rev || 0) + 1;
          if (lbl.cache) { lbl.cache.tint = undefined; lbl.cache.outline = undefined; }
          const afterL = snapshotFor(lbl);
          if (!imageDataEqual(beforeL, afterL)) pushHistory(lbl, beforeL, afterL);
        }
      }
      // Skip the generic history push below (already done per-label above)
      resetPreviewState();
      scheduleRedraw();
      lastPtRef.current = null; strokePathRef.current = [];
      strokeTransformRef.current = null; activeStrokeLabelRef.current = null;
      strokeStartSnapshot.current = null;
      isDrawingRef.current = false;
      return;
    } else if (tool === "stroke-eraser") {
      eraseConnectedComponent(label, strokePathRef.current);
      cleanMask(label);
    } else {
      fillHoles(label);
      cleanMask(label);
    }
    if (isSegmentLabel(label.id)) clipToLiverMask(label);

    // bump label revision, invalidate caches
    label.rev = (label.rev || 0) + 1;
    if (label.cache) { label.cache.tint = undefined; label.cache.outline = undefined; }

    const before = strokeStartSnapshot.current!;
    const after = snapshotFor(label);
    const changed = !imageDataEqual(before, after);
    pushHistory(label, before, after);

    resetPreviewState();
    scheduleRedraw();
    lastPtRef.current = null; strokePathRef.current = [];
    strokeTransformRef.current = null;
    activeStrokeLabelRef.current = null;
    strokeStartSnapshot.current = null;
    if (changed && current) logEditCommit({ label, frame: current, station: current.station || "", tool, action: "mask_edit" });
  }

  // Zoom handling
  function zoomAtClientPoint(clientX: number, clientY: number, factor: number) {
    if (!current || !imageAreaRef.current) return;
    const rect = stageRef.current!.getBoundingClientRect();
    const p = toImageCoordsFromClient(clientX, clientY, rect);
    if (!p) return;
    const fit = fitRef.current;
    const newZoom = Math.max(0.1, Math.min(8, zoomRef.current * factor));
    const newScale = fit.baseScale * newZoom;
    const offX = fit.offX;
    const offY = fit.offY;
    const xS = clientX - rect.left;
    const yS = clientY - rect.top;
    const newPanX = (xS - offX) / newScale - p.x;
    const newPanY = (yS - offY) / newScale - p.y;
    zoomRef.current = newZoom;
    panRef.current = { x: newPanX, y: newPanY };
    scheduleRedraw();
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomAtClientPoint(e.clientX, e.clientY, factor);
  }

  function zoomInBtn() {
    const rect = stageRef.current!.getBoundingClientRect();
    zoomAtClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.1);
  }
  function zoomOutBtn() {
    const rect = stageRef.current!.getBoundingClientRect();
    zoomAtClientPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.1);
  }
  function zoomResetBtn() { resetView(); scheduleRedraw(); }

  // Undo / Redo
  function doUndo() {
    if (!current || !current.history.length) return;
    const h = current.history.pop()!;
    if (h.kind === "mask") {
      const label = current.labels.find(l => l.id === h.labelId)!;
      label.ctx!.putImageData(h.before, 0, 0);
      label.rev = (label.rev || 0) + 1;
      if (label.cache) { label.cache.tint = undefined; label.cache.outline = undefined; }
      if (current.redo.length >= MAX_HISTORY_PER_IMAGE) current.redo.shift();
      current.redo.push(h);
      scheduleRedraw();
      setProject({ ...project });
      logEditCommit({ label, frame: current, station: current.station || "", tool: "undo", action: "undo" });
    } else if (h.kind === "annotations") {
      current.annotations = h.before;
      if (current.redo.length >= MAX_HISTORY_PER_IMAGE) current.redo.shift();
      current.redo.push(h);
      scheduleRedraw();
      setProject({ ...project });
      logEditCommit({ frame: current, station: current.station || "", tool: "undo", action: "undo" });
    } else if (h.kind === "keypoints") {
      current.keypoints = h.before;
      if (current.redo.length >= MAX_HISTORY_PER_IMAGE) current.redo.shift();
      current.redo.push(h);
      scheduleRedraw();
      setProject({ ...project });
      logEditCommit({ frame: current, station: current.station || "", tool: "undo", action: "undo" });
    }
  }
  function doRedo() {
    if (!current || !current.redo.length) return;
    const h = current.redo.pop()!;
    if (h.kind === "mask") {
      const label = current.labels.find(l => l.id === h.labelId)!;
      label.ctx!.putImageData(h.after, 0, 0);
      label.rev = (label.rev || 0) + 1;
      if (label.cache) { label.cache.tint = undefined; label.cache.outline = undefined; }
      if (current.history.length >= MAX_HISTORY_PER_IMAGE) current.history.shift();
      current.history.push(h);
      scheduleRedraw();
      setProject({ ...project });
      logEditCommit({ label, frame: current, station: current.station || "", tool: "redo", action: "redo" });
    } else if (h.kind === "annotations") {
      current.annotations = h.after;
      if (current.history.length >= MAX_HISTORY_PER_IMAGE) current.history.shift();
      current.history.push(h);
      scheduleRedraw();
      setProject({ ...project });
      logEditCommit({ frame: current, station: current.station || "", tool: "redo", action: "redo" });
    } else if (h.kind === "keypoints") {
      current.keypoints = h.after;
      if (current.history.length >= MAX_HISTORY_PER_IMAGE) current.history.shift();
      current.history.push(h);
      scheduleRedraw();
      setProject({ ...project });
      logEditCommit({ frame: current, station: current.station || "", tool: "redo", action: "redo" });
    }
  }
  /** Move all pixels from srcId label to dstId label (relabel operation for select tool). */
  function transferMask(srcId: number, dstId: number) {
    if (!current) return;
    const src = current.labels.find(l => l.id === srcId);
    const dst = current.labels.find(l => l.id === dstId);
    if (!src?.ctx || !dst?.ctx) return;
    ensureCanvasSize(src, current.w, current.h);
    ensureCanvasSize(dst, current.w, current.h);
    const srcBefore = snapshotFor(src);
    const dstBefore = snapshotFor(dst);
    const srcData = src.ctx.getImageData(0, 0, current.w, current.h);
    const dstData = dst.ctx.getImageData(0, 0, current.w, current.h);
    const s = srcData.data, d = dstData.data;
    for (let i = 3; i < s.length; i += 4) {
      if (s[i] > 0) {
        d[i - 3] = 255; d[i - 2] = 255; d[i - 1] = 255; d[i] = 255;
        s[i - 3] = 0; s[i - 2] = 0; s[i - 1] = 0; s[i] = 0;
      }
    }
    src.ctx.putImageData(srcData, 0, 0);
    dst.ctx.putImageData(dstData, 0, 0);
    src.rev = (src.rev || 0) + 1; if (src.cache) { src.cache.tint = undefined; src.cache.outline = undefined; }
    dst.rev = (dst.rev || 0) + 1; if (dst.cache) { dst.cache.tint = undefined; dst.cache.outline = undefined; }
    pushHistory(src, srcBefore, snapshotFor(src));
    pushHistory(dst, dstBefore, snapshotFor(dst));
    scheduleRedraw();
    setProject({ ...project });
  }

  function copyLabelFromAbove() {
    if (project.current <= 0 || !current) return;
    const srcImg = project.images[project.current - 1];
    const srcLabel = srcImg.labels.find(l => l.id === activeId);
    if (!srcLabel?.canvas) return;
    ensureCanvasSize(srcLabel, srcImg.w, srcImg.h);
    const tgtLabel = current.labels.find(l => l.id === activeId);
    if (!tgtLabel) return;
    ensureCanvasSize(tgtLabel, current.w, current.h);
    const before = tgtLabel.ctx!.getImageData(0, 0, current.w, current.h);
    tgtLabel.ctx!.globalCompositeOperation = "source-over";
    tgtLabel.ctx!.drawImage(srcLabel.canvas, 0, 0);
    tgtLabel.ctx!.globalCompositeOperation = "source-over";
    const after = tgtLabel.ctx!.getImageData(0, 0, current.w, current.h);
    const bd = before.data, ad = after.data;
    let px = false;
    for (let i = 3; i < bd.length; i += 4) { if (bd[i] !== ad[i]) { px = true; break; } }
    if (px) {
      pushHistory(tgtLabel, before, after);
      tgtLabel.rev = (tgtLabel.rev || 0) + 1;
      if (tgtLabel.cache) { tgtLabel.cache.tint = undefined; tgtLabel.cache.outline = undefined; }
      scheduleRedraw(); setProject({ ...project });
    }
  }
  function copyMasksFromAbove() {
    if (project.current <= 0 || !current) return;
    const srcImg = project.images[project.current - 1];
    let changed = false;
    for (const srcLabel of srcImg.labels) {
      if (!srcLabel.canvas) continue;
      ensureCanvasSize(srcLabel, srcImg.w, srcImg.h);
      const tgtLabel = current.labels.find(l => l.id === srcLabel.id);
      if (!tgtLabel) continue;
      ensureCanvasSize(tgtLabel, current.w, current.h);
      const before = tgtLabel.ctx!.getImageData(0, 0, current.w, current.h);
      tgtLabel.ctx!.globalCompositeOperation = "source-over";
      tgtLabel.ctx!.drawImage(srcLabel.canvas, 0, 0);
      tgtLabel.ctx!.globalCompositeOperation = "source-over";
      const after = tgtLabel.ctx!.getImageData(0, 0, current.w, current.h);
      const bd = before.data, ad = after.data;
      let px = false;
      for (let i = 3; i < bd.length; i += 4) { if (bd[i] !== ad[i]) { px = true; break; } }
      if (px) {
        pushHistory(tgtLabel, before, after);
        tgtLabel.rev = (tgtLabel.rev || 0) + 1;
        if (tgtLabel.cache) { tgtLabel.cache.tint = undefined; tgtLabel.cache.outline = undefined; }
        changed = true;
      }
    }
    if (changed) { scheduleRedraw(); setProject({ ...project }); }
  }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (showLabelPicker) {
          e.preventDefault();
          setShowLabelPicker(false);
          return;
        }
        if (tool === "polygon" && polygonPointsRef.current.length > 0) {
          e.preventDefault();
          polygonPointsRef.current = [];
          polygonMousePtRef.current = null;
          scheduleRedraw();
          return;
        }
        if (selectedInstanceIdRef.current) {
          e.preventDefault();
          setSelectedInstanceId(null);
          hoveredVertexRef.current = null;
          scheduleRedraw();
          return;
        }
        if (selectedKeypointIdRef.current) {
          e.preventDefault();
          setSelectedKeypointId(null);
          hoveredKeypointIdRef.current = null;
          scheduleRedraw();
          return;
        }
        if (keypointPlacingAt) {
          e.preventDefault();
          setKeypointPlacingAt(null);
          return;
        }
      }
      // V: cycle visibility on the selected keypoint
      if (e.key.toLowerCase() === "v" && !isTypingContext(e) && !(e.metaKey || e.ctrlKey)) {
        const cur = current;
        if (!cur) return;
        const selKpId = selectedKeypointIdRef.current;
        if (!selKpId) return;
        const k = cur.keypoints.find(kp => kp.id === selKpId);
        if (!k) return;
        const NEXT: Record<typeof k.visibility, typeof k.visibility> = {
          "visible": "partially-occluded",
          "partially-occluded": "inferred",
          "inferred": "visible",
        };
        e.preventDefault();
        const before = cur.keypoints.map(kp => ({ ...kp }));
        k.visibility = NEXT[k.visibility];
        pushKeypointsHistory(before, cur.keypoints.slice());
        scheduleRedraw();
        return;
      }
      // Delete / Backspace: polygon vertex → polygon instance → selected keypoint.
      if ((e.key === "Delete" || e.key === "Backspace") && !isTypingContext(e)) {
        const cur = current;
        if (!cur) return;
        const selId = selectedInstanceIdRef.current;
        const selKpId = selectedKeypointIdRef.current;
        // Keypoint deletion
        if (selKpId && !selId) {
          e.preventDefault();
          const before = cur.keypoints.map(kp => ({ ...kp }));
          cur.keypoints = cur.keypoints.filter(kp => kp.id !== selKpId);
          setSelectedKeypointId(null);
          hoveredKeypointIdRef.current = null;
          pushKeypointsHistory(before, cur.keypoints.slice());
          scheduleRedraw();
          return;
        }
        if (!selId) return;
        const inst = cur.annotations.find(a => a.id === selId);
        if (!inst || inst.geometry.kind !== "polygon") return;
        const hv = hoveredVertexRef.current;
        const before = cur.annotations.map(a => ({
          ...a,
          geometry: a.geometry.kind === "polygon"
            ? { kind: "polygon" as const, points: a.geometry.points.map(p => ({ x: p.x, y: p.y })) }
            : { ...a.geometry },
          attributes: { ...a.attributes },
        }));
        if (hv && hv.instanceId === selId && inst.geometry.points.length > 3) {
          e.preventDefault();
          inst.geometry.points.splice(hv.vertexIdx, 1);
          hoveredVertexRef.current = null;
          pushAnnotationsHistory(before, cur.annotations.slice());
          scheduleRedraw();
          return;
        }
        e.preventDefault();
        cur.annotations = cur.annotations.filter(a => a.id !== selId);
        setSelectedInstanceId(null);
        hoveredVertexRef.current = null;
        pushAnnotationsHistory(before, cur.annotations.slice());
        scheduleRedraw();
        return;
      }
      // 1..8 — switch the active ERCP class (matches ercp_annotator_spec.md hotkeys).
      // Bare digits only; ignore when modifiers or typing focus are active.
      if (!isTypingContext(e) && !(e.metaKey || e.ctrlKey) && /^[1-8]$/.test(e.key)) {
        const id = parseInt(e.key, 10);
        if (TIER2A_LABELS.some(l => l.id === id)) {
          e.preventDefault();
          setActiveId(id);
          return;
        }
      }
      // K — switch to the keypoint tool.
      if (!isTypingContext(e) && !(e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setTool("keypoint");
        polygonPointsRef.current = [];
        polygonMousePtRef.current = null;
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      }
      if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomInBtn(); }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomOutBtn(); }
      if (e.key.toLowerCase() === "0") { e.preventDefault(); zoomResetBtn(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, showLabelPicker]);

  // Tool hotkeys: P → pen, O → polygon, E → eraser, S → select
  // Handlers clear polygon in-progress state when switching away from polygon.
  // (onAuto stub — auto-segmentation removed in ERCP fork; useToolHotkeys interface
  //  still expects it pending replacement with ercpHotkeys.ts in a later step.)
  useToolHotkeys({
    onPen:     () => { setTool("pen");      polygonPointsRef.current = []; polygonMousePtRef.current = null; },
    onPolygon: () => { setTool("polygon"); },
    onEraser:  () => { setTool(eraserMode); polygonPointsRef.current = []; polygonMousePtRef.current = null; },
    onAuto:    () => { /* no-op: auto tool removed */ },
    onSelect:  () => { setTool("select");   polygonPointsRef.current = []; polygonMousePtRef.current = null; },
  });

  // finalize & export
  function finalizeAll(img: ImageItem) { img.labels.forEach(l => { fillHoles(l); cleanMask(l); }); }

  // --- COCO-style export (ERCP) ---
  // Replaces the old NRRD/MITK pipeline. One JSON file per image; bundle for "all" path.
  function buildCocoForFrame(img: ImageItem) {
    return buildCocoExportFrame({
      imageId: img.id,
      metadata: img.metadata,
      annotations: img.annotations,
      keypoints: img.keypoints,
      labelCanvases: img.labels
        .filter(l => l.canvas)
        .map(l => ({ id: l.id, canvas: l.canvas! })),
    });
  }
  async function exportCocoForImages(ids: string[], scope: "current" | "selected" | "all") {
    const imgs = project.images.filter(im => ids.includes(im.id));
    if (!imgs.length) { alert('No images to export.'); return; }
    let delay = 0;
    let exportedCount = 0;
    for (const img of imgs) {
      finalizeAll(img);
      const frame = buildCocoForFrame(img);
      const blob = cocoExportBlob(frame);
      const fname = `${img.name}.coco.json`;
      setTimeout(() => downloadBlob(blob, fname), delay);
      delay += 180;
      exportedCount += 1;
    }
    logExportNRRD(scope, imgs.length, exportedCount);
  }
  async function exportCocoCurrent() {
    if (!current) { alert('No current image.'); return; }
    await exportCocoForImages([current.id], "current");
  }
  async function exportCocoBulkSelected() {
    const ids = Array.from(selectedIds);
    if (!ids.length) { alert('No images selected.'); return; }
    await exportCocoForImages(ids, ids.length === project.images.length ? "all" : "selected");
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  // ↓↓↓ Legacy NRRD export/import code retained as reference for the v1 build.
  //     Not wired into the UI; will be removed after COCO export stabilizes.
  async function buildNRRDBlobMITK4D(_img: ImageItem): Promise<Blob> { throw new Error("NRRD export disabled in ERCP v1 (use COCO instead)"); }
  async function exportNRRDForImages(_ids: string[], _scope: "current" | "selected" | "all") { /* disabled */ }
  async function exportNRRDCurrent() { /* disabled */ }
  async function exportNRRDBulkSelected() { /* disabled */ }
  async function importNRRDMask(_file: File) { /* disabled */ }
  void buildNRRDBlobMITK4D; void exportNRRDForImages; void exportNRRDCurrent;
  void exportNRRDBulkSelected; void importNRRDMask;
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // NRRD legacy block — deleted in ERCP fork. Stubs above keep the names alive.

  // Project save/open (.ercp JSON, schema "ercp-papilla-v1")
  // Save dialog state
  const [showSaveDialog, setShowSaveDialog] = useState<boolean>(false);
  const [saveName, setSaveName] = useState<string>(projectName);
  const [revKah, setRevKah] = useState<boolean>(false);
  const [revVa, setRevVa] = useState<boolean>(false);
  const [revJli, setRevJli] = useState<boolean>(false);
  const [revOtherOn, setRevOtherOn] = useState<boolean>(false);
  const [revOtherText, setRevOtherText] = useState<string>("");

  async function onSaveProject() {
    setSaveName(projectName || "project");
    setRevKah(false); setRevVa(false); setRevJli(false); setRevOtherOn(false); setRevOtherText("");
    setShowSaveDialog(true);
  }

  /**
   * Build the ERCP project snapshot (schema "ercp-papilla-v1") for save/load.
   * Carries per-frame metadata, polygon AnnotationInstances, KeypointInstances,
   * and a per-class mask PNG dictionary (the pen/eraser data lives in the
   * per-class LabelSpec canvas; this serializes them losslessly).
   */
  async function buildErcpProjectSnapshot(baseName: string) {
    setProjectName(baseName);
    const now = new Date().toISOString();
    return {
      schema: "ercp-papilla-v1",
      createdAt: now,
      updatedAt: now,
      projectName: baseName,
      frames: project.images.map((im) => {
        const labelMasks: Record<string, string> = {};
        for (const l of im.labels) {
          if (!l.canvas || !l.ctx) continue;
          // Skip empty canvases (no painted pixels) to keep file small.
          const data = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height).data;
          let anyAlpha = false;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) { anyAlpha = true; break; }
          }
          if (anyAlpha) labelMasks[String(l.id)] = l.canvas.toDataURL("image/png");
        }
        return {
          imageId: im.id,
          name: im.name,
          width: im.w,
          height: im.h,
          baseURL: im.baseURL,
          sourceTimestamp: im.sourceTimestamp ?? null,
          frame_metadata: im.metadata,
          annotations: im.annotations,
          keypoints: im.keypoints,
          label_masks: labelMasks,
        };
      }),
    };
  }
  // Backwards-compat alias for the hosted-review pathway which still references
  // buildLeusProjectSnapshot via the HostedAnnotatorOutput contract. The output
  // is the new ERCP schema; the field name is preserved for now.
  const buildLeusProjectSnapshot = buildErcpProjectSnapshot;

  async function submitHostedReview() {
    if (!hostedReview || hostedSubmitBusy) return;
    try {
      setHostedSubmitBusy(true);
      const leusJson = await buildLeusProjectSnapshot(projectName || hostedReview.manifest.displayCaseId || "project");
      const output: HostedAnnotatorOutput = {
        caseId: hostedReview.manifest.caseId,
        assignmentId: hostedReview.manifest.assignmentId,
        reviewStage: hostedReview.manifest.reviewStage,
        outputType: "stage_submit",
        leusJson,
        summary: {
          imageCount: project.images.length,
          labelsObserved: collectUsedLabels(project.images).map(label => ({ id: label.id, name: label.name })),
          stationsUsed: stationsFromImages(project.images) as Array<"TG" | "TD" | "">,
        },
        clientContext: {
          localLogExportIncluded: false,
          appVersion: "hosted-phase-3",
        },
      };
      await hostedReview.onSubmitReview(output);
      alert("Hosted review submitted.");
    } catch (err) {
      console.error("Hosted review submission failed.", err);
      alert("Hosted review submission failed.");
    } finally {
      setHostedSubmitBusy(false);
    }
  }

  async function performSaveWith(values?: { name: string; reviewers: string[] }) {
    const baseName = stripExt(values?.name || saveName || projectName || "project");
    const out = await buildErcpProjectSnapshot(baseName);

    const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
    const codes = (values?.reviewers || []).map(s => s.trim().toLowerCase()).filter(Boolean).map(s => {
      if (s === 'khalid' || s === 'kah') return 'kah';
      if (s === 'venkat' || s === 'va') return 'va';
      if (s === 'jianing' || s === 'jli') return 'jli';
      return s.replace(/[^a-z0-9_-]+/g, '');
    }).filter(Boolean);
    const suffix = codes.length ? '_' + codes.join('_') : '';
    const savedFilename = `${baseName}${suffix}.ercp`;
    downloadBlob(blob, savedFilename);
    logSaveProject(savedFilename);
    setHasUnsaved(false);
    void idbDelete().catch(() => {});
  }
  async function onOpenProject(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const allImgs: ImageItem[] = [];

    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      const text = await f.text();
      const parsed = JSON.parse(text);

      if (parsed.schema !== "ercp-papilla-v1") {
        alert(`File ${f.name} is not an ERCP project (schema="${parsed.schema ?? "unknown"}"). Skipping.`);
        continue;
      }
      const frames = Array.isArray(parsed.frames) ? parsed.frames : [];

      for (const fr of frames as any[]) {
        const baseURL = fr.baseURL;
        const imgEl = await dataURLToImage(baseURL);
        const w = Number(fr.width || fr.w);
        const h = Number(fr.height || fr.h);
        // Reconstruct one LabelSpec per ERCP class (provides the pen/eraser canvases).
        const labels: LabelSpec[] = [];
        for (const def of TIER2A_LABELS) {
          const lab = makeLabel(def.id, def.name, def.color);
          ensureCanvasSize(lab, w, h);
          const maskPNG = fr.label_masks?.[String(def.id)];
          if (maskPNG) {
            const mimg = await dataURLToImage(maskPNG);
            lab.ctx!.clearRect(0, 0, w, h);
            lab.ctx!.drawImage(mimg, 0, 0);
            lab.rev = (lab.rev || 0) + 1;
          }
          labels.push(lab);
        }
        const thumbURL = makeThumb(imgEl, 120);
        const sourceTimestamp: number | null = typeof fr.sourceTimestamp === "number" ? fr.sourceTimestamp : null;
        const metadata: FrameMetadata = {
          ...makeDefaultFrameMetadata(),
          ...(fr.frame_metadata || {}),
        };
        const annotations: AnnotationInstance[] = Array.isArray(fr.annotations) ? fr.annotations : [];
        const keypoints: KeypointInstance[] = Array.isArray(fr.keypoints) ? fr.keypoints : [];
        allImgs.push({
          id: fr.imageId || uid(),
          name: fr.name,
          w, h,
          baseURL,
          thumbURL,
          labels,
          history: [],
          redo: [],
          station: "",
          sourceTimestamp,
          annotations,
          keypoints,
          metadata,
        });
      }

      logProjectOpen(f.name, null, allImgs);
    }

    if (allImgs.length === 0) {
      e.currentTarget.value = "";
      return;
    }

    const firstName = stripExt(files[0].name);
    setProjectName(files.length > 1 ? `${firstName} +${files.length - 1} more` : firstName);
    setCompatibilityMode(null);
    setShowCompatibilityBanner(false);
    setProject({ images: allImgs, current: 0, opened: true });
    setActiveId(1);
    setSelectedIds(new Set());
    e.currentTarget.value = "";
    resetView(); scheduleRedraw();
  }

  /* -------------------- resizers -------------------- */

  function onHBarDown(e: React.MouseEvent<HTMLDivElement>) {
    resizingH.current = { startX: e.clientX, startW: leftWidth };
    window.addEventListener("mousemove", onHMove); window.addEventListener("mouseup", onHUp);
  }
  function onHMove(e: MouseEvent) {
    if (!resizingH.current) return; const dx = e.clientX - resizingH.current.startX;
    setLeftWidth(Math.max(200, Math.min(600, resizingH.current.startW + dx)));
    // Live update label pane size for responsive label layout
    handleSizeChange();
  }
  function onHUp() { resizingH.current = null; window.removeEventListener("mousemove", onHMove); window.removeEventListener("mouseup", onHUp); handleSizeChange(); }
  function onHBarTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    const t = e.touches[0];
    resizingH.current = { startX: t.clientX, startW: leftWidth };
    window.addEventListener('touchmove', onHBarTouchMove, { passive: false });
    window.addEventListener('touchend', onHBarTouchEnd);
  }
  function onHBarTouchMove(e: TouchEvent) {
    if (!resizingH.current) return; e.preventDefault();
    const t = e.touches[0];
    const dx = t.clientX - resizingH.current.startX;
    setLeftWidth(Math.max(200, Math.min(600, resizingH.current.startW + dx)));
    handleSizeChange();
  }
  function onHBarTouchEnd() {
    resizingH.current = null;
    window.removeEventListener('touchmove', onHBarTouchMove as any);
    window.removeEventListener('touchend', onHBarTouchEnd as any);
    handleSizeChange();
  }

  // (vertical resizer handlers removed)

  /* -------------------- styles -------------------- */
  const app: React.CSSProperties = {
    display: "flex",
    height: isHostedReview ? "100%" : 'calc(var(--app-vh, 100dvh))',
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    background: C.bg,
    color: C.text,
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    overflow: "hidden",
  };
  const leftPane: React.CSSProperties = {
    width: currentLeftW, minWidth: 56, maxWidth: 600,
    minHeight: 0,
    overflow: "hidden",
    borderRight: `1px solid ${C.line2}`, background: C.panel, display: "flex", flexDirection: "column"
  };
  const hBar: React.CSSProperties = { width: isPhone ? 10 : 6, cursor: "col-resize", background: C.line2 };
  const rightPane: React.CSSProperties = {
    flex: 1,
    width: "auto",
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    position: "relative",
  };
  const topArea: React.CSSProperties = {
    flex: '1 1 auto',
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    display: "flex", alignItems: "stretch", justifyContent: "stretch",
    background: "#000", position: "relative",
  };
  function onSidebarDragHandleDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const ia = imageAreaRef.current;
    if (!ia) return;
    const parentRect = ia.getBoundingClientRect();
    sidebarDragRef.current = {
      ox: sidebarPos.x,
      oy: sidebarPos.y,
      mx: e.clientX - parentRect.left,
      my: e.clientY - parentRect.top,
    };
  }
  function onSidebarDragHandleMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!sidebarDragRef.current) return;
    const ia = imageAreaRef.current;
    if (!ia) return;
    const parentRect = ia.getBoundingClientRect();
    const { ox, oy, mx, my } = sidebarDragRef.current;
    const cx = e.clientX - parentRect.left;
    const cy = e.clientY - parentRect.top;
    const newX = Math.max(0, Math.min(parentRect.width - 52, ox + (cx - mx)));
    const newY = Math.max(0, Math.min(parentRect.height - 60, oy + (cy - my)));
    setSidebarPos({ x: newX, y: newY });
  }
  function onSidebarDragHandleUp() {
    sidebarDragRef.current = null;
  }

  function cancelActiveStroke() {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPtRef.current = null;
    strokePathRef.current = [];
    activeStrokeLabelRef.current = null;
    strokeTransformRef.current = null;
    strokeStartSnapshot.current = null;
    resetPreviewState();
    scheduleRedraw();
  }
  const SIDEBAR_W = 52;
  const toolbar: React.CSSProperties = {
    position: "absolute", top: 0, left: 0, right: 0,
    display: "flex",
    gap: toolbarCompact ? 6 : 8,
    alignItems: "center",
    flexWrap: toolbarCompact ? "nowrap" : "wrap",
    overflowX: toolbarCompact ? "auto" : "visible",
    background: C.panel,
    padding: "8px 10px",
    borderBottom: `1px solid ${C.line}`,
    zIndex: 5,
    minWidth: 0,
  };
  const toolSidebar: React.CSSProperties = {
    position: "absolute",
    left: sidebarPos.x,
    top: sidebarPos.y,
    width: SIDEBAR_W,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    paddingTop: 4,
    paddingBottom: 8,
    background: C.panel,
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
    zIndex: 10,
    overflow: "visible",
    userSelect: "none",
  };
  const canvasWrap: React.CSSProperties = {
    position: "absolute",
    top: toolbarH,
    left: 0,
    right: 0,
    bottom: 0,
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
  };
  const labelPickerBackdrop: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    background: "transparent",
    border: 0,
    padding: 0,
    margin: 0,
    zIndex: 6,
  };
  const labelPickerPanel: React.CSSProperties = {
    position: "absolute",
    right: 8,
    bottom: 12,
    width: isPhone ? "calc(100% - 24px)" : 340,
    maxWidth: "calc(100% - 24px)",
    maxHeight: isPhone ? "min(62vh, 520px)" : "min(56vh, 560px)",
    background: C.panel,
    color: C.text,
    border: `1px solid ${C.line}`,
    borderRadius: 16,
    boxShadow: "0 20px 48px rgba(0,0,0,0.24)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    zIndex: 7,
  };
  const labelPickerHeader: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    padding: "12px 14px",
    borderBottom: `1px solid ${C.line}`,
    background: C.panel2,
  };
  const labelPickerList: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 10,
    overflowY: "auto",
    minHeight: 0,
  };
  const labelPickerButton = (selected: boolean, color: string): React.CSSProperties => ({
    borderRadius: 12,
    padding: 10,
    background: C.panel,
    border: `2px solid ${selected ? color : C.line}`,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: "100%",
    minWidth: 0,
    textAlign: "left",
  });
  const btn: React.CSSProperties = {
    padding: toolbarCompact ? "6px 8px" : "6px 10px",
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: C.line,
    background: C.bg2,
    color: C.text,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600
  };
  const btnActive: React.CSSProperties = { ...btn, background: C.accent, borderColor: C.accent, color: C.chipBg };
  // Sidebar icon button styles
  const sideBtn: React.CSSProperties = {
    width: 36, height: 36, borderRadius: 8,
    border: `1px solid ${C.line}`,
    background: C.bg2,
    color: C.text,
    cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    flexShrink: 0,
  };
  const sideBtnActive: React.CSSProperties = {
    ...sideBtn,
    background: C.accent, borderColor: C.accent, color: C.chipBg,
  };
  const sideDivider: React.CSSProperties = {
    width: 28, height: 1, background: C.line, margin: "4px 0", flexShrink: 0,
  };
  const exportBtn: React.CSSProperties = { ...btn, background: C.brand, borderColor: C.brand, color: "#fff" };
  const settingsBtn: React.CSSProperties = { ...btn, display: "flex", alignItems: "center", gap: 6 };
  const imgListItem = (active: boolean): React.CSSProperties => {
    const base: React.CSSProperties = {
      display: "flex",
      gap: 10,
      padding: 8,
      alignItems: "center",
      borderBottom: `1px solid ${C.line2}`,
      background: active ? C.panel2 : "transparent",
      cursor: "pointer",
      borderRadius: 8,
      position: "relative"
    };
    if (active) {
      // Stronger, obvious selection affordance
      base.boxShadow = `0 0 0 2px ${C.brand} inset`;
    }
    return base;
  };
  const nameInput: React.CSSProperties = {
    width: "100%",
    background: C.panel2,
    color: C.text,
    border: `1px solid ${C.line}`,
    borderRadius: 6,
    padding: "4px 6px",
    fontSize: 12,
    userSelect: "text",
    WebkitUserSelect: "text"
  };
  // Prevent browser text selection highlight during multi-select in image list (sidebar)
  function suppressTextSelectionOnMouseDown(e: React.MouseEvent) {
    // When doing multi-select (shift or meta/ctrl), prevent browser text selection highlight
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      (window.getSelection && window.getSelection()?.removeAllRanges?.());
    }
  }

  function shortName(full: string) {
    if (!(isPhone || layoutMode === 'abbr')) return full;
    const def = TIER2A_LABELS.find(l => l.name === full);
    return def?.abbr || full.slice(0, 4).toUpperCase();
  }

  const chipDot = (color: string, small = false): React.CSSProperties => {
    const s = small ? 8 : 12;
    return { width: s, height: s, borderRadius: 999, background: color, boxShadow: `0 0 0 2px ${C.chipBg} inset` };
  };

  // rename helpers
  function startRename(im: ImageItem) { setEditingId(im.id); setEditingText(im.name); }
  function commitRename() {
    if (!editingId) return; const name = editingText.trim(); if (!name) { setEditingId(null); return; }
    setProject(prev => ({ ...prev, images: prev.images.map(im => im.id === editingId ? { ...im, name } : im) })); setEditingId(null);
  }

  // icons
  const IconGear = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="2"/><path d="M19.4 15a8 8 0 0 0 0-2l2-1.6-2-3.46-2.4.5a8.3 8.3 0 0 0-1.7-1L13 3H9l-.3 2.44a8.3 8.3 0 0 0-1.7 1l-2.4-.5-2 3.46 2 1.6a8 8 0 0 0 0 2l-2 1.6 2 3.46 2.4-.5a8.3 8.3 0 0 0 1.7 1L9 21h4l.3-2.44a8.3 8.3 0 0 0 1.7-1l2.4.5 2-3.46-2-1.6Z" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconUndo = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M7 7H3v4" stroke="currentColor" strokeWidth="2"/><path d="M3 11c2.5-3 6-5 10-5a8 8 0 1 1-8 9" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconRedo = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 7h4v4" stroke="currentColor" strokeWidth="2"/><path d="M21 11c-2.5-3-6-5-10-5a8 8 0 1 0 8 9" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconZoomIn = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2"/><path d="M11 8v6M8 11h6" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconZoomOut = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2"/><path d="M8 11h6" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconZoomReset = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/><path d="M4 11a7 7 0 0 1 7-7" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconEye = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconEyeOff = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 3l18 18" stroke="currentColor" strokeWidth="2"/><path d="M10.58 10.58A3 3 0 0 0 12 15a3 3 0 0 0 2.42-1.24" stroke="currentColor" strokeWidth="2"/><path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a18.73 18.73 0 0 1-5.06 5.94M6.11 6.11A18.78 18.78 0 0 0 1 12s4 7 11 7a10.93 10.93 0 0 0 2.12-.21" stroke="currentColor" strokeWidth="2"/></svg>);
  const IconFillOn = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M2 12l7-7 7 7-7 7-7-7Z" stroke="currentColor" strokeWidth="2" fill="currentColor"/>
      <path d="M19 14c2 2 2 4 0 6s-6 2-6 0 4-6 6-6Z" fill="currentColor"/>
    </svg>
  );
  const IconFillOff = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M2 12l7-7 7 7-7 7-7-7Z" stroke="currentColor" strokeWidth="2" fill="none"/>
      <path d="M19 14c2 2 2 4 0 6s-6 2-6 0 4-6 6-6Z" stroke="currentColor" strokeWidth="2" fill="none"/>
    </svg>
  );
  const IconGrip = () => (<svg width="14" height="10" viewBox="0 0 14 10" fill="currentColor" style={{ opacity: 0.45 }}><circle cx="3" cy="2.5" r="1.2"/><circle cx="7" cy="2.5" r="1.2"/><circle cx="11" cy="2.5" r="1.2"/><circle cx="3" cy="7.5" r="1.2"/><circle cx="7" cy="7.5" r="1.2"/><circle cx="11" cy="7.5" r="1.2"/></svg>);

  // sidebar selection logic
  function onItemClick(e: React.MouseEvent, index: number, id: string) {
    // Clear any accidental browser text selection highlight
    try { window.getSelection()?.removeAllRanges(); } catch {}
    const meta = e.metaKey || e.ctrlKey;
    const shift = e.shiftKey;
    if (meta) {
      // toggle selection, don't open
      setSelectedIds(prev => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id); else n.add(id);
        return n;
      });
      lastClickedIndex.current = index;
      return;
    }
    if (shift && lastClickedIndex.current !== null) {
      // range select
      const start = Math.min(lastClickedIndex.current, index);
      const end = Math.max(lastClickedIndex.current, index);
      const range = project.images.slice(start, end + 1).map(im => im.id);
      setSelectedIds(prev => {
        const n = new Set(prev);
        range.forEach(i => n.add(i));
        return n;
      });
      return;
    }
    // normal click: open & clear selection
    setSelectedIds(new Set());
    switchImage(index);
    lastClickedIndex.current = index;
  }

  // Global visibility toggle
  function toggleAllVisibility() {
    const next = !allVisible;
    setAllVisible(next);
    scheduleRedraw();
  }

  // Global Fill helpers
  function allFillsOn(): boolean {
    if (!current) return false;
    return current.labels.every(l => l.displayFill);
  }
  function toggleAllFills() {
    if (!current) return;
    const next = !allFillsOn();
    current.labels.forEach(l => { l.displayFill = next; });
    setProject({ ...project });
    scheduleRedraw();
  }
  const activeLabelSpec = activeLabel();

  return (
    <div style={app} className="no-text-select">
      {/* LEFT: Images */}
      <aside style={leftPane}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 10, borderBottom: `1px solid ${C.line2}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              style={{ ...btn, padding: '4px 6px', minWidth: 0 }}
              onClick={() => { setLeftCollapsed(!leftCollapsed); requestAnimationFrame(handleSizeChange); }}
              title={leftCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >{leftCollapsed ? '»' : '«'}</button>
            <div style={{ fontSize: 13, fontWeight: 800, display: leftCollapsed ? 'none' : 'block' }}>{projectName}</div>
          </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            style={btn}
            onClick={() => {
              if (selectedIds.size > 0) {
                void exportCocoBulkSelected();
              } else {
                void exportCocoCurrent();
              }
            }}
            disabled={!project.images.length}
            title={
              selectedIds.size > 0
                ? (selectedIds.size === project.images.length ? 'Export all' : 'Export selected')
                : 'Export'
            }
          >
            {selectedIds.size > 0
              ? (selectedIds.size === project.images.length ? 'Export all' : 'Export selected')
              : 'Export'}
          </button>
          {!isHostedReview && (
            <label style={{ ...btn, display: "inline-block" }}>
              Add frames
              <input type="file" accept="image/*,application/octet-stream" multiple onChange={onPickImages} style={{ display: 'none' }} onClick={(e) => { (e.currentTarget as HTMLInputElement).value = ''; }} />
            </label>
          )}
        </div>
        </div>

        {/* Legacy / compatibility warning banner */}
        {compatibilityMode && showCompatibilityBanner && !leftCollapsed && (
          <div style={{
            background: theme === 'dark' ? '#451a03' : '#fef3c7',
            color: theme === 'dark' ? '#fcd34d' : '#92400e',
            borderBottom: `1px solid ${theme === 'dark' ? '#78350f' : '#fcd34d'}`,
            padding: '8px 10px',
            fontSize: 11,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
          }}>
            <div style={{ flex: 1 }}>{compatibilityMode === "restricted-v2" ? (
              <>
                <strong>Compatibility-restricted project</strong> - Stored labels using IDs 2-9 do not match the current liver landmark ontology.
                Those labels are loaded exactly as saved and are <strong>not</strong> remapped or shown as liver landmark masks.
                In this session, only label ID 1 is visible and actionable.
              </>
            ) : (
              <>
              <strong>Legacy file (v1 - pancreatic EUS)</strong> - Legacy <code>.eus</code> pancreas projects can be opened in this liver tool.
              Station may be blank because old files did not store TG/TD, so reassign it manually before exporting.
              Old pancreas labels are loaded exactly as saved and are <strong>not</strong> remapped to liver labels.
              In the current liver landmark workflow, only label ID 1 is visible and actionable; legacy IDs 2-9 remain loaded but inaccessible.
              </>)}</div>
            <button
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 14, padding: 0, lineHeight: 1, flexShrink: 0 }}
              onClick={() => setShowCompatibilityBanner(false)}
              title="Dismiss"
            >✕</button>
          </div>
        )}

        <div
          style={{ flex: 1, overflow: 'auto', display: leftCollapsed ? 'none' : 'block', WebkitUserSelect: 'none', userSelect: 'none' }}
          onMouseDown={suppressTextSelectionOnMouseDown}
        >
          {project.images.map((im, i) => {
            const active = i === project.current;
            const multiSel = selectedIds.has(im.id);
            return (
              <div
                key={im.id}
                style={{ ...imgListItem(active), outline: multiSel ? `2px solid ${C.brand}` : "none", outlineOffset: -2 }}
                onClick={(e) => onItemClick(e, i, im.id)}
                onContextMenu={(e) => { e.preventDefault(); startRename(im); }}
                onMouseDown={suppressTextSelectionOnMouseDown}
              >
                {(() => {
                  const ringColor = frameCompletionColor({
                    annotations: im.annotations,
                    keypoints: im.keypoints,
                    metadata: im.metadata,
                  });
                  const wrap: React.CSSProperties = {
                    width: 48, height: 48, borderRadius: 10, padding: 2,
                    border: `2px solid ${ringColor}`, flex: "0 0 auto",
                  };
                  const inner: React.CSSProperties = {
                    width: "100%", height: "100%", objectFit: "cover", borderRadius: 6, display: "block",
                  };
                  return im.thumbURL ? (
                    <div style={wrap}><img src={im.thumbURL} alt="thumb" style={inner} /></div>
                  ) : (
                    <div style={wrap}><div style={{ ...inner, background: C.bg2 }} /></div>
                  );
                })()}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingId === im.id ? (
                    <input autoFocus value={editingText} onChange={(e) => setEditingText(e.target.value)}
                           onBlur={commitRename} onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setEditingId(null); }}
                           style={nameInput} />
                  ) : (
                    <div onDoubleClick={() => startRename(im)} title={im.name} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 12 }}>
                      {im.name}
                    </div>
                  )}
                  <div
                    style={{
                      display: "inline-flex",
                      gap: 6,
                      alignItems: "center",
                      flexWrap: "nowrap",
                      marginTop: 4,
                      width: "fit-content"
                    }}
                  >
                    {(() => {
                      const setStation = (val: "TG" | "TD") => {
                        // Toggle off if already selected; otherwise switch to the new value.
                        const next: "TG" | "TD" | "" = im.station === val ? "" : val;
                        const nextImages = projectRef.current.images.map((it, idx) => idx === i ? { ...it, station: next } : it);
                        setProject(prev => ({
                          ...prev,
                          images: nextImages
                        }));
                        const nextFrame = nextImages[i];
                        logEditCommit({ frame: nextFrame, station: next, tool: "station", action: "station_change", imagesOverride: nextImages });
                      };
                      const stationBtnStyle = (val: "TG" | "TD"): React.CSSProperties => ({
                        padding: '2px 7px',
                        borderRadius: 6,
                        border: `1px solid ${im.station === val ? C.brand : C.line}`,
                        background: im.station === val ? C.brand : 'transparent',
                        color: im.station === val ? '#fff' : C.sub,
                        cursor: 'pointer',
                        fontSize: 11,
                        fontWeight: 700,
                      });
                      return (
                        <>
                          <span style={{ fontSize: 11, color: C.sub, fontWeight: 600, userSelect: 'none' }}>Station:</span>
                          <button
                            style={stationBtnStyle("TG")}
                            onClick={(ev) => { ev.stopPropagation(); setStation("TG"); }}
                            onMouseDown={(ev) => ev.stopPropagation()}
                            title="Transgastric — probe in stomach, imaging left lobe"
                          >TG</button>
                          <button
                            style={stationBtnStyle("TD")}
                            onClick={(ev) => { ev.stopPropagation(); setStation("TD"); }}
                            onMouseDown={(ev) => ev.stopPropagation()}
                            title="Transduodenal — probe in duodenum, imaging right lobe"
                          >TD</button>
                        </>
                      );
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* bottom controls */}
        <div style={{ padding: 10, borderTop: `1px solid ${C.line2}`, display: leftCollapsed ? 'none' : 'flex', gap: 6, flexWrap: 'wrap' }}>
          {!isHostedReview ? (
            <>
              <>
                <button
                  style={{ ...btn, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={() => openProjectInputRef.current?.click()}
                >
                  {project.opened ? 'Change project' : 'Open project'}
                </button>
                <input
                  ref={openProjectInputRef}
                  type="file"
                  multiple
                  // Be permissive for iPadOS Files picker; allow any, plus our explicit types
                  accept="*/*,.ercp,application/json"
                  onChange={onOpenProject}
                  // Keep it visually hidden but present in the DOM
                  style={{ position: 'fixed', left: -9999, width: 0, height: 0, opacity: 0 }}
                  onClick={(e) => { (e.currentTarget as HTMLInputElement).value = ''; }}
                />
              </>
              <button
                style={{ ...btn, ...(hasUnsaved ? { borderColor: "#f59e0b", color: "#f59e0b" } : {}) }}
                onClick={onSaveProject}
                disabled={!project.images.length}
                title={hasUnsaved ? "Unsaved changes" : "Project saved"}
              >
                {hasUnsaved ? "● Save project" : "Save project"}
              </button>
              {project.images.length > 0 && (
                <div style={{ fontSize: 10, color: autoSaveStatus === "error" ? "#ef4444" : C.sub, marginTop: 2 }}>
                  {autoSaveStatus === "saving" ? "Auto-saving…" :
                   autoSaveStatus === "error" ? "Auto-save failed" :
                   autoSaveTime ? `Auto-saved ${autoSaveTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` :
                   hasUnsaved ? "Auto-save in ~1 min" : ""}
                </div>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%' }}>
              <button
                style={{ ...btn, borderColor: C.brand, background: C.brand, color: '#fff' }}
                onClick={() => { void submitHostedReview(); }}
                disabled={!project.images.length || hostedSubmitBusy || !hostedReview?.manifest.permissions.canSubmit}
              >
                {hostedSubmitBusy ? 'Submitting...' : 'Submit hosted review'}
              </button>
              <div style={{ fontSize: 12, color: C.sub, display: 'flex', alignItems: 'center' }}>
                Final submission only. Durable draft save is not enabled in this phase.
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Vertical resizer */}
      <div style={hBar} onMouseDown={onHBarDown} onTouchStart={onHBarTouchStart} />

      {/* RIGHT: Workspace */}
      <div style={rightPane} ref={rightPaneRef}>
        {/* Top: Image area */}
        <div ref={imageAreaRef} style={topArea}>
          {/* toolbar (flush at top) */}
          <div style={toolbar} ref={toolbarRef}>
            {/* Global visibility toggle */}
            <button style={btn} onClick={toggleAllVisibility} title={allVisible ? "Hide all masks" : "Show all masks"}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {allVisible ? <IconEye /> : <IconEyeOff />}
                {!toolbarCompact && (allVisible ? " Masks on" : " Masks off")}
              </span>
            </button>

            {/* Global Fill toggle */}
            <button style={btn} onClick={toggleAllFills} title={allFillsOn() ? "Hide all fills" : "Show all fills"}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {allFillsOn() ? <IconFillOn /> : <IconFillOff />}
                {!toolbarCompact && (allFillsOn() ? " Fill: On" : " Fill: Off")}
              </span>
            </button>

            <button
              style={showFrameMetadata ? btnActive : btn}
              onClick={() => setShowFrameMetadata(v => !v)}
              title="Frame metadata: procedural state, quality flags, usability"
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>ℹ</span>
                {!toolbarCompact && " Frame info"}
              </span>
            </button>

            <button
              style={showProgress ? btnActive : btn}
              onClick={() => setShowProgress(v => !v)}
              title="Project progress: per-class counts + usable-frame totals"
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}>📊</span>
                {!toolbarCompact && " Progress"}
              </span>
            </button>

            <button
              style={showLabelPicker ? btnActive : btn}
              onClick={() => setShowLabelPicker(v => !v)}
              title="Open annotation labels"
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <div style={chipDot(activeLabelSpec?.color || C.line)} />
                {!toolbarCompact ? `Labels: ${activeLabelSpec ? shortName(activeLabelSpec.name) : "None"}` : "Labels"}
              </span>
            </button>

            {/* Undo / Redo */}
            <button style={btn} onClick={doUndo} title="Undo (Cmd/Ctrl+Z)">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconUndo />{!toolbarCompact && ' Undo'}
              </span>
            </button>
            <button style={btn} onClick={doRedo} title="Redo (Shift+Cmd/Ctrl+Z)">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconRedo />{!toolbarCompact && ' Redo'}
              </span>
            </button>

            {/* Spacer */}
            <div style={{ flex: 1 }} />

            {/* Zoom controls */}
            <button style={btn} onClick={zoomOutBtn} title="Zoom out (Ctrl/Cmd -)">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconZoomOut />
                {/* No label for zoom in compact mode */}
              </span>
            </button>
            <button style={btn} onClick={zoomInBtn} title="Zoom in (Ctrl/Cmd +)">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconZoomIn />
              </span>
            </button>
            <button style={btn} onClick={zoomResetBtn} title="Reset zoom (Ctrl/Cmd 0)">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <IconZoomReset />
              </span>
            </button>

            {/* Settings */}
            <button style={settingsBtn} onClick={() => setShowSettings(true)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <IconGear />{!toolbarCompact && ' Settings'}
              </span>
            </button>
          </div>

          {/* Right tool sidebar */}
          <div style={toolSidebar} ref={sidebarRef}>
            {/* Drag handle */}
            <div
              style={{ width: "100%", height: 22, display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", flexShrink: 0, touchAction: "none" }}
              onPointerDown={onSidebarDragHandleDown}
              onPointerMove={onSidebarDragHandleMove}
              onPointerUp={onSidebarDragHandleUp}
              onPointerCancel={onSidebarDragHandleUp}
            >
              <IconGrip />
            </div>
            {/* Pen */}
            <button
              style={tool === "pen" ? sideBtnActive : sideBtn}
              onClick={() => { setTool("pen"); polygonPointsRef.current = []; polygonMousePtRef.current = null; }}
              title="Pen (P)"
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>P</span>
            </button>

            {/* Eraser with hover flyout */}
            <div
              style={{ position: "relative" }}
              onMouseEnter={openEraserMenu}
              onMouseLeave={scheduleCloseEraserMenu}
            >
              <button
                style={(tool === "circle-eraser" || tool === "stroke-eraser" || tool === "global-eraser") ? sideBtnActive : sideBtn}
                onClick={() => { setTool(eraserMode); polygonPointsRef.current = []; polygonMousePtRef.current = null; }}
                title="Eraser (E) — hover for options"
              >
                <span style={{ fontSize: 14, fontWeight: 700 }}>E</span>
              </button>
              {showEraserMenu && (
                <div
                  onMouseEnter={openEraserMenu}
                  onMouseLeave={scheduleCloseEraserMenu}
                  style={{
                  position: "absolute",
                  ...(sidebarPos.x < (imageAreaRef.current?.clientWidth ?? 800) / 2
                    ? { left: "100%", marginLeft: 2 }
                    : { right: "100%", marginRight: 2 }),
                  top: 0,
                  background: C.panel,
                  border: `1px solid ${C.line}`,
                  borderRadius: 10,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
                  padding: "6px",
                  display: "flex", flexDirection: "column", gap: 4,
                  zIndex: 20, minWidth: 140,
                }}>
                  <button
                    style={{ ...(eraserMode === "circle-eraser" ? sideBtnActive : sideBtn), width: "100%", height: 32, fontSize: 12, justifyContent: "flex-start", paddingLeft: 10 }}
                    onClick={() => { setEraserMode("circle-eraser"); setTool("circle-eraser"); setShowEraserMenu(false); }}
                    title="Circle eraser — paint to erase"
                  >
                    Circle
                  </button>
                  <button
                    style={{ ...(eraserMode === "stroke-eraser" ? sideBtnActive : sideBtn), width: "100%", height: 32, fontSize: 12, justifyContent: "flex-start", paddingLeft: 10 }}
                    onClick={() => { setEraserMode("stroke-eraser"); setTool("stroke-eraser"); setShowEraserMenu(false); }}
                    title="Stroke eraser — erase connected region"
                  >
                    Stroke
                  </button>
                  <button
                    style={{ ...(eraserMode === "global-eraser" ? sideBtnActive : sideBtn), width: "100%", height: 32, fontSize: 12, justifyContent: "flex-start", paddingLeft: 10 }}
                    onClick={() => { setEraserMode("global-eraser"); setTool("global-eraser"); setShowEraserMenu(false); }}
                    title="Global eraser — erase across all labels"
                  >
                    Global
                  </button>
                </div>
              )}
            </div>

            {/* Select */}
            <button
              style={tool === "select" ? sideBtnActive : sideBtn}
              onClick={() => { setTool("select"); polygonPointsRef.current = []; polygonMousePtRef.current = null; }}
              title="Select (S) — click mask, drag to move, open Labels to relabel"
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>S</span>
            </button>

            <div style={sideDivider} />

            {/* Keypoint */}
            <button
              style={tool === "keypoint" ? sideBtnActive : sideBtn}
              onClick={() => { setTool("keypoint"); polygonPointsRef.current = []; polygonMousePtRef.current = null; }}
              title="Keypoint (K) — click to place a named landmark"
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>K</span>
            </button>

            {/* Polygon */}
            <button
              style={tool === "polygon" ? sideBtnActive : sideBtn}
              onClick={() => { setTool("polygon"); polygonPointsRef.current = []; polygonMousePtRef.current = null; }}
              title="Polygon (O) — click vertices, double-click to fill"
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>O</span>
            </button>

            <div style={sideDivider} />

            {/* Copy above with hover flyout */}
            <div
              style={{ position: "relative" }}
              onMouseEnter={openCopyMenu}
              onMouseLeave={scheduleCloseCopyMenu}
            >
              <button
                style={{ ...sideBtn, opacity: project.current === 0 ? 0.4 : 1 }}
                disabled={project.current === 0}
                title="Copy from image above — hover for options"
              >
                <span style={{ fontSize: 16, fontWeight: 700 }}>↑</span>
              </button>
              {showCopyMenu && project.current > 0 && (
                <div
                  onMouseEnter={openCopyMenu}
                  onMouseLeave={scheduleCloseCopyMenu}
                  style={{
                    position: "absolute",
                    ...(sidebarPos.x < (imageAreaRef.current?.clientWidth ?? 800) / 2
                      ? { left: "100%", marginLeft: 2 }
                      : { right: "100%", marginRight: 2 }),
                    top: 0,
                    background: C.panel,
                    border: `1px solid ${C.line}`,
                    borderRadius: 10,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
                    padding: "6px",
                    display: "flex", flexDirection: "column", gap: 4,
                    zIndex: 20, minWidth: 150,
                  }}
                >
                  <button
                    style={{ ...(sideBtn), width: "100%", height: 32, fontSize: 12, justifyContent: "flex-start", paddingLeft: 10 }}
                    onClick={() => { copyLabelFromAbove(); setShowCopyMenu(false); }}
                    title="Copy active label from image above"
                  >
                    Current label
                  </button>
                  <button
                    style={{ ...(sideBtn), width: "100%", height: 32, fontSize: 12, justifyContent: "flex-start", paddingLeft: 10 }}
                    onClick={() => { copyMasksFromAbove(); setShowCopyMenu(false); }}
                    title="Copy all labels from image above"
                  >
                    All labels
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* offscreen image buffer + stage */}
          <div style={canvasWrap} ref={canvasWrapRef}>
            <canvas ref={baseCanvasRef} style={{ display: "none" }} />
            <canvas
              ref={stageRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onWheel={onWheel}
              onClick={onCanvasClick}
              onPointerCancel={() => cancelActiveStroke()}
              onPointerLeave={() => { cancelActiveStroke(); polygonMousePtRef.current = null; if (tool === "polygon" && polygonPointsRef.current.length > 0) scheduleRedraw(); }}
              style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: tool === "select" ? "default" : "crosshair" }}
            />
            <canvas
              ref={previewCanvasRef}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", pointerEvents: "none" }}
            />
          </div>

          {showLabelPicker ? (
            <>
              <button
                aria-label="Close annotation labels"
                onClick={() => setShowLabelPicker(false)}
                style={labelPickerBackdrop}
                type="button"
              />
              <div ref={bottomPaneRef} style={labelPickerPanel}>
                <div style={labelPickerHeader}>
                  <div>
                    <div style={{ fontSize: 11, letterSpacing: 0.08, textTransform: "uppercase", color: C.sub }}>
                      Annotation labels
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {activeLabelSpec ? `${activeLabelSpec.name} selected` : "Choose active label"}
                    </div>
                  </div>
                  <button
                    onClick={() => setShowLabelPicker(false)}
                    style={{ ...btn, padding: "4px 8px" }}
                    title="Close labels"
                    type="button"
                  >
                    Close
                  </button>
                </div>

                <div ref={labelsGridRef} style={labelPickerList}>
                  {current ? labelDisplayOrder.map(id => current.labels.find(l => l.id === id)!).filter(Boolean).map((l) => {
                    const selected = l.id === activeId;
                    return (
                      <div
                        key={l.id}
                        onClick={() => {
                          if (tool === "select" && selectedMaskId !== null && l.id !== selectedMaskId) {
                            transferMask(selectedMaskId, l.id);
                            setSelectedMaskId(l.id);
                            setActiveId(l.id);
                          } else {
                            setActiveId(l.id);
                          }
                          setShowLabelPicker(false);
                        }}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            if (tool === "select" && selectedMaskId !== null && l.id !== selectedMaskId) {
                              transferMask(selectedMaskId, l.id);
                              setSelectedMaskId(l.id);
                              setActiveId(l.id);
                            } else {
                              setActiveId(l.id);
                            }
                            setShowLabelPicker(false);
                          }
                        }}
                        role="button"
                        style={labelPickerButton(selected, l.color)}
                        tabIndex={0}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, width: "100%" }}>
                          <div style={chipDot(l.color)} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {l.name}
                            </div>
                            <div style={{ fontSize: 11, color: C.sub }}>
                              {selected ? "Active label" : "Select label"}
                            </div>
                          </div>
                          <button
                            onClick={(ev) => {
                              ev.stopPropagation();
                              l.visible = !l.visible;
                              setProject({ ...project });
                              scheduleRedraw();
                            }}
                            title={l.visible ? "Visible" : "Hidden"}
                            style={{
                              padding: "4px 8px",
                              borderRadius: 8,
                              border: `1px solid ${C.brand}`,
                              background: l.visible ? C.brand : "transparent",
                              color: l.visible ? "#fff" : C.brand,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              cursor: "pointer",
                              fontSize: 12,
                              fontWeight: 700,
                              minWidth: 36
                            }}
                            type="button"
                          >
                            {l.visible ? <IconEye /> : <IconEyeOff />}
                          </button>
                        </div>

                        {showFillActionInCards ? (
                          <div style={{ marginTop: 2 }}>
                            <button
                              onClick={(ev) => {
                                ev.stopPropagation();
                                fillHoles(l);
                                cleanMask(l);
                                l.rev = (l.rev || 0) + 1;
                                if (l.cache) { l.cache.tint = undefined; l.cache.outline = undefined; }
                                scheduleRedraw();
                              }}
                              style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg2, color: C.text, cursor: "pointer", fontSize: 12 }}
                              type="button"
                            >
                              Fill enclosed now
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : (
                    <div style={{ fontSize: 12, color: C.sub }}>Add frames to begin annotating.</div>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {/* Frame metadata panel — floats top-left, toggled by the Frame info toolbar button */}
          {showFrameMetadata && current && (() => {
            const { depth, seg } = computeUsableFlags(current);
            return (
              <div style={{
                position: "absolute",
                top: 64, left: 12,
                maxHeight: "calc(100% - 80px)",
                overflowY: "auto",
                zIndex: 8,
                display: "flex", flexDirection: "column", gap: 8,
              }}>
                <FrameMetadataPanel
                  metadata={current.metadata}
                  computedUsableDepth={depth}
                  computedUsableSeg={seg}
                  onClose={() => setShowFrameMetadata(false)}
                  onChange={(patch) => {
                    if (!current) return;
                    current.metadata = { ...current.metadata, ...patch };
                    recomputeUsableFlags(current);
                    setHasUnsaved(true);
                    setProject({ ...project });
                  }}
                />
                <SoftWarnings
                  annotations={current.annotations}
                  keypoints={current.keypoints}
                  metadata={current.metadata}
                />
              </div>
            );
          })()}

          {/* Progress sidebar — toggled from toolbar */}
          {showProgress && (
            <div style={{
              position: "absolute",
              top: 64, right: 12 + (selectedInstanceId ? 312 : 0),
              maxHeight: "calc(100% - 80px)",
              overflowY: "auto",
              zIndex: 8,
            }}>
              <ProgressSidebar
                frames={project.images.map(im => ({
                  annotations: im.annotations,
                  keypoints: im.keypoints,
                  metadata: im.metadata,
                }))}
                onClose={() => setShowProgress(false)}
              />
            </div>
          )}

          {/* Keypoint placement modal — opens on a click while the keypoint tool is active */}
          {keypointPlacingAt && current && (
            <KeypointModal
              onCancel={() => setKeypointPlacingAt(null)}
              onSubmit={(name: KeypointName, note: string | undefined) => {
                const at = keypointPlacingAt!;
                const before = current.keypoints.map(k => ({ ...k }));
                const kp: KeypointInstance = {
                  id: uid(),
                  name,
                  x: at.x,
                  y: at.y,
                  visibility: "visible",
                  ...(note ? { note } : {}),
                };
                current.keypoints = [...current.keypoints, kp];
                pushKeypointsHistory(before, current.keypoints.slice());
                setKeypointPlacingAt(null);
                setSelectedKeypointId(kp.id);
                scheduleRedraw();
                setProject({ ...project });
              }}
            />
          )}

          {/* AttributePanel — floats top-right of canvas when a polygon instance is selected */}
          {(() => {
            const selId = selectedInstanceId;
            const inst = selId && current ? current.annotations.find(a => a.id === selId) : null;
            const cls = inst ? ERCP_CLASS_BY_ID.get(inst.classId) : null;
            if (!inst || !cls) return null;
            const snapshotAnnotations = (): AnnotationInstance[] =>
              current!.annotations.map(a => ({
                ...a,
                geometry: a.geometry.kind === "polygon"
                  ? { kind: "polygon" as const, points: a.geometry.points.map(p => ({ x: p.x, y: p.y })) }
                  : { ...a.geometry },
                attributes: { ...a.attributes },
              }));
            const mutateInstance = (mut: (a: AnnotationInstance) => void) => {
              if (!current) return;
              const before = snapshotAnnotations();
              const target = current.annotations.find(a => a.id === selId);
              if (!target) return;
              mut(target);
              pushAnnotationsHistory(before, current.annotations.slice());
              scheduleRedraw();
              setProject({ ...project });
            };
            return (
              <div style={{
                position: "absolute",
                top: 64,            // below the toolbar
                right: 12,
                width: 300,
                maxHeight: "calc(100% - 80px)",
                overflowY: "auto",
                zIndex: 8,
              }}>
                <AttributePanel
                  instance={inst}
                  cls={cls}
                  onAttributeChange={(field, value) => mutateInstance(a => { a.attributes[field] = value; })}
                  onDepthRankChange={(rank) => mutateInstance(a => { a.depth_rank = rank; })}
                  onDelete={() => {
                    if (!current) return;
                    const before = snapshotAnnotations();
                    current.annotations = current.annotations.filter(a => a.id !== selId);
                    setSelectedInstanceId(null);
                    hoveredVertexRef.current = null;
                    pushAnnotationsHistory(before, current.annotations.slice());
                    scheduleRedraw();
                    setProject({ ...project });
                  }}
                />
              </div>
            );
          })()}
        </div>
      </div>

      {/* Settings Drawer */}
      {showSettings && (
        <div style={{
          position: "fixed", inset: 0, background: theme === "dark" ? "rgba(0,0,0,.5)" : "rgba(0,0,0,.3)",
          display: "flex", justifyContent: "flex-end", zIndex: 40
        }}
             onClick={() => setShowSettings(false)}>
          <div onClick={(e) => e.stopPropagation()}
               style={{ width: 360, height: "100%", background: C.panel, color: C.text, borderLeft: `1px solid ${C.line}`, padding: 16, overflow: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontWeight: 800 }}>Settings</div>
              <button style={btn} onClick={() => setShowSettings(false)}>Close</button>
            </div>

            <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Appearance</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={theme === "dark" ? btnActive : btn} onClick={() => setTheme("dark")}>Dark</button>
                <button style={theme === "light" ? btnActive : btn} onClick={() => setTheme("light")}>Light</button>
              </div>
            </div>

            <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Labels</div>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>
                Edit label colors here.
              </div>
              {project.images[project.current]?.labels?.map(l => (
                <div key={l.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px dashed ${C.line2}` }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={chipDot(l.color)} />
                    {l.name}
                  </span>
                  <input
                    type="color"
                    value={l.color}
                    onChange={(e) => {
                      l.color = e.target.value;
                      if (l.cache) { l.cache.tint = undefined; l.cache.outline = undefined; }
                      setProject({ ...project });
                      scheduleRedraw();
                    }}
                  />
                </div>
              ))}
            </div>

            <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Label Card Options</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={showFillActionInCards} onChange={(e) => setShowFillActionInCards(e.target.checked)} />
                Show “Fill enclosed now” buttons in label cards
              </label>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>
                Auto-fill of enclosed shapes is always enabled.
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                <input type="checkbox" checked={showFillToggles} onChange={(e) => setShowFillToggles(e.target.checked)} />
                Show per-label “Fill” toggle buttons in label cards
              </label>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>
                By default, per-label Fill toggles are hidden. Use the top-bar Fill switch to control fills globally.
              </div>
            </div>

            <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Annotation Log</div>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 10 }}>
                Stored locally in this browser only. Export downloads the current JSON log. Clear resets only the annotation log store.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={btn} onClick={exportAnnotationLog}>Export annotation log</button>
                <button
                  style={{ ...btn, borderColor: "#b91c1c", color: "#b91c1c" }}
                  onClick={clearAnnotationLog}
                >
                  Clear annotation log
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Save Dialog */}
      {showSaveDialog && (
        <div style={{ position: 'fixed', inset: 0, background: theme === 'dark' ? 'rgba(0,0,0,.5)' : 'rgba(0,0,0,.3)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 50 }} onClick={() => setShowSaveDialog(false)}>
          <div onClick={(e)=>e.stopPropagation()} style={{ width: 420, maxWidth: '90vw', background: C.panel, color: C.text, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,.3)' }}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>Save Project</div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>Project name</div>
              <input value={saveName} onChange={(e)=>setSaveName(e.target.value)} style={{ width: '100%', ...nameInput }} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>Reviewer(s)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={revKah} onChange={(e)=>setRevKah(e.target.checked)} /> Khalid (kah)
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={revVa} onChange={(e)=>setRevVa(e.target.checked)} /> Venkat (va)
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={revJli} onChange={(e)=>setRevJli(e.target.checked)} /> Jianing (jli)
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={revOtherOn} onChange={(e)=>setRevOtherOn(e.target.checked)} /> Other
                </label>
                {revOtherOn && (
                  <input value={revOtherText} onChange={(e)=>setRevOtherText(e.target.value)} placeholder="name of reviewer" style={{ ...nameInput, width: 140 }} />
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={btn} onClick={()=>setShowSaveDialog(false)}>Cancel</button>
              <button style={exportBtn} onClick={()=>{
                const reviewers: string[] = [];
                if (revKah) reviewers.push('kah');
                if (revVa) reviewers.push('va');
                if (revJli) reviewers.push('jli');
                if (revOtherOn && revOtherText.trim()) reviewers.push(revOtherText.trim());
                setShowSaveDialog(false);
                performSaveWith({ name: saveName, reviewers });
              }}>Save .ercp</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
