// Safe parsing/validation of project.json coming from disk (untrusted input)
// plus the library-level summary used by the Project Hub.

import {
  type ProjectManifest,
  type StageId,
  type StageState,
  type StageStatus,
  STAGES,
  currentStage,
  needsAttention,
  completion,
} from "./stages.js";

const STATUSES: StageStatus[] = [
  "pending",
  "in_progress",
  "done",
  "error",
  "needs_review",
];

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseStage(raw: unknown): ParseResult<StageState> {
  if (!isObject(raw)) return { ok: false, error: "stage is not an object" };
  if (!STATUSES.includes(raw.status as StageStatus)) {
    return { ok: false, error: `invalid stage status: ${String(raw.status)}` };
  }
  const out: StageState = { status: raw.status as StageStatus };
  if (typeof raw.at === "string") out.at = raw.at;
  if (typeof raw.error === "string") out.error = raw.error;
  if (isObject(raw.counts)) {
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.counts)) {
      if (typeof v === "number" && Number.isFinite(v)) counts[k] = v;
    }
    out.counts = counts;
  }
  return { ok: true, value: out };
}

/** Validate an untrusted parsed `project.json` into a ProjectManifest. */
export function parseManifest(raw: unknown): ParseResult<ProjectManifest> {
  if (!isObject(raw)) return { ok: false, error: "manifest is not an object" };
  if (raw.schemaVersion !== 1) {
    return { ok: false, error: `unsupported schemaVersion: ${String(raw.schemaVersion)}` };
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return { ok: false, error: "missing id" };
  }
  if (typeof raw.name !== "string") {
    return { ok: false, error: "missing name" };
  }
  if (!isObject(raw.stages)) {
    return { ok: false, error: "missing stages" };
  }

  const stages = {} as Record<StageId, StageState>;
  for (const s of STAGES) {
    const rawStage = (raw.stages as Record<string, unknown>)[s];
    // Stages added after a project was created (e.g. phases) start out pending.
    if (rawStage === undefined && s === "phases") {
      stages[s] = { status: "pending" };
      continue;
    }
    const parsed = parseStage(rawStage);
    if (!parsed.ok) return { ok: false, error: `stage "${s}": ${parsed.error}` };
    stages[s] = parsed.value;
  }

  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  const value: ProjectManifest = {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
    stages,
  };
  return { ok: true, value };
}

// ── Library summary (what the hub renders) ───────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  currentStage: StageId;
  currentStatus: StageStatus;
  completion: number;
  needsAttention: boolean;
  updatedAt: string;
  /** Per-stage status, in pipeline order, for the stage indicator. */
  stageStatuses: { stage: StageId; status: StageStatus }[];
}

export function summarize(manifest: ProjectManifest): ProjectSummary {
  const cur = currentStage(manifest);
  return {
    id: manifest.id,
    name: manifest.name,
    currentStage: cur,
    currentStatus: manifest.stages[cur].status,
    completion: completion(manifest),
    needsAttention: needsAttention(manifest),
    updatedAt: manifest.updatedAt,
    stageStatuses: STAGES.map((stage) => ({
      stage,
      status: manifest.stages[stage].status,
    })),
  };
}

/** Sort: attention-needed first, then most-recently-updated. */
export function sortSummaries(items: ProjectSummary[]): ProjectSummary[] {
  return [...items].sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
