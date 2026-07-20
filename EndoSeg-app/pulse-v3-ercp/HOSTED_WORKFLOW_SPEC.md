# Hosted Workflow Specification

Workflow freeze for the hosted multi-reviewer review platform.

## Workflow Summary

Hosted MVP review flow is linear and admin-controlled:

1. Admin uploads or registers a case package.
2. Case completes intake and becomes ready for assignment.
3. Admin defines the ordered review chain for the case.
4. Reviewer 1 completes the first hosted review.
5. System automatically progresses the case to Reviewer 2 within the admin-defined chain.
6. Reviewer 2 completes the second hosted review.
7. Case returns to Admin for final acceptance.
8. Admin finalizes the case as hosted ground-truth.

MVP does not include branching workflow logic. The chain is linear at minimum:

`Reviewer 1 -> Reviewer 2 -> Admin finalization`

Adjudication remains deferred and is not part of the default MVP workflow.

## Roles

Hosted roles:

- `admin`
- `reviewer`
- `adjudicator`
- `auditor`

## Role Permissions

### Admin

Can:

- upload case packages
- view all cases, assignments, and workflow chains
- define or edit the ordered reviewer chain for a case
- trigger automatic assignment using admin-selected rules
- manually assign or reassign reviewers
- adjust case priority
- return a case for rework
- finalize a case as ground-truth
- view report/reference content
- view audit and workflow history

Cannot:

- bypass audit logging

### Reviewer

Can:

- view only assigned cases
- use a hosted To-Do queue for assigned work
- open the case detail page for their assignment
- view the read-only report/reference before opening the annotator
- open the hosted review session for their assigned stage
- submit their assigned stage
- view their own prior submission artifacts for the same stage if policy allows

Cannot:

- access unassigned cases
- see Reviewer 1 output while Reviewer 2 is still in active blinded review
- reassign workflow steps
- finalize ground-truth

### Adjudicator

Can:

- access only adjudication-stage cases assigned to them
- view prior reviewer outputs when adjudication policy allows
- submit adjudication output

Cannot:

- alter historical reviewer submissions

### Auditor

Can:

- view workflow metadata and audit history under policy
- inspect state transitions and access events

Cannot:

- annotate
- submit stages
- reassign cases
- finalize ground-truth

## Report / Reference Access Requirement

Before a reviewer opens the hosted annotator, the hosted case detail or review entry flow must expose a read-only report/reference view.

Hosted MVP requirement:

- provide a clear `View report` or `Open reference` action on the hosted case detail page
- open the report/reference in a side panel or modal
- keep the content read-only
- keep this feature in the hosted shell, not inside the standalone local annotator

The hosted review session may also provide the same read-only reference access, but pre-annotation access is the minimum requirement.

## Admin-Controlled Chain Assignment Requirement

Assignment remains admin-controlled.

Hosted MVP rules:

- every case must have an explicit ordered workflow chain
- Admin may define the chain manually per case
- Admin may trigger automatic reviewer selection, but only as an admin action
- the system must not autonomously assign cases without an Admin-controlled trigger
- MVP chain is linear only
- MVP minimum supported chain is `review_1 -> review_2 -> admin_finalization`

Real user assignment rule:

- `review_1` and `review_2` are workflow-stage positions
- each stage position references an assigned user record
- Admin assigns actual users by name/email/role to those positions
- stage labels must not be treated as person names
- after Reviewer 1 has started, Admin may reassign only the currently active stage

## Reviewer To-Do Queue Requirement

Hosted MVP must include a reviewer To-Do queue.

Minimum queue behavior:

- show currently assigned work
- show assignment stage
- show case priority
- show case status
- show due date if available
- link directly to case detail

Later extension:

- add completed/history view
- add richer filtering and bulk review operations

## Admin Workflow Dashboard Requirement

Hosted MVP Admin workflow UI must support:

- search
- filter by status, reviewer, and priority
- open case detail
- reassign an active reviewer stage
- inspect the ordered workflow chain for a case
- inspect current chain position
- inspect case priority

Deferred from MVP:

- branching workflow visualization
- bulk reassignment
- queue balancing automation without Admin confirmation

## Case-Level States

Recommended hosted case state set:

- `intake_pending`
- `ingestion_failed`
- `ready_for_assignment`
- `assigned_to_r1`
- `in_review_r1`
- `assigned_to_r2`
- `in_review_r2`
- `awaiting_admin_finalization`
- `ground_truth_finalized`
- `returned_for_rework`
- `archived`

## Assignment-Level States

Recommended hosted assignment state set:

- `unassigned`
- `assigned`
- `opened`
- `in_progress`
- `submitted`
- `returned`
- `cancelled`

## Allowed Transitions

### Case-Level Transitions

