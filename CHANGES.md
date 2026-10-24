# EndoSeg — v0.2.3 (2026-10-23)

## Cannulation success is a moment, not a phase
- Press **4** at the end of the last cannulation attempt to mark success (press again, or **Move ← here**, to move it; ✕ removes it). It shows as a blue ✓ line on the timeline and is saved as `cannulationSuccess` in `00_intake/phases.json`.
- The attempt it ends (the last one starting before it) carries **success** in its names: clip `<case>_cannulation-attempt_NN_success_t….mp4`, frames `<case>_t<ms>_cannulation-attempt_NN_success.png`. `frames.json` gives `cannulationSuccessSec`, and `success: true` on that clip and its frames; dataset `metadata.json` gives each frame `cannulationSuccess`.
- Projects labelled with the old *Cannulation success* span convert automatically: the success moment goes at the span's start, and the span becomes **Post-cannulation**. The old `<case>_cannulation-success` folder is removed on the next export once it's empty.

## Post-cannulation maneuvers (PEP-related)
- New maneuvers: **Sphincterotomy (7)**, **Balloon dilation (8)**, **Pancreatic stent (9)**. Press the key to start, press again to end. They run independently of the phases, so they can overlap the phases and each other.
- Each maneuver span exports a clip into `<case>_<maneuver>/`.
- Maneuver frames go to the annotator. A moment already sampled as part of a phase is not duplicated; its frame name gets the maneuvers under way, e.g. `<case>_t00050000_post-cannulation_01_sphincterotomy_pancreatic-stent.png`. Maneuver time outside every phase gets frames of its own (`<case>_t<ms>_sphincterotomy_NN.png`). `frames.json` and `metadata.json` list `maneuvers` per frame.
- In the annotator, frame thumbnails show maneuver tags (EST, EPBD, PS) and SUCCESS; the right panel lists them under Phase.

## Annotations follow renamed frames
- Frame names can now change when success or maneuvers are relabelled. On re-export, saved annotations, ✓ ticks, removals and masks move to the frame that now holds the same source time (`_t<ms>_`), so no work is lost. The previous `annotations.leus` is kept as `.bak`.

## Keys
- Phases: 1 Duodenum, 2 Pre-cannulation, 3 Cannulation attempt, 5 Post-cannulation, 6 Fluoroscopy. 4 = success moment. 7–9 = maneuvers.

# EndoSeg — v0.2.2 (2026-10-23)

## Source timestamps on clips (for training)
- Phase clips now carry where they were cut from the source video: `<case>_<phase>_NN_t<startMs>-<endMs>.mp4` (e.g. `…_cannulation-attempt_02_t00026000-00031000.mp4` = 26.0–31.0 s). Frames already carry theirs: `<case>_t<ms>_<phase>_NN.png`.
- `01_frames/frames.json` now also lists every clip with its phase, span number and start/end seconds, plus the case name.
- Dataset export `metadata.json` gives each frame its `timeSec` in the source video, its `span` number and whether it was ticked `completed`.
- Re-exporting phases replaces clips with the old names (no `_t…`) as well.

## Annotator
- **Annotation complete** tick box at the top of the right panel (key **C**). Ticked frames show a green ✓ on their thumbnail in the frame list; the panel shows *N / total frames complete*. Saved with the annotations.
- **Remove this frame…** (click **Remove it** to confirm) takes the current frame out of the annotation set — for frames that aren't significant, blurry, split-screen, etc. The file moves to `01_frames/removed/` (recoverable) and the project is saved. **Mark for removal [X]** + **Remove N marked frames…** still does several at once.
- Removed frames stay removed when phases are re-exported.
- The frame list now follows you: the current frame is highlighted (blue bar + outline) and scrolled to the middle of the list as you move with A/D, arrows, tracking or removal. Rows show the frame's time in the video and its phase instead of the long file name (full name on hover).

# EndoSeg — v0.2.1 (2026-10-23)

## Crop at intake
- After a video is taken in, a **Crop** screen opens. Drag a rectangle over the part of the picture to keep (e.g. drop black borders, on-screen text or the fluoroscopy half of a split screen), use the slider to check other points in the video, then **Save crop** or **No crop**.
- The crop applies to the exported phase **clips and segmentation frames**. The project's copy of the video stays whole, so the crop can be changed any time with **Crop…** on the Intake card. Changing it marks Phases *In Progress* until you re-export.
- Stored in source pixels in `00_intake/crop.json`, rounded to even numbers (needed for H.264). Re-importing a video clears it.

