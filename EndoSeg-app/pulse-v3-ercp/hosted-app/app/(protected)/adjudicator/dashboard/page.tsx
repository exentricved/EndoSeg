import Link from "next/link";

import { StatusChip } from "@/components/status-chip";
import { SummaryCard } from "@/components/summary-card";
import { requireRole } from "@/lib/auth/session";
import { getDashboardSummaryForUser, listCasesVisibleToUser } from "@/lib/server/mock-store";

export default async function AdjudicatorDashboardPage() {
  const session = await requireRole(["adjudicator"]);
  const visibleCases = await listCasesVisibleToUser(session.userId, session.role);
  const summary = await getDashboardSummaryForUser(session.userId, session.role);

  return (
    <>
      <section className="hero-card">
        <p className="eyebrow">Adjudicator workspace</p>
        <h2>Adjudication queue</h2>
        <p className="muted">
          Review cases that have been routed for adjudication as the workflow expands.
        </p>
      </section>

      <section className="card-grid">
        <SummaryCard label="Assigned cases" value={summary.assigned} tone="ready" />
        <SummaryCard label="Opened" value={summary.opened} tone="active" />
        <SummaryCard label="Submitted" value={summary.submitted} tone="completed" />
      </section>

      <section className="table-card">
        <h3>Adjudication queue</h3>
        {visibleCases.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Stage</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleCases.map((item) => (
                <tr key={item.case.id}>
                  <td>
                    <strong>{item.case.displayCaseId}</strong>
                    <div className="muted">{item.case.metadata.summary}</div>
                  </td>
                  <td>{item.case.currentStage}</td>
                  <td>
                    <StatusChip value={item.assignment?.status || item.case.status} />
                  </td>
                  <td>
                    <Link className="button ghost" href={`/cases/${item.case.id}`}>
                      Open case detail
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No adjudication assignments are queued right now.</div>
        )}
      </section>
    </>
  );
}
