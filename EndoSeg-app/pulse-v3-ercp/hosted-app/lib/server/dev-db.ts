import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";

import type {
  AssignmentStatus,
  CaseCurrentStage,
  CasePriority,
  CaseStatus,
  HostedAssignment,
  HostedAuditEvent,
  HostedCase,
  HostedCaseAsset,
  HostedCaseBundle,
  HostedCasePackage,
  HostedCasePackageSourceType,
  HostedCaseReference,
  HostedComment,
  HostedCommentStatus,
  HostedCommentThread,
  HostedCommentThreadStatus,
  HostedCommentThreadType,
  HostedCommentVisibilityScope,
  HostedDiscussionActivitySummary,
  HostedRole,
  HostedSubmission,
  HostedUser,
  HostedWorkflowChainStep,
  ReviewStage,
} from "@/lib/domain/models";

type HostedDevDatabase = {
  schemaVersion: 5;
  seedVersion: number;
  users: HostedUser[];
  casePackages: HostedCasePackage[];
  cases: HostedCase[];
  caseAssets: HostedCaseAsset[];
  caseReferences: HostedCaseReference[];
  workflowChains: HostedWorkflowChainStep[];
  assignments: HostedAssignment[];
  submissions: HostedSubmission[];
  commentThreads: HostedCommentThread[];
  comments: HostedComment[];
  auditEvents: HostedAuditEvent[];
};

type UploadedPackageInput = {
  uploadedByUserId: string;
  manifestFile: File;
  assetFiles: File[];
};

type DirectIngestionInput = {
  uploadedByUserId: string;
  sourceType: HostedCasePackageSourceType;
  summary: string;
  priority: CasePriority;
  externalCaseId: string | null;
  frameFiles: File[];
  reportFiles: File[];
  frameDimensions: Array<{ width: number; height: number }>;
  uploadFilename: string;
  originalUploadFile?: File | null;
  extractionIntervalSeconds?: number | null;
};

type ActiveReviewStage = Extract<ReviewStage, "review_1" | "review_2">;

const ACTIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = ["assigned", "opened", "in_progress"];
const CHAIN_STAGE_ORDER: ActiveReviewStage[] = ["review_1", "review_2"];

const DEV_DATA_DIR = path.join(process.cwd(), "dev-data");
const DB_PATH = path.join(DEV_DATA_DIR, "hosted-dev-db.json");
const SEED_PATH = path.join(DEV_DATA_DIR, "seed.json");
const OBJECT_STORE_ROOT = path.join(DEV_DATA_DIR, "object-store");

let mutationQueue: Promise<void> = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function sortByDateDesc<T extends { eventTs?: string; createdAt?: string; assignedAt?: string }>(
  items: T[],
) {
  return [...items].sort((a, b) => {
    const aValue = a.eventTs || a.createdAt || a.assignedAt || "";
    const bValue = b.eventTs || b.createdAt || b.assignedAt || "";
    return aValue < bValue ? 1 : -1;
  });
}

function safeCaseKey(input: string) {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "case"
  );
}

function displayCaseIdFromCount(count: number) {
  return `CASE-LIV-${String(count).padStart(3, "0")}`;
}

function isStageActive(assignment: HostedAssignment) {
  return ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status);
}

function assignmentSort(a: HostedAssignment, b: HostedAssignment) {
  return a.assignedAt < b.assignedAt ? 1 : -1;
}

function caseStatusForAssignedStage(stage: ActiveReviewStage): CaseStatus {
  return stage === "review_1" ? "assigned_to_r1" : "assigned_to_r2";
}

function caseStatusForInReviewStage(stage: ActiveReviewStage): CaseStatus {
  return stage === "review_1" ? "in_review_r1" : "in_review_r2";
}

function activeStageFromCase(caseRecord: HostedCase): ActiveReviewStage | null {
  if (caseRecord.currentStage === "review_1" || caseRecord.currentStage === "review_2") {
    return caseRecord.currentStage;
  }
  return null;
}

function normalizeAssignmentStatus(status: unknown): AssignmentStatus {
  if (
    status === "unassigned" ||
    status === "assigned" ||
    status === "opened" ||
    status === "in_progress" ||
    status === "submitted" ||
    status === "returned" ||
    status === "cancelled"
  ) {
    return status;
  }
  if (status === "draft_saved") return "in_progress";
  if (status === "reassigned") return "cancelled";
  return "assigned";
}

function normalizeCommentThreadStatus(status: unknown): HostedCommentThreadStatus {
  if (status === "resolved") return "resolved";
  return "open";
}

function normalizeCommentStatus(status: unknown): HostedCommentStatus {
  if (status === "resolved") return "resolved";
  return "open";
}

function normalizeCurrentStage(stage: unknown): CaseCurrentStage {
  if (
    stage === "review_1" ||
    stage === "review_2" ||
    stage === "adjudication" ||
    stage === "admin_finalization" ||
    stage === "completed"
  ) {
    return stage;
  }
  return "review_1";
}

function normalizePriority(priority: unknown): CasePriority {
  if (priority === "routine" || priority === "priority" || priority === "urgent") {
    return priority;
  }
  return "routine";
}

function referenceKindFromFilename(filename: string): HostedCaseReference["referenceKind"] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp")
  ) {
    return "image";
  }
  return "text";
}

function mimeTypeForReference(referenceKind: HostedCaseReference["referenceKind"], filename: string) {
  if (referenceKind === "pdf") return "application/pdf";
  if (referenceKind === "image") {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    return "image/png";
  }
  if (referenceKind === "json") return "application/json";
  return "text/plain; charset=utf-8";
}

