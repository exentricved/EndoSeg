import { STAGE_LABELS, type StageId, type StageStatus } from "../core/stages.js";

// Visual pipeline indicator: one segment per stage, coloured by status.
export function StageBar({
  statuses,
}: {
  statuses: { stage: StageId; status: StageStatus }[];
}) {
  return (
    <div className="stagebar" role="img" aria-label="pipeline progress">
      {statuses.map(({ stage, status }, i) => (
        <div key={stage} className="stagebar-seg" title={`${STAGE_LABELS[stage]}: ${status}`}>
          <span className={`dot status-${status}`} />
          <span className="stagebar-label">{STAGE_LABELS[stage]}</span>
          {i < statuses.length - 1 && <span className="stagebar-arrow">›</span>}
        </div>
      ))}
    </div>
  );
}
