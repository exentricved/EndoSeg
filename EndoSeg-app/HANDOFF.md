# EndoSeg — Work Handoff

_Last updated: 2026-06-23. Pick up here next session._

---

## ⛔ RESUME HERE — embedded annotator renders BLANK / empty (unresolved)

**Symptom:** opening a project → Segmentation → "Open annotator" mounts the annotator, but
the frames don't display. User: "import does not work", "did not serve frames". The OS file
picker appears because the project is empty so they hit "Add frames".

**What we know from the main-process `[seg]` logs (dev):**
- `listFrames project=case-1 source=kept count=276` ALWAYS fires → frame *listing* works.
- Frame *serving* is INTERMITTENT: one session served real bytes
  (`frame served #1 frame_000001.png (2262825 bytes)`, plus thumbnails up to #25), but other
  sessions served **0** → the annotator's `project.images` came up EMPTY (nothing requested).
- So the bug is the embedded load populating `project.images` UNRELIABLY (empty → blank).

**Fixes already attempted this session (all committed to working tree, NOT git-committed):**
1. PNG-header `width/height` from main (`segmentation.ts pngSize`) so the annotator doesn't
   decode 276 frames upfront. ✅ in `SegFrame`.
2. `dataURLToImage` given an `onerror` (was `onload`-only → hung forever on any failure).
3. Removed the `endosegLoadKeyRef` early-return guard in the annotator's `endoseg` load
   effect (StrictMode defeats that pattern — runs, cancels, re-runs, returns early →
   discards the load → empty). Kept the `cancelled` flag (StrictMode-safe).
4. `crossOrigin="anonymous"` on the base-image loader + `dataURLToImage` (frames come from
   the `endoseg-frame://` origin; drawing them tainted the canvas). NOTE: after THIS change
   the next session served 0 — so either crossOrigin broke the request, or it's just timing.

**Strong next step — USE THE SCREENSHOT HARNESS (added this session):** run dev with
`ENDOSEG_CAPTURE=1` (env-gated, dev-only, in `electron/main.ts createWindow`). It writes a
window snapshot every 2.5s to `%TEMP%\endoseg-capture.png` — Read that file to SEE the
rendered annotator instead of guessing. Also add a renderer→main debug log of how many
ImageItems the `endoseg` load effect actually builds (route via a tiny `debug:log` IPC),
to confirm whether `project.images` is empty vs populated-but-not-drawn.

**Likely root causes still to rule out (in order):**
- (a) `project.images` ends up empty — the `endoseg` load effect (`App.tsx`, keyed on
  `[endoseg]`) not calling `setProject` reliably (StrictMode double-mount + async race, or
  `annotatorData` identity churn from `src/renderer/App.tsx`).
- (b) cross-origin display: with/without `crossOrigin` the canvas either taints or the CORS
  image request fails before reaching `protocol.handle` (0 served). Test by temporarily
  returning frames as base64 data: URLs from `listSegFrames` to bypass the protocol entirely.
- (c) embed layout: annotator `app` height in the `flex:1` container computing 0 before
  ResizeObserver settles.

**User's stated direction:** leaning toward a **native rebuild** of the annotator (answered
the scope question with "import does not work"). So either finish debugging the embed OR
pivot to the lean-native rebuild (see [[project_endoseg]] / scope discussion). Decide first.

---

## Session 2026-06-23 (cont.) — Phase 2: frame/mask IO wired

The embedded annotator now reads the project's frames and saves masks back — one app, no
manual loading.
- **Frames in (lazy):** custom privileged protocol `endoseg-frame://frame/<projectId>/<source>/<file>`
  streams frames from disk on demand (registered in `electron/main.ts`; path-checked by
  `resolveFramePath` in `src/node/segmentation.ts`). Avoids base64-loading thousands of frames.
  CSP updated in `index.html`.
