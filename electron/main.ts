import { app, BrowserWindow, ipcMain, dialog, shell, type IpcMainInvokeEvent } from "electron";
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
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
import type { ProjectManifest, StageId, StageState, StageStatus } from "../src/core/stages.js";
import { startSecondReview, isInReview } from "../src/node/review.js";
import { foreignLock, holderLabel, LOCK_FILE, type Me } from "../src/node/caselock.js";
import { CaseSession, CaseLockedError } from "../src/node/session.js";
import { caseAccess, reviewAccess } from "../src/node/access.js";
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
import { listRawCases, isInside, rawCaseId } from "../src/node/raw.js";
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
import {
  listSegFrames,
  loadSegmentationSnapshot,
  saveSegmentationSnapshot,
  removeFrames,
} from "../src/node/segmentation.js";
import { runExport } from "../src/node/export.js";
import { setupUpdater, checkForUpdates } from "./updater.js";
import { registerSchemes, handleSchemes } from "./protocols.js";
import {
  type Settings,
  loadSettings,
  saveSettings,
  applySettings,
} from "../src/node/settings.js";
import { CrashLogger } from "../src/node/crashlog.js";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5234";

// Must be declared before app "ready".
registerSchemes();

let mainWindow: BrowserWindow | null = null;
let crashLogger: CrashLogger;
let settings: Settings;
let nasCheck: LibraryCheck = { writable: false };

function nowIso(): string {
  return new Date().toISOString();
}

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

function caseDirOf(p: Resolved): string {
  return projectDir(p.baseDir, p.id);
}

/** Clips live inside the case folder: <case>\clips\<case>_<phase>\. */
function clipsRootFor(p: Resolved): string {
  return path.join(caseDirOf(p), "clips");
}

/** Where a project's exports go: custom root (per-project subfolder) or 03_export. */
function exportRootFor(p: Resolved): string {
  return settings.exportDir ? path.join(settings.exportDir, p.id) : path.join(caseDirOf(p), "03_export");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ── Open-case lock and access ────────────────────────────────────────────────

/** This app run. The lock shows the computer and Windows user; nothing is kept after closing. */
const me: Me = (() => {
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    /* no user info */
  }
  return { sessionId: randomUUID(), computer: os.hostname(), user };
})();

function notifyAccess(ref: string, access: CaseAccess): void {
  mainWindow?.webContents.send(IPC.caseAccessChanged, { ref, access });
}

const session = new CaseSession(me, {
  // Someone took the case over: tell the renderer, which stops offering edits.
  onLost: (ref) => {
    const p = resolveRef(ref);
    if (p) void accessOf(p).then((a) => notifyAccess(ref, a.readOnly ? a : { readOnly: true, reason: "This case was taken over on another computer." }));
  },
});

/**
 * Annotated 1 cases are read-only while they have a copy in Annotated 2, and
 * any case is read-only while someone else has it open.
 */
function accessOf(p: Resolved): Promise<CaseAccess> {
  return caseAccess({ ws: p.ws, id: p.id, caseDir: caseDirOf(p), a2Dir: workspaceDir("a2"), sessionId: me.sessionId, nowMs: Date.now() });
}

async function openByMap(refs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const now = Date.now();
  await Promise.all(
    refs.map(async (ref) => {
      const p = resolveRef(ref);
      const l = p && (await foreignLock(caseDirOf(p), me.sessionId, now).catch(() => null));
      if (l) out[ref] = holderLabel(l);
    }),
  );
  return out;
}

const CASE_MISSING =
  "This case's folder can't be reached on the NAS (it was deleted, or the network drive dropped). The change was not saved.";

/**
 * Register a handler that changes a case. It runs only if the case may be
 * changed here, and holds the case's lock until it finishes (see CaseSession).
 * Every handler that writes into a case folder must be registered this way.
 */
function handleWrite<R>(
  channel: string,
  fallback: R,
  fn: (event: IpcMainInvokeEvent, p: Resolved, ...args: unknown[]) => Promise<R>,
): void {
  ipcMain.handle(channel, async (event, ref: unknown, ...args: unknown[]): Promise<R> => {
    const p = resolveRef(ref);
    if (!p) return fallback;
    const dir = caseDirOf(p);
    try {
      // Joins the session's queue straight away, so a Back sent just after this
      // write can't release the lock before the write has it.
      return await session.run(p.ref, dir, async () => {
        const a = await accessOf(p);
        if (a.readOnly) throw new Error(a.reason);
        return fn(event, p, ...args);
      });
    } catch (err) {
      if (err instanceof CaseLockedError) throw new Error(err.message);
      if (!(await pathExists(dir))) throw new Error(CASE_MISSING);
      throw err;
    }
  });
}

type StagePatch = Partial<StageState> & { status: StageStatus };

