import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
import { promises as fs, existsSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import * as path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { path as ffprobePathRaw } from "ffprobe-static";
import {
  IPC,
  type AppInfo,
  type WorkspacesState,
  type StartFromRawResult,
  type IntakeProgress,
  type ExportProgress,
  type PhaseExportProgress,
  type PhasesState,
  type UpdateStatus,
  type CaseAccess,
  type ReviewStartResult,
} from "../src/shared/ipc.js";
import { startSecondReview, isInReview } from "../src/node/review.js";
import {
  claimProjectOnDisk,
  AlreadyExistsError,
  listProjects,
  readManifest,
  updateStageOnDisk,
  checkLibrary,
  projectDir,
  deleteProjectOnDisk,
  type LibraryCheck,
} from "../src/node/library.js";
import { listRawCases, isInside } from "../src/node/raw.js";
import {
  NAS_FOLDERS,
  DEFAULT_NAS_ROOT,
  WORKSPACES,
  isSafeCaseId,
  parseRef,
  makeRef,
  rawRows,
  type WorkspaceId,
} from "../src/core/workspaces.js";
import { runIntake } from "../src/node/intake.js";
import {
  loadPhaseLabels,
  savePhaseLabels,
  readIntakeRecord,
  runPhaseExport,
  loadCrop,
  saveCrop,
} from "../src/node/phases.js";
import { caseNameFromSource, safeFolderName } from "../src/core/phases.js";
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
let nasCheck: LibraryCheck = { writable: false };

// ── Settings + NAS folders ───────────────────────────────────────────────────

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** The shared NAS folder holding Raw ERCP Videos, Annotated 1 and Annotated 2. */
function nasRoot(): string {
  return settings.nasRoot ?? DEFAULT_NAS_ROOT;
}

function rawVideosDir(): string {
  return path.join(nasRoot(), NAS_FOLDERS.raw);
}

function workspaceDir(ws: WorkspaceId): string {
  return path.join(nasRoot(), NAS_FOLDERS[ws]);
}

/**
 * Re-checked on every hub refresh, because the NAS can drop and reconnect.
 * The root itself is never created: a missing root means the drive isn't
 * mapped (or the setting is wrong), and writing to C: instead would split the
 * team's data.
 */
async function checkNas(): Promise<LibraryCheck> {
  if (!existsSync(nasRoot())) {
    nasCheck = { writable: false, error: `Cannot reach ${nasRoot()}: folder or drive not found — is the NAS drive connected?` };
    return nasCheck;
  }
  for (const ws of WORKSPACES) {
    const c = await checkLibrary(workspaceDir(ws));
    if (!c.writable) {
      nasCheck = c;
      return c;
    }
  }
  nasCheck = { writable: true };
  return nasCheck;
}

interface Resolved {
  ws: WorkspaceId;
  /** The workspace folder (Annotated 1 or 2): the baseDir for library/phases/segmentation calls. */
  baseDir: string;
  id: string;
  ref: string;
}

/** Resolve an untrusted "<ws>:<case>" reference from the renderer. */
function resolveRef(ref: unknown): Resolved | null {
  const r = parseRef(ref);
  return r ? { ws: r.ws, baseDir: workspaceDir(r.ws), id: r.id, ref: makeRef(r.ws, r.id) } : null;
}

/** Clips live inside the case folder: <case>\clips\<case>_<phase>\. */
function clipsRootFor(p: Resolved): string {
  return path.join(projectDir(p.baseDir, p.id), "clips");
}

/** Where a project's exports go: custom root (per-project subfolder) or 03_export. */
function exportRootFor(p: Resolved): string {
  return settings.exportDir
    ? path.join(settings.exportDir, p.id)
    : path.join(projectDir(p.baseDir, p.id), "03_export");
}

async function workspacesState(): Promise<WorkspacesState> {
  const ok = nasCheck.writable;
  const [raw, a1, a2] = ok
    ? await Promise.all([listRawCases(rawVideosDir()), listProjects(workspaceDir("a1")), listProjects(workspaceDir("a2"))])
    : [[], [], []];
  return {
    nasRoot: nasRoot(),
    folders: { raw: rawVideosDir(), a1: workspaceDir("a1"), a2: workspaceDir("a2") },
    rawFound: ok && existsSync(rawVideosDir()),
    raw: rawRows(raw, a1, a2),
    a1,
    a2,
    a1InReview: a1.filter((p) => isInReview(workspaceDir("a2"), p.id)).map((p) => p.id),
    ...nasCheck,
  };
}

/** Annotated 1 cases are read-only while they have a copy in Annotated 2. */
function accessOf(p: Resolved): CaseAccess {
  if (p.ws === "a1" && isInReview(workspaceDir("a2"), p.id)) {
    return {
      readOnly: true,
      reason: "This case is in second review. Its Annotated 1 copy is kept unchanged as the record of the first pass; edit the Annotated 2 copy instead.",
      reviewRef: makeRef("a2", p.id),
    };
  }
  return { readOnly: false };
}

/** Resolve a ref for a write; throws if the case is read-only (backstop for the UI). */
function editable(ref: unknown): Resolved | null {
  const p = resolveRef(ref);
  if (!p) return null;
  const a = accessOf(p);
  if (a.readOnly) throw new Error(a.reason);
  return p;
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
    nasRoot: nasRoot(),
  };
}

function registerIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => appInfo());

  ipcMain.handle(IPC.workspacesGet, async () => {
    await checkNas(); // re-check: the NAS may have (re)connected
    return workspacesState();
  });

  // Raw tab → Start intake: claim the case folder in Annotated 1 (atomic, so two
  // people can't both start it), then the renderer runs intake on the video.
  ipcMain.handle(IPC.rawStart, async (_e, videoPath: unknown): Promise<StartFromRawResult> => {
    if (typeof videoPath !== "string" || !isInside(rawVideosDir(), videoPath) || !existsSync(videoPath)) {
      return { ok: false, error: "That video is not in the Raw ERCP Videos folder any more. Refresh and try again." };
    }
    const looseAtRoot = path.dirname(path.resolve(videoPath)) === path.resolve(rawVideosDir());
    const caseId = looseAtRoot
      ? safeFolderName(path.basename(videoPath).replace(/\.[^.]+$/, ""))
      : caseNameFromSource(videoPath);
    if (!isSafeCaseId(caseId)) {
      return { ok: false, error: `The folder name "${caseId}" can't be used as a case name (it starts with "_" or "."). Rename it in Raw ERCP Videos first.` };
    }
    try {
      await claimProjectOnDisk(workspaceDir("a1"), caseId, caseId, nowIso());
      return { ok: true, ref: makeRef("a1", caseId) };
    } catch (err) {
      if (err instanceof AlreadyExistsError) return { ok: false, error: err.message, ref: makeRef("a1", caseId) };
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record({ source: "intake", message: e.message, detail: e.stack, stage: "intake" }, nowIso());
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.nasChooseRoot, async (): Promise<Settings | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Choose the NAS folder (the one holding Raw ERCP Videos)",
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    settings = applySettings(settings, { nasRoot: res.filePaths[0] });
    await saveSettings(settingsPath(), settings);
    await checkNas();
    return settings;
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

  ipcMain.handle(IPC.projectGet, (_e, ref: unknown) => {
    const p = resolveRef(ref);
    return p ? readManifest(p.baseDir, p.id) : null;
  });

  ipcMain.handle(IPC.projectReveal, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (p) shell.showItemInFolder(path.join(projectDir(p.baseDir, p.id), "project.json"));
  });

  ipcMain.handle(IPC.projectAccess, (_e, ref: unknown): CaseAccess => {
    const p = resolveRef(ref);
    return p ? accessOf(p) : { readOnly: true, reason: "Unknown case." };
  });

  // Annotated 1 → Second review: full verified copy into Annotated 2.
  ipcMain.handle(IPC.reviewStart, async (event, ref: unknown): Promise<ReviewStartResult> => {
    const p = resolveRef(ref);
    if (!p || p.ws !== "a1") return { ok: false, error: "Second review starts from a case in Annotated 1." };
    if (!nasCheck.writable) return { ok: false, error: nasCheck.error ?? "The NAS folder can't be reached." };
    try {
      await startSecondReview({
        a1Dir: workspaceDir("a1"),
        a2Dir: workspaceDir("a2"),
        id: p.id,
        now: nowIso(),
        appVersion: app.getVersion(),
        onProgress: (pr) => event.sender.send(IPC.reviewProgress, pr),
      });
      return { ok: true, ref: makeRef("a2", p.id) };
    } catch (err) {
      if (err instanceof AlreadyExistsError) return { ok: false, error: err.message, ref: makeRef("a2", p.id) };
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record({ source: "review", message: e.message, detail: e.stack, projectId: p.id }, nowIso());
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle(IPC.projectDelete, async (_e, ref: unknown): Promise<boolean> => {
    const p = editable(ref);
    return p ? (await deleteProjectOnDisk(p.baseDir, p.id, nowIso())) !== null : false;
  });

  ipcMain.handle(IPC.settingsGet, (): Settings => settings);

  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: unknown): Promise<Settings> => {
    settings = applySettings(settings, patch);
    await saveSettings(settingsPath(), settings);
    await checkNas();
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

  ipcMain.handle(IPC.intakeRun, async (_e, ref: unknown, sourcePath: unknown) => {
    const p = editable(ref);
    if (!p || typeof sourcePath !== "string") return null;
    const { baseDir, id: projectId } = p;
    if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
    const send = (p: IntakeProgress) => mainWindow?.webContents.send(IPC.intakeProgress, p);
    try {
      await updateStageOnDisk(baseDir, projectId, "intake", { status: "in_progress" }, nowIso());
      const record = await runIntake({
        baseDir: baseDir,
        projectId,
        sourcePath,
        ffmpegPath: resolveBinary(ffmpegPath),
        ffprobePath: resolveBinary(ffprobePathRaw),
        now: nowIso(),
        onProgress: send,
      });
      return await updateStageOnDisk(
        baseDir,
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
      return updateStageOnDisk(baseDir, projectId, "intake", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.phasesLoad, async (_e, ref: unknown): Promise<PhasesState | null> => {
    const p = resolveRef(ref);
    if (!p) return null;
    const { baseDir, id: projectId } = p;
    const intake = await readIntakeRecord(baseDir, projectId);
    return {
      labels: await loadPhaseLabels(baseDir, projectId),
      videoUrl: intake?.playbackFile ? `endoseg-video://video/${encodeURIComponent(p.ref)}` : null,
      durationSec: intake?.meta.durationSec ?? 0,
      fps: intake?.meta.fps ?? 0,
      width: intake?.meta.width ?? 0,
      height: intake?.meta.height ?? 0,
      crop: await loadCrop(baseDir, projectId, intake),
      caseName: intake ? caseNameFromSource(intake.sourcePath) : null,
      exportRoot: clipsRootFor(p),
    };
  });

  ipcMain.handle(IPC.phasesSave, async (_e, ref: unknown, labels: unknown) => {
    const p = editable(ref);
    if (!p) return null;
    const { baseDir, id: projectId } = p;
    const saved = await savePhaseLabels(baseDir, projectId, labels);
    // Edited labels mean the clips/frames on disk are stale until re-exported.
    await updateStageOnDisk(baseDir, projectId, "phases", { status: "in_progress", counts: { spans: saved.spans.length } }, nowIso());
    return saved;
  });

  ipcMain.handle(IPC.phasesExport, async (event, ref: unknown) => {
    const p = editable(ref);
    if (!p) return null;
    const { baseDir, id: projectId } = p;
    if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
    const send = (p: PhaseExportProgress) => event.sender.send(IPC.phasesProgress, p);
    try {
      const r = await runPhaseExport({
        baseDir: baseDir,
        projectId,
        ffmpegPath: resolveBinary(ffmpegPath),
        exportRoot: clipsRootFor(p),
        fps: settings.phaseFps,
        onProgress: send,
      });
      return await updateStageOnDisk(
        baseDir,
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
      return updateStageOnDisk(baseDir, projectId, "phases", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.cropSave, async (_e, ref: unknown, crop: unknown) => {
    const p = editable(ref);
    if (!p) return null;
    const { baseDir, id: projectId } = p;
    const saved = await saveCrop(baseDir, projectId, crop);
    // Clips/frames already exported used the old crop — flag the stage for re-export.
    const m = await readManifest(baseDir, projectId);
    if (m?.stages.phases.status === "done") {
      await updateStageOnDisk(baseDir, projectId, "phases", { status: "in_progress" }, nowIso());
    }
    return saved;
  });

  ipcMain.handle(IPC.phasesReveal, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (!p) return;
    const dir = clipsRootFor(p);
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle(IPC.segListFrames, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (!p) return { source: "none", frames: [] };
    const r = await listSegFrames(p.baseDir, p.id, p.ref);
    console.log(`[seg] listFrames ws=${p.ws} source=${r.source} count=${r.frames.length}`);
    return r;
  });

  ipcMain.handle(IPC.segLoad, (_e, ref: unknown) => {
    const p = resolveRef(ref);
    return p ? loadSegmentationSnapshot(p.baseDir, p.id) : null;
  });

  ipcMain.handle(IPC.segSave, async (_e, ref: unknown, snapshot: unknown) => {
    const p = editable(ref);
    if (!p) return null;
    const { baseDir, id: projectId } = p;
    try {
      const { frameCount, maskCount } = await saveSegmentationSnapshot(baseDir, projectId, snapshot);
      return await updateStageOnDisk(
        baseDir,
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
      return updateStageOnDisk(baseDir, projectId, "segmentation", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.exportRun, async (event, ref: unknown) => {
    const p = editable(ref);
    if (!p) return null;
    const { baseDir, id: projectId } = p;
    const send = (p: ExportProgress) => event.sender.send(IPC.exportProgress, p);
    try {
      await updateStageOnDisk(baseDir, projectId, "export", { status: "in_progress" }, nowIso());
      const result = await runExport(baseDir, projectId, send, exportRootFor(p));
      return await updateStageOnDisk(
        baseDir,
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
      return updateStageOnDisk(baseDir, projectId, "export", { status: "error", error: e.message }, nowIso());
    }
  });

  ipcMain.handle(IPC.exportReveal, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (!p) return;
    const dir = exportRootFor(p);
    await fs.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle(IPC.framesRemove, async (_e, ref: unknown, frameIds: unknown): Promise<string[]> => {
    const p = editable(ref);
    if (!p || !Array.isArray(frameIds)) return [];
    const names = frameIds.filter((f): f is string => typeof f === "string");
    return removeFrames(p.baseDir, p.id, names);
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
      console.log("ENDOSEG_SMOKE_OK renderer-loaded nas=" + nasRoot() + " writable=" + nasCheck.writable);
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
  await checkNas();

  // Serve project frames over endoseg-frame://frame/<projectId>/<source>/<file>.
  protocol.handle("endoseg-frame", async (req) => {
    try {
      const u = new URL(req.url);
      const parts = u.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
      const [ref, source, filename] = parts;
      const p = resolveRef(ref);
      const abs = p ? resolveFramePath(p.baseDir, p.id, source, filename) : null;
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
      const p = resolveRef(decodeURIComponent(new URL(req.url).pathname.split("/").filter(Boolean)[0] ?? ""));
      const intake = p ? await readIntakeRecord(p.baseDir, p.id) : null;
      const rel = intake?.playbackFile;
      if (!p || !rel || rel.includes("..")) return new Response("not found", { status: 404 });
      const abs = path.join(projectDir(p.baseDir, p.id), "00_intake", rel);
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