function safeFileName(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function isSupportedReportKind(referenceKind: HostedCaseReference["referenceKind"]) {
  return referenceKind === "pdf" || referenceKind === "image";
}

type ParsedReferenceInput =
  | {
      title: string;
      referenceKind: "text" | "json";
      sourceName: string;
      textContent: string;
    }
  | {
      title: string;
      referenceKind: "pdf" | "image";
      sourceName: string;
      attachmentFilename: string;
    };

function deriveWorkflowChains(raw: Record<string, unknown>) {
  const cases = Array.isArray(raw.cases) ? raw.cases : [];
  const assignments = Array.isArray(raw.assignments) ? raw.assignments : [];
  const createdAtFallback = nowIso();

  return cases.flatMap((caseValue, caseIndex) => {
    const caseRecord = caseValue as Record<string, unknown>;
    const caseId = typeof caseRecord.id === "string" ? caseRecord.id : `case_${caseIndex + 1}`;
    const caseAssignments = assignments.filter((value) => {
      const assignment = value as Record<string, unknown>;
      return assignment.caseId === caseId;
    }) as Array<Record<string, unknown>>;

    const inferredReviewers = new Map<ActiveReviewStage, string | null>();

    for (const stage of CHAIN_STAGE_ORDER) {
      const latest = caseAssignments
        .filter((assignment) => assignment.reviewStage === stage)
        .sort((a, b) => {
          const aValue = typeof a.assignedAt === "string" ? a.assignedAt : "";
          const bValue = typeof b.assignedAt === "string" ? b.assignedAt : "";
          return aValue < bValue ? 1 : -1;
        })[0];

      inferredReviewers.set(
        stage,
        latest && typeof latest.assignedToUserId === "string" ? latest.assignedToUserId : null,
      );
    }

    return CHAIN_STAGE_ORDER.map((stage, index) => ({
      id: `chain_${caseId}_${stage}`,
      caseId,
      position: index + 1,
      reviewStage: stage,
      assignedReviewerUserId: inferredReviewers.get(stage) || null,
      assignmentMode: "manual" as const,
      status: index === 0 ? "active" as const : "planned" as const,
      createdAt:
        typeof caseRecord.createdAt === "string" ? caseRecord.createdAt : createdAtFallback,
      updatedAt:
        typeof caseRecord.createdAt === "string" ? caseRecord.createdAt : createdAtFallback,
    }));
  });
}

function normalizeDatabase(raw: Record<string, unknown>): HostedDevDatabase {
  const workflowChainsRaw = Array.isArray(raw.workflowChains)
    ? raw.workflowChains
    : deriveWorkflowChains(raw);

  const db: HostedDevDatabase = {
    schemaVersion: 5,
    seedVersion: typeof raw.seedVersion === "number" ? raw.seedVersion : 1,
    users: Array.isArray(raw.users) ? (raw.users as HostedUser[]) : [],
    casePackages: Array.isArray(raw.casePackages)
      ? (raw.casePackages as Array<Record<string, unknown>>).map((item) => ({
          id: typeof item.id === "string" ? item.id : `pkg_${randomUUID()}`,
          caseId: typeof item.caseId === "string" ? item.caseId : "unknown",
          uploadFilename:
            typeof item.uploadFilename === "string" ? item.uploadFilename : "uploaded_package",
          manifestStorageKey:
            typeof item.manifestStorageKey === "string" ? item.manifestStorageKey : "",
          originalUploadStorageKey:
            typeof item.originalUploadStorageKey === "string" ? item.originalUploadStorageKey : "",
          intakeStatus:
            item.intakeStatus === "pending" ||
            item.intakeStatus === "processing" ||
            item.intakeStatus === "failed"
              ? item.intakeStatus
              : "ready",
          sourceType:
            item.sourceType === "image_upload" || item.sourceType === "video_upload"
              ? item.sourceType
              : "manifest_package",
          extractionIntervalSeconds:
            typeof item.extractionIntervalSeconds === "number"
              ? item.extractionIntervalSeconds
              : null,
          uploadedAt: typeof item.uploadedAt === "string" ? item.uploadedAt : nowIso(),
          processedAt: typeof item.processedAt === "string" ? item.processedAt : null,
        }))
      : [],
    cases: Array.isArray(raw.cases)
      ? (raw.cases as Array<Record<string, unknown>>).map((item) => ({
          id: typeof item.id === "string" ? item.id : `case_${randomUUID()}`,
          displayCaseId:
            typeof item.displayCaseId === "string" ? item.displayCaseId : displayCaseIdFromCount(1),
          externalCaseId: typeof item.externalCaseId === "string" ? item.externalCaseId : null,
          status: "ready_for_assignment",
          currentStage: normalizeCurrentStage(item.currentStage),
          priority: normalizePriority(item.priority),
          uploadedByUserId:
            typeof item.uploadedByUserId === "string" ? item.uploadedByUserId : "unknown",
          createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
          completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
          metadata: {
            summary:
              item.metadata && typeof item.metadata === "object"
                ? String((item.metadata as Record<string, unknown>).summary || "")
                : "",
            manifestStorageKey:
              item.metadata && typeof item.metadata === "object"
                ? String((item.metadata as Record<string, unknown>).manifestStorageKey || "")
                : "",
            intakeStatus:
              item.metadata && typeof item.metadata === "object"
                ? ((((item.metadata as Record<string, unknown>).intakeStatus as HostedCase["metadata"]["intakeStatus"]) ||
                    "ready") as HostedCase["metadata"]["intakeStatus"])
                : "ready",
            packageFilename:
              item.metadata && typeof item.metadata === "object"
                ? String((item.metadata as Record<string, unknown>).packageFilename || "")
                : "",
          },
        }))
      : [],
    caseAssets: Array.isArray(raw.caseAssets) ? (raw.caseAssets as HostedCaseAsset[]) : [],
    caseReferences: Array.isArray(raw.caseReferences)
      ? (raw.caseReferences as HostedCaseReference[])
      : [],
    workflowChains: workflowChainsRaw.map((item, index) => {
      const record = item as Record<string, unknown>;
      const reviewStage =
        record.reviewStage === "review_2" ? "review_2" : ("review_1" as ActiveReviewStage);
      return {
        id:
          typeof record.id === "string"
            ? record.id
            : `chain_${String(record.caseId || "case")}_${reviewStage}_${index + 1}`,
        caseId: typeof record.caseId === "string" ? record.caseId : "unknown",
        position: typeof record.position === "number" ? record.position : index + 1,
        reviewStage,
        assignedReviewerUserId:
          typeof record.assignedReviewerUserId === "string" ? record.assignedReviewerUserId : null,
        assignmentMode:
          record.assignmentMode === "auto_admin_triggered" ? "auto_admin_triggered" : "manual",
        status:
          record.status === "active" ||
          record.status === "completed" ||
          record.status === "cancelled"
            ? record.status
            : "planned",
        createdAt: typeof record.createdAt === "string" ? record.createdAt : nowIso(),
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
      };
    }),
    assignments: Array.isArray(raw.assignments)
      ? (raw.assignments as Array<Record<string, unknown>>).map((item) => ({
          id: typeof item.id === "string" ? item.id : `assignment_${randomUUID()}`,
          caseId: typeof item.caseId === "string" ? item.caseId : "unknown",
          reviewStage:
            item.reviewStage === "review_2" || item.reviewStage === "adjudication"
              ? item.reviewStage
              : "review_1",
          assignedToUserId:
            typeof item.assignedToUserId === "string" ? item.assignedToUserId : "unknown",
          status: normalizeAssignmentStatus(item.status),
          assignedAt: typeof item.assignedAt === "string" ? item.assignedAt : nowIso(),
          startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
          submittedAt: typeof item.submittedAt === "string" ? item.submittedAt : null,
          previousAssignmentId:
            typeof item.previousAssignmentId === "string" ? item.previousAssignmentId : null,
        }))
      : [],
    submissions: Array.isArray(raw.submissions) ? (raw.submissions as HostedSubmission[]) : [],
    commentThreads: Array.isArray(raw.commentThreads)
      ? (raw.commentThreads as Array<Record<string, unknown>>).map((item) => ({
          id: typeof item.id === "string" ? item.id : `thread_${randomUUID()}`,
          caseId: typeof item.caseId === "string" ? item.caseId : "unknown",
        assignmentId: typeof item.assignmentId === "string" ? item.assignmentId : null,
        threadType:
            item.threadType === "case_discussion"
              ? "case_discussion"
              : item.threadType === "admin_internal_note"
                ? "admin_internal_note"
                : ("assignment_clarification" as HostedCommentThreadType),
        visibilityScope:
            item.visibilityScope === "admin_only"
              ? "admin_only"
              : item.visibilityScope === "case_admin_and_assigned_reviewers"
                ? "case_admin_and_assigned_reviewers"
                : ("assignment_admin_and_assignee" as HostedCommentVisibilityScope),
          createdByUserId:
            typeof item.createdByUserId === "string" ? item.createdByUserId : "unknown",
          createdByDisplayName:
            typeof item.createdByDisplayName === "string" ? item.createdByDisplayName : "Unknown",
          createdByEmail:
            typeof item.createdByEmail === "string" ? item.createdByEmail : "unknown@local",
          createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso(),
          status: normalizeCommentThreadStatus(item.status),
          resolvedAt: typeof item.resolvedAt === "string" ? item.resolvedAt : null,
          resolvedByUserId:
            typeof item.resolvedByUserId === "string" ? item.resolvedByUserId : null,
        }))
      : [],
    comments: Array.isArray(raw.comments)
      ? (raw.comments as Array<Record<string, unknown>>).map((item) => ({
          id: typeof item.id === "string" ? item.id : `comment_${randomUUID()}`,
          threadId: typeof item.threadId === "string" ? item.threadId : "unknown",
          caseId: typeof item.caseId === "string" ? item.caseId : "unknown",
          assignmentId: typeof item.assignmentId === "string" ? item.assignmentId : null,
          authorUserId: typeof item.authorUserId === "string" ? item.authorUserId : "unknown",
          authorDisplayName:
            typeof item.authorDisplayName === "string" ? item.authorDisplayName : "Unknown",
          authorEmail:
            typeof item.authorEmail === "string" ? item.authorEmail : "unknown@local",
          visibilityScope:
            item.visibilityScope === "admin_only"
              ? "admin_only"
              : item.visibilityScope === "case_admin_and_assigned_reviewers"
                ? "case_admin_and_assigned_reviewers"
                : ("assignment_admin_and_assignee" as HostedCommentVisibilityScope),
          body: typeof item.body === "string" ? item.body : "",
          createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
          status: normalizeCommentStatus(item.status),
          resolvedAt: typeof item.resolvedAt === "string" ? item.resolvedAt : null,
          resolvedByUserId:
            typeof item.resolvedByUserId === "string" ? item.resolvedByUserId : null,
        }))
      : [],
    auditEvents: Array.isArray(raw.auditEvents) ? (raw.auditEvents as HostedAuditEvent[]) : [],
  };

  for (const caseRecord of db.cases) {
    const caseAssignments = db.assignments
      .filter((assignment) => assignment.caseId === caseRecord.id)
      .sort(assignmentSort);
    const submittedReview1 = caseAssignments.some(
      (assignment) => assignment.reviewStage === "review_1" && assignment.status === "submitted",
    );
    const submittedReview2 = caseAssignments.some(
      (assignment) => assignment.reviewStage === "review_2" && assignment.status === "submitted",
    );
    const activeAssignment =
      caseAssignments.find(
        (assignment) =>
          (assignment.reviewStage === "review_1" || assignment.reviewStage === "review_2") &&
          isStageActive(assignment),
      ) || null;

    const originalStage = caseRecord.currentStage;
    if (originalStage === "adjudication") {
      caseRecord.currentStage = "admin_finalization";
    }
    if (originalStage === "completed") {
      caseRecord.currentStage = "completed";
    }

    if (caseRecord.currentStage === "completed") {
      caseRecord.status = "ground_truth_finalized";
      continue;
    }

    if (caseRecord.status === "needs_adjudication") {
      caseRecord.currentStage = "adjudication";
      continue;
    }

    if (caseRecord.status === "returned_for_rework") {
      if (activeAssignment?.reviewStage === "review_1" || activeAssignment?.reviewStage === "review_2") {
        caseRecord.currentStage = activeAssignment.reviewStage;
        caseRecord.status =
          activeAssignment.status === "assigned"
            ? "returned_for_rework"
            : caseStatusForInReviewStage(activeAssignment.reviewStage);
      }
      continue;
    }

    if (submittedReview2) {
      caseRecord.currentStage = "admin_finalization";
      caseRecord.status = "awaiting_admin_finalization";
      continue;
    }

    if (activeAssignment?.reviewStage === "review_2") {
      caseRecord.currentStage = "review_2";
      caseRecord.status =
        activeAssignment.status === "assigned" ? "assigned_to_r2" : "in_review_r2";
      continue;
    }

    if (submittedReview1) {
      caseRecord.currentStage = "review_2";
      caseRecord.status = activeAssignment ? "assigned_to_r2" : "ready_for_assignment";
      continue;
    }

    if (activeAssignment?.reviewStage === "review_1") {
      caseRecord.currentStage = "review_1";
      caseRecord.status =
        activeAssignment.status === "assigned" ? "assigned_to_r1" : "in_review_r1";
      continue;
    }

    if (caseRecord.status === "archived") {
      continue;
    }

    if (caseRecord.status === "ingestion_failed") {
      caseRecord.currentStage = "review_1";
      caseRecord.status = "ingestion_failed";
      continue;
    }

    caseRecord.currentStage = caseRecord.currentStage === "review_2" ? "review_2" : "review_1";
    caseRecord.status = "ready_for_assignment";
  }

  syncWorkflowChainStatuses(db);
  return db;
}

async function ensureStore() {
  await fs.mkdir(DEV_DATA_DIR, { recursive: true });
  await fs.mkdir(OBJECT_STORE_ROOT, { recursive: true });

  try {
    await fs.access(DB_PATH);
  } catch {
    const seed = await fs.readFile(SEED_PATH, "utf8");
    await fs.writeFile(DB_PATH, seed, "utf8");
  }
}

async function readDatabase(): Promise<HostedDevDatabase> {
  await ensureStore();
  const raw = await fs.readFile(DB_PATH, "utf8");
  return normalizeDatabase(JSON.parse(raw) as Record<string, unknown>);
}

async function writeDatabase(db: HostedDevDatabase) {
  db.workflowChains.sort((a, b) => {
    if (a.caseId === b.caseId) return a.position - b.position;
    return a.caseId < b.caseId ? -1 : 1;
  });
  db.commentThreads.sort((a, b) => {
    if (a.caseId === b.caseId) return a.createdAt < b.createdAt ? -1 : 1;
    return a.caseId < b.caseId ? -1 : 1;
  });
  db.comments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

async function mutateDatabase<T>(mutator: (db: HostedDevDatabase) => Promise<T>) {
  let result!: T;
  mutationQueue = mutationQueue.then(async () => {
    const db = await readDatabase();
    result = await mutator(db);
    syncWorkflowChainStatuses(db);
    await writeDatabase(db);
  });
  await mutationQueue;
  return result;
}

async function writeUploadedFile(storageKey: string, file: File) {
  const outputPath = path.join(OBJECT_STORE_ROOT, storageKey);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const bytes = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
}

async function writeTextArtifact(storageKey: string, contents: string) {
  const outputPath = path.join(OBJECT_STORE_ROOT, storageKey);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, contents, "utf8");
}

function objectStorePathFor(storageKey: string) {
  return path.join(OBJECT_STORE_ROOT, storageKey);
}

async function parseManifestFile(file: File) {
  const raw = await file.text();
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const externalCaseId =
    typeof parsed.externalCaseId === "string"
      ? parsed.externalCaseId
      : typeof parsed.caseId === "string"
        ? parsed.caseId
        : null;

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary
      : typeof parsed.description === "string"
        ? parsed.description
        : `${file.name} intake package`;

  const parsedReferences: ParsedReferenceInput[] = [];
  const explicitReferences = Array.isArray(parsed.references) ? parsed.references : [];

  for (const item of explicitReferences) {
    if (!item || typeof item !== "object") continue;
    const ref = item as Record<string, unknown>;
    const title = typeof ref.title === "string" ? ref.title : "Reference";
    const type = typeof ref.type === "string" ? ref.type.toLowerCase() : "";

    if ((type === "text" || type === "json") && ref.content !== undefined) {
      parsedReferences.push({
        title,
        referenceKind: type === "json" ? "json" : "text",
        sourceName:
          typeof ref.sourceName === "string" ? ref.sourceName : `${title.replace(/\s+/g, "_")}.${type}`,
        textContent:
          type === "json"
            ? JSON.stringify(ref.content, null, 2)
            : typeof ref.content === "string"
              ? ref.content
              : JSON.stringify(ref.content, null, 2),
      });
    }

    if (type === "attachment" && typeof ref.filename === "string") {
      const referenceKind = referenceKindFromFilename(ref.filename);
      if (referenceKind === "pdf" || referenceKind === "image") {
        parsedReferences.push({
          title,
          referenceKind,
          sourceName: ref.filename,
          attachmentFilename: ref.filename,
        });
      }
    }
  }

  if (typeof parsed.referenceText === "string" || typeof parsed.reportText === "string") {
    parsedReferences.push({
      title: typeof parsed.referenceTitle === "string" ? parsed.referenceTitle : "Reference note",
      referenceKind: "text",
      sourceName: "reference.txt",
      textContent: String(parsed.referenceText || parsed.reportText || ""),
    });
  }

  if (parsed.referenceJson !== undefined || parsed.reportJson !== undefined) {
    parsedReferences.push({
      title: "Structured reference",
      referenceKind: "json",
      sourceName: "reference.json",
      textContent: JSON.stringify(parsed.referenceJson ?? parsed.reportJson, null, 2),
    });
  }

  const attachmentNames = [
    ...(Array.isArray(parsed.referenceAttachments) ? parsed.referenceAttachments : []),
    ...(Array.isArray(parsed.reportAttachments) ? parsed.reportAttachments : []),
  ].filter((value): value is string => typeof value === "string");

  for (const attachmentName of attachmentNames) {
    const referenceKind = referenceKindFromFilename(attachmentName);
    if (referenceKind === "pdf" || referenceKind === "image") {
      parsedReferences.push({
        title: attachmentName,
        referenceKind,
        sourceName: attachmentName,
        attachmentFilename: attachmentName,
      });
    }
  }

  return {
    raw,
    parsed,
    externalCaseId,
    summary,
    priority: normalizePriority(parsed.priority),
    references: parsedReferences,
  };
}

function getCaseAssignments(db: HostedDevDatabase, caseId: string) {
  return db.assignments.filter((assignment) => assignment.caseId === caseId).sort(assignmentSort);
}

function getWorkflowChain(db: HostedDevDatabase, caseId: string) {
  return db.workflowChains
    .filter((step) => step.caseId === caseId)
    .sort((a, b) => a.position - b.position);
}

function getLatestAssignmentForStage(
  db: HostedDevDatabase,
  caseId: string,
  stage: ActiveReviewStage,
) {
  return getCaseAssignments(db, caseId).find((assignment) => assignment.reviewStage === stage) || null;
}

function getActiveAssignmentForStage(
  db: HostedDevDatabase,
  caseId: string,
  stage: ActiveReviewStage,
) {
  return getCaseAssignments(db, caseId).find(
    (assignment) => assignment.reviewStage === stage && isStageActive(assignment),
  );
}

function getChainStepForStage(
  db: HostedDevDatabase,
  caseId: string,
  stage: ActiveReviewStage,
) {
  return db.workflowChains.find((step) => step.caseId === caseId && step.reviewStage === stage) || null;
}

function syncWorkflowChainStatuses(db: HostedDevDatabase) {
  for (const caseRecord of db.cases) {
    const chain = getWorkflowChain(db, caseRecord.id);
    const assignments = getCaseAssignments(db, caseRecord.id);

    for (const step of chain) {
      const stageAssignments = assignments.filter((assignment) => assignment.reviewStage === step.reviewStage);
      const hasSubmitted = stageAssignments.some((assignment) => assignment.status === "submitted");
      const hasActive = stageAssignments.some((assignment) => isStageActive(assignment));

      if (caseRecord.status === "ground_truth_finalized") {
        step.status = "completed";
      } else if (hasSubmitted) {
        step.status = "completed";
      } else if (hasActive) {
        step.status = "active";
      } else if (caseRecord.currentStage === "review_2" && step.reviewStage === "review_1") {
        step.status = "completed";
      } else {
        step.status = "planned";
      }

      step.updatedAt = nowIso();
    }
  }
}

function buildBundleFromDb(db: HostedDevDatabase, caseId: string): HostedCaseBundle | null {
  const foundCase = db.cases.find((item) => item.id === caseId);
  if (!foundCase) return null;

  return {
    case: foundCase,
    casePackage: db.casePackages.find((pkg) => pkg.caseId === caseId) || null,
    assets: db.caseAssets.filter((asset) => asset.caseId === caseId),
    references: db.caseReferences.filter((reference) => reference.caseId === caseId),
    workflowChain: getWorkflowChain(db, caseId),
    assignments: getCaseAssignments(db, caseId),
    submissions: db.submissions
      .filter((submission) => submission.caseId === caseId)
      .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)),
  };
}