- **IPC** (`src/shared/ipc.ts` + preload + main): `segmentation:listFrames` (prefers
  `01_frames/kept`, falls back to `raw`), `segmentation:load`, `segmentation:save`
  (writes `02_segmentation/annotations.leus` + `02_segmentation/masks/<frame>__class<id>.png`;
  marks segmentation stage done with `{frames,masks}` counts).
- **Annotator** got an `endoseg` prop (`{projectId, frames, initialSnapshot, onSave}`): load
  effect builds images from frame URLs + restores prior masks; "💾 Save to project" toolbar
  button. Thumbnails are `loading="lazy"`.
- Verified: typecheck + full build + ENDOSEG_SMOKE clean. **Test bed: project `case-1`**
  (276 kept frames). Not yet live-clicked by Claude in the GUI.
- **Next — Phase 3:** de-identified NRRD + `project.json` export reading `02_segmentation/`.
  **Deferred (user-requested):** lightweight MANUAL local save-file for annotation state.

## Session 2026-06-23 (cont.) — annotator integrated into EndoSeg (Phase 1/3)

User: *"instead of wiring between the two, can you integrate the annotator into endoseg?"*
Done — the annotator is now a **mounted view inside EndoSeg-app's renderer**, not a separate
app/bridge.
- `src/renderer/App.tsx` imports it: `import Annotator from "../../pulse-v3-ercp/src/App"`;
  new `View` kind `"annotator"` renders it full-window with a back bar.
- Entry point: ProjectDetail **Segmentation → "Open annotator"** (gate temporarily relaxed
  for Phase-1 testing; will re-gate on dedup once frames auto-load).
- Annotator gained an `embedded` prop (sizes to parent, like `hostedReview`) — full UI kept.
- **`pulse-v3-ercp/node_modules` removed** → single React/csstype tree (required for hooks +
  types). The standalone annotator no longer runs on its own; the hosted-review platform
  (`pulse-v3-ercp/hosted-app/`) is unaffected (own node_modules).
- Verified: `npm run typecheck` + `npm run build:renderer` clean (47 modules bundled).
- **Next — Phase 2:** wire IO over IPC (load `01_frames/kept/` into the annotator; save
  masks/annotations to `02_segmentation/`). **Phase 3:** de-identified NRRD + project.json
  export. Phase-1 has NO data wiring yet — frames are loaded manually via the annotator's
  "Open images" picker.

## Session 2026-06-23 — folder consolidation + manual crop tool

**1. Annotator moved into the app folder.** `pulse-v3-ercp/` (was a sibling at the
repo root) is now **`EndoSeg-app/pulse-v3-ercp/`** so the application is one
self-contained folder. It remains a separate sub-package with its own Vite build
(`npm run dev|build|test` inside that dir). Verified after the move: `tsc -b` clean,
59 vitest tests pass. A stray `EndoSeg-app - Copy/` manual backup at the repo root is
now gitignored. NOTE: the move is **not committed** — `git add -A` is very slow on this
OneDrive path (timed out at 2 min, left a stale `.git/index.lock` that had to be removed);
commit deliberately/with a scoped `git add` when ready.

**2. Split-screen handling pivoted.** The planned automatic content-based crop pipeline
stage (`docs/split-screen-crop.md`) was **dropped**. Instead, frames stay whole and the
operator gets a **manual, non-destructive crop + zoom tool in the annotator toolbar**
(`pulse-v3-ercp/src/App.tsx`): a **Crop** button (drag a rectangle), a **Zoom crop**
toggle (fits the view to the rectangle), and a **✕ Crop** clear button. It is purely a
view transform built on the existing fit/zoom/pan system (`resetView` fits the crop's w/h
and pans to it); the full frame and all masks are preserved. Not yet manually run in the
live app — worth a visual smoke test (`npm run dev` in `pulse-v3-ercp/`).

This is a working scratch/status doc. The locked spec and source of truth is the
repo-root `EndoSeg.md`; per-area README is `EndoSeg-app/README.md`. This file just
captures recent work + what's next so you don't have to reconstruct context.

---

## Where things stand

Pipeline lifecycle: **Intake → Dedup → Segmentation → Export**

