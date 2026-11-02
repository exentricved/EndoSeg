// Whether a case may be changed from this computer. Pure Node, unit tested.
//
// - An Annotated 1 case is read-only while it has a copy in Annotated 2.
// - Any case is read-only while someone else has it open (live .open.lock).
// - If the NAS can't be read, the case is read-only (never assume it's free).

import type { CaseAccess } from "../shared/ipc.js";
import type { WorkspaceId } from "../core/workspaces.js";
import { makeRef } from "../core/workspaces.js";
import { foreignLock, holderLabel } from "./caselock.js";
import { isInReview } from "./review.js";

export const IN_REVIEW_REASON =
  "This case is in second review. Its Annotated 1 copy is kept unchanged as the record of the first pass; edit the Annotated 2 copy instead.";

export interface AccessQuery {
  ws: WorkspaceId;
  id: string;
  caseDir: string;
  a2Dir: string;
  sessionId: string;
  nowMs: number;
}

/** Only the review check (no lock), for cases that are read-only regardless of who has them open. */
export async function reviewAccess(q: Pick<AccessQuery, "ws" | "id" | "a2Dir" | "nowMs">): Promise<CaseAccess | null> {
  if (q.ws !== "a1" || !(await isInReview(q.a2Dir, q.id, q.nowMs))) return null;
  return { readOnly: true, reason: IN_REVIEW_REASON, reviewRef: makeRef("a2", q.id) };
}

export async function caseAccess(q: AccessQuery): Promise<CaseAccess> {
  try {
    const r = await reviewAccess(q);
    if (r) return r;
    const l = await foreignLock(q.caseDir, q.sessionId, q.nowMs);
    if (l) {
      return {
        readOnly: true,
        reason: `${holderLabel(l)} has this case open, so you can't change it here.`,
        lockedBy: holderLabel(l),
        lockedSince: l.openedAt,
      };
    }
    return { readOnly: false };
  } catch (err) {
    return { readOnly: true, reason: `The case can't be read on the NAS right now (${(err as Error).message}). Check the network drive and try again.` };
  }
}