function getCommentsForThread(db: HostedDevDatabase, threadId: string) {
  return db.comments
    .filter((comment) => comment.threadId === threadId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function getAssignmentByIdFromDb(db: HostedDevDatabase, assignmentId: string) {
  return db.assignments.find((assignment) => assignment.id === assignmentId) || null;
}

function canUserCollaborateOnCase(
  db: HostedDevDatabase,
  caseId: string,
  userId: string,
  role: HostedRole,
) {
  if (role === "admin") return true;
  return db.assignments.some(
    (assignment) => assignment.caseId === caseId && assignment.assignedToUserId === userId,
  );
}

function canUserViewThread(
  db: HostedDevDatabase,
  thread: HostedCommentThread,
  userId: string,
  role: HostedRole,
) {
  if (role === "admin") return true;
  if (thread.visibilityScope === "admin_only") return false;
  return canUserCollaborateOnCase(db, thread.caseId, userId, role);
}

function canUserManageSharedThread(
  db: HostedDevDatabase,
  thread: HostedCommentThread,
  userId: string,
  role: HostedRole,
) {
  if (thread.threadType !== "case_discussion") return false;
  return role === "admin" && canUserViewThread(db, thread, userId, role);
}

function canUserEditComment(comment: HostedComment, userId: string) {
  return comment.authorUserId === userId;
}

function canUserResolveComment(comment: HostedComment, userId: string, role: HostedRole) {
  return role === "admin" || comment.authorUserId === userId;
}

function summarizeSharedDiscussionActivity(
  sharedThread: HostedCommentThread | null,
  sharedComments: HostedComment[],
  legacyCount: number,
): HostedDiscussionActivitySummary {
  const activeCount = sharedComments.filter((comment) => comment.status === "open").length;
  const resolvedCount = sharedComments.filter((comment) => comment.status === "resolved").length;

  return {
    totalSharedCount: sharedComments.length,
    activeCount,
    resolvedCount,
    legacyCount,
    threadStatus: sharedThread?.status || null,
  };
}

function resolveCommentRecord(
  comment: HostedComment,
  actorUserId: string,
  resolved: boolean,
  timestamp: string,
) {
  comment.status = resolved ? "resolved" : "open";
  comment.updatedAt = timestamp;
  comment.resolvedAt = resolved ? timestamp : null;
  comment.resolvedByUserId = resolved ? actorUserId : null;
}

function findCaseDiscussionThread(db: HostedDevDatabase, caseId: string) {
  return (
    db.commentThreads.find(
      (thread) =>
        thread.caseId === caseId &&
        thread.threadType === "case_discussion" &&
        thread.visibilityScope === "case_admin_and_assigned_reviewers",
    ) || null
  );
}

function getThreadById(db: HostedDevDatabase, threadId: string) {
  return db.commentThreads.find((thread) => thread.id === threadId) || null;
}

function findAssignmentThread(
  db: HostedDevDatabase,
  assignmentId: string,
  visibilityScope: HostedCommentVisibilityScope = "assignment_admin_and_assignee",
) {
  return (
    db.commentThreads.find(
      (thread) =>
        thread.assignmentId === assignmentId &&
        thread.threadType === "assignment_clarification" &&
        thread.visibilityScope === visibilityScope,
    ) || null
  );
}

function getLegacyAssignmentThreads(db: HostedDevDatabase, caseId: string) {
  return db.commentThreads
    .filter(
      (thread) =>
        thread.caseId === caseId &&
        thread.threadType === "assignment_clarification" &&
        thread.visibilityScope === "assignment_admin_and_assignee",
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function findAdminNotesThread(db: HostedDevDatabase, caseId: string) {
  return (
    db.commentThreads.find(
      (thread) =>
        thread.caseId === caseId &&
        thread.threadType === "admin_internal_note" &&
        thread.visibilityScope === "admin_only",
    ) || null
  );
}

function getOrCreateAssignmentThread(
  db: HostedDevDatabase,
  assignment: HostedAssignment,
  author: HostedUser,
) {
  const existing = findAssignmentThread(db, assignment.id);
  if (existing) return existing;

  const timestamp = nowIso();
  const created: HostedCommentThread = {
    id: `thread_${randomUUID()}`,
    caseId: assignment.caseId,
    assignmentId: assignment.id,
    threadType: "assignment_clarification",
    visibilityScope: "assignment_admin_and_assignee",
    createdByUserId: author.id,
    createdByDisplayName: author.displayName,
    createdByEmail: author.email,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "open",
    resolvedAt: null,
    resolvedByUserId: null,
  };
  db.commentThreads.push(created);
  return created;
}

function getOrCreateCaseDiscussionThread(
  db: HostedDevDatabase,
  caseId: string,
  author: HostedUser,
) {
  const existing = findCaseDiscussionThread(db, caseId);
  if (existing) return existing;

  const timestamp = nowIso();
  const created: HostedCommentThread = {
    id: `thread_${randomUUID()}`,
    caseId,
    assignmentId: null,
    threadType: "case_discussion",
    visibilityScope: "case_admin_and_assigned_reviewers",
    createdByUserId: author.id,
    createdByDisplayName: author.displayName,
    createdByEmail: author.email,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "open",
    resolvedAt: null,
    resolvedByUserId: null,
  };
  db.commentThreads.push(created);
  return created;
}

function getOrCreateAdminNotesThread(db: HostedDevDatabase, caseId: string, author: HostedUser) {
  const existing = findAdminNotesThread(db, caseId);
  if (existing) return existing;

  const timestamp = nowIso();
  const created: HostedCommentThread = {
    id: `thread_${randomUUID()}`,
    caseId,
    assignmentId: null,
    threadType: "admin_internal_note",
    visibilityScope: "admin_only",
    createdByUserId: author.id,
    createdByDisplayName: author.displayName,
    createdByEmail: author.email,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "open",
    resolvedAt: null,
    resolvedByUserId: null,
  };
  db.commentThreads.push(created);
  return created;
}

function createCommentRecord(
  db: HostedDevDatabase,
  thread: HostedCommentThread,
  author: HostedUser,
  body: string,
) {
  const timestamp = nowIso();
  thread.status = "open";
  thread.resolvedAt = null;
  thread.resolvedByUserId = null;
  const comment: HostedComment = {
    id: `comment_${randomUUID()}`,
    threadId: thread.id,
    caseId: thread.caseId,
    assignmentId: thread.assignmentId,
    authorUserId: author.id,
    authorDisplayName: author.displayName,
    authorEmail: author.email,
    visibilityScope: thread.visibilityScope,
    body,
    createdAt: timestamp,
    updatedAt: null,
    status: "open",
    resolvedAt: null,
    resolvedByUserId: null,
  };

  thread.updatedAt = timestamp;
  db.comments.push(comment);
  return comment;
}

function summaryCounts(assignments: HostedAssignment[]) {
  return {
    assigned: assignments.filter((assignment) => assignment.status === "assigned").length,
    opened: assignments.filter((assignment) => assignment.status === "opened").length,
    inProgress: assignments.filter((assignment) => assignment.status === "in_progress").length,
    submitted: assignments.filter((assignment) => assignment.status === "submitted").length,
  };
}

function getCurrentAssignmentForUser(
  bundle: HostedCaseBundle,
  userId: string,
  role: HostedRole,
) {
  if (role === "admin") {
    return (
      bundle.assignments.find(
        (assignment) =>
          assignment.reviewStage === bundle.case.currentStage && isStageActive(assignment),
      ) ||
      bundle.assignments[0] ||
      null
    );
  }

  return (
    bundle.assignments.find(
      (assignment) => assignment.assignedToUserId === userId && isStageActive(assignment),
    ) ||
    bundle.assignments.find((assignment) => assignment.assignedToUserId === userId) ||
    null
  );
}

export async function listDevUsers() {
  const db = await readDatabase();
  return db.users;
}

export async function listReviewerDirectory() {
  const db = await readDatabase();
  return db.users.filter((user) => user.primaryRole === "reviewer");
}

export async function listAssignableReviewers() {
  const db = await readDatabase();
  return db.users.filter((user) => user.primaryRole === "reviewer" && user.status === "active");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function validateReviewerIdentity(displayName: string, email: string) {
  const nextDisplayName = displayName.trim();
  const nextEmail = normalizeEmail(email);

  if (!nextDisplayName) {
    throw new Error("Reviewer name is required.");
  }

  if (!nextEmail || !nextEmail.includes("@")) {
    throw new Error("Reviewer email must be valid.");
  }

  return { nextDisplayName, nextEmail };
}

export async function createReviewerUser({
  displayName,
  email,
}: {
  displayName: string;
  email: string;
}) {
  return mutateDatabase(async (db) => {
    const { nextDisplayName, nextEmail } = validateReviewerIdentity(displayName, email);
    const emailExists = db.users.some((user) => normalizeEmail(user.email) === nextEmail);
    if (emailExists) {
      throw new Error("A user with that email already exists.");
    }

    const user: HostedUser = {
      id: `user_${randomUUID()}`,
      email: nextEmail,
      displayName: nextDisplayName,
      primaryRole: "reviewer",
      status: "active",
      createdAt: nowIso(),
    };

    db.users.push(user);
    return user;
  });
}

export async function updateReviewerUser({
  userId,
  displayName,
  email,
}: {
  userId: string;
  displayName: string;
  email: string;
}) {
  return mutateDatabase(async (db) => {
    const user = db.users.find((item) => item.id === userId && item.primaryRole === "reviewer");
    if (!user) {
      throw new Error("Reviewer not found.");
    }

    const { nextDisplayName, nextEmail } = validateReviewerIdentity(displayName, email);
    const emailExists = db.users.some(
      (item) => item.id !== userId && normalizeEmail(item.email) === nextEmail,
    );
    if (emailExists) {
      throw new Error("A user with that email already exists.");
    }

    user.displayName = nextDisplayName;
    user.email = nextEmail;
    return user;
  });
}

export async function setReviewerUserStatus({
  userId,
  status,
}: {
  userId: string;
  status: "active" | "disabled";
}) {
  return mutateDatabase(async (db) => {
    const user = db.users.find((item) => item.id === userId && item.primaryRole === "reviewer");
    if (!user) {
      throw new Error("Reviewer not found.");
    }

    if (status === "disabled") {
      const hasActiveAssignments = db.assignments.some(
        (assignment) =>
          assignment.assignedToUserId === userId &&
          (assignment.status === "assigned" ||
            assignment.status === "opened" ||
            assignment.status === "in_progress"),
      );
      if (hasActiveAssignments) {
        throw new Error("Cannot disable a reviewer with active assignments.");
      }
    }

    user.status = status;
    return user;
  });
}

export async function findDevUserById(userId: string) {
  const db = await readDatabase();
  return db.users.find((user) => user.id === userId) || null;
}

export async function listAllCases() {
  const db = await readDatabase();
  return db.cases
    .map((item) => buildBundleFromDb(db, item.id))
    .filter(Boolean) as HostedCaseBundle[];
}

export async function getCaseBundle(caseId: string) {
  const db = await readDatabase();
  return buildBundleFromDb(db, caseId);
}

export async function getAssignmentById(assignmentId: string) {
  const db = await readDatabase();
  return db.assignments.find((assignment) => assignment.id === assignmentId) || null;
}

export async function getBundleForAssignment(assignmentId: string) {
  const db = await readDatabase();
  const assignment = db.assignments.find((item) => item.id === assignmentId);
  if (!assignment) return null;
  const bundle = buildBundleFromDb(db, assignment.caseId);
  if (!bundle) return null;
  return { assignment, bundle };
}

export async function getSharedCaseDiscussionView({
  caseId,
  userId,
  role,
}: {
  caseId: string;
  userId: string;
  role: HostedRole;
}) {
  const db = await readDatabase();
  const bundle = buildBundleFromDb(db, caseId);
  if (!bundle) return null;
  if (!canUserCollaborateOnCase(db, caseId, userId, role)) return null;

  const sharedThread = findCaseDiscussionThread(db, caseId);
  const sharedComments = sharedThread ? getCommentsForThread(db, sharedThread.id) : [];
  const legacyThreadViews = getLegacyAssignmentThreads(db, caseId)
    .filter((thread) => canUserViewThread(db, thread, userId, role))
    .map((thread) => ({
      thread,
      assignment: thread.assignmentId ? getAssignmentByIdFromDb(db, thread.assignmentId) : null,
      comments: getCommentsForThread(db, thread.id),
    }));
  const activeComments = sharedComments.filter((comment) => comment.status === "open");
  const resolvedComments = sharedComments.filter((comment) => comment.status === "resolved");
  const legacyTimeline = legacyThreadViews.flatMap((entry) =>
    entry.comments.map((comment) => ({
      comment,
      source: "legacy_assignment_thread" as const,
      sourceLabel: entry.assignment
        ? `Legacy ${entry.assignment.reviewStage} thread`
        : "Legacy assignment thread",
      reviewStage: entry.assignment?.reviewStage || null,
    })),
  );

  const timeline = [
    ...sharedComments.map((comment) => ({
      comment,
      source: "shared_case_discussion" as const,
      sourceLabel: "Shared case discussion",
      reviewStage: null as ReviewStage | null,
    })),
    ...legacyTimeline,
  ].sort((a, b) => (a.comment.createdAt < b.comment.createdAt ? -1 : 1));

  return {
    sharedThread,
    sharedComments,
    activeComments,
    resolvedComments,
    legacyThreadViews,
    legacyTimeline,
    timeline,
    activity: summarizeSharedDiscussionActivity(sharedThread, sharedComments, legacyTimeline.length),
  };
}

export async function listVisibleAssignmentThreadViews({
  caseId,
  userId,
  role,
}: {
  caseId: string;
  userId: string;
  role: HostedRole;
}) {
  const db = await readDatabase();
  const bundle = buildBundleFromDb(db, caseId);
  if (!bundle) return [];

  return db.commentThreads
    .filter(
      (thread) =>
        thread.caseId === caseId &&
        thread.threadType === "assignment_clarification" &&
        canUserViewThread(db, thread, userId, role),
    )
    .map((thread) => ({
      thread,
      assignment: thread.assignmentId ? getAssignmentByIdFromDb(db, thread.assignmentId) : null,
      comments: getCommentsForThread(db, thread.id),
    }))
    .filter((entry) => entry.assignment)
    .sort((a, b) => {
      const aValue = a.assignment?.assignedAt || a.thread.createdAt;
      const bValue = b.assignment?.assignedAt || b.thread.createdAt;
      return aValue < bValue ? 1 : -1;
    });
}

export async function getAssignmentThreadViewForUser({
  assignmentId,
  userId,
  role,
}: {
  assignmentId: string;
  userId: string;
  role: HostedRole;
}) {
  const db = await readDatabase();
  const assignment = getAssignmentByIdFromDb(db, assignmentId);
  if (!assignment) return null;

  const thread = findAssignmentThread(db, assignmentId);
  if (!thread) {
    if (role === "admin" || assignment.assignedToUserId === userId) {
      return { thread: null, assignment, comments: [] as HostedComment[] };
    }
    return null;
  }

  if (!canUserViewThread(db, thread, userId, role)) return null;

  return {
    thread,
    assignment,
    comments: getCommentsForThread(db, thread.id),
  };
}

export async function getAdminNotesThreadView(caseId: string, userId: string, role: HostedRole) {
  if (role !== "admin") return null;
  const db = await readDatabase();
  const user = db.users.find((item) => item.id === userId && item.primaryRole === "admin");
  if (!user) return null;

  const thread = findAdminNotesThread(db, caseId);
  if (!thread) {
    return { thread: null, comments: [] as HostedComment[] };
  }

  return {
    thread,
    comments: getCommentsForThread(db, thread.id),
  };
}

export async function listCasesVisibleToUser(userId: string, role: HostedRole) {
  const all = await listAllCases();

  if (role === "admin") {
    return all.map((bundle) => ({
      ...bundle,
      assignment: getCurrentAssignmentForUser(bundle, userId, role),
    }));
  }

  return all
    .map((bundle) => ({
      ...bundle,
      assignment: getCurrentAssignmentForUser(bundle, userId, role),
    }))
    .filter((bundle) => bundle.assignment);
}

function discussionActivityForCase(
  db: HostedDevDatabase,
  caseId: string,
  userId: string,
  role: HostedRole,
) {
  const sharedThread = findCaseDiscussionThread(db, caseId);
  const sharedComments = sharedThread ? getCommentsForThread(db, sharedThread.id) : [];
  const legacyVisibleCount = getLegacyAssignmentThreads(db, caseId)
    .filter((thread) => canUserViewThread(db, thread, userId, role))
    .reduce((count, thread) => count + getCommentsForThread(db, thread.id).length, 0);

  return summarizeSharedDiscussionActivity(sharedThread, sharedComments, legacyVisibleCount);
}

export async function listReviewerQueue(userId: string) {
  const db = await readDatabase();
  return db.cases
    .map((item) => buildBundleFromDb(db, item.id))
    .filter(Boolean)
    .map((bundle) => {
      const caseBundle = bundle as HostedCaseBundle;
      return {
        ...caseBundle,
        assignment: getCurrentAssignmentForUser(caseBundle, userId, "reviewer"),
        discussionActivity: discussionActivityForCase(db, caseBundle.case.id, userId, "reviewer"),
      };
    })
    .filter(
      (bundle) =>
        bundle.assignment &&
        (bundle.assignment.status === "assigned" ||
          bundle.assignment.status === "opened" ||
          bundle.assignment.status === "in_progress"),
    );
}

export async function listReviewerCompletedHistory(userId: string) {
  const db = await readDatabase();

  return db.assignments
    .filter(
      (assignment) =>
        assignment.assignedToUserId === userId &&
        (assignment.status === "submitted" ||
          assignment.status === "returned" ||
          assignment.status === "cancelled"),
    )
    .map((assignment) => {
      const bundle = buildBundleFromDb(db, assignment.caseId);
      if (!bundle) return null;

      return {
        case: bundle.case,
        assignment,
        discussionActivity: discussionActivityForCase(db, bundle.case.id, userId, "reviewer"),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      const aValue = a.assignment.submittedAt || a.assignment.assignedAt;
      const bValue = b.assignment.submittedAt || b.assignment.assignedAt;
      return aValue < bValue ? 1 : -1;
    });
}

export async function getDashboardSummaryForUser(userId: string, role: HostedRole) {
  const visible = await listCasesVisibleToUser(userId, role);
  const assignments = visible
    .map((item) => item.assignment)
    .filter((assignment): assignment is HostedAssignment => Boolean(assignment));
  return summaryCounts(assignments);
}

export function canUserAccessCase(bundle: HostedCaseBundle, userId: string, role: HostedRole) {
  if (role === "admin") return true;
  return bundle.assignments.some((assignment) => assignment.assignedToUserId === userId);
}

export function getMostRelevantAssignmentForUser(
  bundle: HostedCaseBundle,
  userId: string,
  role: HostedRole,
) {
  return getCurrentAssignmentForUser(bundle, userId, role);
}

export async function createCaseDiscussionComment({
  caseId,
  actorUserId,
  body,
}: {
  caseId: string;
  actorUserId: string;
  body: string;
}) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) {
      throw new Error("Case not found.");
    }

    const author = db.users.find((user) => user.id === actorUserId);
    if (!author) {
      throw new Error("Author not found.");
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new Error("Comment body cannot be empty.");
    }

    if (!canUserCollaborateOnCase(db, caseId, actorUserId, author.primaryRole)) {
      throw new Error("You do not have access to the shared case discussion.");
    }

    const thread = getOrCreateCaseDiscussionThread(db, caseId, author);
    const comment = createCommentRecord(db, thread, author, trimmedBody);
    return { thread, comment, hostedCase };
  });
}

export async function updateCaseDiscussionComment({
  commentId,
  actorUserId,
  body,
}: {
  commentId: string;
  actorUserId: string;
  body: string;
}) {
  return mutateDatabase(async (db) => {
    const comment = db.comments.find((item) => item.id === commentId);
    if (!comment) {
      throw new Error("Comment not found.");
    }

    const thread = getThreadById(db, comment.threadId);
    if (!thread || thread.threadType !== "case_discussion") {
      throw new Error("Only shared case discussion comments can be edited here.");
    }

    const actor = db.users.find((user) => user.id === actorUserId);
    if (!actor) {
      throw new Error("User not found.");
    }

    if (!canUserViewThread(db, thread, actorUserId, actor.primaryRole)) {
      throw new Error("You do not have access to this discussion comment.");
    }

    if (!canUserEditComment(comment, actorUserId)) {
      throw new Error("Only the comment author can edit this comment.");
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new Error("Comment body cannot be empty.");
    }

    comment.body = trimmedBody;
    comment.updatedAt = nowIso();
    thread.updatedAt = comment.updatedAt;
    return { thread, comment };
  });
}

export async function setCaseDiscussionCommentResolved({
  commentId,
  actorUserId,
  resolved,
}: {
  commentId: string;
  actorUserId: string;
  resolved: boolean;
}) {
  return mutateDatabase(async (db) => {
    const comment = db.comments.find((item) => item.id === commentId);
    if (!comment) {
      throw new Error("Comment not found.");
    }

    const thread = getThreadById(db, comment.threadId);
    if (!thread || thread.threadType !== "case_discussion") {
      throw new Error("Only shared case discussion comments can be resolved here.");
    }

    const actor = db.users.find((user) => user.id === actorUserId);
    if (!actor) {
      throw new Error("User not found.");
    }

    if (!canUserViewThread(db, thread, actorUserId, actor.primaryRole)) {
      throw new Error("You do not have access to this discussion comment.");
    }

    if (!canUserResolveComment(comment, actorUserId, actor.primaryRole)) {
      throw new Error("Only the author or Admin can resolve this comment.");
    }

    const timestamp = nowIso();
    resolveCommentRecord(comment, actorUserId, resolved, timestamp);
    thread.updatedAt = timestamp;
    thread.status = db.comments
      .filter((item) => item.threadId === thread.id)
      .some((item) => item.status === "open")
      ? "open"
      : "resolved";
    thread.resolvedAt = thread.status === "resolved" ? timestamp : null;
    thread.resolvedByUserId = thread.status === "resolved" ? actorUserId : null;
    return { thread, comment };
  });
}

export async function setCaseDiscussionThreadResolved({
  caseId,
  actorUserId,
  resolved,
}: {
  caseId: string;
  actorUserId: string;
  resolved: boolean;
}) {
  return mutateDatabase(async (db) => {
    const actor = db.users.find((user) => user.id === actorUserId);
    if (!actor) {
      throw new Error("User not found.");
    }

    const thread = findCaseDiscussionThread(db, caseId);
    if (!thread) {
      throw new Error("Shared discussion thread not found.");
    }

    if (!canUserManageSharedThread(db, thread, actorUserId, actor.primaryRole)) {
      throw new Error("You do not have access to manage this discussion.");
    }

    const timestamp = nowIso();
    thread.status = resolved ? "resolved" : "open";
    thread.updatedAt = timestamp;
    thread.resolvedAt = resolved ? timestamp : null;
    thread.resolvedByUserId = resolved ? actorUserId : null;

    if (resolved) {
      for (const comment of db.comments.filter((item) => item.threadId === thread.id)) {
        if (comment.status === "open") {
          resolveCommentRecord(comment, actorUserId, true, timestamp);
        }
      }
    }

    return { thread };
  });
}

export async function createAssignmentComment({
  assignmentId,
  actorUserId,
  body,
}: {
  assignmentId: string;
  actorUserId: string;
  body: string;
}) {
  return mutateDatabase(async (db) => {
    const assignment = getAssignmentByIdFromDb(db, assignmentId);
    if (!assignment) {
      throw new Error("Assignment not found.");
    }

    const author = db.users.find((user) => user.id === actorUserId);
    if (!author) {
      throw new Error("Author not found.");
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new Error("Comment body cannot be empty.");
    }

    const mayPost =
      author.primaryRole === "admin" || assignment.assignedToUserId === author.id;
    if (!mayPost) {
      throw new Error("You do not have access to this assignment thread.");
    }

    const thread = getOrCreateAssignmentThread(db, assignment, author);
    const comment = createCommentRecord(db, thread, author, trimmedBody);
    return { thread, comment, assignment };
  });
}

export async function createAdminCaseNote({
  caseId,
  actorUserId,
  body,
}: {
  caseId: string;
  actorUserId: string;
  body: string;
}) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) {
      throw new Error("Case not found.");
    }

    const author = db.users.find(
      (user) => user.id === actorUserId && user.primaryRole === "admin",
    );
    if (!author) {
      throw new Error("Only Admin can create case notes.");
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      throw new Error("Note body cannot be empty.");
    }

    const thread = getOrCreateAdminNotesThread(db, caseId, author);
    const comment = createCommentRecord(db, thread, author, trimmedBody);
    return { thread, comment, hostedCase };
  });
}

