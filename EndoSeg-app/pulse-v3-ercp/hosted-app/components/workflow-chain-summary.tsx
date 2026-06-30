import type { HostedUser, HostedWorkflowChainStep } from "@/lib/domain/models";
import { UserIdentity } from "@/components/user-identity";

export function WorkflowChainSummary({
  chain,
  reviewers,
}: {
  chain: HostedWorkflowChainStep[];
  reviewers: HostedUser[];
}) {
  const reviewersById = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer]));

  if (!chain.length) {
    return <span className="muted">No workflow chain defined yet.</span>;
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {chain
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((step) => (
          <div key={step.id}>
            <strong>{step.reviewStage.replace("_", " ")}</strong>:{" "}
            {step.assignedReviewerUserId ? (
              <UserIdentity
                compact
                fallback={step.assignedReviewerUserId}
                user={reviewersById.get(step.assignedReviewerUserId) || null}
              />
            ) : (
              "Unassigned"
            )}
          </div>
        ))}
    </div>
  );
}
