// Shared contract between the Electron main process and the renderer.
// Channel names live here so both sides cannot drift.

import type { ProjectSummary } from "../core/manifest.js";
import type { ProjectManifest } from "../core/stages.js";
import type { CropRect, PhaseLabels } from "../core/phases.js";
import type { PhaseExportProgress } from "../node/phases.js";
import type { Settings } from "../node/settings.js";
import type { RawRow } from "../core/workspaces.js";
import type { ReviewProgress } from "../node/review.js";

export type { PhaseExportProgress };

export const IPC = {
  appInfo: "app:info",
  workspacesGet: "workspaces:get",
  rawStart: "raw:start",
  nasChooseRoot: "nas:chooseRoot",
  exportChooseDir: "export:chooseDir",
  projectGet: "project:get",
  projectReveal: "project:reveal",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  intakePickVideo: "intake:pickVideo",
  intakeRun: "intake:run",
  intakeProgress: "intake:progress",
  segListFrames: "segmentation:listFrames",
  segLoad: "segmentation:load",
  segSave: "segmentation:save",
  exportRun: "export:run",
  exportProgress: "export:progress",
  exportReveal: "export:reveal",
  updateCheck: "update:check",
  updateStatus: "update:status",
  crashList: "crash:list",
  crashRead: "crash:read",
  crashOpenFolder: "crash:openFolder",
  framesRemove: "frames:remove",
  phasesLoad: "phases:load",
  phasesSave: "phases:save",
  phasesExport: "phases:export",
  phasesProgress: "phases:progress",
  phasesReveal: "phases:reveal",
  cropSave: "crop:save",
  projectDelete: "project:delete",
  projectAccess: "project:access",
  reviewStart: "review:start",
  reviewProgress: "review:progress",
} as const;

export type { ReviewProgress };

/** Whether a case can be edited here. */
export interface CaseAccess {
  readOnly: boolean;
  /** Shown to the user when read-only. */
  reason?: string;
  /** Ref of the editable copy (the Annotated 2 case), when there is one. */
  reviewRef?: string;
}

export interface ReviewStartResult {
  ok: boolean;
  /** "a2:<case>" of the new review copy (or the existing one, when already started). */
  ref?: string;
  error?: string;
}

export interface IntakeProgress {
  phase: "copy" | "probe" | "preview";
  percent?: number;
}

/** Everything the phase-labelling view needs for one project. */
export interface PhasesState {
  labels: PhaseLabels;
  /** endoseg-video://video/<projectId> — null until a video has been taken in. */
  videoUrl: string | null;
  durationSec: number;
  fps: number;
  /** Source picture size (crop coordinates are in these pixels). */
  width: number;
  height: number;
  /** Region kept on export; null = whole picture. */
  crop: CropRect | null;
  /** Case name (folder the video came from) used for the export folders. */
  caseName: string | null;
  /** Where the <case>_<phase> folders will be written (<case>\clips). */
  exportRoot: string;
}

/** One frame the annotator can load, addressed by the endoseg-frame:// protocol. */
export interface SegFrame {
  frameId: string;
  name: string;
  /** endoseg-frame://<projectId>/<source>/<name> — streamed from disk on demand. */
  url: string;
  /** Pixel dimensions, parsed from the PNG header so the renderer needn't decode upfront. */
  width: number;
  height: number;
  /** Phase the frame was extracted from (absent for frames from older projects). */
  phase?: string;
  /** Seconds into the source video (absent for frames from older projects). */
  timeSec?: number;
  /** Maneuvers under way at this moment (ids from core/phases MANEUVERS). */
  maneuvers?: string[];
  /** Sampled from the cannulation attempt that succeeded. */
  success?: boolean;
}

export interface SegFramesResult {
  /** Which on-disk frame set is being annotated. */
  source: "kept" | "raw" | "none";
  frames: SegFrame[];
}

export interface SegSaveResult {
  frameCount: number;
  maskCount: number;
}

export interface ExportProgress {
  phase: "frames" | "metadata";
  done: number;
  total: number;
}

export interface ExportResult {
  exportId: string;
  exportDir: string;
  frameCount: number;
  labelMapCount: number;
}

export type UpdateState =
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "disabled";

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  nasRoot: string;
}