export async function createCaseFromUploadedPackage({
  uploadedByUserId,
  manifestFile,
  assetFiles,
}: UploadedPackageInput) {
  const manifest = await parseManifestFile(manifestFile);

  return mutateDatabase(async (db) => {
    const createdAt = nowIso();
    const caseNumber = db.cases.length + 1;
    const inferredKey = safeCaseKey(manifest.externalCaseId || manifestFile.name);
    const caseId = `case_${inferredKey}_${String(caseNumber).padStart(3, "0")}`;
    const displayCaseId = displayCaseIdFromCount(caseNumber);
    const manifestStorageKey = `cases/${caseId}/manifest.json`;
    const packageStorageKey = `cases/${caseId}/package/${manifestFile.name}`;

    await writeTextArtifact(manifestStorageKey, manifest.raw);
    await writeUploadedFile(packageStorageKey, manifestFile);

    const attachmentReferenceByName = new Map(
      manifest.references
        .filter(
          (
            reference,
          ): reference is Extract<ParsedReferenceInput, { attachmentFilename: string }> =>
            "attachmentFilename" in reference,
        )
        .map((reference) => [reference.attachmentFilename, reference]),
    );
    const matchedReferenceAttachments = new Set<string>();

    const storedAssets: HostedCaseAsset[] = [];
    const storedReferences: HostedCaseReference[] = [];
    let frameIndex = 1;
    for (const asset of assetFiles) {
      const referenceAttachment = attachmentReferenceByName.get(asset.name);
      const bytes = Buffer.from(await asset.arrayBuffer());
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      const storageKey = referenceAttachment
        ? `cases/${caseId}/references/${asset.name}`
        : `cases/${caseId}/frames/${asset.name}`;
      await writeUploadedFile(storageKey, asset);

      if (referenceAttachment) {
        matchedReferenceAttachments.add(asset.name);
        storedReferences.push({
          id: `reference_${randomUUID()}`,
          caseId,
          title: referenceAttachment.title,
          referenceKind: referenceAttachment.referenceKind,
          sourceName: asset.name,
          storageKey,
          mimeType: mimeTypeForReference(referenceAttachment.referenceKind, asset.name),
          textContent: null,
          createdAt,
        });
      } else {
        storedAssets.push({
          id: `asset_${randomUUID()}`,
          caseId,
          frameIndex,
          sourceName: asset.name,
          storageKey,
          width: 0,
          height: 0,
          checksumSha256,
        });
        frameIndex += 1;
      }
    }

    const unmatchedReferenceAttachments = [...attachmentReferenceByName.keys()].filter(
      (filename) => !matchedReferenceAttachments.has(filename),
    );
    if (unmatchedReferenceAttachments.length) {
      throw new Error(
        `Reference attachment(s) missing from uploaded assets: ${unmatchedReferenceAttachments.join(", ")}`,
      );
    }

    for (const reference of manifest.references) {
      if ("attachmentFilename" in reference) continue;
      storedReferences.push({
        id: `reference_${randomUUID()}`,
        caseId,
        title: reference.title,
        referenceKind: reference.referenceKind,
        sourceName: reference.sourceName,
        storageKey: null,
        mimeType: mimeTypeForReference(reference.referenceKind, reference.sourceName),
        textContent: reference.textContent,
        createdAt,
      });
    }

    if (!storedAssets.length) {
      throw new Error("Case package must include at least one frame/image asset for annotation.");
    }

    db.casePackages.push({
      id: `pkg_${randomUUID()}`,
      caseId,
      uploadFilename: manifestFile.name,
      manifestStorageKey,
      originalUploadStorageKey: packageStorageKey,
      intakeStatus: "ready",
      sourceType: "manifest_package",
      extractionIntervalSeconds: null,
      uploadedAt: createdAt,
      processedAt: createdAt,
    });

    db.cases.push({
      id: caseId,
      displayCaseId,
      externalCaseId: manifest.externalCaseId,
      status: "ready_for_assignment",
      currentStage: "review_1",
      priority: manifest.priority,
      uploadedByUserId,
      createdAt,
      completedAt: null,
      metadata: {
        summary: manifest.summary,
        manifestStorageKey,
        intakeStatus: "ready",
        packageFilename: manifestFile.name,
      },
    });

    db.caseAssets.push(...storedAssets);
    db.caseReferences.push(...storedReferences);
    return buildBundleFromDb(db, caseId)!;
  });
}

