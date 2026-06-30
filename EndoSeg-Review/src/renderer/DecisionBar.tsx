import React, { useState } from "react";
import type { FrameDecision } from "../shared/ipc";

interface Props {
  frameId: string;
  decision: FrameDecision | undefined;
  onDecision(frameId: string, status: "approved" | "rejected", comment?: string): void;
}

export default function DecisionBar({ frameId, decision, onDecision }: Props): React.ReactElement {
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState(decision?.comment ?? "");

  const status = decision?.status ?? "pending";

  function approve() {
    onDecision(frameId, "approved", comment || undefined);
  }

  function reject() {
    if (!commentOpen) { setCommentOpen(true); return; }
    onDecision(frameId, "rejected", comment || undefined);
    setCommentOpen(false);
  }

  function submitComment(e: React.FormEvent) {
    e.preventDefault();
    onDecision(frameId, "rejected", comment || undefined);
    setCommentOpen(false);
  }

  return (
    <div className="decision-bar">
      <div className="decision-status">
        <span className={`decision-badge decision-badge--${status}`}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
      </div>

      <div className="decision-actions">
        <button
          className={`btn-decision btn-approve${status === "approved" ? " active" : ""}`}
          onClick={approve}
          title="Approve this frame"
        >
          ✓ Approve
        </button>
        <button
          className={`btn-decision btn-reject${status === "rejected" ? " active" : ""}`}
          onClick={reject}
          title="Reject this frame"
        >
          ✗ Reject
        </button>
      </div>

      {commentOpen && (
        <form className="comment-form" onSubmit={submitComment}>
          <input
            className="comment-input"
            type="text"
            placeholder="Reason for rejection (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            autoFocus
          />
          <button className="btn-decision btn-reject" type="submit">Confirm Reject</button>
          <button
            className="btn-decision"
            type="button"
            onClick={() => setCommentOpen(false)}
          >
            Cancel
          </button>
        </form>
      )}

      {decision?.comment && !commentOpen && (
        <p className="decision-comment">"{decision.comment}"</p>
      )}
    </div>
  );
}