/**
 * Run a stage's work and record the result on the manifest: the patch it
 * returns, or the error (also written to the crash log).
 */
async function runStage(p: Resolved, stage: StageId, work: () => Promise<StagePatch>, markStarted = false): Promise<ProjectManifest | null> {
  try {
    if (markStarted) await updateStageOnDisk(p.baseDir, p.id, stage, { status: "in_progress" }, nowIso());
    return await updateStageOnDisk(p.baseDir, p.id, stage, await work(), nowIso());
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    await crashLogger.record({ source: stage, message: e.message, detail: e.stack, projectId: p.id, stage }, nowIso());
    return updateStageOnDisk(p.baseDir, p.id, stage, { status: "error", error: e.message }, nowIso());
  }
}

/** Open a folder of the case, creating it only if the case may be changed here. */
async function revealDir(p: Resolved, dir: string): Promise<void> {
  if (!(await pathExists(dir))) {
    const caseDir = caseDirOf(p);
    if (!(await pathExists(caseDir))) return;
    const made = await session
      .run(p.ref, caseDir, async () => {
        if ((await accessOf(p)).readOnly) return false;
        await fs.mkdir(dir, { recursive: true });
        return true;
      })
      .catch(() => false);
    if (!made) {
      await shell.openPath(caseDir);
      return;
    }
  }
  await shell.openPath(dir);
}

function bundledFfmpeg(): string {
  if (!ffmpegPath) throw new Error("Bundled ffmpeg not found");
  return resolveBinary(ffmpegPath);
}

/** In a packaged app the bundled binaries are unpacked from the asar archive. */
function resolveBinary(p: string): string {
  return app.isPackaged ? p.replace("app.asar", "app.asar.unpacked") : p;
}

async function workspacesState(): Promise<WorkspacesState> {
  const ok = nasCheck.writable;
  const [raw, a1, a2] = ok
    ? await Promise.all([listRawCases(rawVideosDir()), listProjects(workspaceDir("a1")), listProjects(workspaceDir("a2"))])
    : [[], [], []];
  const now = Date.now();
  const inReview = await Promise.all(a1.map((p) => isInReview(workspaceDir("a2"), p.id, now).catch(() => true)));
  return {
    nasRoot: nasRoot(),
    folders: { raw: rawVideosDir(), a1: workspaceDir("a1"), a2: workspaceDir("a2") },
    rawFound: ok && existsSync(rawVideosDir()),
    raw: rawRows(raw, a1, a2),
    a1,
    a2,
    a1InReview: a1.filter((_, i) => inReview[i]).map((p) => p.id),
    openBy: ok ? await openByMap([...a1.map((c) => makeRef("a1", c.id)), ...a2.map((c) => makeRef("a2", c.id))]) : {},
    ...nasCheck,
  };
}

// ── Crash handling ───────────────────────────────────────────────────────────