export async function createCaseFromDirectIngestion({
  uploadedByUserId,
  sourceType,
  summary,
  priority,
  externalCaseId,
  frameFiles,
  reportFiles,
  frameDimensions,
  uploadFilename,
  originalUploadFile,
  extractionIntervalSeconds,
}: DirectIngestionInput) {
  return mutateDatabase(async (db) => {
    const createdAt = nowIso();
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      throw new Error("Case summary is required.");
    }
    if (!frameFiles.length) {
      throw new Error("At least one frame is required.");
    }
    if (frameDimensions.length && frameDimensions.length !== frameFiles.length) {
      throw new Error("Frame metadata is incomplete.");
    }
    const caseNumber = db.cases.length + 1;
    const inferredKey = safeCaseKey(externalCaseId || uploadFilename || `case_${caseNumber}`);
    const caseId = `case_${inferredKey}_${String(caseNumber).padStart(3, "0")}`;
    const displayCaseId = displayCaseIdFromCount(caseNumber);
    const manifestStorageKey = `cases/${caseId}/manifest.json`;
    const originalUploadStorageKey =
      sourceType === "video_upload" && originalUploadFile
        ? `cases/${caseId}/uploads/${safeFileName(originalUploadFile.name)}`
        : `cases/${caseId}/uploads/image_set.json`;

    if (sourceType === "video_upload" && originalUploadFile) {
      await writeUploadedFile(originalUploadStorageKey, originalUploadFile);
    } else {
      await writeTextArtifact(
        originalUploadStorageKey,
        JSON.stringify(
          {
            sourceType,
            uploadFilename,
            originalUploadStored: Boolean(originalUploadFile),
            frameFiles: frameFiles.map((file) => file.name),
            reportFiles: reportFiles.map((file) => file.name),
            extractionIntervalSeconds:
              sourceType === "video_upload" ? extractionIntervalSeconds ?? null : null,
          },
          null,
          2,
        ),
      );
    }

    const storedAssets: HostedCaseAsset[] = [];
    for (let index = 0; index < frameFiles.length; index += 1) {
      const frameFile = frameFiles[index];
      const storageKey = `cases/${caseId}/frames/${String(index + 1).padStart(4, "0")}_${safeFileName(frameFile.name)}`;
      await writeUploadedFile(storageKey, frameFile);
      const bytes = Buffer.from(await frameFile.arrayBuffer());
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      const dimensions = frameDimensions[index] || { width: 0, height: 0 };
      storedAssets.push({
        id: `asset_${randomUUID()}`,
        caseId,
        frameIndex: index + 1,
        sourceName: frameFile.name,
        storageKey,
        width: dimensions.width,
        height: dimensions.height,
        checksumSha256,
      });
    }

    const storedReferences: HostedCaseReference[] = [];
    for (let index = 0; index < reportFiles.length; index += 1) {
      const reportFile = reportFiles[index];
      const referenceKind = referenceKindFromFilename(reportFile.name);
      if (!isSupportedReportKind(referenceKind)) {
        throw new Error(`Unsupported report file type for ${reportFile.name}.`);
      }
      const storageKey = `cases/${caseId}/references/${String(index + 1).padStart(2, "0")}_${safeFileName(reportFile.name)}`;
      await writeUploadedFile(storageKey, reportFile);
      storedReferences.push({
        id: `reference_${randomUUID()}`,
        caseId,
        title:
          referenceKind === "pdf"
            ? "Reviewer report PDF"
            : reportFile.name.replace(/\.[^.]+$/, ""),
        referenceKind,
        sourceName: reportFile.name,
        storageKey,
        mimeType: mimeTypeForReference(referenceKind, reportFile.name),
        textContent: null,
        createdAt,
      });
    }

    const manifest = {
      externalCaseId: externalCaseId || null,
      summary: trimmedSummary,
      priority,
      sourceType,
      extractionIntervalSeconds:
        sourceType === "video_upload" ? extractionIntervalSeconds ?? null : null,
      frames: storedAssets.map((asset) => ({
        frameIndex: asset.frameIndex,
        sourceName: asset.sourceName,
        storageKey: asset.storageKey,
        width: asset.width,
        height: asset.height,
      })),
      references: storedReferences.map((reference) => ({
        title: reference.title,
        referenceKind: reference.referenceKind,
        sourceName: reference.sourceName,
        storageKey: reference.storageKey,
      })),
    };
    await writeTextArtifact(manifestStorageKey, JSON.stringify(manifest, null, 2));

    db.casePackages.push({
      id: `pkg_${randomUUID()}`,
      caseId,
      uploadFilename,
      manifestStorageKey,
      originalUploadStorageKey,
      intakeStatus: "ready",
      sourceType,
      extractionIntervalSeconds:
        sourceType === "video_upload" ? extractionIntervalSeconds ?? null : null,
      uploadedAt: createdAt,
      processedAt: createdAt,
    });

    db.cases.push({
      id: caseId,
      displayCaseId,
      externalCaseId,
      status: "ready_for_assignment",
      currentStage: "review_1",
      priority,
      uploadedByUserId,
      createdAt,
      completedAt: null,
      metadata: {
        summary: trimmedSummary,
        manifestStorageKey,
        intakeStatus: "ready",
        packageFilename: uploadFilename,
      },
    });

    db.caseAssets.push(...storedAssets);
    db.caseReferences.push(...storedReferences);
    return buildBundleFromDb(db, caseId)!;
  });
}

