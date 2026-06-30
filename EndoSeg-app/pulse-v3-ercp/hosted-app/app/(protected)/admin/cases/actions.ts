"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import {
  activateCurrentStageAssignment,
  createReviewerUser,
  defineWorkflowChain,
  findDevUserById,
  finalizeCaseAsGroundTruth,
  getCaseBundle,
  markCaseAsNeedsAdjudication,
  reassignCurrentStageAssignment,
  returnCaseForRework,
  setReviewerUserStatus,
  updateReviewerUser,
} from "@/lib/server/mock-store";

function caseRedirect(caseId: string, message: string, ok = true) {
  const params = new URLSearchParams();
  params.set("workflow", ok ? "1" : "0");
  params.set("message", message);
  redirect(`/cases/${caseId}?${params.toString()}`);
}

function adminRedirect(message: string, ok = true, scope: "workflow" | "reviewers" = "reviewers") {
  const params = new URLSearchParams();
  params.set(scope, ok ? "1" : "0");
  params.set("message", message);
  redirect(`/admin/cases?${params.toString()}`);
}

function revalidateWorkflowSurfaces(caseId: string) {
  revalidatePath("/admin/cases");
  revalidatePath("/reviewer/dashboard");
  revalidatePath(`/cases/${caseId}`);
}

function revalidateReviewerManagementSurfaces() {
  revalidatePath("/admin/cases");
  revalidatePath("/sign-in");
}

export async function defineWorkflowChainAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");
  const review1ReviewerUserId = String(formData.get("review1ReviewerUserId") || "");
  const review2ReviewerUserId = String(formData.get("review2ReviewerUserId") || "");

  if (!caseId || !review1ReviewerUserId || !review2ReviewerUserId) {
    caseRedirect(caseId || "unknown", "Both reviewer steps must be assigned.", false);
  }

  try {
    const review1Reviewer = await findDevUserById(review1ReviewerUserId);
    const review2Reviewer = await findDevUserById(review2ReviewerUserId);
    const bundle = await defineWorkflowChain({
      caseId,
      review1ReviewerUserId,
      review2ReviewerUserId,
      assignmentMode: "manual",
    });

    if (!bundle) {
      caseRedirect(caseId, "Case not found.", false);
      return;
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "workflow_chain",
      objectId: caseId,
      action: "workflow_chain_defined",
      payload: {
        caseId,
        review1ReviewerUserId,
        review2ReviewerUserId,
        review1ReviewerDisplayName: review1Reviewer?.displayName || null,
        review1ReviewerEmail: review1Reviewer?.email || null,
        review2ReviewerDisplayName: review2Reviewer?.displayName || null,
        review2ReviewerEmail: review2Reviewer?.email || null,
      },
    });

    revalidateWorkflowSurfaces(caseId);
    caseRedirect(caseId, "Workflow chain saved.");
  } catch (error) {
    caseRedirect(caseId, error instanceof Error ? error.message : "Chain update failed.", false);
  }
}

export async function activateCurrentStageAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");

  try {
    const activated = await activateCurrentStageAssignment(caseId);
    if (!activated) {
      caseRedirect(caseId, "Case not found.", false);
      return;
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "assignment",
      objectId: activated.assignment.id,
      action: "workflow_stage_activated",
      payload: {
        caseId,
        reviewStage: activated.assignment.reviewStage,
        assignedToUserId: activated.assignment.assignedToUserId,
      },
    });

    revalidateWorkflowSurfaces(caseId);
    caseRedirect(caseId, "Current workflow stage activated.");
  } catch (error) {
    caseRedirect(caseId, error instanceof Error ? error.message : "Stage activation failed.", false);
  }
}

export async function reassignCurrentStageAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");
  const reviewerUserId = String(formData.get("reviewerUserId") || "");

  try {
    const nextReviewer = await findDevUserById(reviewerUserId);
    const result = await reassignCurrentStageAssignment({ caseId, reviewerUserId });
    if (!result) {
      caseRedirect(caseId, "Case not found or stage is not reassignable.", false);
      return;
    }

    const latestBundle = await getCaseBundle(caseId);
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "assignment",
      objectId: result.assignment.id,
      action: "assignment_reassigned",
      payload: {
        caseId,
        reviewStage: result.assignment.reviewStage,
        previousAssignmentId: result.previous?.id || null,
        newAssignedToUserId: reviewerUserId,
        newAssignedToDisplayName: nextReviewer?.displayName || null,
        newAssignedToEmail: nextReviewer?.email || null,
        currentCaseStatus: latestBundle?.case.status || null,
      },
    });

    revalidateWorkflowSurfaces(caseId);
    caseRedirect(caseId, "Current workflow stage reassigned.");
  } catch (error) {
    caseRedirect(caseId, error instanceof Error ? error.message : "Reassignment failed.", false);
  }
}

