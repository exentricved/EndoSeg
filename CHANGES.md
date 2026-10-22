# EndoSeg Annotator — Changes (2026-10-22)

## Intake / export tracking
- Every intake records the OS user, the original file name + full path, and sets the project **Ongoing**. **Mark complete / Reopen** on the project page records who changed it and when.
- Projects table shows the video, who took it in, and Ongoing/Complete.
- New **Activity** page: intake started/completed/failed, exports, status changes and frame removals for everyone using the library (filter by user, copy as CSV). Stored as `<library>/activity/<user>.jsonl`, one file per user so shared libraries never have two writers on one file.

## Split-screen frames (`X`)
- **X** marks/unmarks the current frame as split-screen (endoscopy + fluoroscopy); marked frames are dimmed with ⊘ in the frame list and never exported.
- **Remove N marked frames…** (two-step confirm) moves them to `01_frames/removed/` (recoverable), drops their annotations, logs it, and saves.

## Optical tracking (`T`)
- **Track next → [T]** adds the current frame's polygons + pixel masks to the next frame (moved by optical flow) and goes there; **← Track prev** adds the previous frame's annotations to the current one. Existing annotations on the destination are kept.
- Pyramidal Lucas-Kanade optical flow (`src/core/optflow.ts`, pure TS) with a forward-backward check. Polygon vertices follow their own flow; vertices that can't be tracked (low texture, occlusion) follow a similarity transform fitted to the polygon's tracked points. Masks move by a fitted similarity transform.
- One tracking step = one undo (`Ctrl+Z`). Review tracked annotations before saving.

## Dedup stage removed
- Pipeline is now **Intake → Segmentation → Export**; every extracted frame goes to the annotator.
- Old projects still open (the stale `dedup` stage is ignored; frames from `01_frames/raw`, falling back to `kept`).

## Frame sampling default
- `frameSampleEvery` default 15 → **4** (≈7.5 fps at 30 fps) so consecutive frames are close enough to track. Settings saved with the old default of 15 are migrated to 4; other custom values are kept.

# EndoSeg Annotator — Changes (2026-06-25)

## Frame sampling default
- Changed `frameSampleEvery` default from 6 → **15** (≈2 fps at 30 fps source).  
  Literature standard for surgical/endoscopy annotation: 1–2 fps. Applies to new projects only; existing extracted frames are unaffected.

## Canvas resolution fix (HiDPI / Retina)
- Canvas buffer now multiplied by `devicePixelRatio` on resize.  
  All rendering applies `ctx.scale(dpr, dpr)` so coordinates remain in CSS pixels.  
  Effect: sharp images and visible thin annotation strokes on any HiDPI display (4K, Retina, etc.).

## New tool: Brush (`B`)
- Paints a filled circle stamp at the active class color onto a per-frame pixel mask.  
- Mask stored at native frame resolution (separate from polygons).  
- Size slider in floating panel; `[` / `]` keys adjust radius in 5px steps.

## New tool: Eraser (`E`)
- Click on a polygon → deletes it.  
- Drag over empty area → erases from the active class's pixel mask (`destination-out`).  
- Shares the brush size slider.

## Pixel mask layer
- Each (frameId, classId) pair has an `HTMLCanvasElement` at native image resolution.  
- Rendered in `drawScene` at 50% alpha over the image.  
- Serialized as base64 PNG data URLs in `annotations.leus` and restored on reopen.  
- Merged with polygon rasterization at save time → same per-class PNG mask output.

## Copy from arbitrary frame
- Floating panel: number input + **Copy** button. Copies polygons *and* pixel masks from the entered frame number into the current frame.  
- Quick **← Copy prev** shortcut retained below the input.

## Auto DW button (upper toolbar)
- Fixed toolbar above the canvas (not in the floating panel).  
- Loads current frame with `crossOrigin`, reads pixel data via `getImageData`.  
- Pixels matching reddish/pinkish HSL range (H ≤ 35° or H ≥ 325°, S > 12%, L 15–88%) are painted into the Duodenal Wall class mask.  
- Result is immediately editable with Brush / Eraser tools.

## Frame Review page
- Accessible via **Review frames** button on the Dedup stage card (appears after dedup completes).  
- Thumbnail grid of all raw frames: green border = kept, red/dimmed = dropped.  
- Shows frame index, filename, and Hamming distance for dropped frames.  
- Filter bar: All / Kept / Dropped.

## Keyboard shortcuts (updated)
| Key | Action |
|-----|--------|
| `P` | Polygon tool |
| `B` | Brush tool |
| `E` | Eraser tool |
| `S` | Select tool |
| `[` / `]` | Decrease / increase brush size |
| `1`–`9`, `0` | Select annotation class |
| `A` / `←` | Previous frame |
| `D` / `→` | Next frame |
| `F` | Fit image to window |
| `Ctrl+S` | Save annotations |
| `Esc` | Cancel in-progress polygon |
| `Enter` | Finish polygon |
| `Del` / `Backspace` | Delete selected polygon |

## Files changed
| File | Change |
|------|--------|
| `src/node/settings.ts` | Default `frameSampleEvery` 6 → 15 |
| `src/shared/ipc.ts` | Add `framesReview` channel, `FrameReviewItem`, `FrameReviewResult` types, `getFrameReview` API method |
| `src/node/segmentation.ts` | Add `getFrameReview()` — reads `dedup-report.json`, attaches thumbnail URLs |
| `electron/main.ts` | Register `framesReview` IPC handler |
| `electron/preload.ts` | Bridge `getFrameReview` |
| `src/renderer/SegmentationView.tsx` | DPR fix, brush, eraser, pixel mask layer, copy-from-N, Auto DW, keyboard shortcuts |
| `src/renderer/FrameReviewView.tsx` | **New** — frame review thumbnail grid |
| `src/renderer/App.tsx` | Add `frame-review` view kind, import + render `FrameReviewView` |
| `src/renderer/ProjectDetail.tsx` | Add `onOpenFrameReview` prop, "Review frames" button on dedup card |