function ensureReviewerUser(db: HostedDevDatabase, userId: string) {
  const reviewer = db.users.find((user) => user.id === userId && user.primaryRole === "reviewer");
  if (!reviewer) {
    throw new Error("Assigned user must be an active reviewer.");
  }
  if (reviewer.status !== "active") {
    throw new Error("Assigned reviewer is not active.");
  }
  return reviewer;
}

function ensureChainStep(
  db: HostedDevDatabase,
  caseId: string,
  reviewStage: ActiveReviewStage,
  position: number,
  reviewerUserId: string | null,
  assignmentMode: HostedWorkflowChainStep["assignmentMode"],
) {
  const existing = db.workflowChains.find(
    (step) => step.caseId === caseId && step.reviewStage === reviewStage,
  );
  const timestamp = nowIso();

  if (existing) {
    existing.position = position;
    existing.assignedReviewerUserId = reviewerUserId;
    existing.assignmentMode = assignmentMode;
    existing.updatedAt = timestamp;
    return existing;
  }

  const created: HostedWorkflowChainStep = {
    id: `chain_${randomUUID()}`,
    caseId,
    position,
    reviewStage,
    assignedReviewerUserId: reviewerUserId,
    assignmentMode,
    status: position === 1 ? "active" : "planned",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.workflowChains.push(created);
  return created;
}

function createAssignmentRecord(
  db: HostedDevDatabase,
  caseId: string,
  reviewStage: ActiveReviewStage,
  assignedToUserId: string,
  previousAssignmentId: string | null,
) {
  const createdAt = nowIso();
  const assignment: HostedAssignment = {
    id: `assignment_${randomUUID()}`,
    caseId,
    reviewStage,
    assignedToUserId,
    status: "assigned",
    assignedAt: createdAt,
    startedAt: null,
    submittedAt: null,
    previousAssignmentId,
  };
  db.assignments.push(assignment);
  return assignment;
}

export async function defineWorkflowChain({
  caseId,
  review1ReviewerUserId,
  review2ReviewerUserId,
  assignmentMode,
}: {
  caseId: string;
  review1ReviewerUserId: string;
  review2ReviewerUserId: string;
  assignmentMode?: HostedWorkflowChainStep["assignmentMode"];
}) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) return null;

    ensureReviewerUser(db, review1ReviewerUserId);
    ensureReviewerUser(db, review2ReviewerUserId);

    const existingReview1Step = getChainStepForStage(db, caseId, "review_1");
    const existingReview2Step = getChainStepForStage(db, caseId, "review_2");
    const review1Assignments = getCaseAssignments(db, caseId).filter(
      (assignment) => assignment.reviewStage === "review_1",
    );
    const review2ActiveAssignment = getActiveAssignmentForStage(db, caseId, "review_2");

    const review1HasStarted = review1Assignments.some(
      (assignment) => Boolean(assignment.startedAt || assignment.submittedAt),
    );
    if (
      review1HasStarted &&
      existingReview1Step?.assignedReviewerUserId &&
      existingReview1Step.assignedReviewerUserId !== review1ReviewerUserId
    ) {
      throw new Error("Reviewer 1 cannot be rewritten after review has started.");
    }

    if (
      review2ActiveAssignment &&
      existingReview2Step?.assignedReviewerUserId &&
      existingReview2Step.assignedReviewerUserId !== review2ReviewerUserId
    ) {
      throw new Error("Use reassign current stage to change the active Reviewer 2 assignment.");
    }

    const mode = assignmentMode || "manual";
    ensureChainStep(db, caseId, "review_1", 1, review1ReviewerUserId, mode);
    ensureChainStep(db, caseId, "review_2", 2, review2ReviewerUserId, mode);

    if (hostedCase.status === "ready_for_assignment" && hostedCase.currentStage === "review_1") {
      const existingActive = getActiveAssignmentForStage(db, caseId, "review_1");
      if (!existingActive) {
        createAssignmentRecord(db, caseId, "review_1", review1ReviewerUserId, null);
        hostedCase.status = "assigned_to_r1";
      }
    }

    return buildBundleFromDb(db, caseId)!;
  });
}

