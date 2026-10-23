# EndoSeg (desktop app)

Offline Electron desktop app for the sphincterotomy/ERCP video pipeline:
**Intake → Phases → Segmentation → Export**. See [`../EndoSeg.md`](../EndoSeg.md)
for the full specification.

## Built so far (phases 1–3)

- Electron shell (main + preload + context-isolated bridge)
- Project **library** on disk with the full stage directory skeleton per project
- **Project Hub** landing view: every project with a pipeline stage indicator
- **Project detail** view with per-stage cards
- **Settings**: library, raw-videos and phase-clip folders, segmentation frame rate, compute mode, updates
- **Intake**: pick a video → copy into the project, SHA-256 hash, ffprobe metadata,
  H.264 preview copy when the player can't open it (bundled ffmpeg/ffprobe — no Python needed)
- **Phases**: label procedure phases on the video; export one clip per span to
  `<case>_<phase>/` folders and 1 fps frames of the endoscopic phases for segmentation
- **Auto-update** via electron-updater + GitHub Releases (Settings → Updates)
- **Troubleshooting** page: viewable, copy/paste-able crash log
- Global crash handlers (main, renderer, child process) → PHI-free incident reports
- Tested pure core (`src/core`) + Node disk/crash/intake/settings layers (`src/node`)

## Layout

```
src/core/     pure lifecycle model (stages, manifest) — unit-tested, no Node/Electron
src/node/     disk layer (library, crash log) — Node fs, unit-tested against temp dirs
src/shared/   IPC contract shared by main + renderer
src/renderer/ React Project Hub UI
electron/     main process + preload (Electron only)
scripts/      dev runner + electron bundler
```

## Commands

```bash
npm install
npm test          # vitest — run frequently
npm run typecheck # tsc --noEmit
npm run dev       # vite dev server + electron
npm run build     # build renderer + electron bundle
npm run dist      # package a Windows installer (electron-builder) → release/
npm run release   # build + publish a GitHub Release (needs repo + GH_TOKEN)
```

Or double-click **`Launch EndoSeg (dev).cmd`** to run in dev mode.

The project library defaults to `Documents/EndoSeg Library`; change it from
Settings.

## Pushing an update

1. Bump `version` in `package.json` and commit.
2. Push a matching tag (`git tag v0.2.0 && git push origin main v0.2.0`). The
   Release workflow builds Windows + macOS and publishes a GitHub Release.
3. Installed apps see it under **Settings → Updates → Check for updates**.
