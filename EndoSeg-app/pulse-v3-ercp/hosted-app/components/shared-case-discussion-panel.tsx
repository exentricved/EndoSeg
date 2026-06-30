import Link from "next/link";

import {
  editSharedCaseCommentAction,
  postSharedCaseCommentAction,
  setSharedCaseCommentResolutionAction,
  setSharedCaseThreadResolutionAction,
} from "@/app/(protected)/cases/comment-actions";
import { DiscussionActivityBadge } from "@/components/discussion-activity-badge";
import type {
  HostedComment,
  HostedCommentThread,
  HostedDiscussionActivitySummary,
  HostedRole,
  ReviewStage,
} from "@/lib/domain/models";

type SharedTimelineEntry = {
  comment: HostedComment;
  source: "shared_case_discussion" | "legacy_assignment_thread";
  sourceLabel: string;
  reviewStage: ReviewStage | null;
};

type SharedCaseDiscussionPanelProps = {
  caseId: string;
  thread: HostedCommentThread | null;
  activeComments: HostedComment[];
  resolvedComments: HostedComment[];
  legacyTimeline: SharedTimelineEntry[];
  activity: HostedDiscussionActivitySummary;
  returnTo: string;
  viewerUserId: string;
  viewerRole: HostedRole;
  editingCommentId?: string | null;
};

function updateHref(
  href: string,
  updates: Record<string, string | null | undefined>,
) {
  const [pathWithQuery, hash = "communication"] = href.split("#");
  const [path, queryString = ""] = pathWithQuery.split("?");
  const params = new URLSearchParams(queryString);

  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }

  const nextQuery = params.toString();
  return `${path}${nextQuery ? `?${nextQuery}` : ""}#${hash}`;
}

function mayResolveComment(comment: HostedComment, viewerUserId: string, viewerRole: HostedRole) {
  return viewerRole === "admin" || comment.authorUserId === viewerUserId;
}

function renderCommentMeta(comment: HostedComment) {
  return (
    <div className="row thread-meta" style={{ justifyContent: "space-between" }}>
      <div className="muted">{comment.authorEmail}</div>
      <div className="muted">
        {comment.updatedAt ? `Edited ${comment.updatedAt}` : `Posted ${comment.createdAt}`}
      </div>
    </div>
  );
}

