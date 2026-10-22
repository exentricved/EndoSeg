import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC,
  type EndoSegApi,
  type IntakeProgress,
  type ExportProgress,
  type UpdateStatus,
} from "../src/shared/ipc.js";

// Minimal, explicit bridge. The renderer gets only these async methods —
// no direct Node/Electron access (contextIsolation stays on).
const api: EndoSegApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getLibrary: () => ipcRenderer.invoke(IPC.libraryGet),
  createProject: (name) => ipcRenderer.invoke(IPC.libraryCreate, name),
  chooseLibraryDir: () => ipcRenderer.invoke(IPC.libraryChooseDir),
  chooseExportDir: () => ipcRenderer.invoke(IPC.exportChooseDir),
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
  listSegFrames: (projectId) => ipcRenderer.invoke(IPC.segListFrames, projectId),
  loadSegmentation: (projectId) => ipcRenderer.invoke(IPC.segLoad, projectId),
  saveSegmentation: (projectId, snapshot) => ipcRenderer.invoke(IPC.segSave, projectId, snapshot),
  runExport: (projectId) => ipcRenderer.invoke(IPC.exportRun, projectId),
  onExportProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: ExportProgress) => cb(p);
    ipcRenderer.on(IPC.exportProgress, listener);
    return () => ipcRenderer.removeListener(IPC.exportProgress, listener);
  },
  revealExport: (projectId) => ipcRenderer.invoke(IPC.exportReveal, projectId),
  setProjectStatus: (projectId, status) => ipcRenderer.invoke(IPC.projectSetStatus, projectId, status),
  removeFrames: (projectId, frameIds) => ipcRenderer.invoke(IPC.framesRemove, projectId, frameIds),
  listActivity: () => ipcRenderer.invoke(IPC.activityList),
  openActivityFolder: () => ipcRenderer.invoke(IPC.activityOpenFolder),
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
