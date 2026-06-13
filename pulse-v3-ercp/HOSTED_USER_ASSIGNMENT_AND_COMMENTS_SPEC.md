# Hosted User Assignment And Comments Specification

Design freeze for real hosted user assignment, in-app comments/threading, and deferred notification-only email support.

## Executive Recommendation

The hosted workflow should treat `review_1` and `review_2` as workflow-stage positions, while actual people are attached through user records and assignment records.

Communication should be in-app and persisted in the hosted platform. Email, if added later, should be notification-only and must never become the system of record.

To preserve blinded review safely:

- use assignment-scoped threads for reviewer/Admin communication
- keep Admin as the only role with cross-stage visibility
- do not use a single shared case thread visible to both reviewers
- do not expose Reviewer 1 comments to Reviewer 2 during active review

## Proposed User / Assignment Model

### Core Principle

Workflow stages remain:

- `review_1`
- `review_2`
- `admin_finalization`

People are assigned to those stages through user-linked workflow records.

### Recommended User Directory Model

`users`

- `id`
- `auth_subject` nullable until real OIDC is wired
- `email`
- `display_name`
- `status` (`active`, `disabled`, later `invited`)
- `primary_role`
- `created_at`
- `last_login_at`

`roles`

- `admin`
- `reviewer`
- `adjudicator`
- `auditor`

`user_roles`

- supports future multi-role users without hard-coding one role forever

### Recommended Workflow Assignment Model

`workflow_chain_steps`

- `id`
- `case_id`
- `position`
- `review_stage` (`review_1`, `review_2`)
- `assigned_user_id`
- `assignment_mode` (`manual`, `auto_admin_triggered`)
- `status` (`planned`, `active`, `completed`, `cancelled`)
- `created_at`
- `updated_at`

`review_assignments`

- one operational assignment record per stage activation
- references `assigned_to_user_id`
- remains the source of queue visibility and submission ownership

Rules:

- `workflow_chain_steps` defines who is intended for each stage position
- `review_assignments` defines the actual active or historical work record
- after Reviewer 1 has started, Admin may reassign only the currently active stage
- historical chain positions and historical assignments must remain immutable for audit purposes

## Proposed Comment / Thread Model

## Recommended Default

Use narrow, scoped threads rather than a single case-wide conversation.

### Thread Types

`comment_threads`

- `id`
- `case_id`
- `assignment_id` nullable
- `thread_type`
- `visibility_scope`
- `created_by_user_id`
- `created_at`
- `closed_at` nullable

Recommended `thread_type` values:

- `assignment_clarification`
- `admin_internal_note`
- `case_operations_note`

### Comment Records

`comments`

- `id`
- `thread_id`
- `case_id`
- `assignment_id` nullable
- `author_user_id`
- `body`
- `visibility_scope`
- `created_at`
- `edited_at` nullable
- `resolved_at` nullable
- `resolved_by_user_id` nullable

### Safest MVP Thread Shapes

1. Assignment-level reviewer/Admin thread
   - used for clarifications tied to one active review stage
   - visible only to the assigned reviewer and Admin
2. Admin-only case notes
   - used for intake/workflow/operational notes
   - never visible to reviewers

Avoid in MVP:

- reviewer-shared case threads
- Reviewer 1 to Reviewer 2 direct communication
- public comments visible across both review stages

## Recommended Comment Types

For MVP:

- assignment-level: yes
- admin-only case-level: yes
- reviewer-private-to-admin: yes
- shared reviewer-to-reviewer: no

This yields the safest starting model:

- reviewers can ask Admin for clarification
- Admin can document operational notes
- blinding remains intact

## Visibility Rules

### Reviewer 1

Can see:

- their own assignment thread
- their own comments
- Admin replies in that thread
- read-only report/reference content

Cannot see:

- Reviewer 2 thread
- Reviewer 2 comments
- Admin-only notes

### Reviewer 2

Can see:

- their own assignment thread
- their own comments
- Admin replies in that thread
- read-only report/reference content

Cannot see during active review:

- Reviewer 1 thread
- Reviewer 1 comments
- Reviewer 1 submission notes or clarifications
- Admin-only notes

### Admin

Can see:

- all workflow chain assignments
- all assignment-level threads
- all Admin-only notes
- all comments

### Adjudicator

Deferred until adjudication exists:

- visibility policy should be explicitly defined later
- should not inherit reviewer-thread access by accident

## Audit / Event Requirements

Audit the following at minimum:

- user assigned to workflow stage
- active assignment reassigned
- comment thread created
- comment posted
- comment edited
- comment resolved or closed
- comment visibility scope changed
- Admin-only note created
- denied attempt to access hidden thread/comment

Useful payload fields:

- `case_id`
- `assignment_id`
- `thread_id`
- `comment_id`
- `actor_user_id`
- `visibility_scope`
- `review_stage`

## MVP UI Scope

### Admin UI

- case detail shows actual assigned user names/emails for `review_1` and `review_2`
- chain assignment UI uses real users from the hosted user directory
- current active assignee is visible by name
- assignment thread panel visible per stage
- Admin-only notes panel on case detail

### Reviewer UI

- queue shows assigned work tied to the signed-in user
- case detail shows only that reviewer’s assignment thread
- reviewer can post clarification comments to Admin
- no visibility into the other reviewer’s thread or notes

### Thread UX Recommendation

MVP should include:

- simple chronological thread
- reply/add comment
- resolved/open state
- unread or pending-response badge later if needed

MVP does not need:

- real-time chat
- mentions
- attachments inside comments
- cross-thread linking

## Deferred Email Notification Scope

Email is deferred and should be notification-only.

Recommended later email events:

- new assignment created for a user
- assignment reassigned
- new Admin reply on your assignment thread
- case returned for rework
- case finalized

Email must not be:

- the authoritative record of communication
- the place where comments live
- the mechanism that performs workflow transitions

Recommended pattern:

- email contains minimal summary plus a link back to the hosted case or assignment
- full discussion remains in-app

## Phased Implementation Plan

### Phase A: Real User Assignment Foundation

- normalize hosted user directory
- ensure workflow chain steps reference actual users cleanly
- show names/emails in chain assignment and workflow dashboard UI

### Phase B: Assignment-Scoped In-App Comments

- add `comment_threads` and `comments`
- implement reviewer-to-Admin assignment threads
- enforce visibility rules in backend and UI

### Phase C: Admin-Only Notes

- add Admin-only case notes
- keep these separate from reviewer-visible threads

### Phase D: UX Hardening

- unresolved comment indicators
- comment counts on queue and case detail
- lock or archive thread behavior after submission/finalization where appropriate

### Phase E: Notification Layer

- add notification-only email support
- keep email secondary to in-app workflow and comments

## Design Guardrails

- do not collapse reviewer communication into one shared case thread
- do not let Reviewer 2 see Reviewer 1 comments during active review
- do not move comment logic into the standalone local annotator
- keep hosted communication and audit state on the server side