function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => {
    void crashLogger.record({ source: "uncaughtException", message: err.message, detail: err.stack }, nowIso());
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    void crashLogger.record({ source: "unhandledRejection", message: err.message, detail: err.stack }, nowIso());
  });
  app.on("render-process-gone", (_e, _wc, details) => {
    void crashLogger.record(
      { source: "render-process-gone", message: `renderer gone: ${details.reason}`, detail: `exitCode=${details.exitCode}` },
      nowIso(),
    );
  });
  app.on("child-process-gone", (_e, details) => {
    void crashLogger.record({ source: "child-process-gone", message: `child gone: ${details.type} ${details.reason}` }, nowIso());
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

/** App, settings, NAS and troubleshooting. */
function registerAppIpc(): void {
  ipcMain.handle(IPC.appInfo, (): AppInfo => appInfo());

  ipcMain.handle(IPC.workspacesGet, async () => {
    await checkNas(); // re-check: the NAS may have (re)connected
    return workspacesState();
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

  ipcMain.handle(IPC.settingsGet, (): Settings => settings);

  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: unknown): Promise<Settings> => {
    settings = applySettings(settings, patch);
    await saveSettings(settingsPath(), settings);
    await checkNas();
    return settings;
  });

  ipcMain.handle(IPC.updateCheck, (): Promise<UpdateStatus> => checkForUpdates(app.isPackaged));

  ipcMain.handle(IPC.crashList, () => crashLogger.list());
  ipcMain.handle(IPC.crashRead, (_e, file: unknown) => (typeof file === "string" ? crashLogger.read(file) : null));
  ipcMain.handle(IPC.crashOpenFolder, () => {
    void shell.openPath(crashLogger.directory);
  });
}

/** Cases: start, open/close (lock), second review, delete. */
function registerCaseIpc(): void {
  // Raw tab → Start intake: claim the case folder in Annotated 1 (atomic, so two
  // people can't both start it), then the renderer runs intake on the video.
  ipcMain.handle(IPC.rawStart, async (_e, videoPath: unknown): Promise<StartFromRawResult> => {
    if (typeof videoPath !== "string" || !isInside(rawVideosDir(), videoPath) || !existsSync(videoPath)) {
      return { ok: false, error: "That video is not in the Raw ERCP Videos folder any more. Refresh and try again." };
    }
    const caseId = rawCaseId(rawVideosDir(), videoPath);
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

  ipcMain.handle(IPC.projectGet, (_e, ref: unknown) => {
    const p = resolveRef(ref);
    return p ? readManifest(p.baseDir, p.id) : null;
  });

  ipcMain.handle(IPC.projectReveal, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (p) shell.showItemInFolder(path.join(caseDirOf(p), "project.json"));
  });

  ipcMain.handle(IPC.projectAccess, async (_e, ref: unknown): Promise<CaseAccess> => {
    const p = resolveRef(ref);
    return p ? accessOf(p) : { readOnly: true, reason: "Unknown case." };
  });

  ipcMain.handle(IPC.caseOpen, async (_e, ref: unknown, takeOver: unknown): Promise<CaseAccess> => {
    const p = resolveRef(ref);
    if (!p) return { readOnly: true, reason: "Unknown case." };
    const dir = caseDirOf(p);
    const result = await (async (): Promise<CaseAccess> => {
      // A case in second review stays read-only in Annotated 1: no lock needed.
      const review = await reviewAccess({ ws: p.ws, id: p.id, a2Dir: workspaceDir("a2"), nowMs: Date.now() }).catch(
        (err: Error): CaseAccess => ({ readOnly: true, reason: `The case can't be read on the NAS right now (${err.message}). Check the network drive and try again.` }),
      );
      if (review) {
        await session.close();
        return review;
      }
      if (!(await pathExists(dir))) {
        await session.close();
        return { readOnly: true, reason: "This case's folder can't be found." };
      }
      try {
        const r = await session.open(p.ref, dir, takeOver === true);
        if (r.ok) return { readOnly: false };
        // Not ours: never report editable without the lock, even if it was just released.
        const l = r.holder;
        return {
          readOnly: true,
          reason: `${holderLabel(l)} has this case open, so you can't change it here.`,
          lockedBy: holderLabel(l),
          lockedSince: l.openedAt,
        };
      } catch (err) {
        return { readOnly: true, reason: `Can't open the case for editing: ${(err as Error).message}` };
      }
    })();
    // Clears a "taken over" warning once the case is ours again.
    if (!result.readOnly) notifyAccess(p.ref, result);
    return result;
  });

  ipcMain.handle(IPC.caseClose, () => session.close());

  // Annotated 1 → Second review: full verified copy into Annotated 2.
  ipcMain.handle(IPC.reviewStart, async (event, ref: unknown): Promise<ReviewStartResult> => {
    const p = resolveRef(ref);
    if (!p || p.ws !== "a1") return { ok: false, error: "Second review starts from a case in Annotated 1." };
    if (!nasCheck.writable) return { ok: false, error: nasCheck.error ?? "The NAS folder can't be reached." };
    try {
      // Hold the Annotated 1 case's lock for the whole copy, so nobody edits it meanwhile.
      await session.run(p.ref, caseDirOf(p), () =>
        startSecondReview({
          a1Dir: workspaceDir("a1"),
          a2Dir: workspaceDir("a2"),
          id: p.id,
          now: nowIso(),
          appVersion: app.getVersion(),
          onProgress: (pr) => event.sender.send(IPC.reviewProgress, pr),
        }),
      );
      return { ok: true, ref: makeRef("a2", p.id) };
    } catch (err) {
      if (err instanceof AlreadyExistsError) return { ok: false, error: err.message, ref: makeRef("a2", p.id) };
      if (err instanceof CaseLockedError) {
        return { ok: false, error: `${holderLabel(err.holder)} has this case open. Ask them to close it first, so the review starts from their finished work.` };
      }
      const e = err instanceof Error ? err : new Error(String(err));
      await crashLogger.record({ source: "review", message: e.message, detail: e.stack, projectId: p.id }, nowIso());
      return { ok: false, error: e.message };
    }
  });

  handleWrite(IPC.projectDelete, false, async (_e, p) => {
    const moved = await deleteProjectOnDisk(p.baseDir, p.id, nowIso());
    // The lock taken for the delete moved with the folder: drop it there.
    if (moved) await fs.rm(path.join(moved, LOCK_FILE), { force: true }).catch(() => undefined);
    return moved !== null;
  });
}

/** Intake, phases, crop, segmentation and export inside one case. */
function registerStageIpc(): void {
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

  handleWrite(IPC.intakeRun, null, async (_e, p, sourcePath) => {
    if (typeof sourcePath !== "string") return null;
    const ffmpeg = bundledFfmpeg();
    return runStage(
      p,
      "intake",
      async () => {
        const record = await runIntake({
          baseDir: p.baseDir,
          projectId: p.id,
          sourcePath,
          ffmpegPath: ffmpeg,
          ffprobePath: resolveBinary(ffprobePathRaw),
          now: nowIso(),
          onProgress: (pr: IntakeProgress) => mainWindow?.webContents.send(IPC.intakeProgress, pr),
        });
        return { status: "done", counts: { sources: 1, minutes: Math.round(record.meta.durationSec / 6) / 10 } };
      },
      true,
    );
  });

  ipcMain.handle(IPC.phasesLoad, async (_e, ref: unknown): Promise<PhasesState | null> => {
    const p = resolveRef(ref);
    if (!p) return null;
    const intake = await readIntakeRecord(p.baseDir, p.id);
    return {
      labels: await loadPhaseLabels(p.baseDir, p.id),
      videoUrl: intake?.playbackFile ? `endoseg-video://video/${encodeURIComponent(p.ref)}` : null,
      durationSec: intake?.meta.durationSec ?? 0,
      fps: intake?.meta.fps ?? 0,
      width: intake?.meta.width ?? 0,
      height: intake?.meta.height ?? 0,
      crop: await loadCrop(p.baseDir, p.id, intake),
      caseName: intake ? p.id : null,
      exportRoot: clipsRootFor(p),
    };
  });

  handleWrite(IPC.phasesSave, null, async (_e, p, labels) => {
    const saved = await savePhaseLabels(p.baseDir, p.id, labels);
    // Edited labels mean the clips/frames on disk are stale until re-exported.
    await updateStageOnDisk(p.baseDir, p.id, "phases", { status: "in_progress", counts: { spans: saved.spans.length } }, nowIso());
    return saved;
  });

  handleWrite(IPC.phasesExport, null, async (event, p) => {
    const ffmpeg = bundledFfmpeg();
    return runStage(p, "phases", async () => {
      const r = await runPhaseExport({
        baseDir: p.baseDir,
        projectId: p.id,
        ffmpegPath: ffmpeg,
        exportRoot: clipsRootFor(p),
        fps: settings.phaseFps,
        onProgress: (pr: PhaseExportProgress) => event.sender.send(IPC.phasesProgress, pr),
      });
      return { status: "done", counts: { clips: r.clips, frames: r.frames } };
    });
  });

  handleWrite(IPC.cropSave, null, async (_e, p, crop) => {
    const saved = await saveCrop(p.baseDir, p.id, crop);
    // Clips/frames already exported used the old crop — flag the stage for re-export.
    const m = await readManifest(p.baseDir, p.id);
    if (m?.stages.phases.status === "done") {
      await updateStageOnDisk(p.baseDir, p.id, "phases", { status: "in_progress" }, nowIso());
    }
    return saved;
  });

  ipcMain.handle(IPC.phasesReveal, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (p) await revealDir(p, clipsRootFor(p));
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

  handleWrite(IPC.segSave, null, (_e, p, snapshot) =>
    runStage(p, "segmentation", async () => {
      const { frameCount, maskCount } = await saveSegmentationSnapshot(p.baseDir, p.id, snapshot);
      return { status: "done", counts: { frames: frameCount, masks: maskCount } };
    }),
  );

  handleWrite(IPC.exportRun, null, (event, p) =>
    runStage(
      p,
      "export",
      async () => {
        const result = await runExport(p.baseDir, p.id, (pr: ExportProgress) => event.sender.send(IPC.exportProgress, pr), exportRootFor(p));
        return { status: "done", counts: { frames: result.frameCount, labelMaps: result.labelMapCount } };
      },
      true,
    ),
  );

  ipcMain.handle(IPC.exportReveal, async (_e, ref: unknown) => {
    const p = resolveRef(ref);
    if (p) await revealDir(p, exportRootFor(p));
  });

  handleWrite(IPC.framesRemove, [] as string[], async (_e, p, frameIds) => {
    if (!Array.isArray(frameIds)) return [];
    return removeFrames(p.baseDir, p.id, frameIds.filter((f): f is string => typeof f === "string"));
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

  handleSchemes(resolveRef);
  registerAppIpc();
  registerCaseIpc();
  registerStageIpc();
  setupUpdater((s) => mainWindow?.webContents.send(IPC.updateStatus, s));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Release the open-case locks on the way out (a crash just lets them go stale).
let releasedOnQuit = false;
app.on("before-quit", (e) => {
  if (releasedOnQuit) return;
  e.preventDefault();
  releasedOnQuit = true;
  // Don't let a hung network drive stop EndoSeg from closing: the lock just goes stale.
  const timeout = new Promise((r) => setTimeout(r, 5000));
  void Promise.race([session.releaseAll(), timeout]).finally(() => app.quit());
});
