import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type ReviewerEndoSegApi,
  type ReviewerApi,
  type SegFramesResult,
  type FrameDecision,
  type OpenPackageResult,
} from "../src/shared/ipc.js";

// Annotator-compatible surface (same shape as EndoSeg so AnnotatorCanvas needs no changes).
const endosegApi: ReviewerEndoSegApi = {
  listSegFrames: (_projectId) => ipcRenderer.invoke(IPC.segListFrames) as Promise<SegFramesResult>,
  loadSegmentation: (_projectId) => ipcRenderer.invoke(IPC.segLoad) as Promise<unknown | null>,
  saveSegmentation: (_projectId, snapshot) =>
    ipcRenderer.invoke(IPC.segSave, "", snapshot) as Promise<null>,
};

// Reviewer-specific surface.
const reviewerApi: ReviewerApi = {
  openPackage: () => ipcRenderer.invoke(IPC.reviewOpen) as Promise<OpenPackageResult | null>,
  savePackage: () => ipcRenderer.invoke(IPC.reviewSavePackage) as Promise<string | null>,
  getReviewerName: () => ipcRenderer.invoke(IPC.reviewGetName) as Promise<string | null>,
  setReviewerName: (name) => ipcRenderer.invoke(IPC.reviewSetName, name) as Promise<void>,
  setDecision: (frameId, status, comment) =>
    ipcRenderer.invoke(IPC.reviewSetDecision, frameId, status, comment) as Promise<void>,
  getDecisions: () =>
    ipcRenderer.invoke(IPC.reviewGetDecisions) as Promise<Record<string, FrameDecision>>,
  getAutoOpen: () => ipcRenderer.invoke(IPC.reviewGetAutoOpen) as Promise<string | null>,
};

contextBridge.exposeInMainWorld("endoseg", endosegApi);
contextBridge.exposeInMainWorld("reviewerApi", reviewerApi);
