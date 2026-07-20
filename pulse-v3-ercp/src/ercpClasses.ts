/**
 * ERCP papilla annotation class catalog + shared instance/metadata types.
 *
 * Single source of truth for:
 *  - annotation classes (PAPILLA_BODY, PAPILLA_ORIFICE, ...) with their colors,
 *    attribute schemas, and depth-rank policy
 *  - keypoint names (orifice rim points, fold tip, etc.)
 *  - frame-level metadata enums (procedural state, deformation, quality flags)
 *  - the per-instance / per-frame TypeScript types used in ImageItem
 *
 * App.tsx imports from here; UI components and exporters import from here too.
 */

export type Pt = { x: number; y: number };

/* -------------------- attribute schema -------------------- */
export type AttrSchema =
  | { kind: "dropdown"; field: string; options: string[]; default: string; tooltip?: string }
  | { kind: "integer";  field: string; min: number; max: number; widget?: "clockDial"; default?: number }
  | { kind: "freeText"; field: string };

/* -------------------- depth rank policy -------------------- */
export type DepthRank = 1 | 2 | 3 | 4 | null;
export type DepthRankPolicy =
  | { mode: "fixed";    value: DepthRank }
  | { mode: "editable"; default: 1 | 2 | 3 | 4 };

/* -------------------- class definition -------------------- */
export type ErcpClassDef = {
  id: number;            // 1..8 (matches 1-8 class hotkeys)
  name: string;          // "PAPILLA_BODY"
  abbr: string;          // "PB"
  color: string;         // hex; used as fill base + stroke
  depthRank: DepthRankPolicy;
  attributes: AttrSchema[];
  /** PAPILLA_ORIFICE: polygon boundary also serializes as a depth-discontinuity edge. */
  exportAsDepthDiscontinuity?: boolean;
  /** INSTRUMENT_MASK: exported as occlusion mask only, never used for depth training. */
  exportAsOcclusionMask?: boolean;
  /** INSTRUMENT_MASK: overlap with PAPILLA_ORIFICE flips usable_for_depth_training off. */
  triggersUnusableDepthIfOverlapsOrifice?: boolean;
};

/* -------------------- class catalog -------------------- */
export const ERCP_CLASSES: ErcpClassDef[] = [
  {
    id: 1,
    name: "PAPILLA_BODY",
    abbr: "PB",
    color: "#F472B6",
    depthRank: { mode: "editable", default: 2 },
    attributes: [
      { kind: "dropdown", field: "haraldsson_type",
        options: ["1", "2", "3a", "3b", "4", "D", "unknown"],
        default: "unknown",
        tooltip: "Haraldsson papilla morphotype" },
    ],
  },
  {
    id: 2,
    name: "PAPILLA_ORIFICE",
    abbr: "PO",
    color: "#A78BFA",
    depthRank: { mode: "fixed", value: 3 },
    exportAsDepthDiscontinuity: true,
    attributes: [
      { kind: "integer", field: "surface_normal_clock",
        min: 1, max: 12, widget: "clockDial" },
    ],
  },
  {
    id: 3,
    name: "HOODING_FOLD",
    abbr: "HF",
    color: "#FB923C",
    depthRank: { mode: "editable", default: 2 },
    attributes: [],
  },
  {
    id: 4,
    name: "PERIAMPULLARY_DIVERTICULUM",
    abbr: "PAD",
    color: "#7C3AED",
    depthRank: { mode: "fixed", value: 4 },
    attributes: [
      { kind: "dropdown", field: "papilla_position",
        options: ["intradiverticular", "at-rim", "adjacent"],
        default: "adjacent" },
    ],
  },
  {
    id: 5,
    name: "DUODENAL_WALL",
    abbr: "DW",
    color: "#FBBF24",
    depthRank: { mode: "editable", default: 1 },
    attributes: [],
  },
  {
    id: 6,
    name: "INSTRUMENT_MASK",
    abbr: "INS",
    color: "#9CA3AF",
    depthRank: { mode: "fixed", value: null },
    exportAsOcclusionMask: true,
    triggersUnusableDepthIfOverlapsOrifice: true,
    attributes: [],
  },
  {
    id: 7,
    name: "SPECULAR_HIGHLIGHT",
    abbr: "SH",
    color: "#FDE68A",
    depthRank: { mode: "fixed", value: null },
    attributes: [],
  },
  {
    id: 8,
    name: "FLUID_POOL",
    abbr: "FP",
    color: "#22D3EE",
    depthRank: { mode: "fixed", value: null },
    attributes: [],
  },
];

