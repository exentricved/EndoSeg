import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import { getBundleForAssignment, markAssignmentInProgressIfNeeded } from "@/lib/server/mock-store";

export async function POST(
  _request: Request,
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

  await markAssignmentInProgressIfNeeded(assignmentId);
  await recordAuditEvent({
    actorUserId: session.userId,
    objectType: "assignment",
    objectId: assignmentId,
    action: "assignment_in_progress",
    payload: {
      caseId: payload.bundle.case.id,
      reviewStage: payload.assignment.reviewStage,
    },
  });

  return NextResponse.json({ ok: true });
}
