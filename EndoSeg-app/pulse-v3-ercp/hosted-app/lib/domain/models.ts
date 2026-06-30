export type HostedRole = "admin" | "reviewer" | "adjudicator";
export type UserStatus = "active" | "disabled";
export type CasePriority = "routine" | "priority" | "urgent";
export type ReviewStage = "review_1" | "review_2" | "adjudication";
export type CaseCurrentStage = ReviewStage | "admin_finalization" | "completed";
export type CaseStatus =
  | "intake_pending"
  | "ingestion_failed"
  | "ready_for_assignment"
  | "assigned_to_r1"
  | "in_review_r1"
  | "assigned_to_r2"
  | "in_review_r2"
  | "needs_adjudication"
  | "awaiting_admin_finalization"
  | "ground_truth_finalized"
  | "returned_for_rework"
  | "archived";
export type AssignmentStatus =
  | "unassigned"
  | "assigned"
  | "opened"
  | "in_progress"
  | "submitted"
  | "returned"
  | "cancelled";
export type IntakeStatus = "pending" | "processing" | "ready" | "failed";
export type SubmissionType = "draft" | "final_stage_submission" | "adjudication_final";
export type CasePackageIntakeStatus = "pending" | "processing" | "ready" | "failed";
export type HostedCasePackageSourceType = "manifest_package" | "image_upload" | "video_upload";
export type ChainAssignmentMode = "manual" | "auto_admin_triggered";
export type HostedWorkflowChainStepStatus = "planned" | "active" | "completed" | "cancelled";
export type HostedCaseReferenceKind = "text" | "json" | "pdf" | "image";
export type HostedCommentThreadType =
  | "case_discussion"
  | "assignment_clarification"
  | "admin_internal_note";
export type HostedCommentVisibilityScope =
  | "case_admin_and_assigned_reviewers"
  | "assignment_admin_and_assignee"
  | "admin_only";
export type HostedCommentThreadStatus = "open" | "resolved";
export type HostedCommentStatus = "open" | "resolved";

export type HostedUser = {
  id: string;
  email: string;
  displayName: string;
  primaryRole: HostedRole;
  status: UserStatus;
  createdAt: string;
};

export type HostedCase = {
  id: string;
  displayCaseId: string;
  externalCaseId: string | null;
  status: CaseStatus;
  currentStage: CaseCurrentStage;
  priority: CasePriority;
  uploadedByUserId: string;
  createdAt: string;
  completedAt: string | null;
  metadata: {
    summary: string;
    manifestStorageKey: string;
    intakeStatus: IntakeStatus;
    packageFilename: string;
  };
};

export type HostedCaseAsset = {
  id: string;
  caseId: string;
  frameIndex: number;
  sourceName: string;
  storageKey: string;
  width: number;
  height: number;
  checksumSha256: string;
};

export type HostedCasePackage = {
  id: string;
  caseId: string;
  uploadFilename: string;
  manifestStorageKey: string;
  originalUploadStorageKey: string;
  intakeStatus: CasePackageIntakeStatus;
  sourceType: HostedCasePackageSourceType;
  extractionIntervalSeconds: number | null;
  uploadedAt: string;
  processedAt: string | null;
};

export type HostedCaseReference = {
  id: string;
  caseId: string;
  title: string;
  referenceKind: HostedCaseReferenceKind;
  sourceName: string;
  storageKey: string | null;
  mimeType: string;
  textContent: string | null;
  createdAt: string;
};

export type HostedWorkflowChainStep = {
  id: string;
  caseId: string;
  position: number;
  reviewStage: Extract<ReviewStage, "review_1" | "review_2">;
  assignedReviewerUserId: string | null;
  assignmentMode: ChainAssignmentMode;
  status: HostedWorkflowChainStepStatus;
  createdAt: string;
  updatedAt: string;
};

export type HostedAssignment = {
  id: string;
  caseId: string;
  reviewStage: ReviewStage;
  assignedToUserId: string;
  status: AssignmentStatus;
  assignedAt: string;
  startedAt: string | null;
  submittedAt: string | null;
  previousAssignmentId: string | null;
};

export type HostedSubmission = {
  id: string;
  caseId: string;
  assignmentId: string;
  submittedByUserId: string;
  submissionType: SubmissionType;
  leusStorageKey: string;
  submittedAt: string;
  isFinalForStage: boolean;
  summary?: {
    imageCount: number;
    labelsObserved?: Array<{ id: number; name: string }>;
    stationsUsed?: Array<"TG" | "TD" | "">;
  };
};

export type HostedCommentThread = {
  id: string;
  caseId: string;
  assignmentId: string | null;
  threadType: HostedCommentThreadType;
  visibilityScope: HostedCommentVisibilityScope;
  createdByUserId: string;
  createdByDisplayName: string;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  status: HostedCommentThreadStatus;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
};

export type HostedComment = {
  id: string;
  threadId: string;
  caseId: string;
  assignmentId: string | null;
  authorUserId: string;
  authorDisplayName: string;
  authorEmail: string;
  visibilityScope: HostedCommentVisibilityScope;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  status: HostedCommentStatus;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
};

export type HostedDiscussionActivitySummary = {
  totalSharedCount: number;
  activeCount: number;
  resolvedCount: number;
  legacyCount: number;
  threadStatus: HostedCommentThreadStatus | null;
};

export type HostedAuditEvent = {
  id: string;
  actorUserId: string | null;
  objectType: string;
  objectId: string;
  action: string;
  payload?: Record<string, unknown>;
  eventTs: string;
};

export type HostedCaseBundle = {
  case: HostedCase;
  casePackage: HostedCasePackage | null;
  assets: HostedCaseAsset[];
  references: HostedCaseReference[];
  workflowChain: HostedWorkflowChainStep[];
  assignments: HostedAssignment[];
  submissions: HostedSubmission[];
};