export const ERCP_CLASS_BY_ID = new Map<number, ErcpClassDef>(
  ERCP_CLASSES.map((c) => [c.id, c]),
);

export const ERCP_CLASS_BY_NAME = new Map<string, ErcpClassDef>(
  ERCP_CLASSES.map((c) => [c.name, c]),
);

export function classDefaultDepthRank(cls: ErcpClassDef): DepthRank {
  return cls.depthRank.mode === "fixed" ? cls.depthRank.value : cls.depthRank.default;
}

export function defaultAttributesFor(cls: ErcpClassDef): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const a of cls.attributes) {
    if (a.kind === "dropdown") out[a.field] = a.default;
    else if (a.kind === "integer" && a.default !== undefined) out[a.field] = a.default;
  }
  return out;
}

/* -------------------- keypoints -------------------- */
export const KEYPOINT_NAMES = [
  "ORIFICE_RIM_TOP",
  "ORIFICE_RIM_BOTTOM",
  "ORIFICE_RIM_LEFT",
  "ORIFICE_RIM_RIGHT",
  "FOLD_TIP",
  "PAPILLA_BASE_LEFT",
  "PAPILLA_BASE_RIGHT",
  "VASCULAR_MARK",
] as const;
export type KeypointName = (typeof KEYPOINT_NAMES)[number];

export type KeypointVisibility = "visible" | "partially-occluded" | "inferred";

/* -------------------- frame metadata enums -------------------- */
export const PROCEDURAL_STATES = [
  "pre-approach",
  "approaching",
  "wire-at-orifice",
  "PD-cannulated",
  "CBD-cannulated",
  "post-sphincterotomy",
  "under-traction",
] as const;
export type ProceduralState = (typeof PROCEDURAL_STATES)[number] | "";

export const DEFORMATION_STATES = [
  "resting",
  "mild-peristalsis",
  "strong-peristalsis",
] as const;
export type DeformationState = (typeof DEFORMATION_STATES)[number] | "";

export const QUALITY_FLAGS = [
  "motion-blur",
  "lens-contamination",
  "pre-flush-bubbles",
  "tangential-view",
  "inadequate-lighting",
] as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[number];

/* -------------------- instance + metadata types -------------------- */
export type PolygonGeom = { kind: "polygon"; points: Pt[] };
export type MaskGeom = {
  kind: "mask";
  bbox: [number, number, number, number]; // [x, y, w, h] in image coords
  maskPNG: string;                          // data URL, binary alpha, cropped to bbox
};

export type AnnotationInstance = {
  id: string;
  classId: number;
  geometry: PolygonGeom | MaskGeom;
  depth_rank: DepthRank;
  depth_rank_fixed: boolean;
  attributes: Record<string, string | number>;
};

export type KeypointInstance = {
  id: string;
  name: KeypointName;
  x: number;
  y: number;
  visibility: KeypointVisibility;
  note?: string;
};

export type FrameMetadata = {
  procedural_state: ProceduralState;
  deformation_state: DeformationState;
  frame_quality_flags: QualityFlag[];
  usable_for_depth_training: boolean;
  usable_for_segmentation_training: boolean;
  usable_for_depth_manual_override: boolean;
  usable_for_segmentation_manual_override: boolean;
};

export function makeDefaultFrameMetadata(): FrameMetadata {
  return {
    procedural_state: "",
    deformation_state: "",
    frame_quality_flags: [],
    usable_for_depth_training: true,
    usable_for_segmentation_training: true,
    usable_for_depth_manual_override: false,
    usable_for_segmentation_manual_override: false,
  };
}
