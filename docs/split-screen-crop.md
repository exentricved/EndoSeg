# Split-screen endo/fluoro handling

> **SUPERSEDED (2026-06-23).** This automatic, content-based crop *pipeline stage*
> was not implemented. Instead, frames are kept whole and the operator uses a
> **manual, non-destructive crop + zoom-to-crop tool in the annotator toolbar**
> (`pulse-v3-ercp/src/App.tsx`). The design below is retained for reference only,
> in case automatic layout detection is revisited later.

Some sphincterotomy/ERCP videos switch between two on-screen layouts mid-video.
We only want the **endoscopic** view; the fluoroscopy panel must be removed.

## The two layouts

- **Layout A** — endoscopic view centered, no fluoroscopy.
- **Layout B** — endoscopic view shifted left (and a bit smaller), grayscale
  fluoroscopy panel on the right. Appears *around* (not exactly at) cannulation;
  timing varies per video and may come and go, so **no time/event shortcut is
  valid** — detection must be content-based.

Because the endoscopic panel moves and resizes between A and B, a single fixed
crop cannot work, and the split cannot be ignored.

## Approach: classify each frame, then apply one of two pre-measured crops

### Classification (A vs. B)

Fluoroscopy is essentially grayscale, so the decisive signal is **color
saturation in the right region** of the canvas:

| Right-region content            | Layout | Crop       |
| ------------------------------- | ------ | ---------- |
| bright **and** colorful         | A      | center ROI |
| bright **but** ~zero saturation | B      | left ROI   |
| near-black                      | A      | center ROI |

Rule: `right region brightness > t1 AND saturation < t2 → Layout B`, else A.
Nothing in the endoscopic image is "lit up but colorless," so fluoro is
distinctive.

### Temporal hysteresis

The split turns on and stays on for a run of frames. Only flip A→B (or B→A)
after several consecutive frames classify the new way. This treats layouts as
runs, kills flicker during the transition, and is far more stable than naive
per-frame voting.

### ROIs

Two pre-measured crop rectangles: a **center** rectangle (Layout A) and a
**left** rectangle (Layout B), each the bounding box of the endoscopic panel.
- Same recording tower + resolution → fixed pixel ROIs.
- If capture resolution varies across videos → normalize ROIs to fractions of
  frame size instead of absolute pixels.

## Where it fits in the pipeline

A new **`crop` (a.k.a. `layout`) stage between `intake` and `dedup`.**

> **Must run before dedup.** `dedup.ts` computes its dHash over the *whole*
> frame. If the independently-changing fluoro panel is still present, dedup will
> treat fluoro motion as new endoscopic content — keeping near-duplicate scope
> frames and polluting segmentation. Crop first, then dedup reads the cropped
> frames.

The stage mirrors the existing `dedup` stage structure:

1. **One ffmpeg pass** → small RGB thumbnails for every raw frame (same trick as
   `hashFrames`, RGB instead of gray).
2. **Classify in JS** → per-frame A/B from right-region saturation, with
   hysteresis.
3. **Crop each frame** to its layout's ROI → write to `01_frames/cropped/`.
4. **Write `layout-report.json`** (per-frame layout + ROIs used) so it is
   reviewable and re-runnable, like `dedup-report.json`.
5. Point `dedup` at `01_frames/cropped/` instead of `01_frames/raw/`.

ROIs and thresholds are best stored in `settings.ts` for reuse across projects
from the same recorder.

## Status

Design agreed (2026-06-18). Awaiting sample frames from the user — a few of each
layout plus one per capture resolution — to measure the two ROIs, calibrate the
saturation/brightness thresholds, and scaffold the stage. Not yet implemented.