export function SharedCaseDiscussionPanel({
  caseId,
  thread,
  activeComments,
  resolvedComments,
  legacyTimeline,
  activity,
  returnTo,
  viewerUserId,
  viewerRole,
  editingCommentId = null,
}: SharedCaseDiscussionPanelProps) {
  const cancelEditHref = updateHref(returnTo, { editing: null });

  return (
    <section className="card thread-panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>Shared case discussion</h3>
            <DiscussionActivityBadge activity={activity} />
          </div>
          <div className="muted">
            Visible to Admin and assigned reviewers for this case. Active items stay in focus;
            resolved discussion remains accessible below.
          </div>
        </div>
        <div className="row">
          <div className="chip active">Shared</div>
          {thread && viewerRole === "admin" ? (
            <form action={setSharedCaseThreadResolutionAction}>
              <input name="caseId" type="hidden" value={caseId} />
              <input name="intent" type="hidden" value={thread.status === "resolved" ? "reopen" : "resolve"} />
              <input name="returnTo" type="hidden" value={returnTo} />
              <button className="button ghost" type="submit">
                {thread.status === "resolved" ? "Reopen discussion" : "Resolve discussion"}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {activity.activeCount ? (
        <div className="notice">
          {activity.activeCount} active discussion {activity.activeCount === 1 ? "item" : "items"} need
          attention.
        </div>
      ) : activity.resolvedCount ? (
        <div className="notice">
          Active discussion is resolved. Reopen the discussion or an individual comment to continue.
        </div>
      ) : null}

      {activeComments.length ? (
        <div className="stack thread-list">
          {activeComments.map((comment) => {
            const isEditing = editingCommentId === comment.id && comment.authorUserId === viewerUserId;
            const mayEdit = comment.authorUserId === viewerUserId;
            const mayResolve = mayResolveComment(comment, viewerUserId, viewerRole);

            return (
              <article className="thread-entry" key={comment.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{comment.authorDisplayName}</strong>
                  <div className="chip ready">Active</div>
                </div>
                {renderCommentMeta(comment)}

                {isEditing ? (
                  <form action={editSharedCaseCommentAction} className="form-grid" style={{ marginTop: 12 }}>
                    <input name="caseId" type="hidden" value={caseId} />
                    <input name="commentId" type="hidden" value={comment.id} />
                    <input name="returnTo" type="hidden" value={returnTo} />
                    <div className="field">
                      <label htmlFor={`edit-comment-${comment.id}`}>Edit comment</label>
                      <textarea
                        defaultValue={comment.body}
                        id={`edit-comment-${comment.id}`}
                        name="body"
                        rows={4}
                      />
                    </div>
                    <div className="row">
                      <button className="button primary" type="submit">
                        Save edit
                      </button>
                      <Link className="button ghost" href={cancelEditHref}>
                        Cancel
                      </Link>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="thread-body">{comment.body}</div>
                    <div className="row" style={{ marginTop: 12 }}>
                      {mayEdit ? (
                        <Link
                          className="button ghost"
                          href={updateHref(returnTo, { editing: comment.id })}
                        >
                          Edit
                        </Link>
                      ) : null}
                      {mayResolve ? (
                        <form action={setSharedCaseCommentResolutionAction}>
                          <input name="caseId" type="hidden" value={caseId} />
                          <input name="commentId" type="hidden" value={comment.id} />
                          <input name="intent" type="hidden" value="resolve" />
                          <input name="returnTo" type="hidden" value={returnTo} />
                          <button className="button ghost" type="submit">
                            Resolve
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          {thread
            ? "No active discussion comments are open right now."
            : "No shared discussion exists yet for this case."}
        </div>
      )}

      {thread?.status === "resolved" ? null : (
        <form action={postSharedCaseCommentAction} className="form-grid">
          <input name="caseId" type="hidden" value={caseId} />
          <input name="returnTo" type="hidden" value={returnTo} />
          <div className="field">
            <label htmlFor={`shared-discussion-${caseId}`}>
              {thread ? "Add comment" : "Start shared discussion"}
            </label>
            <textarea
              id={`shared-discussion-${caseId}`}
              name="body"
              placeholder="Add a case-level discussion comment for Admin and assigned reviewers."
              rows={4}
            />
          </div>
          <div className="row">
            <button className="button primary" type="submit">
              Post shared comment
            </button>
          </div>
        </form>
      )}

      {resolvedComments.length ? (
        <details className="thread-collapsed-section">
          <summary>
            Resolved discussion ({resolvedComments.length})
          </summary>
          <div className="stack thread-list compact">
            {resolvedComments.map((comment) => {
              const mayResolve = mayResolveComment(comment, viewerUserId, viewerRole);
              return (
                <article className="thread-entry resolved" key={comment.id}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{comment.authorDisplayName}</strong>
                    <div className="chip archived">Resolved</div>
                  </div>
                  {renderCommentMeta(comment)}
                  <div className="thread-body">{comment.body}</div>
                  {comment.resolvedAt ? (
                    <div className="muted" style={{ marginTop: 10 }}>
                      Resolved {comment.resolvedAt}
                    </div>
                  ) : null}
                  {mayResolve ? (
                    <form action={setSharedCaseCommentResolutionAction} style={{ marginTop: 12 }}>
                      <input name="caseId" type="hidden" value={caseId} />
                      <input name="commentId" type="hidden" value={comment.id} />
                      <input name="intent" type="hidden" value="reopen" />
                      <input name="returnTo" type="hidden" value={returnTo} />
                      <button className="button ghost" type="submit">
                        Reopen
                      </button>
                    </form>
                  ) : null}
                </article>
              );
            })}
          </div>
        </details>
      ) : null}

      {legacyTimeline.length ? (
        <details className="thread-collapsed-section">
          <summary>
            Legacy thread history ({legacyTimeline.length})
          </summary>
          <div className="stack thread-list compact">
            {legacyTimeline.map((entry) => (
              <article className="thread-entry resolved legacy" key={entry.comment.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{entry.comment.authorDisplayName}</strong>
                  <div className="chip archived">{entry.sourceLabel}</div>
                </div>
                {renderCommentMeta(entry.comment)}
                <div className="thread-body">{entry.comment.body}</div>
              </article>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