export async function activateCurrentStageAssignment(caseId: string) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) return null;
    const currentStage = activeStageFromCase(hostedCase);
    if (!currentStage) return null;

    const existingActive = getActiveAssignmentForStage(db, caseId, currentStage);
    if (existingActive) {
      return { bundle: buildBundleFromDb(db, caseId)!, assignment: existingActive };
    }

    const step = db.workflowChains.find(
      (item) => item.caseId === caseId && item.reviewStage === currentStage,
    );
    if (!step?.assignedReviewerUserId) {
      throw new Error("Current stage does not have an assigned reviewer in the workflow chain.");
    }

    ensureReviewerUser(db, step.assignedReviewerUserId);

    const previousAssignment = getLatestAssignmentForStage(db, caseId, currentStage);
    const assignment = createAssignmentRecord(
      db,
      caseId,
      currentStage,
      step.assignedReviewerUserId,
      previousAssignment?.id || null,
    );

    hostedCase.status = caseStatusForAssignedStage(currentStage);
    return { bundle: buildBundleFromDb(db, caseId)!, assignment };
  });
}

export async function reassignCurrentStageAssignment({
  caseId,
  reviewerUserId,
}: {
  caseId: string;
  reviewerUserId: string;
}) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) return null;

    const currentStage = activeStageFromCase(hostedCase);
    if (!currentStage) return null;

    ensureReviewerUser(db, reviewerUserId);

    const step = db.workflowChains.find(
      (item) => item.caseId === caseId && item.reviewStage === currentStage,
    );
    if (!step) {
      throw new Error("Workflow chain must be defined before reassignment.");
    }

    step.assignedReviewerUserId = reviewerUserId;
    step.updatedAt = nowIso();

    const activeAssignment = getActiveAssignmentForStage(db, caseId, currentStage);
    if (activeAssignment) {
      activeAssignment.status = "cancelled";
    }

    const replacement = createAssignmentRecord(
      db,
      caseId,
      currentStage,
      reviewerUserId,
      activeAssignment?.id || null,
    );

    hostedCase.status = caseStatusForAssignedStage(currentStage);
    return {
      bundle: buildBundleFromDb(db, caseId)!,
      assignment: replacement,
      previous: activeAssignment,
    };
  });
}

