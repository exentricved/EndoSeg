# EndoSeg — Desktop Application Specification

> Status: **Spec / plan** (no Electron code built yet). This document is the source of
> truth for turning the existing ERCP papilla annotation tool + Python segmentation
> pipeline into a single installable desktop application named **EndoSeg**.
> Last updated: 2026-06-13.

---

## 1. What EndoSeg is

EndoSeg is a **local, offline desktop application** for managing sphincterotomy /
ERCP papilla video data through its full lifecycle:

```
INTAKE  →  DEDUP (filter redundant frames)  →  SEGMENTATION  →  EXPORT
```

It wraps two pieces that already exist in this repo:

| Existing piece | Role in EndoSeg |
|---|---|
| `pulse-v3-ercp/` (React + TS + Vite annotation tool) | The **renderer UI** — project hub, intake page, annotation canvas |
| `pulse-v3-ercp/scripts/*.py` (MobileSAM video seg, pipeline UI) | The **pipeline engine** — frame extraction, dedup, ML segmentation, export |

The product the user sees is renamed from "ERCP Papilla Annotator" to **EndoSeg**
(window title already updated in `pulse-v3-ercp/index.html`).

### Design constraints

- **Fully offline / local-first.** Input is patient sphincterotomy video (PHI). Nothing
  leaves the machine. No cloud calls, no telemetry. (The existing `hosted-app/` Next.js
  variant is explicitly out of scope for EndoSeg.)
- **Crash-resilient.** A crash must never lose project work, and must leave a
  human-readable log a non-technical user can copy/paste for troubleshooting.
- **Single installer**, Windows-first (dev box is Windows 11).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Electron App "EndoSeg"                                       │
│                                                              │
│  ┌────────────────┐   IPC   ┌────────────────────────────┐  │
│  │ Main process   │◄───────►│ Renderer (React/Vite build)│  │
│  │ (Node)         │         │  - Project Hub             │  │
│  │  - window mgmt │         │  - Intake page             │  │
│  │  - file system │         │  - Annotation canvas       │  │
│  │  - autosave/   │         │    (existing App.tsx)      │  │
│  │    journaling  │         │  - Status / export views   │  │
│  │  - crash log   │         └────────────────────────────┘  │
│  │  - Python      │                                         │
│  │    orchestrator│──────────────┐                          │
│  └────────────────┘              ▼                          │
│                         ┌────────────────────┐              │
│                         │ Local Python venv  │  (spawned)   │
│                         │  ffmpeg, opencv,   │              │
│                         │  torch, MobileSAM  │              │
│                         │  → CLI jobs, JSON  │              │
│                         │    progress on     │              │
│                         │    stdout          │              │
│                         └────────────────────┘              │
└─────────────────────────────────────────────────────────────┘
```

### Pipeline engine: orchestrate a local Python venv (chosen)

- The installer ships the Electron app. **On first run**, a setup step creates a local
  Python virtual environment under the app's user-data dir and `pip install`s the
  pipeline deps + downloads the MobileSAM weights. A progress UI covers this one-time step.
- The Gradio scripts are **refactored into headless CLI entrypoints** (Gradio stays as a
  dev tool but is not used inside EndoSeg). Each pipeline step becomes a subprocess the
  main process spawns with explicit `--input` / `--output` paths and emits **line-delimited
  JSON progress** on stdout so the renderer can show real progress bars.
- Rationale: full offline segmentation without a multi-GB monolithic installer. (The
  "bundle a frozen Python + weights" option was rejected for installer size; "annotation
  shell only" was rejected because the user wants real dedup + segmentation.)

Target CLI surface (wrappers around existing `scripts/`):

| Command | Wraps | In → Out |
|---|---|---|
| `endoseg-extract` | new (ffmpeg/opencv) | video → raw frames |
| `endoseg-dedup` | new (perceptual hash) | raw frames → kept frames + dropped manifest |
| `endoseg-segment` | `video_seg_ui.py` ML path | frames/video → masks + annotated preview + `.leus`/COCO |
| `endoseg-export` | NRRD writer | masks → **a folder of NRRD files + a `project.json`** |

---

## 3. Project directory format (on-disk)

Each clinical case is a **self-contained project folder**, so projects are portable,
backup-friendly, and the stage of every file is derivable from disk state alone.

```
<EndoSeg Library>/
  endoseg-library.json            # index of all projects (cached; rebuildable from folders)
  projects/
    <project-id>/
      project.json                # manifest: id, name, patient ref (de-identified), stages, timestamps
      autosave/                   # crash-recovery journal (see §7)
        session-<ts>.json
      00_intake/
        source/                   # original uploaded video(s), copied here verbatim
          case12.mp4
        intake.json               # source metadata, hash, duration, fps, import time
      01_frames/
        raw/                      # every extracted frame
        kept/                     # frames surviving dedup  (symlink or copy)
        dedup-report.json         # which frames dropped, cluster ids, similarity scores
      02_segmentation/
        masks/                    # per-frame masks (PNG) + class metadata
        annotations.leus          # editable annotation project (existing format)
        preview.mp4               # annotated overlay video
      03_export/
        <export-name>/            # one folder per export run
          nrrd/                   # the segmentation masks as NRRD files
          project.json            # project/export descriptor packaged with the NRRDs
        export-manifest.json      # index of all export runs for this project
      logs/
        crash/                    # per-project crash captures (see §8)
