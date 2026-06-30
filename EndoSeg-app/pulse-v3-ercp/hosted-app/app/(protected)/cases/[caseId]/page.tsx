import Link from "next/link";
import { notFound } from "next/navigation";

import {
  activateCurrentStageAction,
  defineWorkflowChainAction,
  finalizeCaseAction,
  markCaseNeedsAdjudicationAction,
  reassignCurrentStageAction,
  returnCaseForReworkAction,
} from "@/app/(protected)/admin/cases/actions";
import { AdminNotesPanel } from "@/components/admin-notes-panel";
import { DiscussionActivityBadge } from "@/components/discussion-activity-badge";
import { ReferenceViewerPanel } from "@/components/reference-viewer-panel";
import { ReviewWorkspaceLaunchLink } from "@/components/review-workspace-launch-link";
import { SharedCaseDiscussionPanel } from "@/components/shared-case-discussion-panel";
import { StatusChip } from "@/components/status-chip";
import { UserIdentity } from "@/components/user-identity";
import { WorkflowAttentionIndicators } from "@/components/workflow-attention-indicators";
import { WorkflowChainSummary } from "@/components/workflow-chain-summary";
import { requireSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/server/audit";
import {
  canUserAccessCase,
  getAdminNotesThreadView,
  getCaseBundle,
  getMostRelevantAssignmentForUser,
  getSharedCaseDiscussionView,
  listAssignableReviewers,
  listReviewerDirectory,
} from "@/lib/server/mock-store";

type CaseDetailPageProps = {
  params: Promise<{ caseId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CaseDetailPage({ params, searchParams }: CaseDetailPageProps) {
  const session = await requireSession();
  const { caseId } = await params;
  const query = (await searchParams) || {};
  const submitted = query.submitted === "1";
  const workflowOk = query.workflow === "1";
  const workflowError = query.workflow === "0";
  const workflowMessage = typeof query.message === "string" ? query.message : "";
  const commentOk = query.comment === "1";
  const commentError = query.comment === "0";
  const noteOk = query.note === "1";
  const noteError = query.note === "0";
  const selectedReferenceId = typeof query.reference === "string" ? query.reference : "";
  const editingCommentId = typeof query.editing === "string" ? query.editing : "";

  const bundle = await getCaseBundle(caseId);
  if (!bundle) notFound();

  if (!canUserAccessCase(bundle, session.userId, session.role)) {
    notFound();
  }

  const reviewerDirectory = await listReviewerDirectory();
  const assignableReviewers = await listAssignableReviewers();
  const reviewersById = new Map(reviewerDirectory.map((reviewer) => [reviewer.id, reviewer]));
  const assignment = getMostRelevantAssignmentForUser(bundle, session.userId, session.role);
  const activeReviewerAssignment =
    assignment &&
    (assignment.status === "assigned" ||
      assignment.status === "opened" ||
      assignment.status === "in_progress")
      ? assignment
      : null;

  const visibleSubmissions =
    session.role === "admin" || session.role === "adjudicator"
      ? bundle.submissions
      : bundle.submissions.filter((submission) => submission.submittedByUserId === session.userId);
  const sharedDiscussion = await getSharedCaseDiscussionView({
    caseId: bundle.case.id,
    userId: session.userId,
    role: session.role,
  });
  const adminNotes =
    session.role === "admin"
      ? await getAdminNotesThreadView(bundle.case.id, session.userId, session.role)
      : null;
  const selectedReference = bundle.references.find((reference) => reference.id === selectedReferenceId) || null;
  const pdfReference =
    bundle.references.find((reference) => reference.referenceKind === "pdf") || null;
  const supplementalReferences = bundle.references.filter(
    (reference) => reference.id !== pdfReference?.id,
  );
  const reviewerReferenceToPreview =
    selectedReference || (!pdfReference && supplementalReferences[0]) || null;
  const pdfHref = pdfReference
    ? `/api/cases/${bundle.case.id}/references/${pdfReference.id}`
    : null;
  const isReviewer = session.role === "reviewer";
  const isAdmin = session.role === "admin";

  if (selectedReference) {
    await recordAuditEvent({
      actorUserId: session.userId,
      objectType: "case_reference",
      objectId: selectedReference.id,
      action: "case_reference_viewed",
      payload: {
        caseId: bundle.case.id,
        referenceKind: selectedReference.referenceKind,
      },
    });
  }

  const review1Step = bundle.workflowChain.find((step) => step.reviewStage === "review_1");
  const review2Step = bundle.workflowChain.find((step) => step.reviewStage === "review_2");
  const currentWorkflowStep =
    bundle.case.currentStage === "review_1"
      ? review1Step
      : bundle.case.currentStage === "review_2"
        ? review2Step
        : null;
  const canActivateCurrentStage =
    session.role === "admin" &&
    bundle.case.status === "ready_for_assignment" &&
    Boolean(currentWorkflowStep?.assignedReviewerUserId);
  const canFinalizeCase =
    session.role === "admin" && bundle.case.status === "awaiting_admin_finalization";
  const canReturnForRework =
    session.role === "admin" &&
    (bundle.case.status === "awaiting_admin_finalization" ||
      bundle.case.status === "needs_adjudication");
  const canMarkNeedsAdjudication =
    session.role === "admin" && bundle.case.status === "awaiting_admin_finalization";
  const defaultReworkStage = bundle.assignments.some(
    (item) => item.reviewStage === "review_2" && item.submittedAt,
  )
    ? "review_2"
    : "review_1";
  const assignmentOwnerId = activeReviewerAssignment?.assignedToUserId || assignment?.assignedToUserId || currentWorkflowStep?.assignedReviewerUserId || null;
  const assignmentOwner = assignmentOwnerId ? reviewersById.get(assignmentOwnerId) || null : null;

  return (
    <>
      <section className="hero-card">
        <p className="eyebrow">{isReviewer ? "Assigned case" : "Case detail"}</p>
        <h2>{bundle.case.displayCaseId}</h2>
        {isReviewer ? (
          <div className="row" style={{ marginTop: 10 }}>
            <StatusChip value={bundle.case.status} />
            <StatusChip value={bundle.case.currentStage} />
            {sharedDiscussion ? <DiscussionActivityBadge activity={sharedDiscussion.activity} /> : null}
          </div>
        ) : (
          <p className="muted">Review state, assignment ownership, and case operations live here.</p>
        )}
        {isReviewer && activeReviewerAssignment ? (
          <div className="row" style={{ marginTop: 14 }}>
            <ReviewWorkspaceLaunchLink
              className="button primary"
              href={`/review/${activeReviewerAssignment.id}`}
              title="Choose how to open the review workspace."
            >
              Open review workspace
            </ReviewWorkspaceLaunchLink>
            {pdfHref ? (
              <a
                className="button ghost"
                href={pdfHref}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open report PDF
              </a>
            ) : bundle.references.length ? (
              <Link className="button ghost" href={`/cases/${bundle.case.id}?reference=${bundle.references[0].id}`}>
                View reference
              </Link>
            ) : null}
          </div>
        ) : null}
        {isAdmin && bundle.references.length ? (
          <div className="row" style={{ marginTop: 14 }}>
            <Link
              className="button ghost"
              href={`/cases/${bundle.case.id}?reference=${bundle.references[0].id}`}
            >
              Open reference
            </Link>
          </div>
        ) : null}
      </section>

      {submitted ? (
        <section className="notice success">
          Hosted review submission persisted successfully for this assignment.
        </section>
      ) : null}

      {workflowOk && workflowMessage ? (
        <section className="notice success">{workflowMessage}</section>
      ) : null}

      {workflowError && workflowMessage ? (
        <section className="notice warning">{workflowMessage}</section>
      ) : null}

      {commentOk && workflowMessage ? (
        <section className="notice success">{workflowMessage}</section>
      ) : null}

      {commentError && workflowMessage ? (
        <section className="notice warning">{workflowMessage}</section>
      ) : null}

      {noteOk && workflowMessage ? (
        <section className="notice success">{workflowMessage}</section>
      ) : null}

      {noteError && workflowMessage ? (
        <section className="notice warning">{workflowMessage}</section>
      ) : null}

      <section className="meta-list">
        <div className="meta-item">
          <span className="meta-label">Case status</span>
          <StatusChip value={bundle.case.status} />
        </div>
        <div className="meta-item">
          <span className="meta-label">Current stage</span>
          <span className="meta-value">{bundle.case.currentStage}</span>
        </div>
        <div className="meta-item">
          <span className="meta-label">{isReviewer ? "Frames" : "Priority"}</span>
          {isReviewer ? (
            <span className="meta-value">{bundle.assets.length} frames</span>
          ) : (
            <StatusChip value={bundle.case.priority} />
          )}
        </div>
        <div className="meta-item">
          <span className="meta-label">Discussion activity</span>
          {sharedDiscussion ? (
            <DiscussionActivityBadge activity={sharedDiscussion.activity} />
          ) : (
            "Unavailable"
          )}
        </div>
        <div className="meta-item">
          <span className="meta-label">{isReviewer ? "Assignment owner" : "Your assignment"}</span>
          {isReviewer ? (
            assignmentOwner ? (
              <UserIdentity
                compact
                fallback={assignmentOwnerId || undefined}
                user={assignmentOwner}
              />
            ) : (
              <span className="meta-value">No active reviewer assignment</span>
            )
          ) : (
            <span className="meta-value">
              {assignment ? `${assignment.reviewStage} (${assignment.status})` : "No direct assignment"}
            </span>
          )}
        </div>
        {!isReviewer ? (
          <>
            <div className="meta-item">
              <span className="meta-label">Visible assets</span>
              <span className="meta-value">{bundle.assets.length} frames</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Manifest reference</span>
              <span
                className="meta-value"
                title={bundle.casePackage?.manifestStorageKey || bundle.case.metadata.manifestStorageKey}
              >
                {bundle.casePackage?.manifestStorageKey || bundle.case.metadata.manifestStorageKey}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Reference items</span>
              <span className="meta-value">{bundle.references.length}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Attention indicators</span>
              {sharedDiscussion ? (
                <WorkflowAttentionIndicators
                  assignmentStatus={assignment?.status || null}
                  caseStatus={bundle.case.status}
                  discussionActivity={sharedDiscussion.activity}
                />
              ) : (
                "None"
              )}
            </div>
          </>
        ) : null}
      </section>

      {bundle.references.length ? (
        isReviewer ? (
          <section className="split">
            <div className="card">
              <p className="eyebrow">Report access</p>
              <h3>Reviewer report</h3>
              {pdfReference ? (
                <div className="stack">
                  <div className="notice success">
                    Reviewer-facing PDF is available for this case.
                  </div>
                  <div className="reference-quick-card">
                    <div className="stack" style={{ gap: 8 }}>
                      <div>
                        <strong>{pdfReference.title}</strong>
                        <div className="muted">{pdfReference.sourceName}</div>
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
                          className={`button ${selectedReference?.id === pdfReference.id ? "primary" : "ghost"}`}
                          href={`/cases/${bundle.case.id}?reference=${pdfReference.id}`}
                        >
                          Preview here
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="notice">
                  No reviewer-facing PDF is attached to this case yet.
                </div>
              )}

              {supplementalReferences.length ? (
                <div className="stack" style={{ marginTop: 16 }}>
                  <div className="brand-kicker">Other reference material</div>
                  <div className="row">
                    {supplementalReferences.map((reference) => (
                      <Link
                        key={reference.id}
                        className={`button ${selectedReference?.id === reference.id ? "primary" : "ghost"}`}
                        href={`/cases/${bundle.case.id}?reference=${reference.id}`}
                        title={reference.title}
                      >
                        {reference.title}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            {reviewerReferenceToPreview ? (
              <ReferenceViewerPanel caseId={bundle.case.id} reference={reviewerReferenceToPreview} />
            ) : (
              <aside className="card">
                <h3>Reference preview</h3>
                <div className="empty">
                  {pdfReference
                    ? "Open the PDF directly or preview it here when needed."
                    : "Reference material will appear here when a case report is available."}
                </div>
              </aside>
            )}
          </section>
        ) : (
          <section className="split">
            <div className="table-card">
              <h3>Report / reference access</h3>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Source</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {bundle.references.map((reference) => (
                      <tr key={reference.id}>
                        <td>{reference.title}</td>
                        <td>
                          <StatusChip value={reference.referenceKind} />
                        </td>
                        <td>{reference.sourceName}</td>
                        <td>
                          <Link
                            className="button ghost"
                            href={`/cases/${bundle.case.id}?reference=${reference.id}`}
                          >
                            {selectedReference?.id === reference.id ? "Viewing" : "Open reference"}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {selectedReference ? (
              <ReferenceViewerPanel caseId={bundle.case.id} reference={selectedReference} />
            ) : (
              <aside className="card">
                <h3>Reference viewer</h3>
                <div className="notice">
                  Open a report or reference item here before entering the hosted review session.
                </div>
              </aside>
            )}
          </section>
        )
      ) : null}

      {!isReviewer ? (
      <section className="split">
        <div className="table-card">
          <h3>Workflow chain</h3>
          <WorkflowChainSummary chain={bundle.workflowChain} reviewers={reviewerDirectory} />
          <div className="row" style={{ marginTop: 16 }}>
            {canActivateCurrentStage ? (
              <form action={activateCurrentStageAction}>
                <input name="caseId" type="hidden" value={bundle.case.id} />
                <button className="button primary" type="submit">
                  Activate current stage
                </button>
              </form>
            ) : null}
          </div>

          {session.role === "admin" ? (
            <div className="stack" style={{ marginTop: 18 }}>
              <div className="notice">
                Admin controls the linear Reviewer 1 to Reviewer 2 chain. Reviewer 1 now
                auto-progresses to Reviewer 2 on submission, and Reviewer 2 returns the case
                here for final ground-truth acceptance.
              </div>

              <form action={defineWorkflowChainAction} className="form-grid">
                <input name="caseId" type="hidden" value={bundle.case.id} />
                <div className="field">
                  <label htmlFor="review1ReviewerUserId">Reviewer 1</label>
                  <select
                    id="review1ReviewerUserId"
                    name="review1ReviewerUserId"
                    defaultValue={review1Step?.assignedReviewerUserId || ""}
                  >
                    <option value="">Select reviewer</option>
                    {assignableReviewers.map((reviewer) => (
                      <option key={reviewer.id} value={reviewer.id}>
                        {reviewer.displayName} ({reviewer.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="review2ReviewerUserId">Reviewer 2</label>
                  <select
                    id="review2ReviewerUserId"
                    name="review2ReviewerUserId"
                    defaultValue={review2Step?.assignedReviewerUserId || ""}
                  >
                    <option value="">Select reviewer</option>
                    {assignableReviewers.map((reviewer) => (
                      <option key={reviewer.id} value={reviewer.id}>
                        {reviewer.displayName} ({reviewer.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row">
                  <button className="button primary" type="submit">
                    Save workflow chain
                  </button>
                </div>
              </form>

              <form action={reassignCurrentStageAction} className="form-grid">
                <input name="caseId" type="hidden" value={bundle.case.id} />
                <div className="field">
                  <label htmlFor="reviewerUserId">Reassign current active stage</label>
                  <select id="reviewerUserId" name="reviewerUserId" defaultValue="">
                    <option value="">Select reviewer</option>
                    {assignableReviewers.map((reviewer) => (
                      <option key={reviewer.id} value={reviewer.id}>
                        {reviewer.displayName} ({reviewer.email})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="row">
                  <button className="button ghost" type="submit">
                    Reassign current stage
                  </button>
                </div>
              </form>

              {canFinalizeCase ? (
                <form action={finalizeCaseAction}>
                  <input name="caseId" type="hidden" value={bundle.case.id} />
                  <button className="button primary" type="submit">
                    Finalize as ground truth
                  </button>
                </form>
              ) : null}

              {canMarkNeedsAdjudication ? (
                <form action={markCaseNeedsAdjudicationAction}>
                  <input name="caseId" type="hidden" value={bundle.case.id} />
                  <button className="button ghost" type="submit">
                    Mark as needing adjudication
                  </button>
                </form>
              ) : null}

              {canReturnForRework ? (
                <form action={returnCaseForReworkAction} className="form-grid">
                  <input name="caseId" type="hidden" value={bundle.case.id} />
                  <div className="field">
                    <label htmlFor="reviewStage">Return for rework</label>
                    <select defaultValue={defaultReworkStage} id="reviewStage" name="reviewStage">
                      <option value="review_2">Reviewer 2</option>
                      <option value="review_1">Reviewer 1</option>
                    </select>
                  </div>
                  <div className="row">
                    <button className="button ghost" type="submit">
                      Send back for rework
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : (
            <div className="notice" style={{ marginTop: 18 }}>
              Reviewer queue and active assignment visibility are driven from the hosted workflow chain.
            </div>
          )}
        </div>

        <aside className="card">
          <h3>Hosted review status</h3>
          <div className="stack">
            <div className="notice">
              Final submission only is enabled in this phase. Durable draft save remains deferred.
            </div>
            <div className="meta-item">
              <span className="meta-label">Discussion model</span>
              Shared case discussion is visible to Admin and assigned reviewers.
            </div>
            <div className="meta-item">
              <span className="meta-label">Submitted artifacts</span>
              {visibleSubmissions.length}
            </div>
            {assignment ? (
              <div className="meta-item">
                <span className="meta-label">Assignment owner</span>
                <UserIdentity
                  compact
                  fallback={assignment.assignedToUserId}
                  user={reviewersById.get(assignment.assignedToUserId) || null}
                />
              </div>
            ) : null}
            <div className="meta-item">
              <span className="meta-label">Finalization</span>
              {bundle.case.status === "needs_adjudication"
                ? "Marked as needing adjudication"
                : bundle.case.status === "ground_truth_finalized"
                ? "Ground truth accepted"
                : bundle.case.status === "awaiting_admin_finalization"
                  ? "Awaiting Admin finalization"
                  : bundle.case.status === "returned_for_rework"
                    ? "Returned for rework"
                  : "Not ready yet"}
            </div>
          </div>
        </aside>
      </section>
      ) : null}

      {!isReviewer ? (
      <section className="table-card">
        <h3>Frame manifest references</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Frame</th>
                <th>Source</th>
                <th>Storage key</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {bundle.assets.map((asset) => (
                <tr key={asset.id}>
                  <td>{asset.frameIndex}</td>
                  <td>{asset.sourceName}</td>
                  <td>{asset.storageKey}</td>
                  <td>
                    {asset.width} x {asset.height}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      ) : null}

      {!isReviewer ? (
      <section className="table-card">
        <h3>Submitted `.leus` snapshots</h3>
        {visibleSubmissions.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Submission</th>
                  <th>Assignment</th>
                  <th>Submitted at</th>
                  <th>Storage key</th>
                </tr>
              </thead>
              <tbody>
                {visibleSubmissions.map((submission) => (
                  <tr key={submission.id}>
                    <td>{submission.id}</td>
                    <td>{submission.assignmentId}</td>
                    <td>{submission.submittedAt}</td>
                    <td>{submission.leusStorageKey}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No hosted `.leus` submissions have been persisted for this case yet.</div>
        )}
      </section>
      ) : null}

      <section className="stack" id="communication">
        {sharedDiscussion ? (
          <SharedCaseDiscussionPanel
            activeComments={sharedDiscussion.activeComments}
            activity={sharedDiscussion.activity}
            caseId={bundle.case.id}
            editingCommentId={editingCommentId}
            legacyTimeline={sharedDiscussion.legacyTimeline}
            resolvedComments={sharedDiscussion.resolvedComments}
            returnTo={`/cases/${bundle.case.id}`}
            thread={sharedDiscussion.sharedThread}
            viewerRole={session.role}
            viewerUserId={session.userId}
          />
        ) : (
          <div className="empty">
            Shared case discussion is not available for your current hosted role on this case.
          </div>
        )}

        {session.role === "admin" && adminNotes ? (
          <AdminNotesPanel
            caseId={bundle.case.id}
            comments={adminNotes.comments}
            returnTo={`/cases/${bundle.case.id}`}
            thread={adminNotes.thread}
          />
        ) : null}
      </section>
    </>
  );
}