## Span numbers in frame names
- Frames now carry the number of the span they came from, matching that span's clip: `<case>_t<ms>_<phase>_NN.png` (e.g. the second cannulation attempt → `…_cannulation-attempt_02.png`). `01_frames/frames.json` records it as `span`.
- Projects already exported under v0.2.0 get the new names on their next phase export (annotations saved on the old names won't carry over).

## Delete projects
- **Delete…** on each row of the Projects list (click **Delete** again to confirm). The project folder moves to `<library>\deleted\<id>__<time>`, so it can be restored by moving it back into `projects\`. Exported phase clips in Annotated Videos are not touched.

# EndoSeg — v0.2.0 (2026-10-23)

## New stage: Phases (Intake → **Phases** → Segmentation → Export)
- **Label phases** on the project page opens a video player. Phases: **Duodenum, Pre-cannulation, Cannulation attempt, Cannulation success, Post-cannulation, Fluoroscopy**.
- Press a phase key **1–6** to start that phase at the playhead and press it again to end it. Pressing a different phase key ends the current phase there and starts the next. A phase can occur several times (e.g. repeated cannulation attempts).
- Player keys: Space play/pause, ←/→ ±1 s (Shift ±10 s), `,`/`.` one frame, Esc cancels an open phase, Del deletes the selected span. Speeds 0.25×–8×. Each span can be retyped, trimmed to the playhead or deleted. Labels autosave to `00_intake/phases.json`.
- **Export clips + frames:**
  - One frame-accurate H.264 clip per span → `<phase clips folder>\<case>_<phase>\<case>_<phase>_NN.mp4`. `<case>` is the folder the video came from. The default folder is `R:\akshin-ercp-nas\Annotated Videos`. Re-exporting replaces the clips EndoSeg wrote and leaves other files in those folders alone.
  - Frames at **1 fps** (Settings) from every phase except fluoroscopy → `01_frames/raw/<case>_t<ms>_<phase>.png`, indexed in `01_frames/frames.json`. Each frame is the first source frame at or after its time stamp.

## Intake
- **New project from video…** opens in `R:\akshin-ercp-nas\Raw ERCP Videos` and names the project after the video's folder.
- Intake no longer extracts every-Nth frames; frames now come from the Phases stage.
- Videos the player can't open (e.g. AVI/MJPEG, HEVC) get a 1280 px H.264 preview copy (`00_intake/preview.mp4`) used only for labelling. Clips and frames are always cut from the original.
- A re-import replaces the previous source video.

## Annotator
- Each frame starts with the phase it was extracted from (pick list updated to the new phases); a phase saved earlier still wins.
- Dataset export now only includes frames that have annotations.

## Tracking removed (tracked manually)
- Removed the name sign-in, Activity page/logs, Ongoing/Complete status and the "taken in by" fields. Existing `activity/` files and old manifest fields are ignored and nothing is deleted.

## Settings
- New: raw videos folder, phase clips folder, segmentation frame rate (default 1 fps). Removed: frame sampling (every Nth).

# EndoSeg Annotator — v0.1.2 (2026-10-22)

## Start-up sign-in
- On launch, people enter their **name** (last name used is prefilled); that name — not the Windows login — is recorded on intake, export, status changes and frame removals. **Switch** in the top bar changes person.
- The same screen shows the **library folder** and proves it is writable (create + delete a probe file). An unmapped/offline network drive shows "folder or drive not found — is the network drive connected?" and blocks Continue instead of the app failing to open. Continue pins the shown folder, so a later launch with the NAS offline errors rather than silently using Documents.
- Default library: `R:\akshin-ercp-nas\EndoSeg Library` when that drive exists (SAFE Desktop), else Documents.

## Windows portable build
- `electron-builder` also produces `EndoSeg-<version>-portable.exe` — no install; run it from the NAS or H: on SAFE/VDI sessions where the local install folder may not persist.

## Intake / export tracking
- Every intake records the person's name, the original file name + full path, and sets the project **Ongoing**. **Mark complete / Reopen** on the project page records who changed it and when.
- Projects table shows the video, who took it in, and Ongoing/Complete.
- New **Activity** page: intake started/completed/failed, exports, status changes and frame removals for everyone using the library (filter by user, copy as CSV). Stored as `<library>/activity/<name>.jsonl`, one file per person so shared libraries never have two writers on one file.

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
