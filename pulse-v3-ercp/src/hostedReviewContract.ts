export type HostedReviewStage = "review_1" | "review_2" | "adjudication";
export type HostedActorRole = "reviewer" | "adjudicator";

export type HostedAnnotatorManifest = {
  caseId: string;
  displayCaseId: string;
  assignmentId: string;
  reviewStage: HostedReviewStage;
  actor: {
    userId: string;
    displayName: string;
    role: HostedActorRole;
  };
  permissions: {
    canSaveDraft: boolean;
    canSubmit: boolean;
    readOnly: boolean;
    mayViewPriorStageOutputs: boolean;
  };
  frames: Array<{
    frameId: string;
    frameIndex: number;
    sourceName: string;
    imageUrl: string;
    width: number;
    height: number;
    checksumSha256?: string;
  }>;
  existingDraft?: {
    submissionId: string;
    leusJson: unknown;
    savedAt: string;
  } | null;
  priorStageOutputs?: Array<{
    submissionId: string;
    reviewStage: "review_1" | "review_2";
    leusJson?: unknown;
    submittedAt: string;
    submittedByDisplayName: string;
  }>;
  serverPolicy: {
    submissionCommentRequired: boolean;
    allowEscalateToAdjudication: boolean;
  };
};

export type HostedAnnotatorOutput = {
  caseId: string;
  assignmentId: string;
  reviewStage: HostedReviewStage;
  outputType: "stage_submit";
  leusJson: unknown;
  summary: {
    imageCount: number;
    labelsObserved?: Array<{ id: number; name: string }>;
    stationsUsed?: Array<"TG" | "TD" | "">;
  };
  clientContext?: {
    localLogExportIncluded: boolean;
    appVersion?: string;
  };
};
