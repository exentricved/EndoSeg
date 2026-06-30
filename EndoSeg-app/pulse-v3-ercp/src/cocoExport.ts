/**
 * COCO-style export for ERCP annotations.
 *
 * One JSON file per image, schema matches ercp_annotator_spec.md:106-138:
 *
 * {
 *   "image_id": "...",
 *   "frame_metadata": { ... },
 *   "annotations": [
 *     { class, polygon, depth_rank, depth_rank_fixed, is_depth_discontinuity_boundary,
 *       is_occlusion_mask, attributes }
 *     { class, bbox, segmentation_png, depth_rank, ..., attributes }   // mask-geom
 *   ],
 *   "keypoints": [ { name, x, y, visibility, note? } ]
 * }
 *
 * Mask-geom instances come from two sources:
 *  1. existing AnnotationInstance with geometry.kind === "mask" (from a future
 *     instance-mode pen workflow)
 *  2. per-class LabelSpec canvases that have painted pixels (current v1 pen/eraser
 *     stores here) — each non-empty class becomes one mask-geom instance whose
 *     bbox is the tight rectangle of painted pixels.
 */

import type {
  AnnotationInstance,
  KeypointInstance,
  FrameMetadata,
  ErcpClassDef,
} from "./ercpClasses";
import { ERCP_CLASS_BY_ID } from "./ercpClasses";

type LabelCanvas = {
  id: number;
  canvas: HTMLCanvasElement;
};

export type CocoAnnotationOut = {
  class: string;
  depth_rank: number | null;
  depth_rank_fixed: boolean;
  is_depth_discontinuity_boundary: boolean;
  is_occlusion_mask: boolean;
  attributes: Record<string, string | number>;
  polygon?: number[][];           // [[x,y], ...]
  bbox?: [number, number, number, number];
  segmentation_png?: string;       // data URL for mask-geom
};

export type CocoExportFrame = {
  image_id: string;
  frame_metadata: {
    procedural_state: string;
    deformation_state: string;
    frame_quality_flags: string[];
    usable_for_depth_training: boolean;
    usable_for_segmentation_training: boolean;
  };
  annotations: CocoAnnotationOut[];
  keypoints: Array<{
    name: string;
    x: number;
    y: number;
    visibility: string;
    note?: string;
  }>;
};

function exportFromAnnotationInstance(a: AnnotationInstance, cls: ErcpClassDef): CocoAnnotationOut {
  const base: CocoAnnotationOut = {
    class: cls.name,
    depth_rank: a.depth_rank,
    depth_rank_fixed: a.depth_rank_fixed,
    is_depth_discontinuity_boundary: !!cls.exportAsDepthDiscontinuity,
    is_occlusion_mask: !!cls.exportAsOcclusionMask,
    attributes: a.attributes,
  };
  if (a.geometry.kind === "polygon") {
    return {
      ...base,
      polygon: a.geometry.points.map(p => [Math.round(p.x), Math.round(p.y)]),
    };
  }
  return {
    ...base,
    bbox: a.geometry.bbox,
    segmentation_png: a.geometry.maskPNG,
  };
}

/**
 * Connected-component labeling on the alpha channel of a canvas (4-connectivity).
 * Returns one entry per component, each with its tight bbox in canvas coords
 * and a cropped maskPNG containing only that component.
 *
 * Used for instance-segmentation export: a single SPECULAR_HIGHLIGHT canvas
 * with N disjoint glints produces N mask-geom AnnotationInstances instead of
 * one big union.
 */
