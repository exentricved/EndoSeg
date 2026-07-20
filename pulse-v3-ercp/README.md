# AnnotateLiver EUS

Manual annotation tool for liver segmentation in linear endoscopic ultrasound (EUS).
Part of the PULSE project. Built with React + TypeScript + Vite.

---

## What this tool is

AnnotateLiver EUS is a browser-based frame annotation tool that lets expert annotators
draw segmentation masks over liver EUS images. The resulting annotations are saved as
structured project files and exported as NRRD segmentation masks for use in AI model
training pipelines.

This is a manual annotation tool. It does not automatically detect or segment the
liver. All masks are drawn by the annotator.

---

## Current scope

| Item | Value |
|---|---|
| Active mask classes | Liver, Portal Vein Main Trunk, Portal Vein Left Branch, Portal Vein Right Branch, Inferior Vena Cava, Left Hepatic Vein, Middle Hepatic Vein, Right Hepatic Vein, Gallbladder |
| Frame metadata | Station: `TG` (transgastric) or `TD` (transduodenal) |
| Stations in scope | Transgastric and transduodenal only |
| Project file format | `.leus` (JSON, schema v2) |
| Export format | MITK 4D multi-label NRRD (gzip where supported) |

All masks are manual annotations. `Liver` is a parenchymal mask. Portal veins, IVC,
and hepatic veins are lumen-only landmark masks. `Gallbladder` is a structure-interior
mask.

---

## Current ontology

The current 9-label set is:

1. `Liver`
2. `Portal Vein Main Trunk`
3. `Portal Vein Left Branch`
4. `Portal Vein Right Branch`
5. `Inferior Vena Cava`
6. `Left Hepatic Vein`
7. `Middle Hepatic Vein`
8. `Right Hepatic Vein`
9. `Gallbladder`

Annotation rules for the full label set are summarized in
[`ANNOTATION_GUIDELINES.md`](./ANNOTATION_GUIDELINES.md).

---

## How to run

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173` by default.

To build for production:

```bash
npm run build
```

---

## How to annotate and save a liver project

1. **Add frames** - click "Add frames" in the sidebar to load one or more EUS image files.
2. **Set station** - for each frame, click `TG` (transgastric) or `TD` (transduodenal)
   in the sidebar. Click again to deselect.
3. **Draw masks** - select a label card at the bottom, then use the Pen tool to draw
   the corresponding mask. `Liver` is parenchyma only. Vessel labels are lumen only.
   Use Circle Eraser or Stroke Eraser to correct mistakes. Ctrl/Cmd+Z to undo.
4. **Zoom and pan** - Ctrl/Cmd + scroll wheel to zoom around the cursor. Toolbar
   buttons for `+` / `-` / reset.
5. **Save the project** - click "Save project" in the sidebar footer. Enter a project
   name and select reviewer(s). The file is saved as `<name>.leus`.
6. **Export NRRD** - click "Export" (or select multiple frames and click "Export selected")
   to download NRRD segmentation files. Each file is named
   `<frame>-liver-<TG|TD>-seg.nrrd`. Empty frames with no mask drawn are skipped.

---

## Opening a project

Click "Open project" and select a `.leus` file. The session restores with all frames,
masks, and station values intact.

**Compatibility-safe project opening:**

- **Legacy `.eus` / v1 files (`legacy-v1`)**: the file will load but a warning banner
  will appear. Masks are loaded exactly as saved with their original label names.
  Station will be blank for all frames. Only the label with ID 1 will be visible in the
  current liver landmark workflow; legacy IDs 2-9 remain loaded but inaccessible.
- **Schema-v2 projects with canonical ID/name collisions (`restricted-v2`)**: the file
  will load with a warning banner. Stored labels are preserved exactly as saved and are
  not remapped into the current liver ontology. In this restricted workflow, only label
  ID 1 is visible and actionable; IDs 2-9 remain loaded but inaccessible.

Review compatibility-opened projects carefully before continuing annotation or export.

---

## Project file format

`.leus` files are JSON with the following top-level structure:

```json
{
  "version": 2,
  "organ": "liver",
  "modality": "linear-eus",
  "images": [
    {
      "id": "...",
      "name": "frame_001",
      "w": 640,
      "h": 480,
      "station": "TG",
      "labels": [
        {
          "id": 1,
          "name": "Liver",
          "color": "#f59e0b",
          "visible": true,
          "displayFill": true,
          "maskPNG": "data:image/png;base64,..."
        }
      ]
    }
  ]
}
```

Masks are stored as base64-encoded PNG data URLs (lossless, binary alpha channel).

---

## Local annotation activity logging

The current build includes a local annotation activity logging MVP.

- Storage backend: browser `localStorage`
- Scope: local to the current browser profile/device
- Tracks: session start/end, project open, edit commits, project save, and NRRD export
- Current limitation: logs are not yet durable/shareable outside the local browser
  environment without a future export or sync feature

This logging is intended for local instrumentation only at this stage. It is not a
hosted analytics or team-sync system.

---

## Deferred to later phases

The following are out of scope for this version and may be added in a future phase:

- Additional landmark classes beyond the current 9-label set: portal vein umbilical
  portion, portal subdivisions such as P5/8 or P6/7, aorta, hepatic artery branches,
  ligamentum teres, ligamentum venosum, diaphragm.
- Couinaud segment context metadata.
- Frame quality flags.
- AI-assisted annotation overlay. This tool produces the training data; the model
  itself is a separate downstream system.

---

## Notes for annotators

- Annotation is landmark-based and approximate. Liver EUS does not have clean
  anatomical borders as seen in CT or MRI.
- If anatomy is uncertain, leave it unlabeled rather than guessing.
- Do not intentionally overlap vessel masks with each other or with `Liver`.
- Always set the station (`TG` or `TD`) for every frame before exporting.
- Frames with no mask drawn are automatically excluded from NRRD export.
- The "Fill enclosed now" button in Settings -> Label Card Options can help close
  outline loops automatically.
