import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import { getBundleForAssignment, persistHostedSubmission } from "@/lib/server/mock-store";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ assignmentId: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { assignmentId } = await params;
  const payload = await getBundleForAssignment(assignmentId);
  if (!payload) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  if (payload.assignment.assignedToUserId !== session.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (
    payload.assignment.status === "submitted" ||
    payload.assignment.status === "cancelled" ||
    payload.assignment.status === "returned"
  ) {
    return NextResponse.json({ error: "Assignment is no longer active" }, { status: 409 });
  }

  const body = (await request.json()) as {
    caseId?: string;
    assignmentId?: string;
    leusJson?: unknown;
    summary?: {
      imageCount: number;
      labelsObserved?: Array<{ id: number; name: string }>;
      stationsUsed?: Array<"TG" | "TD" | "">;
    };
  };

  if (!body || body.assignmentId !== assignmentId || body.caseId !== payload.bundle.case.id || !body.leusJson) {
    return NextResponse.json({ error: "Invalid submission payload" }, { status: 400 });
  }

  const persisted = await persistHostedSubmission({
    assignmentId,
    actorUserId: session.userId,
    leusJson: body.leusJson,
    summary: body.summary,
  });

  if (!persisted) {
    return NextResponse.json({ error: "Submission persistence failed" }, { status: 500 });
  }

  await recordAuditEvent({
    actorUserId: session.userId,
    objectType: "assignment",
    objectId: assignmentId,
    action: "assignment_submitted",
    payload: {
      caseId: persisted.hostedCase.id,
      submissionId: persisted.submission.id,
      reviewStage: persisted.assignment.reviewStage,
      leusStorageKey: persisted.submission.leusStorageKey,
    },
  });

  if (persisted.nextAssignment) {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "assignment",
      objectId: persisted.nextAssignment.id,
      action: "workflow_auto_progressed_to_next_stage",
      payload: {
        caseId: persisted.hostedCase.id,
        fromReviewStage: persisted.assignment.reviewStage,
        toReviewStage: persisted.nextAssignment.reviewStage,
        assignedToUserId: persisted.nextAssignment.assignedToUserId,
      },
    });
  }

  if (persisted.hostedCase.status === "awaiting_admin_finalization") {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case",
      objectId: persisted.hostedCase.id,
      action: "case_returned_to_admin_finalization",
      payload: {
        caseId: persisted.hostedCase.id,
        reviewStage: persisted.assignment.reviewStage,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    submissionId: persisted.submission.id,
    leusStorageKey: persisted.submission.leusStorageKey,
  });
}
