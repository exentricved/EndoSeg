import Link from "next/link";

import {
  createReviewerUserAction,
  setReviewerUserStatusAction,
  updateReviewerUserAction,
} from "@/app/(protected)/admin/cases/actions";
import { StatusChip } from "@/components/status-chip";
import { UserIdentity } from "@/components/user-identity";
import { WorkflowChainSummary } from "@/components/workflow-chain-summary";
import { requireRole } from "@/lib/auth/session";
import { listAllCases, listReviewerDirectory } from "@/lib/server/mock-store";

type AdminCaseListPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminCaseListPage({ searchParams }: AdminCaseListPageProps) {
  await requireRole(["admin"]);
  const reviewers = await listReviewerDirectory();
  const reviewersById = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer]));
  const cases = await listAllCases();
  const query = (await searchParams) || {};
  const q = typeof query.q === "string" ? query.q.trim().toLowerCase() : "";
  const status = typeof query.status === "string" ? query.status : "";
  const reviewerOk = query.reviewers === "1";
  const reviewerError = query.reviewers === "0";
  const message = typeof query.message === "string" ? query.message : "";

  const filteredCases = cases.filter((item) => {
    const matchesQuery =
      !q ||
      item.case.displayCaseId.toLowerCase().includes(q) ||
      item.case.metadata.summary.toLowerCase().includes(q);
    const matchesStatus = !status || item.case.status === status;
    return matchesQuery && matchesStatus;
  });

  return (
    <>
      <section className="hero-card">
        <p className="eyebrow">Admin workflow</p>
        <h2>Review operations</h2>
        <p className="muted">
          Manage case workflow, reviewer assignments, and the current reviewer directory.
        </p>
        <div className="row" style={{ marginTop: 14 }}>
          <Link className="button primary" href="/admin/upload">
            Upload case package
          </Link>
        </div>
      </section>

      {reviewerOk && message ? <section className="notice success">{message}</section> : null}
      {reviewerError && message ? <section className="notice warning">{message}</section> : null}

      <section className="card">
        <form className="row" action="/admin/cases">
          <div className="field" style={{ flex: "1 1 260px" }}>
            <label htmlFor="q">Search</label>
            <input id="q" name="q" defaultValue={q} placeholder="Case ID or summary" />
          </div>
          <div className="field" style={{ width: 220 }}>
            <label htmlFor="status">Status</label>
            <select id="status" name="status" defaultValue={status}>
              <option value="">All statuses</option>
              <option value="ready_for_assignment">ready_for_assignment</option>
              <option value="assigned_to_r1">assigned_to_r1</option>
              <option value="in_review_r1">in_review_r1</option>
              <option value="assigned_to_r2">assigned_to_r2</option>
              <option value="in_review_r2">in_review_r2</option>
              <option value="returned_for_rework">returned_for_rework</option>
              <option value="needs_adjudication">needs_adjudication</option>
              <option value="awaiting_admin_finalization">awaiting_admin_finalization</option>
              <option value="ground_truth_finalized">ground_truth_finalized</option>
            </select>
          </div>
          <div className="row" style={{ marginTop: 30 }}>
            <button className="button primary" type="submit">
              Apply filters
            </button>
          </div>
        </form>
      </section>

      <section className="table-card">
        <h3>Cases in workflow</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Current step</th>
                <th>Chain summary</th>
                <th>Active assignee</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredCases.map((item) => (
                (() => {
                  const activeAssignment =
                    item.assignments.find(
                      (assignment) =>
                        assignment.reviewStage === item.case.currentStage &&
                        (assignment.status === "assigned" ||
                          assignment.status === "opened" ||
                          assignment.status === "in_progress"),
                    ) || null;

                  return (
                    <tr key={item.case.id}>
                      <td>
                        <strong>{item.case.displayCaseId}</strong>
                        <div className="muted">{item.case.metadata.summary}</div>
                      </td>
                      <td>
                        <StatusChip value={item.case.priority} />
                      </td>
                      <td>
                        <StatusChip value={item.case.status} />
                      </td>
                      <td>{item.case.currentStage}</td>
                      <td style={{ minWidth: 240 }}>
                        <WorkflowChainSummary chain={item.workflowChain} reviewers={reviewers} />
                      </td>
                      <td>
                        {activeAssignment ? (
                          <UserIdentity
                            compact
                            fallback={activeAssignment.assignedToUserId}
                            user={reviewersById.get(activeAssignment.assignedToUserId) || null}
                          />
                        ) : "None active"}
                      </td>
                      <td>
                        <Link className="button ghost" href={`/cases/${item.case.id}`}>
                          Open case
                        </Link>
                      </td>
                    </tr>
                  );
                })()
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="split">
        <section className="card">
          <p className="eyebrow">Reviewer management</p>
          <h3>Add reviewer</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Keep the reviewer list current without affecting assignment history.
          </p>
          <form action={createReviewerUserAction} className="form-grid">
            <div className="field">
              <label htmlFor="reviewer-display-name">Display name</label>
              <input id="reviewer-display-name" name="displayName" placeholder="Reviewer name" />
            </div>
            <div className="field">
              <label htmlFor="reviewer-email">Email</label>
              <input id="reviewer-email" name="email" placeholder="reviewer@example.com" type="email" />
            </div>
            <div className="row">
              <button className="button primary" type="submit">
                Add reviewer
              </button>
            </div>
          </form>
        </section>

        <section className="table-card">
          <p className="eyebrow">Reviewer directory</p>
          <h3>Current reviewers</h3>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Reviewer</th>
                  <th>Status</th>
                  <th>Edit</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {reviewers.map((reviewer) => (
                  <tr key={reviewer.id}>
                    <td>
                      <UserIdentity compact user={reviewer} />
                    </td>
                    <td>
                      <StatusChip value={reviewer.status} />
                    </td>
                    <td>
                      <form action={updateReviewerUserAction} className="inline-form-grid">
                        <input name="userId" type="hidden" value={reviewer.id} />
                        <input name="displayName" defaultValue={reviewer.displayName} />
                        <input name="email" defaultValue={reviewer.email} type="email" />
                        <button className="button ghost" type="submit">
                          Save
                        </button>
                      </form>
                    </td>
                    <td>
                      <form action={setReviewerUserStatusAction}>
                        <input name="userId" type="hidden" value={reviewer.id} />
                        <input
                          name="status"
                          type="hidden"
                          value={reviewer.status === "active" ? "disabled" : "active"}
                        />
                        <button className="button ghost" type="submit">
                          {reviewer.status === "active" ? "Disable access" : "Restore access"}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </>
  );
}
