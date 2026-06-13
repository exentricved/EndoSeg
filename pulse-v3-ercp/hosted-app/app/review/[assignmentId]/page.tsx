import Link from "next/link";
import { notFound } from "next/navigation";

import { DiscussionActivityBadge } from "@/components/discussion-activity-badge";
import { HostedReviewShell } from "@/components/hosted-review-shell";
import { ReferenceViewerPanel } from "@/components/reference-viewer-panel";
import { ReviewWorkspaceDrawer } from "@/components/review-workspace-drawer";
import { SharedCaseDiscussionPanel } from "@/components/shared-case-discussion-panel";
import { requireRole } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import {
  getBundleForAssignment,
  getSharedCaseDiscussionView,
} from "@/lib/server/mock-store";

type ReviewWorkspacePageProps = {
  params: Promise<{ assignmentId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ReviewWorkspacePage({
  params,
  searchParams,
}: ReviewWorkspacePageProps) {
  const session = await requireRole(["reviewer"]);
  const { assignmentId } = await params;
  const query = (await searchParams) || {};
  const commentOk = query.comment === "1";
  const commentError = query.comment === "0";
  const message = typeof query.message === "string" ? query.message : "";
  const activePanel =
    query.panel === "reference" || query.panel === "discussion" ? query.panel : null;
  const selectedReferenceId = typeof query.reference === "string" ? query.reference : "";
  const editingCommentId = typeof query.editing === "string" ? query.editing : "";

  const payload = await getBundleForAssignment(assignmentId);
  if (!payload) notFound();
  if (payload.assignment.assignedToUserId !== session.userId) notFound();
  if (
    payload.assignment.status === "submitted" ||
    payload.assignment.status === "cancelled" ||
    payload.assignment.status === "returned"
  ) {
    notFound();
  }

  const discussion = await getSharedCaseDiscussionView({
    caseId: payload.bundle.case.id,
    userId: session.userId,
    role: session.role,
  });
  const discussionActivity = discussion?.activity || {
    totalSharedCount: 0,
    activeCount: 0,
    resolvedCount: 0,
    legacyCount: 0,
    threadStatus: null,
  };
  const selectedReference =
    payload.bundle.references.find((reference) => reference.id === selectedReferenceId) || null;
  const pdfReference =
    payload.bundle.references.find((reference) => reference.referenceKind === "pdf") || null;
  const defaultReference = pdfReference || payload.bundle.references[0] || null;
  const nonPdfReferences = payload.bundle.references.filter(
    (reference) => reference.id !== pdfReference?.id,
  );
  const referenceHref = defaultReference
    ? `/review/${assignmentId}?panel=reference&reference=${selectedReference?.id || defaultReference.id}`
    : null;
  const pdfHref = pdfReference
    ? `/api/cases/${payload.bundle.case.id}/references/${pdfReference.id}`
    : null;
  const discussionHref = `/review/${assignmentId}?panel=discussion#communication`;

  if (selectedReference) {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case_reference",
      objectId: selectedReference.id,
      action: "case_reference_viewed",
      payload: {
        caseId: payload.bundle.case.id,
        referenceKind: selectedReference.referenceKind,
        surface: "review_workspace",
      },
    });
  }

  const manifest = {
    caseId: payload.bundle.case.id,
    displayCaseId: payload.bundle.case.displayCaseId,
    assignmentId: payload.assignment.id,
    reviewStage: payload.assignment.reviewStage,
    actor: {
      userId: session.userId,
      displayName: session.displayName,
      role: "reviewer" as const,
    },
    permissions: {
      canSaveDraft: false,
      canSubmit: true,
      readOnly: false,
      mayViewPriorStageOutputs: false,
    },
    frames: payload.bundle.assets
      .slice()
      .sort((a, b) => a.frameIndex - b.frameIndex)
      .map((asset) => ({
        frameId: asset.id,
        frameIndex: asset.frameIndex,
        sourceName: asset.sourceName,
        imageUrl: `/api/cases/${payload.bundle.case.id}/assets/${asset.id}`,
        width: asset.width,
        height: asset.height,
        checksumSha256: asset.checksumSha256,
      })),
    existingDraft: null,
    priorStageOutputs: [],
    serverPolicy: {
      submissionCommentRequired: false,
      allowEscalateToAdjudication: false,
    },
  };

  return (
    <div className="review-workspace-shell">
      <header className="review-workspace-topbar" id="review-workspace-topbar">
        <div className="review-workspace-title-block">
          <h1 className="review-workspace-title">{payload.bundle.case.displayCaseId}</h1>
          <div className="review-workspace-identity muted">
            {session.displayName} | {session.email}
          </div>
        </div>

        <div className="row review-workspace-actions">
          <div className="chip ready">{payload.assignment.reviewStage}</div>
          <div className="chip pending">{payload.assignment.status}</div>
          {pdfHref ? (
            <a
              className="button ghost"
              href={pdfHref}
              rel="noopener noreferrer"
              target="_blank"
              title="Open the reviewer-facing report PDF in a new tab."
            >
              View PDF
            </a>
          ) : null}
          {referenceHref ? (
            <Link
              aria-controls="review-workspace-reference-panel"
              aria-expanded={activePanel === "reference"}
              className={`button ${activePanel === "reference" ? "primary" : "ghost"}`}
              href={referenceHref}
              id="review-workspace-report-trigger"
            >
              Report
            </Link>
          ) : null}
          <Link
            aria-controls="review-workspace-discussion-panel"
            aria-expanded={activePanel === "discussion"}
            className={`button ${activePanel === "discussion" ? "primary" : "ghost"}`}
            href={discussionHref}
            id="review-workspace-discussion-trigger"
          >
            Discussion
            <DiscussionActivityBadge activity={discussionActivity} compact />
          </Link>
          <Link className="button ghost" href={`/cases/${payload.bundle.case.id}`}>
            Return to case
          </Link>
        </div>
      </header>

      {(commentOk && message) || (commentError && message) ? (
        <div className={`review-workspace-toast ${commentError ? "warning" : "success"}`}>
          {message}
        </div>
      ) : null}

      <div className="review-workspace-stage">
        <section className="review-workspace-canvas">
          <HostedReviewShell
            manifest={manifest}
            caseDetailHref={`/cases/${payload.bundle.case.id}`}
          />
        </section>
      </div>

      {activePanel === "reference" ? (
        <ReviewWorkspaceDrawer
          anchorId="review-workspace-topbar"
          closeHref={`/review/${assignmentId}`}
          labelledBy="review-workspace-reference-title"
          panelId="review-workspace-reference-panel"
          returnFocusId="review-workspace-report-trigger"
        >
          <div>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="brand-kicker">Read-only reference</div>
                <h3 id="review-workspace-reference-title" style={{ margin: 0 }}>
                  Report / reference
                </h3>
              </div>
            </div>

            {payload.bundle.references.length ? (
              <div className="stack">
                {pdfReference ? (
                  <section className="reference-quick-card">
                    <div className="stack" style={{ gap: 8 }}>
                      <div>
                        <div className="brand-kicker">Preferred reviewer report</div>
                        <h4 style={{ margin: "0 0 4px" }}>{pdfReference.title}</h4>
                        <p className="muted" style={{ margin: 0 }}>
                          Open the PDF directly or preview it below.
                        </p>
                      </div>
                      <div className="row">
                        <a
                          className="button primary"
                          href={pdfHref!}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          Open report PDF
                        </a>
                        <Link
                          className={`button ${
                            selectedReference?.id === pdfReference.id ? "primary" : "ghost"
                          }`}
                          href={`/review/${assignmentId}?panel=reference&reference=${pdfReference.id}`}
                        >
                          Preview here
                        </Link>
                      </div>
                    </div>
                  </section>
                ) : (
                  <div className="notice">
                    No reviewer-facing PDF is attached to this case yet. Supplemental references are
                    listed below.
                  </div>
                )}
                {nonPdfReferences.length ? (
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="brand-kicker">Supplemental reference material</div>
                    <div className="row">
                      {nonPdfReferences.map((reference) => (
                        <Link
                          className={`button ${
                            selectedReference?.id === reference.id ? "primary" : "ghost"
                          }`}
                          href={`/review/${assignmentId}?panel=reference&reference=${reference.id}`}
                          key={reference.id}
                          title={reference.title}
                        >
                          {reference.title}
                        </Link>
                      ))}
                    </div>
                  </div>
                ) : null}
                {selectedReference ? (
                  <ReferenceViewerPanel
                    caseId={payload.bundle.case.id}
                    reference={selectedReference}
                  />
                ) : (
                  <div className="empty">
                    {pdfReference
                      ? "Use the PDF action above or preview the report here."
                      : "No report preview is available yet. Open a supplemental reference when needed."}
                  </div>
                )}
              </div>
            ) : (
              <div className="empty">No report/reference items are attached to this case.</div>
            )}
          </div>
        </ReviewWorkspaceDrawer>
      ) : null}

      {activePanel === "discussion" ? (
        <ReviewWorkspaceDrawer
          anchorId="review-workspace-topbar"
          closeHref={`/review/${assignmentId}`}
          labelledBy="review-workspace-discussion-title"
          panelId="review-workspace-discussion-panel"
          returnFocusId="review-workspace-discussion-trigger"
        >
          <div id="communication">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div className="brand-kicker">Hosted communication</div>
                <h3 id="review-workspace-discussion-title" style={{ margin: 0 }}>
                  Shared case discussion
                </h3>
              </div>
            </div>

            {discussion ? (
              <SharedCaseDiscussionPanel
                activeComments={discussion.activeComments}
                activity={discussion.activity}
                caseId={payload.bundle.case.id}
                editingCommentId={editingCommentId}
                legacyTimeline={discussion.legacyTimeline}
                resolvedComments={discussion.resolvedComments}
                returnTo={`/review/${assignmentId}?panel=discussion#communication`}
                thread={discussion.sharedThread}
                viewerRole={session.role}
                viewerUserId={session.userId}
              />
            ) : (
              <div className="empty">
                Shared case discussion is not available for this review assignment.
              </div>
            )}
          </div>
        </ReviewWorkspaceDrawer>
      ) : null}
    </div>
  );
}
