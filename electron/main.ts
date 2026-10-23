import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
import { promises as fs, existsSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePathRaw } from "ffprobe-static";
import {
  IPC,
  type AppInfo,
  type LibraryState,
  type IntakeProgress,
  type ExportProgress,
  type PhaseExportProgress,
  type PhasesState,
  type UpdateStatus,
} from "../src/shared/ipc.js";
import {
  createProjectOnDisk,
  listProjects,
  readManifest,
  updateStageOnDisk,
  checkLibrary,
  projectDir,
  type LibraryCheck,
} from "../src/node/library.js";
import { runIntake } from "../src/node/intake.js";
import { loadPhaseLabels, savePhaseLabels, readIntakeRecord, runPhaseExport } from "../src/node/phases.js";
import { caseNameFromSource } from "../src/core/phases.js";
import {
  listSegFrames,
  loadSegmentationSnapshot,
  saveSegmentationSnapshot,
  resolveFramePath,
  removeFrames,
} from "../src/node/segmentation.js";
import { runExport } from "../src/node/export.js";
import { setupUpdater, checkForUpdates } from "./updater.js";
import {
  type Settings,
  loadSettings,
  saveSettings,
  applySettings,
} from "../src/node/settings.js";
import { CrashLogger } from "../src/node/crashlog.js";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5234";

