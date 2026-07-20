# ERCP Papilla Annotation Tool — Build Specification

Medical image annotation tool for endoscopic ERCP papilla images to create training data for monocular 3D reconstruction and robotic sphincterotome guidance.

---

## Tech Stack

- React frontend with canvas-based annotation
- Local JSON storage, no backend
- Images loaded via file picker
- Export as COCO-format JSON with custom fields

---

## Annotation: Polygon Tool

Manual vertex placement. Click to place vertices, double-click to close, Escape to cancel, drag vertices to adjust, Delete to remove selected polygon.

Each polygon has a **CLASS** and a **DEPTH RANK**.

### Depth Rank Scheme

| Rank | Meaning |
|------|---------|
| 1 | Nearest to scope |
| 2 | Mid-depth |
| 3 | Deep |
| 4 | Furthest |
| null | Excluded from depth training |

Rank is **per-instance per-frame** — the same structure can be at different depths depending on papilla morphotype. Some ranks are fixed by anatomy and non-editable; others have a suggested default the annotator can override.

---

### Classes

#### PAPILLA_BODY
- **Attributes:** `haraldsson_type` — dropdown: `1 / 2 / 3a / 3b / 4 / D / unknown`
- **Depth rank:** editable, default `2`

#### PAPILLA_ORIFICE
- **Attributes:** `surface_normal_clock` — integer 1–12, set via clock dial widget
- **Depth rank:** FIXED `3` (always the deepest visible surface, non-editable)
- Polygon boundary is automatically exported as a **depth discontinuity edge** in addition to the semantic mask — no extra annotation required

#### HOODING_FOLD
- **Depth rank:** editable, default `2` (override to `1` if fold protrudes toward scope beyond papilla body)

#### PERIAMPULLARY_DIVERTICULUM
- **Attributes:** `papilla_position` — dropdown: `intradiverticular / at-rim / adjacent`
- **Depth rank:** FIXED `4` (always furthest — recessed behind duodenal wall)

#### DUODENAL_WALL
- **Depth rank:** editable, default `1` (override to `2` when papilla protrudes in front of it)

#### INSTRUMENT_MASK
- **Depth rank:** FIXED `null` — exported as occlusion mask only, never used for depth training
- Any frame where this mask overlaps PAPILLA_ORIFICE is auto-flagged `usable_for_depth_training: false`

#### SPECULAR_HIGHLIGHT
- **Depth rank:** FIXED `null`
- Fully saturated pixels only

#### FLUID_POOL
- **Depth rank:** FIXED `null`
- Pooled bile or irrigation fluid — depth cues here are unrelated to tissue geometry

---

## Annotation: Keypoint Tool

Named persistent landmark points for SLAM tracking. Place a point and assign one of the following names:

| Name | Description |
|------|-------------|
| `ORIFICE_RIM_TOP` | |
| `ORIFICE_RIM_BOTTOM` | |
| `ORIFICE_RIM_LEFT` | |
| `ORIFICE_RIM_RIGHT` | |
| `FOLD_TIP` | Tip of hooding fold if present |
| `PAPILLA_BASE_LEFT` | Junction of papilla base and duodenal wall |
| `PAPILLA_BASE_RIGHT` | |
| `VASCULAR_MARK` | Any visible vessel or pigment mark; annotator adds free-text description |

**Visibility states:** `visible` / `partially-occluded` / `inferred`

---

## Frame-Level Metadata

| Field | Type | Options |
|-------|------|---------|
| `procedural_state` | dropdown | `pre-approach / approaching / wire-at-orifice / PD-cannulated / CBD-cannulated / post-sphincterotomy / under-traction` |
| `deformation_state` | dropdown | `resting / mild-peristalsis / strong-peristalsis` |
| `frame_quality_flags` | multi-select | `motion-blur / lens-contamination / pre-flush-bubbles / tangential-view / inadequate-lighting` |
| `usable_for_depth_training` | bool | Auto-set `false` if any quality flag is checked or INSTRUMENT_MASK overlaps PAPILLA_ORIFICE. Manual override allowed. |
| `usable_for_segmentation_training` | bool | Auto-set `false` for `motion-blur` and `lens-contamination` only |

---

## Export Format

One JSON file per image.

```json
{
  "image_id": "string",
  "frame_metadata": {
    "procedural_state": "string",
    "deformation_state": "string",
    "frame_quality_flags": ["string"],
    "usable_for_depth_training": true,
    "usable_for_segmentation_training": true
  },
  "annotations": [
    {
      "class": "PAPILLA_ORIFICE",
      "polygon": [[x, y], "..."],
      "depth_rank": 3,
      "depth_rank_fixed": true,
      "is_depth_discontinuity_boundary": true,
      "is_occlusion_mask": false,
      "attributes": {
        "surface_normal_clock": 11
      }
    }
  ],
  "keypoints": [
    {
      "name": "ORIFICE_RIM_TOP",
      "x": 312,
      "y": 208,
      "visibility": "visible"
    }
  ]
}
```

---

## UI

### Layout

- Canvas: 70% width, left
- Attribute panel: 30% width, right

### Canvas Rendering

- Completed polygons: semi-transparent class colour fill, class name label, depth rank badge
- **Fixed-rank badges:** static coloured chip (non-interactive)
- **Editable-rank badges:** clickable, opens a 1–4 rank selector
- **Null-rank polygons** (instruments, highlights, fluid): grey diagonal stripe fill pattern
- **PAPILLA_ORIFICE rim:** additional dashed white outline rendered on top of the polygon border to indicate depth discontinuity export
- **Keypoints:** named crosshairs colour-coded by visibility — green = visible, yellow = partially-occluded, red = inferred

### Depth Rank Colour Scheme

| Rank | Colour | Meaning |
|------|--------|---------|
| 1 | Red (hot) | Nearest |
| 2 | Orange | Mid |
| 3 | Blue (cool) | Deep |
| 4 | Purple | Furthest |
| null | Grey striped | Excluded |

### Attribute Panel

Shows fields for the currently selected annotation.

**Surface normal clock widget:** circular dial rendering as a clock face with a draggable handle; numerical angle displayed alongside.

**Editable depth rank:** clicking the badge shows a 1–4 selector with a tooltip explaining the expected rank for the annotated haraldsson_type.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1` – `8` | Switch active class |
| `←` `→` | Navigate frames |
| `Delete` | Remove selected annotation |
| `Escape` | Cancel in-progress polygon |

### Frame Navigation

- Previous / next buttons and arrow key navigation
- Completion indicator per frame: `empty` / `partial` / `complete`
- Auto-save on every frame navigation

### Soft Warnings (non-blocking, shown in sidebar)

- PAPILLA_ORIFICE annotated but `surface_normal_clock` not set
- PAPILLA_BODY annotated but `haraldsson_type` is `unknown`
- `usable_for_depth_training` is `true` but no keypoints annotated

### Progress Sidebar

- Annotation count per class across all loaded images
- Frame counts by `usable_for_depth_training` and `usable_for_segmentation_training` status
