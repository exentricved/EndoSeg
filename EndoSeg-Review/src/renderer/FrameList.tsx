import React from "react";
import type { SegFrame, FrameDecision } from "../shared/ipc";

interface Props {
  frames: SegFrame[];
  currentIndex: number;
  decisions: Record<string, FrameDecision>;
  onSelect(index: number): void;
}

const STATUS_ICONS: Record<string, string> = {
  approved: "✓",
  rejected: "✗",
  edited: "✎",
  pending: "·",
};

const STATUS_CLASS: Record<string, string> = {
  approved: "badge--approved",
  rejected: "badge--rejected",
  edited: "badge--edited",
  pending: "badge--pending",
};

export default function FrameList({ frames, currentIndex, decisions, onSelect }: Props): React.ReactElement {
  return (
    <div className="frame-list">
      <div className="frame-list__header">
        Frames <span className="frame-list__count">{frames.length}</span>
      </div>
      <div className="frame-list__scroll">
        {frames.map((f, i) => {
          const dec = decisions[f.frameId];
          const status = dec?.status ?? "pending";
          const active = i === currentIndex;
          return (
            <button
              key={f.frameId}
              className={`frame-thumb${active ? " frame-thumb--active" : ""}`}
              onClick={() => onSelect(i)}
            >
              <img
                className="frame-thumb__img"
                src={f.url}
                alt={f.name}
                draggable={false}
              />
              <div className="frame-thumb__overlay">
                <span className={`badge ${STATUS_CLASS[status] ?? ""}`}>
                  {STATUS_ICONS[status] ?? "·"}
                </span>
                <span className="frame-thumb__name">{f.name}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
