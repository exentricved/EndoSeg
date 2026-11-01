// The NAS folder layout and the project references the renderer passes around.
// Pure (no Node/Electron), so it is unit-tested.
//
//   <NAS root>\Raw ERCP Videos\<case>\video.mp4   ← source videos, never written to
//   <NAS root>\Annotated 1\<case>\                ← first pass
//   <NAS root>\Annotated 2\<case>\                ← reviewed copy
//
// A project is addressed as "<workspace>:<case id>", e.g. "a1:Case 12". Windows
// folder names cannot contain ":", so the split is unambiguous.

import { safeFolderName } from "./phases.js";
import type { ProjectSummary } from "./manifest.js";
import type { StageId, StageStatus } from "./stages.js";

export const WORKSPACES = ["a1", "a2"] as const;
export type WorkspaceId = (typeof WORKSPACES)[number];

export const NAS_FOLDERS = {
  raw: "Raw ERCP Videos",
  a1: "Annotated 1",
  a2: "Annotated 2",
} as const;

export const WORKSPACE_LABELS: Record<WorkspaceId, string> = {
  a1: "Annotated 1",
  a2: "Annotated 2",
};

export const DEFAULT_NAS_ROOT = "R:\\akshin-ercp-nas";

export interface ProjectRef {
  ws: WorkspaceId;
  id: string;
}

export function makeRef(ws: WorkspaceId, id: string): string {
  return `${ws}:${id}`;
}

/** A case id is a single safe folder name, never "."/"..", never a reserved "_" or "." name. */
export function isSafeCaseId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 200 &&
    id === safeFolderName(id) &&
    !id.startsWith(".") &&
    !id.startsWith("_")
  );
}

/** Parse an untrusted "<ws>:<id>" reference; null if malformed or unsafe. */
export function parseRef(ref: unknown): ProjectRef | null {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf(":");
  if (i < 0) return null;
  const ws = ref.slice(0, i);
  const id = ref.slice(i + 1);
  if (!(WORKSPACES as readonly string[]).includes(ws)) return null;
  if (!isSafeCaseId(id)) return null;
  return { ws: ws as WorkspaceId, id };
}

export const VIDEO_EXTS = ["mp4", "mov", "avi", "mkv", "m4v", "wmv", "mpg", "mpeg"];

export function isVideoFile(name: string): boolean {
  const m = /\.([^.]+)$/.exec(name);
  return !!m && VIDEO_EXTS.includes(m[1].toLowerCase()) && !name.startsWith(".") && !name.startsWith("~$");
}

/** One video found in the Raw folder. */
export interface RawVideo {
  file: string;
  path: string;
  bytes: number;
}

/** One case in the Raw tab: a case folder (or a loose video at the Raw root). */
export interface RawCase {
  /** Folder name as it appears on disk. */
  name: string;
  /** Project id the case gets in Annotated 1/2 (the folder name made filesystem-safe). */
  caseId: string;
  videos: RawVideo[];
}

/** Where a Raw case is in the pipeline, derived only from what is on disk. */
export interface RawRow extends RawCase {
  a1: { currentStage: StageId; currentStatus: StageStatus; intakeStatus: StageStatus } | null;
  inA2: boolean;
}

export function intakeStatusOf(s: ProjectSummary): StageStatus {
  return s.stageStatuses.find((x) => x.stage === "intake")?.status ?? "pending";
}

/** Join the Raw listing with what already exists in Annotated 1 and 2. */
export function rawRows(raw: RawCase[], a1: ProjectSummary[], a2: ProjectSummary[]): RawRow[] {
  const byId1 = new Map(a1.map((p) => [p.id, p]));
  const ids2 = new Set(a2.map((p) => p.id));
  return raw.map((c) => {
    const p = byId1.get(c.caseId);
    return {
      ...c,
      a1: p ? { currentStage: p.currentStage, currentStatus: p.currentStatus, intakeStatus: intakeStatusOf(p) } : null,
      inA2: ids2.has(c.caseId),
    };
  });
}

/** Short status text for a Raw row. */
export function rawRowStatus(r: RawRow): string {
  if (r.inA2) return "In Annotated 2";
  if (!r.a1) return r.videos.length ? "Not started" : "No video in folder";
  if (r.a1.intakeStatus === "error") return "Annotated 1 · intake failed";
  if (r.a1.intakeStatus !== "done") return "Annotated 1 · intake not finished";
  return "In Annotated 1";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