export async function markAssignmentOpenedIfNeeded(assignmentId: string) {
  return mutateDatabase(async (db) => {
    const assignment = db.assignments.find((item) => item.id === assignmentId);
    if (!assignment) return null;
    if (assignment.status === "assigned") {
      assignment.status = "opened";
      assignment.startedAt = assignment.startedAt || nowIso();
      const hostedCase = db.cases.find((item) => item.id === assignment.caseId);
      if (hostedCase && (assignment.reviewStage === "review_1" || assignment.reviewStage === "review_2")) {
        hostedCase.currentStage = assignment.reviewStage;
        hostedCase.status = caseStatusForInReviewStage(assignment.reviewStage);
      }
    }
    return assignment;
  });
}

export async function markAssignmentInProgressIfNeeded(assignmentId: string) {
  return mutateDatabase(async (db) => {
    const assignment = db.assignments.find((item) => item.id === assignmentId);
    if (!assignment) return null;

    if (assignment.status === "assigned" || assignment.status === "opened") {
      assignment.status = "in_progress";
      assignment.startedAt = assignment.startedAt || nowIso();
      const hostedCase = db.cases.find((item) => item.id === assignment.caseId);
      if (hostedCase && (assignment.reviewStage === "review_1" || assignment.reviewStage === "review_2")) {
        hostedCase.currentStage = assignment.reviewStage;
        hostedCase.status = caseStatusForInReviewStage(assignment.reviewStage);
      }
    }

    return assignment;
  });
}

export async function persistHostedSubmission({
  assignmentId,
  actorUserId,
  leusJson,
  summary,
}: {
  assignmentId: string;
  actorUserId: string;
  leusJson: unknown;
  summary: HostedSubmission["summary"];
}) {
  return mutateDatabase(async (db) => {
    const assignment = db.assignments.find((item) => item.id === assignmentId);
    if (!assignment) return null;
    const hostedCase = db.cases.find((item) => item.id === assignment.caseId);
    if (!hostedCase) return null;

    const submissionId = `submission_${randomUUID()}`;
    const submittedAt = nowIso();
    const leusStorageKey = `cases/${hostedCase.id}/assignments/${assignmentId}/submissions/${submissionId}.leus`;
    await writeTextArtifact(leusStorageKey, JSON.stringify(leusJson, null, 2));

    const submission: HostedSubmission = {
      id: submissionId,
      caseId: hostedCase.id,
      assignmentId,
      submittedByUserId: actorUserId,
      submissionType:
        assignment.reviewStage === "adjudication" ? "adjudication_final" : "final_stage_submission",
      leusStorageKey,
      submittedAt,
      isFinalForStage: true,
      summary,
    };

    db.submissions.push(submission);
    assignment.status = "submitted";
    assignment.submittedAt = submittedAt;
    let nextAssignment: HostedAssignment | null = null;

    if (assignment.reviewStage === "review_1") {
      hostedCase.currentStage = "review_2";
      const nextStep = getChainStepForStage(db, hostedCase.id, "review_2");
      if (nextStep?.assignedReviewerUserId) {
        nextAssignment = createAssignmentRecord(
          db,
          hostedCase.id,
          "review_2",
          nextStep.assignedReviewerUserId,
          assignment.id,
        );
        hostedCase.status = "assigned_to_r2";
      } else {
        hostedCase.status = "ready_for_assignment";
      }
    } else if (assignment.reviewStage === "review_2") {
      hostedCase.currentStage = "admin_finalization";
      hostedCase.status = "awaiting_admin_finalization";
    } else {
      hostedCase.currentStage = "completed";
      hostedCase.status = "ground_truth_finalized";
      hostedCase.completedAt = submittedAt;
    }

    return { submission, assignment, hostedCase, nextAssignment };
  });
}

export async function returnCaseForRework({
  caseId,
  reviewStage,
}: {
  caseId: string;
  reviewStage: ActiveReviewStage;
}) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) return null;

    if (
      hostedCase.status !== "awaiting_admin_finalization" &&
      hostedCase.status !== "needs_adjudication"
    ) {
      throw new Error("Case can only be returned for rework from finalization or adjudication review.");
    }

    const chainStep = getChainStepForStage(db, caseId, reviewStage);
    if (!chainStep?.assignedReviewerUserId) {
      throw new Error("Selected review stage does not have an assigned reviewer.");
    }

    ensureReviewerUser(db, chainStep.assignedReviewerUserId);

    const previousAssignment = getLatestAssignmentForStage(db, caseId, reviewStage);
    if (!previousAssignment) {
      throw new Error("Selected review stage has no prior assignment history to return.");
    }

    if (previousAssignment.status === "submitted") {
      previousAssignment.status = "returned";
    }

    const replacementAssignment = createAssignmentRecord(
      db,
      caseId,
      reviewStage,
      chainStep.assignedReviewerUserId,
      previousAssignment.id,
    );

    hostedCase.currentStage = reviewStage;
    hostedCase.status = "returned_for_rework";
    hostedCase.completedAt = null;

    return {
      hostedCase,
      previousAssignment,
      replacementAssignment,
    };
  });
}

export async function markCaseAsNeedsAdjudication(caseId: string) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) return null;

    if (hostedCase.status !== "awaiting_admin_finalization") {
      throw new Error("Case must be awaiting Admin finalization before it can be marked for adjudication.");
    }

    hostedCase.currentStage = "adjudication";
    hostedCase.status = "needs_adjudication";
    hostedCase.completedAt = null;

    return { hostedCase };
  });
}

export async function finalizeCaseAsGroundTruth(caseId: string) {
  return mutateDatabase(async (db) => {
    const hostedCase = db.cases.find((item) => item.id === caseId);
    if (!hostedCase) return null;
    if (hostedCase.status !== "awaiting_admin_finalization") {
      throw new Error("Case is not ready for Admin finalization.");
    }

    const completedAt = nowIso();
    hostedCase.currentStage = "completed";
    hostedCase.status = "ground_truth_finalized";
    hostedCase.completedAt = completedAt;

    return { hostedCase, completedAt };
  });
}

export async function resolveCaseAsset(caseId: string, assetId: string) {
  const db = await readDatabase();
  const asset = db.caseAssets.find((item) => item.caseId === caseId && item.id === assetId);
  if (!asset) return null;
  return asset;
}

export async function resolveCaseReference(caseId: string, referenceId: string) {
  const db = await readDatabase();
  const reference = db.caseReferences.find(
    (item) => item.caseId === caseId && item.id === referenceId,
  );
  if (!reference) return null;
  return reference;
}

export async function readObjectArtifact(storageKey: string) {
  const filePath = objectStorePathFor(storageKey);
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export async function appendAuditEvent(event: HostedAuditEvent) {
  await mutateDatabase(async (db) => {
    db.auditEvents.unshift(event);
    db.auditEvents = sortByDateDesc(db.auditEvents).slice(0, 500);
  });
}

export async function listRecentAuditEvents() {
  const db = await readDatabase();
  return sortByDateDesc(db.auditEvents).slice(0, 50);
}
