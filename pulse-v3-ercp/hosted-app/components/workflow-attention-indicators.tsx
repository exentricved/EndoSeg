import type {
  AssignmentStatus,
  CaseStatus,
  HostedDiscussionActivitySummary,
} from "@/lib/domain/models";

type WorkflowAttentionIndicatorsProps = {
  caseStatus: CaseStatus;
  discussionActivity: HostedDiscussionActivitySummary;
  assignmentStatus?: AssignmentStatus | null;
  compact?: boolean;
};

export function WorkflowAttentionIndicators({
  caseStatus,
  discussionActivity,
  assignmentStatus = null,
  compact = false,
}: WorkflowAttentionIndicatorsProps) {
  const items: Array<{ label: string; tone: "pending" | "danger" | "ready" | "archived" }> = [];

  if (discussionActivity.activeCount > 0) {
    items.push({
      label: compact ? `${discussionActivity.activeCount} discussion` : `${discussionActivity.activeCount} unresolved discussion`,
      tone: "pending",
    });
  }

  if (caseStatus === "returned_for_rework") {
    items.push({ label: "Returned for rework", tone: "danger" });
  }

  if (caseStatus === "needs_adjudication") {
    items.push({ label: "Adjudication needed", tone: "danger" });
  }

  if (assignmentStatus === "assigned" || caseStatus === "ready_for_assignment") {
    items.push({ label: "Pending review", tone: "ready" });
  }

  if (!items.length) return null;

  return (
    <div className={`workflow-attention-indicators${compact ? " compact" : ""}`}>
      {items.map((item) => (
        <span className={`chip ${item.tone}`} key={item.label}>
          {item.label}
        </span>
      ))}
    </div>
  );
}
