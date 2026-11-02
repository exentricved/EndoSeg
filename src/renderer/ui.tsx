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

/** The message of an error from the main process, without Electron's "Error invoking remote method …" wrapper. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}