function componentsFromCanvas(canvas: HTMLCanvasElement):
  Array<{ bbox: [number, number, number, number]; maskPNG: string }> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const W = canvas.width, H = canvas.height;
  if (W === 0 || H === 0) return [];
  const data = ctx.getImageData(0, 0, W, H).data;
  // labels[i] = 0 unlabeled, else component id (1-based)
  const labels = new Int32Array(W * H);
  const queue: number[] = [];
  type Comp = { id: number; minX: number; minY: number; maxX: number; maxY: number; pixels: number[] };
  const comps: Comp[] = [];

  for (let y0 = 0; y0 < H; y0++) {
    for (let x0 = 0; x0 < W; x0++) {
      const idx = y0 * W + x0;
      if (labels[idx] !== 0) continue;
      if (data[idx * 4 + 3] === 0) continue;
      const compId = comps.length + 1;
      const comp: Comp = { id: compId, minX: x0, minY: y0, maxX: x0, maxY: y0, pixels: [] };
      labels[idx] = compId;
      queue.length = 0;
      queue.push(idx);
      while (queue.length) {
        const p = queue.pop()!;
        comp.pixels.push(p);
        const x = p % W, y = (p - x) / W;
        if (x < comp.minX) comp.minX = x;
        if (y < comp.minY) comp.minY = y;
        if (x > comp.maxX) comp.maxX = x;
        if (y > comp.maxY) comp.maxY = y;
        // 4-neighbors
        if (x + 1 < W) {
          const n = p + 1;
          if (labels[n] === 0 && data[n * 4 + 3] > 0) { labels[n] = compId; queue.push(n); }
        }
        if (x - 1 >= 0) {
          const n = p - 1;
          if (labels[n] === 0 && data[n * 4 + 3] > 0) { labels[n] = compId; queue.push(n); }
        }
        if (y + 1 < H) {
          const n = p + W;
          if (labels[n] === 0 && data[n * 4 + 3] > 0) { labels[n] = compId; queue.push(n); }
        }
        if (y - 1 >= 0) {
          const n = p - W;
          if (labels[n] === 0 && data[n * 4 + 3] > 0) { labels[n] = compId; queue.push(n); }
        }
      }
      comps.push(comp);
    }
  }

  const out: Array<{ bbox: [number, number, number, number]; maskPNG: string }> = [];
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    // Skip degenerate single-pixel specks under 3 pixels (likely paint noise).
    if (c.pixels.length < 3) continue;
    const tight = document.createElement("canvas");
    tight.width = bw; tight.height = bh;
    const tctx = tight.getContext("2d")!;
    // Build a per-component cropped image: paint only the pixels in this component.
    const cropImg = tctx.createImageData(bw, bh);
    for (const p of c.pixels) {
      const x = p % W, y = (p - x) / W;
      const lx = x - c.minX, ly = y - c.minY;
      const di = (ly * bw + lx) * 4;
      cropImg.data[di + 0] = 255;
      cropImg.data[di + 1] = 255;
      cropImg.data[di + 2] = 255;
      cropImg.data[di + 3] = 255;
    }
    tctx.putImageData(cropImg, 0, 0);
    out.push({ bbox: [c.minX, c.minY, bw, bh], maskPNG: tight.toDataURL("image/png") });
  }
  return out;
}

/**
 * Per-class LabelSpec canvases become 0..N mask-geom annotations — one per
 * connected component. Empty classes produce no output.
 */
function exportFromLabelCanvases(labels: LabelCanvas[]): CocoAnnotationOut[] {
  const out: CocoAnnotationOut[] = [];
  for (const lab of labels) {
    const cls = ERCP_CLASS_BY_ID.get(lab.id);
    if (!cls) continue;
    for (const comp of componentsFromCanvas(lab.canvas)) {
      out.push({
        class: cls.name,
        depth_rank: cls.depthRank.mode === "fixed" ? cls.depthRank.value : cls.depthRank.default,
        depth_rank_fixed: cls.depthRank.mode === "fixed",
        is_depth_discontinuity_boundary: !!cls.exportAsDepthDiscontinuity,
        is_occlusion_mask: !!cls.exportAsOcclusionMask,
        attributes: {},
        bbox: comp.bbox,
        segmentation_png: comp.maskPNG,
      });
    }
  }
  return out;
}

export function buildCocoExportFrame(args: {
  imageId: string;
  metadata: FrameMetadata;
  annotations: AnnotationInstance[];
  keypoints: KeypointInstance[];
  labelCanvases: LabelCanvas[];
}): CocoExportFrame {
  const annOut: CocoAnnotationOut[] = [];
  for (const a of args.annotations) {
    const cls = ERCP_CLASS_BY_ID.get(a.classId);
    if (!cls) continue;
    annOut.push(exportFromAnnotationInstance(a, cls));
  }
  for (const m of exportFromLabelCanvases(args.labelCanvases)) {
    annOut.push(m);
  }

  return {
    image_id: args.imageId,
    frame_metadata: {
      procedural_state: args.metadata.procedural_state,
      deformation_state: args.metadata.deformation_state,
      frame_quality_flags: args.metadata.frame_quality_flags,
      usable_for_depth_training: args.metadata.usable_for_depth_training,
      usable_for_segmentation_training: args.metadata.usable_for_segmentation_training,
    },
    annotations: annOut,
    keypoints: args.keypoints.map(k => ({
      name: k.name, x: k.x, y: k.y, visibility: k.visibility,
      ...(k.note ? { note: k.note } : {}),
    })),
  };
}

/** Convenience: produce a Blob for one frame's COCO JSON. */
export function cocoExportBlob(frame: CocoExportFrame): Blob {
  return new Blob([JSON.stringify(frame, null, 2)], { type: "application/json" });
}
