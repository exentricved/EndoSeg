// Pure, dependency-free model of the EndoSeg project lifecycle.
// Kept free of Electron/Node APIs so it can be unit-tested in isolation and
// reused by both the main process (disk IO) and the renderer (display).

export const STAGES = ["intake", "dedup", "segmentation", "export"] as const;
export type StageId = (typeof STAGES)[number];

export const STAGE_LABELS: Record<StageId, string> = {
  intake: "Intake",
  dedup: "Dedup",
  segmentation: "Segmentation",
  export: "Export",
};

export type StageStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "error"
  | "needs_review";

export interface StageState {
  status: StageStatus;
  /** ISO-8601 timestamp of the last status change. */
  at?: string;
  /** Free-form per-stage counters (kept, dropped, framesDone, ...). */
  counts?: Record<string, number>;
  /** Last error message for this stage, if status === "error". */
  error?: string;
}

export interface ProjectManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  stages: Record<StageId, StageState>;
}

function pendingStages(): Record<StageId, StageState> {
  return {
    intake: { status: "pending" },
    dedup: { status: "pending" },
    segmentation: { status: "pending" },
    export: { status: "pending" },
  };
}

export function createProject(
  id: string,
  name: string,
  now: string,
): ProjectManifest {
  return {
    schemaVersion: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    stages: pendingStages(),
  };
}

export function setStage(
  manifest: ProjectManifest,
  stage: StageId,
  patch: Partial<StageState> & { status: StageStatus },
  now: string,
): ProjectManifest {
  const prev = manifest.stages[stage];
  return {
    ...manifest,
    updatedAt: now,
    stages: {
      ...manifest.stages,
      [stage]: { ...prev, ...patch, at: now },
    },
  };
}

/**
 * The stage the project is currently sitting at: the first stage that is not
 * yet `done`. If every stage is done, returns the last stage (`export`).
 */
export function currentStage(manifest: ProjectManifest): StageId {
  for (const s of STAGES) {
    if (manifest.stages[s].status !== "done") return s;
  }
  return STAGES[STAGES.length - 1];
}

/** A project needs attention if any stage errored or is flagged for review. */
export function needsAttention(manifest: ProjectManifest): boolean {
  return STAGES.some((s) => {
    const st = manifest.stages[s].status;
    return st === "error" || st === "needs_review";
  });
}

/** Fraction (0..1) of stages that are `done`. */
export function completion(manifest: ProjectManifest): number {
  const done = STAGES.filter((s) => manifest.stages[s].status === "done").length;
  return done / STAGES.length;
}
