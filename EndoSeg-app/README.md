# EndoSeg (desktop app)

Offline Electron desktop app for the sphincterotomy/ERCP video pipeline:
**Intake → Dedup → Segmentation → Export**. See [`../EndoSeg.md`](../EndoSeg.md)
for the full specification.

## Phase 1 (this scaffold)

- Electron shell (main + preload + context-isolated bridge)
- Project **library** on disk with the full stage directory skeleton per project
- **Project Hub** landing view: every project with a pipeline stage indicator
- **Troubleshooting** page: viewable, copy/paste-able crash log
- Global crash handlers (main, renderer, child process) → PHI-free incident reports
- Tested pure core (`src/core`) + Node disk/crash layers (`src/node`)

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
npm run dist      # package a Windows installer (electron-builder)
```

The project library defaults to `Documents/EndoSeg Library`; change it from the
hub toolbar.
