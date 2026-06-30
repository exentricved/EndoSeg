import { postAdminCaseNoteAction } from "@/app/(protected)/cases/comment-actions";
import type { HostedComment, HostedCommentThread } from "@/lib/domain/models";

type AdminNotesPanelProps = {
  caseId: string;
  thread: HostedCommentThread | null;
  comments: HostedComment[];
  returnTo: string;
};

export function AdminNotesPanel({
  caseId,
  thread,
  comments,
  returnTo,
}: AdminNotesPanelProps) {
  return (
    <section className="card thread-panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Admin-only notes</h3>
          <div className="muted">Private workflow and operational notes for Admin only.</div>
        </div>
        <div className="chip archived">Admin only</div>
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
          {thread ? "No notes in this Admin-only thread yet." : "No Admin-only notes yet."}
        </div>
      )}

      <form action={postAdminCaseNoteAction} className="form-grid">
        <input name="caseId" type="hidden" value={caseId} />
        <input name="returnTo" type="hidden" value={returnTo} />
        <div className="field">
          <label htmlFor={`admin-note-${caseId}`}>Add Admin note</label>
          <textarea
            id={`admin-note-${caseId}`}
            name="body"
            placeholder="Add a private Admin note for this case."
            rows={4}
          />
        </div>
        <div className="row">
          <button className="button primary" type="submit">
            Save note
          </button>
        </div>
      </form>
    </section>
  );
}