| Stage | Status |
| --- | --- |
| Project library / Hub / Project Detail | ✅ Done |
| Settings store + Settings page | ✅ Done |
| Crash logging + Troubleshooting page | ✅ Done |
| Auto-update (electron-updater) | ✅ Wired (needs GitHub repo + token to publish) |
| **Intake** (copy + SHA-256 + ffprobe + frame extract) | ✅ Done |
| **Dedup** (perceptual-hash near-duplicate removal) | ✅ Done (this session) |
| **Segmentation** (Python venv + MobileSAM) | ⬜ Not started — **next** |
| **Export** (folder of NRRD masks + packaged project.json) | ⬜ Not started |

Tests: **50 vitest tests pass**, `tsc --noEmit` clean.

---

## What was done this session — Dedup stage

Added a non-destructive Dedup pipeline stage that collapses near-duplicate frames
using a perceptual **difference-hash (dHash)**. Raw frames are never touched;
surviving representatives are copied into `01_frames/kept/`, and every decision is
logged to `01_frames/dedup-report.json`. Re-running is idempotent (`kept/` is
rebuilt from scratch each run).

### Commits (on `main`)
- `f898f49` — Add Dedup stage: perceptual-hash near-duplicate frame removal
- `65acfd6` — Dedup review fixes: emit copy-phase progress; guard blank threshold input

### Files
**Core logic (pure + orchestrator):**
- `src/node/dedup.ts`
  - Pure helpers (unit-testable, no IO): `dHash()`, `hamming()`, `planDedup()`.
  - `hashFrames()` — one ffmpeg pass: `scale=9:8:flags=area,format=gray` → `rawvideo`
    stdout; each frame becomes a 72-byte (9×8) grayscale thumbnail → 64-bit dHash.
  - `runDedup()` — hash → plan → copy representatives → write `dedup-report.json`.
  - Constants: `HASH_SIZE = 8`, `HASH_W = 9`, `BYTES_PER_THUMB = 72`.
- `src/node/proc.ts` — added `runBinary()` (like `run()` but captures stdout as raw
  `Buffer` bytes, needed for rawvideo pixel output).

**Settings:**
- `src/node/settings.ts` — added `dedupThreshold` (max Hamming distance 0–64,
  default **8**). `normalizeSettings` validates and **falls back to 8** if invalid
  (note: it rejects-and-defaults; it does NOT clamp, so `65 → 8`, not `65 → 64`).
- `src/renderer/SettingsView.tsx` — "Duplicate filtering" threshold control.

**Wiring (mirrors the intake flow):**
- `src/shared/ipc.ts` — channels `dedup:run` / `dedup:progress`, `DedupProgress`
  type, `runDedup` / `onDedupProgress` on `EndoSegApi`.
- `electron/preload.ts` — bridge methods.
- `electron/main.ts` — `dedupRun` handler: marks stage in-progress, runs `runDedup`
  with `settings.dedupThreshold`, streams progress, records counts
  (`kept` / `dropped`), logs crashes on error.
- `src/renderer/ProjectDetail.tsx` — Dedup stage button (gated on intake `done`),
  live progress for both `hash` and `copy` phases.

**Tests:**
- `src/node/dedup.test.ts` — pure-helper unit tests (dHash gradients, hamming,
  planDedup keep/drop/threshold-0/empty) + a real-ffmpeg integration test that
  synthesizes frames, lays out an `A,A,B,B` sequence, and asserts 2 kept / 2 dropped,
  correct representatives copied, report written, and idempotent re-run.

### Cross-model review (Sonnet) outcome
No definite correctness bugs found. Confirmed correct: dHash bit-packing
(8×8 = 64 bits), the 72-byte ffmpeg layout, `Buffer.concat` in `runBinary`,
`planDedup` logic, settings boundaries, idempotent `kept/` rebuild.

Fixed from the review (commit `65acfd6`):
- `runDedup` now emits `{phase:"copy"}` progress during the copy loop (UI no longer
  looks frozen after hashing).
