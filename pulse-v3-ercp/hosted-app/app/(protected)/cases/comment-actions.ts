"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireRole } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import {
  createAdminCaseNote,
  createCaseDiscussionComment,
  createAssignmentComment,
  setCaseDiscussionCommentResolved,
  setCaseDiscussionThreadResolved,
  updateCaseDiscussionComment,
} from "@/lib/server/mock-store";

function redirectWithMessage(returnTo: string, key: "comment" | "note", ok: boolean, message: string) {
  const [pathWithQuery, hash = "communication"] = returnTo.split("#");
  const [path, existingQuery = ""] = pathWithQuery.split("?");
  const params = new URLSearchParams(existingQuery);
  params.set(key, ok ? "1" : "0");
  params.set("message", message);
  redirect(`${path}?${params.toString()}#${hash}`);
}

function revalidateReturnTarget(returnTo: string) {
  const cleanPath = returnTo.split("?")[0].split("#")[0];
  if (cleanPath.startsWith("/")) {
    revalidatePath(cleanPath);
  }
}

function revalidateDiscussionSurfaces(caseId: string, returnTo: string) {
  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/admin/cases");
  revalidatePath("/reviewer/dashboard");
  revalidateReturnTarget(returnTo);
}

export async function postAssignmentCommentAction(formData: FormData) {
  const session = await requireRole(["admin", "reviewer"]);
  const assignmentId = String(formData.get("assignmentId") || "");
  const caseId = String(formData.get("caseId") || "");
  const body = String(formData.get("body") || "");
  const returnTo = String(formData.get("returnTo") || `/cases/${caseId}`);

  try {
    const result = await createAssignmentComment({
      assignmentId,
      actorUserId: session.userId,
      body,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "comment",
      objectId: result.comment.id,
      action: "comment_created",
      payload: {
        caseId: result.comment.caseId,
        assignmentId: result.comment.assignmentId,
        threadId: result.thread.id,
        visibilityScope: result.comment.visibilityScope,
      },
    });

    revalidatePath(`/cases/${caseId}`);
    revalidatePath("/admin/cases");
    if (assignmentId) {
      revalidatePath(`/reviewer/reviews/${assignmentId}`);
      revalidatePath(`/review/${assignmentId}`);
    }
    revalidateReturnTarget(returnTo);
    redirectWithMessage(returnTo, "comment", true, "Comment posted.");
  } catch (error) {
    redirectWithMessage(
      returnTo,
      "comment",
      false,
      error instanceof Error ? error.message : "Comment post failed.",
    );
  }
}

export async function postSharedCaseCommentAction(formData: FormData) {
  const session = await requireRole(["admin", "reviewer"]);
  const caseId = String(formData.get("caseId") || "");
  const body = String(formData.get("body") || "");
  const returnTo = String(formData.get("returnTo") || `/cases/${caseId}`);

  try {
    const result = await createCaseDiscussionComment({
      caseId,
      actorUserId: session.userId,
      body,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "comment",
      objectId: result.comment.id,
      action: "shared_comment_created",
      payload: {
        caseId,
        threadId: result.thread.id,
        visibilityScope: result.comment.visibilityScope,
      },
    });

    revalidateDiscussionSurfaces(caseId, returnTo);
    redirectWithMessage(returnTo, "comment", true, "Shared case comment posted.");
  } catch (error) {
    redirectWithMessage(
      returnTo,
      "comment",
      false,
      error instanceof Error ? error.message : "Shared comment post failed.",
    );
  }
}

