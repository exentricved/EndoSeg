import Link from "next/link";

import { DiscussionActivityBadge } from "@/components/discussion-activity-badge";
import { ReviewWorkspaceLaunchLink } from "@/components/review-workspace-launch-link";
import { StatusChip } from "@/components/status-chip";
import { SummaryCard } from "@/components/summary-card";
import { WorkflowAttentionIndicators } from "@/components/workflow-attention-indicators";
import { requireRole } from "@/lib/auth/session";
import {
  listReviewerCompletedHistory,
  listReviewerQueue,
} from "@/lib/server/mock-store";

export default async function ReviewerDashboardPage() {
  const session = await requireRole(["reviewer"]);
  const reviewerQueue = await listReviewerQueue(session.userId);
  const completedHistory = await listReviewerCompletedHistory(session.userId);
  const pendingCount = reviewerQueue.filter((item) => item.assignment?.status === "assigned").length;
  const inProgressCount = reviewerQueue.filter(
    (item) => item.assignment?.status === "opened" || item.assignment?.status === "in_progress",
  ).length;
  const attentionCount = reviewerQueue.filter(
    (item) =>
      item.case.status === "returned_for_rework" ||
      item.case.status === "needs_adjudication" ||
      item.discussionActivity.activeCount > 0,
  ).length;

  return (
    <>
      <section className="hero-card">
        <p className="eyebrow">Reviewer queue</p>
        <h2>Your assigned reviews</h2>
        <p className="muted">
          Open active cases, review the report PDF, and keep discussion moving from one place.
        </p>
        <div className="notice" style={{ marginTop: 14 }}>
          Signed in as <strong>{session.displayName}</strong> ({session.email}).
        </div>
      </section>

      <section className="card-grid">
        <SummaryCard label="Active queue" value={reviewerQueue.length} tone="ready" />
        <SummaryCard label="Pending review" value={pendingCount} tone="pending" />
        <SummaryCard label="In progress" value={inProgressCount} tone="active" />
        <SummaryCard label="History" value={completedHistory.length} tone="completed" />
      </section>

      {attentionCount ? (
        <section className="notice warning">
          {attentionCount} active queue {attentionCount === 1 ? "item needs" : "items need"} attention.
          Returned-for-rework cases, adjudication-needed flags, and unresolved discussion are surfaced below.
        </section>
      ) : null}

      <section className="table-card">
        <h3>Actionable queue</h3>
        {reviewerQueue.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Priority</th>
                  <th>Case state</th>
                  <th>Stage</th>
                  <th>Assignment</th>
                  <th>Status</th>
                  <th>Attention</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {reviewerQueue.map((item) => (
                  <tr key={item.assignment!.id}>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <strong>{item.case.displayCaseId}</strong>
                        <DiscussionActivityBadge activity={item.discussionActivity} />
                      </div>
                      <div className="muted">{item.case.metadata.summary}</div>
                    </td>
                    <td>
                      <StatusChip value={item.case.priority} />
                    </td>
                    <td>
                      <StatusChip value={item.case.status} />
                    </td>
                    <td>{item.case.currentStage}</td>
                    <td>{item.assignment?.reviewStage || "unassigned"}</td>
                    <td>
                      <StatusChip value={item.assignment?.status || item.case.status} />
                    </td>
                    <td>
                      <WorkflowAttentionIndicators
                        assignmentStatus={item.assignment?.status || null}
                        caseStatus={item.case.status}
                        compact
                        discussionActivity={item.discussionActivity}
                      />
                    </td>
                    <td>
                      <div className="row">
                        <Link className="button ghost" href={`/cases/${item.case.id}`}>
                          Open case
                        </Link>
                        {item.assignment ? (
                          <ReviewWorkspaceLaunchLink
                            className="button primary"
                            href={`/review/${item.assignment.id}`}
                            title="Choose how to open the review workspace."
                          >
                            Open review workspace
                          </ReviewWorkspaceLaunchLink>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No active hosted review assignments are waiting in your queue.</div>
        )}
      </section>

      <section className="table-card">
        <h3>Completed / history</h3>
        {completedHistory.length ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Case state</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Attention</th>
                  <th>Submitted / updated</th>
                </tr>
              </thead>
              <tbody>
                {completedHistory.map((item) => (
                    <tr key={item.assignment.id}>
                      <td>{item.case.displayCaseId}</td>
                      <td>
                        <StatusChip value={item.case.status} />
                      </td>
                      <td>{item.assignment.reviewStage}</td>
                      <td>
                        <StatusChip value={item.assignment.status} />
                      </td>
                      <td>
                        <WorkflowAttentionIndicators
                          assignmentStatus={item.assignment.status}
                          caseStatus={item.case.status}
                          compact
                          discussionActivity={item.discussionActivity}
                        />
                      </td>
                      <td>{item.assignment.submittedAt || item.assignment.assignedAt}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No completed or returned reviewer history is available yet.</div>
        )}
      </section>
    </>
  );
}