```text
intake_pending -> ready_for_assignment
intake_pending -> ingestion_failed

ready_for_assignment -> assigned_to_r1

assigned_to_r1 -> in_review_r1
in_review_r1 -> assigned_to_r2
in_review_r1 -> returned_for_rework

assigned_to_r2 -> in_review_r2
in_review_r2 -> awaiting_admin_finalization
in_review_r2 -> returned_for_rework

returned_for_rework -> assigned_to_r1
returned_for_rework -> assigned_to_r2

awaiting_admin_finalization -> ground_truth_finalized
awaiting_admin_finalization -> returned_for_rework

ground_truth_finalized -> archived
```

Admin-only exceptions:

- `ingestion_failed` -> `intake_pending` after corrected intake
- reassignment while a case is in `assigned_to_r1` or `assigned_to_r2`
- reopen from `awaiting_admin_finalization` or `ground_truth_finalized` only under controlled policy

### Assignment-Level Transitions

```text
unassigned -> assigned
assigned -> opened
opened -> in_progress
in_progress -> submitted

assigned -> returned
opened -> returned
in_progress -> returned

assigned -> cancelled
opened -> cancelled
in_progress -> cancelled
```

Rules:

- once `submitted`, the reviewer assignment becomes immutable
- only one active reviewer assignment may exist at a time for the current case stage
- reassignment cancels or closes the current active assignment and creates the replacement assignment record
- `returned` is used when Admin explicitly sends work back for rework

## Sequential Routing Logic

### Intake -> Reviewer 1

1. Admin uploads or registers the case package.
2. Intake completes and the case enters `ready_for_assignment`.
3. Admin defines the workflow chain and confirms Reviewer 1.
4. System creates the Reviewer 1 assignment and the case enters `assigned_to_r1`.

### Reviewer 1 -> Reviewer 2

1. Reviewer 1 opens the hosted review: assignment becomes `opened` or `in_progress`, case becomes `in_review_r1`.
2. Reviewer 1 submits: assignment becomes `submitted`.
3. System progresses the case automatically to the next step in the Admin-defined chain.
4. Reviewer 2 assignment is created and the case enters `assigned_to_r2`.

### Reviewer 2 -> Admin Finalization

1. Reviewer 2 opens the hosted review: assignment becomes `opened` or `in_progress`, case becomes `in_review_r2`.
2. Reviewer 2 submits: assignment becomes `submitted`.
3. Case enters `awaiting_admin_finalization`.
4. Admin reviews the case package, workflow context, and allowed reviewer outputs, then either:
   - finalizes the case as `ground_truth_finalized`
   - returns the case for rework

### Returned For Rework

Admin may return a case for rework from:

- `in_review_r1`
- `in_review_r2`
- `awaiting_admin_finalization`

Hosted MVP return behavior:

- Admin selects the target stage to redo
- system creates or reactivates the relevant reviewer assignment path
- case re-enters `assigned_to_r1` or `assigned_to_r2`
- the return action is captured as both a workflow event and an audit event

## Admin Finalization Requirement

Hosted MVP requires an explicit Admin-controlled finalization step.

Finalization means:

- the review chain has completed through Reviewer 2
- the case is accepted as the hosted system's ground-truth result
- the final state is `ground_truth_finalized`

Ground-truth finalization is a case-level action, not a reviewer action.

## Reviewer Visibility Policy

Hosted MVP default policy:

- Reviewer 1 sees only source frames, report/reference content, and their own work
- Reviewer 2 remains blinded to Reviewer 1 output during active review
- Admin may review chain history and permitted submissions
- Adjudicator visibility remains deferred until adjudication is implemented

## In-App Comments / Threading Policy

Hosted communication should be in-app and persisted on the platform.

Primary rule:

- do not use a single shared case thread visible to both reviewers

MVP-safe thread types:

- assignment-level reviewer/Admin clarification thread
- Admin-only case note thread

MVP communication rules:

- Reviewer 1 may communicate with Admin in a thread scoped to Reviewer 1's assignment
- Reviewer 2 may communicate with Admin in a thread scoped to Reviewer 2's assignment
- Reviewer 2 must not see Reviewer 1 comments during active review
- Admin-only notes are never visible to reviewers

Email remains deferred and must be notification-only if added later.

## Audit Events To Capture

Minimum hosted audit/workflow events:

- user login
- user logout
- case uploaded
- intake started
- intake succeeded
- intake failed
- report/reference viewed
- workflow chain defined
- assignment created
- assignment opened
- assignment entered `in_progress`
- stage submitted
- case auto-progressed to next chain step
- assignment reassigned
- comment thread created
- comment posted
- comment edited
- comment resolved or closed
- comment visibility changed
- denied access to hidden comment/thread
- case returned for rework
- Admin finalization opened
- case finalized as ground-truth
- case archived
- artifact downloaded
- permission-denied access attempt

## Notes On Hosted vs Local Logging

Hosted workflow uses server-side workflow and audit events as the authoritative record.

The current local annotator `localStorage` log:

- remains local-only
- is not required for hosted routing
- is not sufficient for hosted audit/compliance needs

Hosted comments and workflow-user assignment history must be persisted server-side and audited independently of browser-local logs.
