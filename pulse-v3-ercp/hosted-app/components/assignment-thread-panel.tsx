import { postAssignmentCommentAction } from "@/app/(protected)/cases/comment-actions";
import type {
  HostedAssignment,
  HostedComment,
  HostedCommentThread,
} from "@/lib/domain/models";

type AssignmentThreadPanelProps = {
  assignment: HostedAssignment;
  thread: HostedCommentThread | null;
  comments: HostedComment[];
  returnTo: string;
  currentRole: "admin" | "reviewer";
};

export function AssignmentThreadPanel({
  assignment,
  thread,
  comments,
  returnTo,
  currentRole,
}: AssignmentThreadPanelProps) {
  return (
    <section className="card thread-panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Assignment thread</h3>
          <div className="muted">
            {assignment.reviewStage} | {assignment.status}
          </div>
        </div>
        <div className="chip pending">
          {currentRole === "admin" ? "Admin + assignee" : "Visible to Admin only"}
        </div>
      </div>

      {comments.length ? (
        <div className="stack thread-list">
          {comments.map((comment) => (
            <article className="thread-entry" key={comment.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{comment.authorDisplayName}</strong>
                <span className="muted">{comment.createdAt}</span>
              </div>
              <div className="muted">{comment.authorEmail}</div>
              <div className="thread-body">{comment.body}</div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          No in-app clarification comments yet. This thread remains visible only to Admin and the
          assignment assignee.
        </div>
      )}

      <form action={postAssignmentCommentAction} className="form-grid">
        <input name="caseId" type="hidden" value={assignment.caseId} />
        <input name="assignmentId" type="hidden" value={assignment.id} />
        <input name="returnTo" type="hidden" value={returnTo} />
        <div className="field">
          <label htmlFor={`comment-${assignment.id}`}>
            {thread ? "Add reply" : "Start clarification thread"}
          </label>
          <textarea
            id={`comment-${assignment.id}`}
            name="body"
            placeholder="Add an in-app clarification for this assignment."
            rows={4}
          />
        </div>
        <div className="row">
          <button className="button primary" type="submit">
            Post comment
          </button>
        </div>
      </form>
    </section>
  );
}
