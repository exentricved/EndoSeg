# EndoSeg (desktop app)

Offline Electron desktop app for the sphincterotomy/ERCP video pipeline:
**Intake → Dedup → Segmentation → Export**. See [`../EndoSeg.md`](../EndoSeg.md)
for the full specification.

## Built so far (phases 1–3)

- Electron shell (main + preload + context-isolated bridge)
- Project **library** on disk with the full stage directory skeleton per project
- **Project Hub** landing view: every project with a pipeline stage indicator
- **Project detail** view with per-stage cards
- **Settings**: library location, frame-sampling rate (every 6th), compute mode, updates
- **Intake**: pick a video → copy into the project, SHA-256 hash, ffprobe metadata,
  extract every Nth frame (bundled ffmpeg/ffprobe — no Python needed)
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

1. Set `owner`/`repo` in `electron-builder.yml` to your GitHub repo (one-time).
2. Bump `version` in `package.json`.
3. `set GH_TOKEN=<token>` then `npm run release`.
4. Installed apps see it under **Settings → Updates → Check for updates**.