export async function editSharedCaseCommentAction(formData: FormData) {
  const session = await requireRole(["admin", "reviewer"]);
  const commentId = String(formData.get("commentId") || "");
  const caseId = String(formData.get("caseId") || "");
  const body = String(formData.get("body") || "");
  const returnTo = String(formData.get("returnTo") || `/cases/${caseId}`);

  try {
    const result = await updateCaseDiscussionComment({
      commentId,
      actorUserId: session.userId,
      body,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "comment",
      objectId: result.comment.id,
      action: "comment_updated",
      payload: {
        caseId: result.comment.caseId,
        threadId: result.thread.id,
        visibilityScope: result.comment.visibilityScope,
      },
    });

    revalidateDiscussionSurfaces(caseId, returnTo);
    redirectWithMessage(returnTo, "comment", true, "Comment updated.");
  } catch (error) {
    redirectWithMessage(
      returnTo,
      "comment",
      false,
      error instanceof Error ? error.message : "Comment update failed.",
    );
  }
}

export async function setSharedCaseCommentResolutionAction(formData: FormData) {
  const session = await requireRole(["admin", "reviewer"]);
  const commentId = String(formData.get("commentId") || "");
  const caseId = String(formData.get("caseId") || "");
  const intent = String(formData.get("intent") || "resolve");
  const resolved = intent !== "reopen";
  const returnTo = String(formData.get("returnTo") || `/cases/${caseId}`);

  try {
    const result = await setCaseDiscussionCommentResolved({
      commentId,
      actorUserId: session.userId,
      resolved,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "comment",
      objectId: result.comment.id,
      action: resolved ? "comment_resolved" : "comment_reopened",
      payload: {
        caseId: result.comment.caseId,
        threadId: result.thread.id,
        visibilityScope: result.comment.visibilityScope,
      },
    });

    revalidateDiscussionSurfaces(caseId, returnTo);
    redirectWithMessage(returnTo, "comment", true, resolved ? "Comment resolved." : "Comment reopened.");
  } catch (error) {
    redirectWithMessage(
      returnTo,
      "comment",
      false,
      error instanceof Error ? error.message : "Comment resolution update failed.",
    );
  }
}

export async function setSharedCaseThreadResolutionAction(formData: FormData) {
  const session = await requireRole(["admin", "reviewer"]);
  const caseId = String(formData.get("caseId") || "");
  const intent = String(formData.get("intent") || "resolve");
  const resolved = intent !== "reopen";
  const returnTo = String(formData.get("returnTo") || `/cases/${caseId}`);

  try {
    const result = await setCaseDiscussionThreadResolved({
      caseId,
      actorUserId: session.userId,
      resolved,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "comment_thread",
      objectId: result.thread.id,
      action: resolved ? "discussion_thread_resolved" : "discussion_thread_reopened",
      payload: {
        caseId: result.thread.caseId,
        threadId: result.thread.id,
        visibilityScope: result.thread.visibilityScope,
      },
    });

    revalidateDiscussionSurfaces(caseId, returnTo);
    redirectWithMessage(
      returnTo,
      "comment",
      true,
      resolved ? "Discussion marked resolved." : "Discussion reopened.",
    );
  } catch (error) {
    redirectWithMessage(
      returnTo,
      "comment",
      false,
      error instanceof Error ? error.message : "Discussion resolution update failed.",
    );
  }
}

export async function postAdminCaseNoteAction(formData: FormData) {
  const session = await requireRole(["admin"]);
  const caseId = String(formData.get("caseId") || "");
  const body = String(formData.get("body") || "");
  const returnTo = String(formData.get("returnTo") || `/cases/${caseId}`);

  try {
    const result = await createAdminCaseNote({
      caseId,
      actorUserId: session.userId,
      body,
    });

    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "comment",
      objectId: result.comment.id,
      action: "admin_note_created",
      payload: {
        caseId,
        threadId: result.thread.id,
        visibilityScope: result.comment.visibilityScope,
      },
    });

    revalidatePath(`/cases/${caseId}`);
    revalidatePath("/admin/cases");
    revalidateReturnTarget(returnTo);
    redirectWithMessage(returnTo, "note", true, "Admin note added.");
  } catch (error) {
    redirectWithMessage(
      returnTo,
      "note",
      false,
      error instanceof Error ? error.message : "Admin note failed.",
    );
  }
}
