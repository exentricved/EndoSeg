import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
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
import {
  listSegFrames,
  loadSegmentationSnapshot,
  saveSegmentationSnapshot,
  resolveFramePath,
} from "../src/node/segmentation.js";
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
]);

let mainWindow: BrowserWindow | null = null;
let frameServeCount = 0;
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
