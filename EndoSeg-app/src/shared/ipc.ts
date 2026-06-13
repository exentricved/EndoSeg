// Shared contract between the Electron main process and the renderer.
// Channel names live here so both sides cannot drift.

import type { ProjectSummary } from "../core/manifest.js";
import type { ProjectManifest } from "../core/stages.js";
import type { Settings } from "../node/settings.js";

export const IPC = {
  appInfo: "app:info",
  libraryGet: "library:get",
  libraryCreate: "library:create",
  libraryChooseDir: "library:chooseDir",
  projectGet: "project:get",
  projectReveal: "project:reveal",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  intakePickVideo: "intake:pickVideo",
  intakeRun: "intake:run",
  intakeProgress: "intake:progress",
  dedupRun: "dedup:run",
  dedupProgress: "dedup:progress",
  updateCheck: "update:check",
  updateStatus: "update:status",
  crashList: "crash:list",
  crashRead: "crash:read",
  crashOpenFolder: "crash:openFolder",
} as const;

export interface IntakeProgress {
  phase: "copy" | "probe" | "extract";
  frames?: number;
}

export interface DedupProgress {
  phase: "hash" | "copy";
  /** Frames hashed so far (during the "hash" phase). */
  frames?: number;
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
  getProject(id: string): Promise<ProjectManifest | null>;
  revealProject(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  pickVideo(): Promise<string | null>;
  runIntake(projectId: string, sourcePath: string): Promise<ProjectManifest | null>;
  onIntakeProgress(cb: (p: IntakeProgress) => void): () => void;
  runDedup(projectId: string): Promise<ProjectManifest | null>;
  onDedupProgress(cb: (p: DedupProgress) => void): () => void;
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
