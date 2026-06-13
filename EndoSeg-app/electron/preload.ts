import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type EndoSegApi,
  type IntakeProgress,
  type UpdateStatus,
} from "../src/shared/ipc.js";

// Minimal, explicit bridge. The renderer gets only these async methods —
// no direct Node/Electron access (contextIsolation stays on).
const api: EndoSegApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getLibrary: () => ipcRenderer.invoke(IPC.libraryGet),
  createProject: (name) => ipcRenderer.invoke(IPC.libraryCreate, name),
  chooseLibraryDir: () => ipcRenderer.invoke(IPC.libraryChooseDir),
  getProject: (id) => ipcRenderer.invoke(IPC.projectGet, id),
  revealProject: (id) => ipcRenderer.invoke(IPC.projectReveal, id),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  pickVideo: () => ipcRenderer.invoke(IPC.intakePickVideo),
  runIntake: (projectId, sourcePath) => ipcRenderer.invoke(IPC.intakeRun, projectId, sourcePath),
  onIntakeProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: IntakeProgress) => cb(p);
    ipcRenderer.on(IPC.intakeProgress, listener);
    return () => ipcRenderer.removeListener(IPC.intakeProgress, listener);
  },
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  onUpdateStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, s: UpdateStatus) => cb(s);
    ipcRenderer.on(IPC.updateStatus, listener);
    return () => ipcRenderer.removeListener(IPC.updateStatus, listener);
  },
  listCrashes: () => ipcRenderer.invoke(IPC.crashList),
  readCrash: (file) => ipcRenderer.invoke(IPC.crashRead, file),
  openCrashFolder: () => ipcRenderer.invoke(IPC.crashOpenFolder),
};

contextBridge.exposeInMainWorld("endoseg", api);
