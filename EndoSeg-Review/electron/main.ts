import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { IPC, type SegFrame, type SegFramesResult, type OpenPackageResult } from "../src/shared/ipc.js";
import { extractPackage, savePackage, saveAnnotationsToWorkingDir } from "../src/node/package-io.js";
import {
  getReviewerName,
  setReviewerName,
  ensureReviewDb,
  setFrameDecision,
  getDecisions,
  logEdit,
} from "../src/node/reviewer-db.js";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5235";

// Custom protocol that serves frames from the current review session's working dir.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "reviewer-frame",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

// Current open review session.
let session: { workingDir: string; zipPath: string } | null = null;

// If launched by double-clicking a .endoseg file the path arrives via argv or open-file.
let pendingFilePath: string | null = null;

function userDataPath(): string {
  return app.getPath("userData");
}

function nowIso(): string {
  return new Date().toISOString();
}

async function pngSize(file: string): Promise<{ w: number; h: number }> {
  let fh: import("node:fs/promises").FileHandle | undefined;
  try {
    fh = await fs.open(file, "r");
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    if (buf.toString("ascii", 1, 4) !== "PNG") return { w: 0, h: 0 };
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return { w: 0, h: 0 };
  } finally {
    await fh?.close();
  }
}

// ── File association: .endoseg ─────────────────────────────────────────────────

// Windows: file path passed as process.argv[1] or later argv entries.
function extractArgvFilePath(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const candidate = args.find((a) => a.endsWith(".endoseg"));
  return candidate ?? null;
}

// macOS: fired when the OS asks the app to open a file.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (filePath.endsWith(".endoseg")) {
    pendingFilePath = filePath;
    // If already running, send to renderer.
    if (mainWindow) {
      mainWindow.webContents.send("reviewer:pendingFile", filePath);
    }
  }
});

// ── IPC ──────────────────────────────────────────────────────────────────────

function registerIpc(): void {
  // ── Annotator-compatible handlers (ignore projectId, use session) ──────────

  ipcMain.handle(IPC.segListFrames, async (): Promise<SegFramesResult> => {
    if (!session) return { source: "none" as const, frames: [] };
    const framesDir = path.join(session.workingDir, "frames");
    try {
      const files = (await fs.readdir(framesDir))
        .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();
      const frames: SegFrame[] = [];
      for (const f of files) {
        const { w, h } = await pngSize(path.join(framesDir, f));
        frames.push({
          frameId: f,
          name: f.replace(/\.(png|jpg|jpeg)$/i, ""),
          url: `reviewer-frame://${encodeURIComponent(f)}`,
          width: w,
          height: h,
        });
      }
      return { source: "kept" as const, frames };
    } catch {
      return { source: "none" as const, frames: [] };
    }
  });

  ipcMain.handle(IPC.segLoad, async (): Promise<unknown | null> => {
    if (!session) return null;
    try {
      const raw = await fs.readFile(path.join(session.workingDir, "annotations.leus"), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.segSave, async (_e, _projectId: unknown, snapshot: unknown): Promise<null> => {
    if (!session) return null;
    try {
      await saveAnnotationsToWorkingDir(session.workingDir, snapshot);
      // Log a save event to the review DB for each frame in the snapshot.
      const snap = snapshot as { frames?: Array<{ frameId?: string }> };
      if (snap?.frames) {
        for (const f of snap.frames) {
          if (f.frameId) logEdit(session.workingDir, f.frameId, "annotation_save", null);
        }
      }
    } catch (e) {
      console.error("[reviewer] save error:", e);
    }
    return null;
  });

  // ── Reviewer-specific handlers ─────────────────────────────────────────────

  ipcMain.handle(IPC.reviewGetAutoOpen, (): string | null => {
    const p = pendingFilePath ?? extractArgvFilePath();
    return p;
  });

  ipcMain.handle(IPC.reviewOpen, async (): Promise<OpenPackageResult | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: "Open .endoseg review package",
      filters: [{ name: "EndoSeg Review Package", extensions: ["endoseg"] }],
      properties: ["openFile"],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return openPackageFromPath(res.filePaths[0]);
  });

  ipcMain.handle(IPC.reviewSavePackage, async (): Promise<string | null> => {
    if (!session) return null;
    const timestamp = nowIso().replace(/[:.]/g, "-").slice(0, 19);
    const base = path.basename(session.zipPath, ".endoseg");
    const defaultName = `${base}_reviewed_${timestamp}.endoseg`;
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: "Save reviewed package",
      defaultPath: path.join(path.dirname(session.zipPath), defaultName),
      filters: [{ name: "EndoSeg Review Package", extensions: ["endoseg"] }],
    });
    if (res.canceled || !res.filePath) return null;
    savePackage(session.workingDir, res.filePath);
    shell.showItemInFolder(res.filePath);
    return res.filePath;
  });

  ipcMain.handle(IPC.reviewGetName, (): string | null => getReviewerName(userDataPath()));

  ipcMain.handle(IPC.reviewSetName, (_e, name: unknown): void => {
    if (typeof name === "string" && name.trim()) {
      setReviewerName(userDataPath(), name.trim());
    }
  });

  ipcMain.handle(IPC.reviewSetDecision, (_e, frameId: unknown, status: unknown, comment: unknown): void => {
    if (!session || typeof frameId !== "string" || typeof status !== "string") return;
    setFrameDecision(session.workingDir, frameId, status, typeof comment === "string" ? comment : undefined);
  });

  ipcMain.handle(IPC.reviewGetDecisions, () => {
    if (!session) return {};
    return getDecisions(session.workingDir);
  });
}

async function openPackageFromPath(zipPath: string): Promise<OpenPackageResult | null> {
  try {
    const workingDir = await extractPackage(zipPath);
    session = { workingDir, zipPath };

    // Ensure review.db is initialised with the reviewer's name.
    const rName = getReviewerName(userDataPath()) ?? "Reviewer";
    ensureReviewDb(workingDir, rName);

    pendingFilePath = null;

    // List frames for the renderer to display immediately.
    const framesDir = path.join(workingDir, "frames");
    const frames: SegFrame[] = [];
    try {
      const files = (await fs.readdir(framesDir))
        .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();
      for (const f of files) {
        const { w, h } = await pngSize(path.join(framesDir, f));
        frames.push({
          frameId: f,
          name: f.replace(/\.(png|jpg|jpeg)$/i, ""),
          url: `reviewer-frame://${encodeURIComponent(f)}`,
          width: w,
          height: h,
        });
      }
    } catch { /* no frames dir */ }

    const decisions = getDecisions(workingDir);

    return { frames, reviewerName: rName, decisions, zipPath };
  } catch (err) {
    console.error("[reviewer] openPackageFromPath error:", err);
    return null;
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "EndoSeg Review",
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

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  protocol.handle("reviewer-frame", async (req) => {
    if (!session) return new Response("no session", { status: 404 });
    try {
      const u = new URL(req.url);
      const filename = decodeURIComponent(u.hostname + u.pathname).replace(/^\//, "");
      const safe = path.basename(filename);
      const data = await fs.readFile(path.join(session.workingDir, "frames", safe));
      return new Response(new Uint8Array(data), {
        headers: { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