// Privileged scheme that streams a project's frames to the renderer on demand
// (lazy — avoids base64-loading thousands of full-res frames). Must be declared
// before app "ready".
protocol.registerSchemesAsPrivileged([
  {
    scheme: "endoseg-frame",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  // The project's intake video (or its preview proxy) for the phase-labelling player.
  {
    scheme: "endoseg-video",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let frameServeCount = 0;
let crashLogger: CrashLogger;
let settings: Settings;
let libraryDir = "";
let libraryCheck: LibraryCheck = { writable: false };

// ── Settings + library location ──────────────────────────────────────────────

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

// Shared library on the team's SAFE Desktop NAS. Used as the default whenever
// that drive is mapped; otherwise fall back to Documents.
const SHARED_LIBRARY_ROOT = "R:\\akshin-ercp-nas";

/** <NAS>\<name> when the NAS is mapped, else Documents\<fallback>. */
function onSharedDrive(name: string, fallback: string): string {
  if (process.platform === "win32" && existsSync(SHARED_LIBRARY_ROOT)) {
    return path.join(SHARED_LIBRARY_ROOT, name);
  }
  return path.join(app.getPath("documents"), fallback);
}

function defaultLibraryDir(): string {
  return onSharedDrive("EndoSeg Library", "EndoSeg Library");
}

function rawVideosDir(): string {
  return settings.rawVideosDir ?? onSharedDrive("Raw ERCP Videos", "");
}

/** Root the <case>_<phase> clip folders are written to. */
function phaseExportRoot(): string {
  return settings.phaseExportDir ?? onSharedDrive("Annotated Videos", "EndoSeg Annotated Videos");
}

/** Resolve the effective library dir from settings (null → default). */
function resolveLibraryDir(): string {
  return settings.libraryDir ?? defaultLibraryDir();
}

/** Where a project's exports go: custom root (per-project subfolder) or 03_export. */
function exportRootFor(projectId: string): string {
  return settings.exportDir
    ? path.join(settings.exportDir, projectId)
    : path.join(libraryDir, "projects", projectId, "03_export");
}

async function ensureLibrary(dir: string): Promise<void> {
  libraryCheck = await checkLibrary(dir);
}

async function libraryState(): Promise<LibraryState> {
  return {
    baseDir: libraryDir,
    projects: libraryCheck.writable ? await listProjects(libraryDir) : [],
    ...libraryCheck,
  };
}

// ── Crash handling ───────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** In a packaged app the bundled binaries are unpacked from the asar archive. */
function resolveBinary(p: string): string {
  return app.isPackaged ? p.replace("app.asar", "app.asar.unpacked") : p;
}

function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    void crashLogger.record(
      { source: "uncaughtException", message: err.message, detail: err.stack },
      nowIso(),
    );
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    void crashLogger.record(
      { source: "unhandledRejection", message: err.message, detail: err.stack },
      nowIso(),
    );
  });
  app.on("render-process-gone", (_e, _wc, details) => {
    void crashLogger.record(
      { source: "render-process-gone", message: `renderer gone: ${details.reason}`, detail: `exitCode=${details.exitCode}` },
      nowIso(),
    );
  });
  app.on("child-process-gone", (_e, details) => {
    void crashLogger.record(
      { source: "child-process-gone", message: `child gone: ${details.type} ${details.reason}` },
      nowIso(),
    );
  });
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    libraryDir,
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => appInfo());

  ipcMain.handle(IPC.libraryGet, async () => {
    await ensureLibrary(libraryDir); // re-check: the NAS may have (re)connected
    return libraryState();
  });

  ipcMain.handle(IPC.libraryCreate, async (_e, name: unknown) => {
    const clean = typeof name === "string" && name.trim() ? name.trim() : "Untitled";
    const { id } = await createProjectOnDisk(libraryDir, clean, nowIso());
    return { id };
  });

  ipcMain.handle(IPC.libraryChooseDir, async (): Promise<LibraryState | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose EndoSeg library folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings = applySettings(settings, { libraryDir: res.filePaths[0] });
    await saveSettings(settingsPath(), settings);
    libraryDir = resolveLibraryDir();
    await ensureLibrary(libraryDir);
    return libraryState();
  });

  ipcMain.handle(IPC.exportChooseDir, async (): Promise<Settings | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose EndoSeg export folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings = applySettings(settings, { exportDir: res.filePaths[0] });
    await saveSettings(settingsPath(), settings);
    return settings;
  });

  ipcMain.handle(IPC.projectGet, (_e, id: unknown) =>
    typeof id === "string" ? readManifest(libraryDir, id) : null,
  );

  ipcMain.handle(IPC.projectReveal, async (_e, id: unknown) => {
    if (typeof id !== "string") return;
    shell.showItemInFolder(path.join(libraryDir, "projects", id, "project.json"));
  });

  ipcMain.handle(IPC.settingsGet, (): Settings => settings);

  ipcMain.handle(IPC.settingChooseDir, async (_e, key: unknown): Promise<Settings | null> => {
    if (key !== "rawVideosDir" && key !== "phaseExportDir") return null;
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: key === "rawVideosDir" ? "Choose raw videos folder" : "Choose phase export folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings = applySettings(settings, { [key]: res.filePaths[0] });
    await saveSettings(settingsPath(), settings);
    return settings;
  });

  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: unknown): Promise<Settings> => {
    settings = applySettings(settings, patch);
    await saveSettings(settingsPath(), settings);
    libraryDir = resolveLibraryDir();
    await ensureLibrary(libraryDir);
    return settings;
  });

  ipcMain.handle(IPC.intakePickVideo, async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Select ERCP video",
      ...(existsSync(rawVideosDir()) ? { defaultPath: rawVideosDir() } : {}),
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "avi", "mkv", "m4v", "wmv", "mpg", "mpeg"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  ipcMain.handle(IPC.intakeRun, async (_e, projectId: unknown, sourcePath: unknown) => {
    if (typeof projectId !== "string" || typeof sourcePath !== "string") return null;
    if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
    const send = (p: IntakeProgress) => mainWindow?.webContents.send(IPC.intakeProgress, p);
    try {
      await updateStageOnDisk(libraryDir, projectId, "intake", { status: "in_progress" }, nowIso());
      const record = await runIntake({
        baseDir: libraryDir,
        projectId,
        sourcePath,
        ffmpegPath: resolveBinary(ffmpegPath),
        ffprobePath: resolveBinary(ffprobePathRaw),
        now: nowIso(),
        onProgress: send,
      });
      return await updateStageOnDisk(
        libraryDir,
        projectId,
        "intake",
        { status: "done", counts: { sources: 1, minutes: Math.round(record.meta.durationSec / 6) / 10 } },
        nowIso(),
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record(
        { source: "intake", message: e.message, detail: e.stack, projectId, stage: "intake" },
        nowIso(),
      );
      return updateStageOnDisk(libraryDir, projectId, "intake", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.phasesLoad, async (_e, projectId: unknown): Promise<PhasesState | null> => {
    if (typeof projectId !== "string") return null;
    const intake = await readIntakeRecord(libraryDir, projectId);
    return {
      labels: await loadPhaseLabels(libraryDir, projectId),
      videoUrl: intake?.playbackFile ? `endoseg-video://video/${encodeURIComponent(projectId)}` : null,
      durationSec: intake?.meta.durationSec ?? 0,
      fps: intake?.meta.fps ?? 0,
      caseName: intake ? caseNameFromSource(intake.sourcePath) : null,
      exportRoot: phaseExportRoot(),
    };
  });

  ipcMain.handle(IPC.phasesSave, async (_e, projectId: unknown, labels: unknown) => {
    if (typeof projectId !== "string") return null;
    const saved = await savePhaseLabels(libraryDir, projectId, labels);
    // Edited labels mean the clips/frames on disk are stale until re-exported.
    await updateStageOnDisk(libraryDir, projectId, "phases", { status: "in_progress", counts: { spans: saved.spans.length } }, nowIso());
    return saved;
  });

  ipcMain.handle(IPC.phasesExport, async (event, projectId: unknown) => {
    if (typeof projectId !== "string") return null;
    if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
    const send = (p: PhaseExportProgress) => event.sender.send(IPC.phasesProgress, p);
    try {
      const r = await runPhaseExport({
        baseDir: libraryDir,
        projectId,
        ffmpegPath: resolveBinary(ffmpegPath),
        exportRoot: phaseExportRoot(),
        fps: settings.phaseFps,
        onProgress: send,
      });
      return await updateStageOnDisk(
        libraryDir,
        projectId,
        "phases",
        { status: "done", counts: { clips: r.clips, frames: r.frames } },
        nowIso(),
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record(
        { source: "phases", message: e.message, detail: e.stack, projectId, stage: "phases" },
        nowIso(),
      );
      return updateStageOnDisk(libraryDir, projectId, "phases", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.phasesReveal, async () => {
    const dir = phaseExportRoot();
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle(IPC.segListFrames, async (_e, projectId: unknown) => {
    if (typeof projectId !== "string") return { source: "none", frames: [] };
    const r = await listSegFrames(libraryDir, projectId);
    console.log(`[seg] listFrames project=${projectId} source=${r.source} count=${r.frames.length}`);
    return r;
  });

  ipcMain.handle(IPC.segLoad, (_e, projectId: unknown) =>
    typeof projectId === "string" ? loadSegmentationSnapshot(libraryDir, projectId) : null,
  );

  ipcMain.handle(IPC.segSave, async (_e, projectId: unknown, snapshot: unknown) => {
    if (typeof projectId !== "string") return null;
    try {
      const { frameCount, maskCount } = await saveSegmentationSnapshot(libraryDir, projectId, snapshot);
      return await updateStageOnDisk(
        libraryDir,
        projectId,
        "segmentation",
        { status: "done", counts: { frames: frameCount, masks: maskCount } },
        nowIso(),
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record(
        { source: "segmentation", message: e.message, detail: e.stack, projectId, stage: "segmentation" },
        nowIso(),
      );
      return updateStageOnDisk(libraryDir, projectId, "segmentation", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.exportRun, async (event, projectId: unknown) => {
    if (typeof projectId !== "string") return null;
    const send = (p: ExportProgress) => event.sender.send(IPC.exportProgress, p);
    try {
      await updateStageOnDisk(libraryDir, projectId, "export", { status: "in_progress" }, nowIso());
      const result = await runExport(libraryDir, projectId, send, exportRootFor(projectId));
      return await updateStageOnDisk(
        libraryDir,
        projectId,
        "export",
        { status: "done", counts: { frames: result.frameCount, labelMaps: result.labelMapCount } },
        nowIso(),
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record(
        { source: "export", message: e.message, detail: e.stack, projectId, stage: "export" },
        nowIso(),
      );
      return updateStageOnDisk(libraryDir, projectId, "export", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.exportReveal, async (_e, projectId: unknown) => {
    if (typeof projectId !== "string") return;
    const dir = exportRootFor(projectId);
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle(IPC.framesRemove, async (_e, projectId: unknown, frameIds: unknown): Promise<string[]> => {
    if (typeof projectId !== "string" || !Array.isArray(frameIds)) return [];
    const names = frameIds.filter((f): f is string => typeof f === "string");
    return removeFrames(libraryDir, projectId, names);
  });

  ipcMain.handle(IPC.updateCheck, (): Promise<UpdateStatus> => checkForUpdates(app.isPackaged));

  ipcMain.handle(IPC.crashList, () => crashLogger.list());
  ipcMain.handle(IPC.crashRead, (_e, file: unknown) =>
    typeof file === "string" ? crashLogger.read(file) : null,
  );
  ipcMain.handle(IPC.crashOpenFolder, () => {
    void shell.openPath(crashLogger.directory);
  });
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    title: "EndoSeg",
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Headless smoke test: boot, confirm the renderer loaded, then quit.
  if (process.env.ENDOSEG_SMOKE) {
    mainWindow.webContents.once("did-finish-load", () => {
      console.log("ENDOSEG_SMOKE_OK renderer-loaded library=" + libraryDir);
      app.quit();
    });
    mainWindow.webContents.once("did-fail-load", (_e, code, desc) => {
      console.error("ENDOSEG_SMOKE_FAIL", code, desc);
      app.exit(1);
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // DEV-ONLY: periodically snapshot the window so issues can be diagnosed headlessly.
  if (isDev && process.env.ENDOSEG_CAPTURE) {
    const capPath = path.join(app.getPath("temp"), "endoseg-capture.png");
    setInterval(() => {
      void (async () => {
        try {
          const img = await mainWindow?.webContents.capturePage();
          if (img) await fs.writeFile(capPath, img.toPNG());
        } catch { /* ignore */ }
      })();
    }, 2500);
    console.log(`[capture] writing window snapshots to ${capPath}`);
  }
}

app.whenReady().then(async () => {
  crashLogger = new CrashLogger(path.join(app.getPath("userData"), "logs"), {
    appVersion: app.getVersion(),
    os: `${process.platform} ${process.getSystemVersion?.() ?? ""}`.trim(),
    electron: process.versions.electron,
  });
  installCrashHandlers();

  settings = await loadSettings(settingsPath());
  libraryDir = resolveLibraryDir();
  await ensureLibrary(libraryDir);

  // Serve project frames over endoseg-frame://frame/<projectId>/<source>/<file>.
  protocol.handle("endoseg-frame", async (req) => {
    try {
      const u = new URL(req.url);
      const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
      const [projectId, source, filename] = parts;
      const abs = resolveFramePath(libraryDir, projectId, source, filename);
      if (!abs) {
        console.warn(`[seg] frame 404 (bad path) ${req.url}`);
        return new Response("not found", { status: 404 });
      }
      const data = await fs.readFile(abs);
      frameServeCount += 1;
      if (frameServeCount <= 3 || frameServeCount % 25 === 0) {
        console.log(`[seg] frame served #${frameServeCount} ${filename} (${data.length} bytes)`);
      }
      return new Response(new Uint8Array(data), {
        headers: { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      console.error(`[seg] frame error ${req.url}:`, err instanceof Error ? err.message : err);
      return new Response("error", { status: 500 });
    }
  });

  // Stream the intake video over endoseg-video://video/<projectId>. Byte ranges
  // are honoured so the <video> element can seek without reading the whole file.
  protocol.handle("endoseg-video", async (req) => {
    try {
      const projectId = decodeURIComponent(new URL(req.url).pathname.split("/").filter(Boolean)[0] ?? "");
      const intake = projectId ? await readIntakeRecord(libraryDir, projectId) : null;
      const rel = intake?.playbackFile;
      if (!rel || rel.includes("..")) return new Response("not found", { status: 404 });
      const abs = path.join(projectDir(libraryDir, projectId), "00_intake", rel);
      const size = (await fs.stat(abs)).size;
      const ext = path.extname(abs).toLowerCase();
      const type = ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "video/mp4";
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
      let start = 0;
      let end = size - 1;
      if (m) {
        if (m[1]) {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), size - 1);
        } else if (m[2]) {
          start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
        }
        if (start > end || start >= size) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
        }
      }
      const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(body, {
        status: m ? 206 : 200,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
        },
      });
    } catch (err) {
      console.error(`[phases] video error ${req.url}:`, err instanceof Error ? err.message : err);
      return new Response("error", { status: 500 });
    }
  });

  registerIpc();
  setupUpdater((s) => mainWindow?.webContents.send(IPC.updateStatus, s));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