- Settings ignores a cleared threshold field instead of saving `0`.

Deliberately NOT changed (defensive-only; intake guarantees contiguous
`frame_%06d.png`, so guarding would risk false failures):
- `dedup.ts` silent truncation if the ffmpeg-decoded frame count drifts from the
  `readdir` file list (frame-sequence gap).
- `listFrames` regex `/^frame_\d+\.png$/` accepts non-zero-padded names while the
  ffmpeg input pattern is fixed at `%06d`.

If segmentation or manual edits ever produce non-contiguous `raw/` frames, revisit
those two — currently safe because only intake writes that folder.

---

## Launcher files

- **Dev launcher (tracked):** `EndoSeg-app/Launch EndoSeg (dev).cmd` — double-click
  to run in dev mode. Adds `C:\Program Files\nodejs` to PATH (Node isn't on PATH on
  this machine), `npm install` on first run, then `npm run dev`.
- **Production launcher:** none in the repo, by design. `npm run dist` runs
  electron-builder's NSIS installer, which installs `EndoSeg.exe` and creates the
  Start Menu / desktop shortcut — that shortcut is the end-user launcher, generated
  at packaging time (not checked into git).
- Possible future nicety (not done): a `.cmd` that runs `electron .` against built
  output for a quick packaged-mode smoke test without a full install.

---

## How to run / verify (from `EndoSeg-app/`)

Node is at `C:\Program Files\nodejs` and not on PATH — call `npm.cmd` directly, e.g.
`"/c/Program Files/nodejs/npm.cmd" run test` from the Bash tool.

```
npm run dev         # Vite + Electron, hot reload
npm test            # vitest (50 tests)
npm run typecheck   # tsc --noEmit
npm run build       # renderer + main bundle
npm run dist        # build + NSIS installer
npm run release     # build + publish GitHub Release (needs repo + GH_TOKEN)
```

Headless smoke test: `ENDOSEG_SMOKE=1` boots, confirms the renderer loaded, quits.

Project library defaults to `Documents/EndoSeg Library` (changeable in Settings).

---

## Next up — Segmentation (Phase 4)

Per `EndoSeg.md` §4/§9 and locked decisions:
- Orchestrate a **local Python venv provisioned on first run** (not a bundled frozen
  runtime). Python is only for ML segmentation — intake/dedup use bundled
  ffmpeg/ffprobe and need no Python.
- Run MobileSAM over `01_frames/kept/` (the deduped representatives), writing masks
  to `02_segmentation/masks/`.
- Compute preference comes from the `gpu` setting (`auto` / `cpu` / `gpu`).
- Annotation/review reuses the existing `pulse-v3-ercp` UI as-is unless a problem
  surfaces.
- Follow the same stage pattern as intake/dedup: IPC channel + progress events,
  main handler updating manifest stage status/counts, crash logging on failure,
  Project Detail button gated on the prior stage being `done`.

Then **Export** (Phase 5): each export = a folder of NRRD masks + a packaged
`project.json` under `03_export/<export-name>/`.

---

## Stage pattern cheatsheet (for the next stage)

When adding Segmentation, copy the Dedup wiring shape:
1. `src/node/<stage>.ts` — pure logic + orchestrator (keep IO-free helpers separate
   so they're cheap to unit-test).
2. `src/shared/ipc.ts` — add `<stage>:run` / `<stage>:progress` channels, a
   `*Progress` type, and `EndoSegApi` methods.
3. `electron/preload.ts` — bridge the two methods.
4. `electron/main.ts` — `ipcMain.handle` for run: set stage `in_progress` → run →
   set `done` with counts (or `error` + crashLogger.record on throw).
5. `src/renderer/ProjectDetail.tsx` — button gated on prior stage `done`, live
   progress; `SettingsView.tsx` for any new setting.
6. `src/node/<stage>.test.ts` — pure unit tests + an integration test.
7. Renderer imports node types via `import type` only (avoid leaking `node:fs` into
   the browser bundle).