/** Everything the hub's Raw / Annotated 1 / Annotated 2 tabs show. */
export interface WorkspacesState {
  nasRoot: string;
  folders: { raw: string; a1: string; a2: string };
  /** False when the NAS is reachable but has no "Raw ERCP Videos" folder. */
  rawFound: boolean;
  raw: RawRow[];
  a1: ProjectSummary[];
  a2: ProjectSummary[];
  /** Annotated 1 cases that have a copy in Annotated 2 (read-only in Annotated 1). */
  a1InReview: string[];
  /** False when the NAS can't be reached or written (e.g. drive not mapped). */
  writable: boolean;
  error?: string;
}

export interface StartFromRawResult {
  ok: boolean;
  /** "<ws>:<case>" of the new (or, when already started, the existing) case. */
  ref?: string;
  error?: string;
}

/** The API surface exposed on `window.endoseg` by the preload bridge. */
export interface EndoSegApi {
  appInfo(): Promise<AppInfo>;
  /** List the Raw folder and both Annotated folders (re-checks that the NAS is reachable). */
  getWorkspaces(): Promise<WorkspacesState>;
  /** Claim a Raw case in Annotated 1 (fails if someone already started it); then call runIntake. */
  startFromRaw(videoPath: string): Promise<StartFromRawResult>;
  /** Pick the NAS root folder; resolves to the updated settings, or null if cancelled. */
  chooseNasRoot(): Promise<Settings | null>;
  /** Pick a custom export folder; resolves to the updated settings, or null if cancelled. */
  chooseExportDir(): Promise<Settings | null>;
  getProject(id: string): Promise<ProjectManifest | null>;
  revealProject(id: string): Promise<void>;
  /** Move a case to <workspace>/_deleted/ (recoverable); resolves to true if it was moved. */
  deleteProject(id: string): Promise<boolean>;
  /** Read-only state of a case (Annotated 1 cases are read-only once in second review). */
  getAccess(id: string): Promise<CaseAccess>;
  /** Copy an Annotated 1 case (video included) to Annotated 2 and verify it by hash. */
  startSecondReview(id: string): Promise<ReviewStartResult>;
  onReviewProgress(cb: (p: ReviewProgress) => void): () => void;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  runIntake(projectId: string, sourcePath: string): Promise<ProjectManifest | null>;
  onIntakeProgress(cb: (p: IntakeProgress) => void): () => void;
  /** Pick a video (opens in the raw-videos folder); resolves to its path, or null if cancelled. */
  pickVideo(): Promise<string | null>;
  /** List the frames to annotate (01_frames/raw; legacy projects fall back to kept). */
  listSegFrames(projectId: string): Promise<SegFramesResult>;
  /** Load a previously saved annotation snapshot (02_segmentation/annotations.leus), or null. */
  loadSegmentation(projectId: string): Promise<unknown | null>;
  /** Persist the annotation snapshot + per-class mask PNGs into 02_segmentation/. */
  saveSegmentation(projectId: string, snapshot: unknown): Promise<ProjectManifest | null>;
  /** Run the export stage: copies frames + generates multi-class label maps + metadata.json. */
  runExport(projectId: string): Promise<ProjectManifest | null>;
  onExportProgress(cb: (p: ExportProgress) => void): () => void;
  /** Open the project's 03_export folder in the system file manager. */
  revealExport(projectId: string): Promise<void>;
  /** Move frames out of the project into 01_frames/removed/; resolves to the names moved. */
  removeFrames(projectId: string, frameIds: string[]): Promise<string[]>;
  loadPhases(projectId: string): Promise<PhasesState>;
  /** Persist phase labels (00_intake/phases.json); resolves to the normalized labels. */
  savePhases(projectId: string, labels: PhaseLabels): Promise<PhaseLabels>;
  /** Write one clip per span to <exportRoot>/<case>_<phase>/ and extract 1 fps frames for segmentation. */
  exportPhases(projectId: string): Promise<ProjectManifest | null>;
  onPhasesProgress(cb: (p: PhaseExportProgress) => void): () => void;
  revealPhases(projectId: string): Promise<void>;
  /** Save the export crop (null clears it); resolves to the stored crop after clamping/rounding. */
  saveCrop(projectId: string, crop: CropRect | null): Promise<CropRect | null>;
  checkForUpdates(): Promise<UpdateStatus>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
  listCrashes(): Promise<string[]>;
  readCrash(file: string): Promise<string | null>;
  openCrashFolder(): Promise<void>;
}

declare global {
  interface Window {
    endoseg: EndoSegApi;
  }
}