export async function finalizeCaseAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");

  try {
    const result = await finalizeCaseAsGroundTruth(caseId);
    if (!result) {
      caseRedirect(caseId, "Case not found.", false);
      return;
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case",
      objectId: caseId,
      action: "case_ground_truth_finalized",
      payload: {
        caseId,
        completedAt: result.completedAt,
      },
    });

    revalidateWorkflowSurfaces(caseId);
    caseRedirect(caseId, "Case finalized as ground truth.");
  } catch (error) {
    caseRedirect(caseId, error instanceof Error ? error.message : "Finalization failed.", false);
  }
}

export async function returnCaseForReworkAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");
  const reviewStage = String(formData.get("reviewStage") || "");

  if (reviewStage !== "review_1" && reviewStage !== "review_2") {
    caseRedirect(caseId || "unknown", "Choose a valid review stage for rework.", false);
  }

  try {
    const result = await returnCaseForRework({
      caseId,
      reviewStage: reviewStage as "review_1" | "review_2",
    });
    if (!result) {
      caseRedirect(caseId, "Case not found.", false);
      return;
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case",
      objectId: caseId,
      action: "case_returned_for_rework",
      payload: {
        caseId,
        reviewStage,
        previousAssignmentId: result.previousAssignment.id,
        replacementAssignmentId: result.replacementAssignment.id,
        assignedToUserId: result.replacementAssignment.assignedToUserId,
      },
    });

    revalidateWorkflowSurfaces(caseId);
    caseRedirect(caseId, `Case returned to ${reviewStage.replace("_", " ")} for rework.`);
  } catch (error) {
    caseRedirect(caseId, error instanceof Error ? error.message : "Return for rework failed.", false);
  }
}

export async function markCaseNeedsAdjudicationAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");

  try {
    const result = await markCaseAsNeedsAdjudication(caseId);
    if (!result) {
      caseRedirect(caseId, "Case not found.", false);
      return;
    }

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case",
      objectId: caseId,
      action: "case_marked_needs_adjudication",
      payload: {
        caseId,
        currentStage: result.hostedCase.currentStage,
      },
    });

    revalidateWorkflowSurfaces(caseId);
    caseRedirect(caseId, "Case marked as needing adjudication.");
  } catch (error) {
    caseRedirect(caseId, error instanceof Error ? error.message : "Adjudication flagging failed.", false);
  }
}

export async function createReviewerUserAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const displayName = String(formData.get("displayName") || "");
  const email = String(formData.get("email") || "");

  try {
    const reviewer = await createReviewerUser({ displayName, email });
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "user",
      objectId: reviewer.id,
      action: "reviewer_created",
      payload: {
        reviewerDisplayName: reviewer.displayName,
        reviewerEmail: reviewer.email,
      },
    });
    revalidateReviewerManagementSurfaces();
    adminRedirect("Reviewer added.");
  } catch (error) {
    adminRedirect(error instanceof Error ? error.message : "Reviewer creation failed.", false);
  }
}

export async function updateReviewerUserAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const userId = String(formData.get("userId") || "");
  const displayName = String(formData.get("displayName") || "");
  const email = String(formData.get("email") || "");

  try {
    const reviewer = await updateReviewerUser({ userId, displayName, email });
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "user",
      objectId: reviewer.id,
      action: "reviewer_updated",
      payload: {
        reviewerDisplayName: reviewer.displayName,
        reviewerEmail: reviewer.email,
        reviewerStatus: reviewer.status,
      },
    });
    revalidateReviewerManagementSurfaces();
    adminRedirect("Reviewer updated.");
  } catch (error) {
    adminRedirect(error instanceof Error ? error.message : "Reviewer update failed.", false);
  }
}

export async function setReviewerUserStatusAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const userId = String(formData.get("userId") || "");
  const status = String(formData.get("status") || "");

  if (status !== "active" && status !== "disabled") {
    adminRedirect("Choose a valid reviewer status.", false);
  }

  try {
    const reviewer = await setReviewerUserStatus({
      userId,
      status: status as "active" | "disabled",
    });
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "user",
      objectId: reviewer.id,
      action: status === "disabled" ? "reviewer_disabled" : "reviewer_restored",
      payload: {
        reviewerDisplayName: reviewer.displayName,
        reviewerEmail: reviewer.email,
        reviewerStatus: reviewer.status,
      },
    });
    revalidateReviewerManagementSurfaces();
    adminRedirect(status === "disabled" ? "Reviewer disabled." : "Reviewer restored.");
  } catch (error) {
    adminRedirect(error instanceof Error ? error.message : "Reviewer status update failed.", false);
  }
}
