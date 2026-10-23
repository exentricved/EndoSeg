// Shared contract between the Electron main process and the renderer.
// Channel names live here so both sides cannot drift.

import type { ProjectSummary } from "../core/manifest.js";
import type { ProjectManifest } from "../core/stages.js";
import type { PhaseLabels } from "../core/phases.js";
import type { PhaseExportProgress } from "../node/phases.js";
import type { Settings } from "../node/settings.js";

export type { PhaseExportProgress };

export const IPC = {
  appInfo: "app:info",
  libraryGet: "library:get",
  libraryCreate: "library:create",
  libraryChooseDir: "library:chooseDir",
  exportChooseDir: "export:chooseDir",
  settingChooseDir: "settings:chooseDir",
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
} as const;

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
  /** Case name (folder the video came from) used for the export folders. */
  caseName: string | null;
  /** Where the <case>_<phase> folders will be written. */
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
  libraryDir: string;
}

export interface LibraryState {
  baseDir: string;
  projects: ProjectSummary[];
  /** False when the folder can't be reached or written (e.g. NAS drive not mapped). */
  writable: boolean;
  error?: string;
}

export interface CreateProjectResult {
  id: string;
}

/** The API surface exposed on `window.endoseg` by the preload bridge. */
export interface EndoSegApi {
  appInfo(): Promise<AppInfo>;
  getLibrary(): Promise<LibraryState>;
  createProject(name: string): Promise<CreateProjectResult>;
  chooseLibraryDir(): Promise<LibraryState | null>;
  /** Pick a custom export folder; resolves to the updated settings, or null if cancelled. */
  chooseExportDir(): Promise<Settings | null>;
  getProject(id: string): Promise<ProjectManifest | null>;
  revealProject(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  /** Pick a folder for a folder-valued setting; resolves to the updated settings, or null if cancelled. */
  chooseSettingDir(key: "rawVideosDir" | "phaseExportDir"): Promise<Settings | null>;
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
