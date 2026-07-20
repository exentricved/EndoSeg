import type { StageStatus } from "../core/stages.js";

// Small shared presentational helpers used across views.

export function StageBadge({ status }: { status: StageStatus }) {
  return <span className={`badge status-${status}`}>{status.replace("_", " ")}</span>;
}

export function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
