import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePathRaw } from "ffprobe-static";
import {
  IPC,
  type AppInfo,
  type LibraryState,
  type IntakeProgress,
  type DedupProgress,
  type UpdateStatus,
} from "../src/shared/ipc.js";
import {
  createProjectOnDisk,
  listProjects,
  readManifest,
  updateStageOnDisk,
} from "../src/node/library.js";
import { runIntake } from "../src/node/intake.js";
import { runDedup } from "../src/node/dedup.js";
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

let mainWindow: BrowserWindow | null = null;
let crashLogger: CrashLogger;
let settings: Settings;
let libraryDir = "";

// ── Settings + library location ──────────────────────────────────────────────

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function defaultLibraryDir(): string {
  return path.join(app.getPath("documents"), "EndoSeg Library");
}

/** Resolve the effective library dir from settings (null → default). */
function resolveLibraryDir(): string {
  return settings.libraryDir ?? defaultLibraryDir();
}

async function ensureLibrary(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "projects"), { recursive: true });
}

async function libraryState(): Promise<LibraryState> {
  return { baseDir: libraryDir, projects: await listProjects(libraryDir) };
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

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    libraryDir,
  }));

  ipcMain.handle(IPC.libraryGet, () => libraryState());

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

  ipcMain.handle(IPC.projectGet, (_e, id: unknown) =>
    typeof id === "string" ? readManifest(libraryDir, id) : null,
  );

  ipcMain.handle(IPC.projectReveal, async (_e, id: unknown) => {
    if (typeof id !== "string") return;
    shell.showItemInFolder(path.join(libraryDir, "projects", id, "project.json"));
  });

  ipcMain.handle(IPC.settingsGet, (): Settings => settings);

  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: unknown): Promise<Settings> => {
    settings = applySettings(settings, patch);
    await saveSettings(settingsPath(), settings);
    libraryDir = resolveLibraryDir();
    await ensureLibrary(libraryDir);
    return settings;
  });

  ipcMain.handle(IPC.intakePickVideo, async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Select sphincterotomy video",
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
        sampleEvery: settings.frameSampleEvery,
        now: nowIso(),
        onProgress: send,
      });
      return await updateStageOnDisk(
        libraryDir,
        projectId,
        "intake",
        { status: "done", counts: { sources: 1, frames: record.framesExtracted } },
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

  ipcMain.handle(IPC.dedupRun, async (_e, projectId: unknown) => {
    if (typeof projectId !== "string") return null;
    if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
    const send = (p: DedupProgress) => mainWindow?.webContents.send(IPC.dedupProgress, p);
    try {
      await updateStageOnDisk(libraryDir, projectId, "dedup", { status: "in_progress" }, nowIso());
      const result = await runDedup({
        baseDir: libraryDir,
        projectId,
        ffmpegPath: resolveBinary(ffmpegPath),
        threshold: settings.dedupThreshold,
        now: nowIso(),
        onProgress: (p) => send({ phase: p.phase, frames: p.done }),
      });
      return await updateStageOnDisk(
        libraryDir,
        projectId,
        "dedup",
        { status: "done", counts: { kept: result.kept, dropped: result.dropped } },
        nowIso(),
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record(
        { source: "dedup", message: e.message, detail: e.stack, projectId, stage: "dedup" },
        nowIso(),
      );
      return updateStageOnDisk(libraryDir, projectId, "dedup", { status: "error", error: e.message }, nowIso());
    }
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