```

### Stage model

A project's stage is the furthest folder that has valid outputs. Each stage records
status in `project.json`:

```jsonc
{
  "id": "case12",
  "name": "Case 12 — sphincterotomy",
  "stages": {
    "intake":       { "status": "done",        "at": "2026-06-13T10:02:00Z", "count": 1 },
    "dedup":        { "status": "done",        "at": "...", "kept": 412, "dropped": 1880 },
    "segmentation": { "status": "in_progress", "at": "...", "framesDone": 120, "framesTotal": 412 },
    "export":       { "status": "pending" }
  }
}
```

Status values: `pending` · `in_progress` · `done` · `error` · `needs_review`.

---

## 4. Intake page

- **Upload from anywhere**: drag-drop or file picker for one or more video files from any
  path / external drive. EndoSeg **copies** (never moves) the source into
  `00_intake/source/` and computes a SHA-256 so re-imports are detected.
- Captures basic metadata (duration, fps, resolution via ffprobe) and a user-entered,
  **de-identified** case label. No patient identifiers are required or stored by default.
- On import, optionally kick off `extract → dedup` automatically, or leave the project at
  `intake: done` for the user to advance manually.
- Large-file friendly: copy runs in the main process with progress; the UI stays responsive.

### Redundant-frame filtering (chosen rule: near-duplicate frames)

- Extract frames, then compute a **perceptual hash (pHash)** per frame and compare
  consecutive frames (and short windows) by Hamming distance / SSIM.
- Visually near-identical runs (scope held still) collapse to **one representative frame**.
- Nothing is deleted destructively: dropped frames are recorded in `dedup-report.json`
  and remain in `01_frames/raw/`, so the threshold can be re-run without re-extracting.
- Threshold is a setting with a sane default; surfaced in the dedup step UI.

---

## 5. Project Hub (landing view)

Opens on launch. High-level portfolio of all projects:

- **Table / card grid** of every project with a **stage pipeline indicator**
  (Intake ▸ Dedup ▸ Segmentation ▸ Export) showing where each case sits, counts, and
  last-activity time.
- Filter/sort by stage, status (`error`, `needs_review`), date.
- Click a project → open its detail (advance stage, open annotation canvas, view reports).
- "New project" → Intake page.
- Global actions: **Export status to Excel**, **View crash log**, settings.

### Excel status export

- One-click export of the whole library status as a real **`.xlsx`** (via `exceljs` in the
  main process), one row per project: id, name, each stage's status + counts + timestamp,
  frames kept/dropped, export artifacts, last error. CSV fallback also offered.

---

## 6. Save state & crash recovery

Goal: a crash (renderer, main, or power loss) never loses annotation work and reopens
projects automatically.

- **Autosave journaling**: annotation edits and project-manifest changes are written to
  `autosave/session-<ts>.json` on a debounce (e.g. every few seconds / on every committed
  edit) — append/journal style, not just on explicit "Save".
- **Dirty-state tracking** in the renderer; the main process flushes pending state on
  `before-quit` and on the `web-contents` crash event.
- **On restart**: EndoSeg detects unclean shutdown (a lock/heartbeat file in user-data)
  and offers **"Restore last session"** — reopens the projects that were open and replays
  the latest autosave journal over the last saved `annotations.leus`.
- Atomic writes (temp file + rename) so a crash mid-write never corrupts a manifest.

---

## 7. Crash log (viewable & copyable)

A non-technical user must be able to open, read, and copy/paste a crash report.

- **Global handlers** in the main process: `process.on('uncaughtException'/'unhandledRejection')`,
  Electron `render-process-gone` / `child-process-gone`, and Python-subprocess non-zero
  exits all funnel into a structured log.
- **Storage**: rolling human-readable log files under the app user-data `logs/` dir, plus
  per-incident `logs/crash/crash-<ts>.txt` containing: timestamp, app version, OS, the
  error + stack, the last pipeline command + its stderr tail, and which project/stage was
  active. **No PHI** (no patient identifiers, no frame pixels) in logs.
- **In-app "Troubleshooting / Crash Log" page**: lists incidents, shows full text in a
  scrollable pane, with **"Copy to clipboard"** and **"Open logs folder"** / **"Save report…"**
  buttons. This is the artifact a user pastes into an email or ticket.

---

## 8. Packaging & installer

- **electron-builder**, Windows NSIS installer first (`.exe`); macOS/Linux later if needed.
- Ship the prebuilt Vite renderer (`vite build` output) + main-process bundle.
- **First-run Python provisioning** step (creates venv, installs pinned requirements,
  downloads model weights) with a progress screen and a retry/offline-bundle path.
- App identity: product name **EndoSeg**, its own icon, versioned releases.
- Note (env): on this machine Node is at `C:\Program Files\nodejs` and not on PATH — call
  `npm.cmd` directly when scripting builds.

---

## 9. Build roadmap (phased)

1. **Scaffold** — Electron main + preload + IPC; load the existing Vite renderer; product
   rename, icon, electron-builder config. Runnable empty shell.
2. **Library + Project Hub** — directory format, `project.json` manifest, hub view with
   stage indicators, settings, library location picker.
3. **Intake** — upload/copy + hashing + metadata; create project at `intake: done`.
4. **Pipeline orchestration** — headless CLI wrappers around `scripts/`; first-run Python
   provisioning; extract → dedup with progress + reports.
5. **Segmentation + annotation** — wire MobileSAM segmentation job; open existing
   annotation canvas on `02_segmentation/annotations.leus`; review/correct masks.
6. **Export + Excel** — export each project as a **folder of NRRD masks + a packaged
   `project.json`**; library-wide `.xlsx` status export.
7. **Crash resilience** — autosave journaling, restore-last-session, global crash log +
   troubleshooting page.
8. **Hardening** — atomic writes, large-file handling, packaging polish, signed installer.

---

## 10. Defaults chosen (changeable)

| Decision | Default |
|---|---|
| Pipeline engine | Orchestrate a local Python venv (offline, first-run setup) |
| Frame sampling on intake | Sample **every 6th frame** (configurable in Settings) |
| Compute | CPU-capable, optional GPU (`gpu: auto`) — affects pinned torch build |
| Annotation UI | Reuse the existing `pulse-v3-ercp` ERCP polygon/keypoint UI as-is |
| Redundant filtering | Near-duplicate (perceptual-hash) collapse, non-destructive |
| Excel export | Real `.xlsx` (exceljs), CSV fallback |
| OS target | Windows first (NSIS) |
| Data handling | Fully local/offline; logs carry no PHI |
| Dropped frames | Kept on disk + recorded, never hard-deleted |
| Source video | Copied (not moved) into the project |

---

## 11. Open questions for later phases

- Should multiple users share one library (network drive), or strictly single-machine?
- GPU expectation for segmentation, or CPU-only acceptable (affects speed + torch build)?
- Retention/cleanup policy for `01_frames/raw/` (can be large) once a project is exported.
- Do we need an audit trail of who annotated what (the existing local activity log MVP
  could be promoted), or is that out of scope for EndoSeg?
