import type { HostedDiscussionActivitySummary } from "@/lib/domain/models";

type DiscussionActivityBadgeProps = {
  activity: HostedDiscussionActivitySummary;
  compact?: boolean;
};

export function DiscussionActivityBadge({
  activity,
  compact = false,
}: DiscussionActivityBadgeProps) {
  const label =
    activity.activeCount > 0
      ? `${activity.activeCount} active discussion ${activity.activeCount === 1 ? "item" : "items"}`
      : activity.threadStatus === "resolved"
        ? "Discussion resolved"
        : activity.legacyCount > 0
          ? "Discussion history available"
          : "";

  if (activity.activeCount > 0) {
    return (
      <span
        aria-label={label}
        className={`discussion-badge discussion-badge-active${compact ? " compact" : ""}`}
        title={label}
      >
        {compact ? activity.activeCount : `${activity.activeCount} active`}
      </span>
    );
  }

  if (activity.threadStatus === "resolved") {
    return (
      <span
        aria-label={label}
        className={`discussion-badge discussion-badge-resolved${compact ? " compact" : ""}`}
        title={label}
      >
        {compact ? "R" : "Resolved"}
      </span>
    );
  }

  if (activity.legacyCount > 0) {
    return (
      <span
        aria-label={label}
        className={`discussion-badge discussion-badge-history${compact ? " compact" : ""}`}
        title={label}
      >
        {compact ? "H" : "History"}
      </span>
    );
  }

  return null;
}
