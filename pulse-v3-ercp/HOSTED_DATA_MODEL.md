# Hosted Data Model

Data-model freeze for the future hosted multi-reviewer workflow.

## Storage Split

### PostgreSQL Stores

PostgreSQL is the durable system-of-record for:

- users and roles
- cases and frame metadata
- case workflow-chain steps with assigned user references
- assignments and workflow state
- submissions and submission metadata
- in-app comment threads and comments
- workflow events
- audit events

### Object Storage Stores

Object storage stores large artifacts:

- original uploaded case packages
- extracted frame image files
- submitted `.leus` review snapshots
- later derived exports/reports

Rule:

- store metadata and references in PostgreSQL
- store large payloads in object storage

## Core Entities

## `users`

Purpose:

- authenticated platform users

Key fields:

- `id` UUID PK
- `auth_subject` text unique
- `email` text unique
- `display_name` text
- `status` enum (`active`, `disabled`)
- `created_at` timestamptz
- `last_login_at` timestamptz nullable

## `roles`

Purpose:

- named platform roles

Key fields:

- `id` UUID PK
- `name` text unique

Recommended role values:

- `admin`
- `reviewer`
- `adjudicator`
- `auditor`

## `user_roles`

Purpose:

- many-to-many mapping between users and roles

Key fields:

- `user_id` FK -> `users.id`
- `role_id` FK -> `roles.id`
- `granted_at` timestamptz

## `workflow_chain_steps`

Purpose:

- ordered hosted workflow definition per case
- binds a workflow stage position to an assigned user record

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `position` integer
- `review_stage` enum (`review_1`, `review_2`)
- `assigned_user_id` FK -> `users.id`
- `assignment_mode` enum (`manual`, `auto_admin_triggered`)
- `status` enum (`planned`, `active`, `completed`, `cancelled`)
- `created_at` timestamptz
- `updated_at` timestamptz

Rules:

- `review_1` and `review_2` remain workflow-stage positions, not person names
- `assigned_user_id` points to the actual human assigned to that stage
- after Reviewer 1 has started, Admin may reassign only the currently active stage
- historical stage/user relationships must remain auditable

## `cases`

Purpose:

- top-level patient/study/case review unit

Key fields:

- `id` UUID PK
- `external_case_id` text unique nullable
- `display_case_id` text unique
- `status` enum
- `current_stage` enum
- `priority` enum nullable
- `uploaded_by_user_id` FK -> `users.id`
- `created_at` timestamptz
- `completed_at` timestamptz nullable
- `metadata_json` jsonb

Notes:

- avoid raw PHI when possible
- use pseudonymized identifiers in app-visible tables

## `case_packages`

Purpose:

- uploaded source package tracking

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `original_upload_storage_key` text
- `upload_filename` text
- `upload_type` text
- `ingestion_status` enum (`pending`, `processing`, `ready`, `failed`)
- `ingestion_notes` text nullable
- `uploaded_at` timestamptz
- `processed_at` timestamptz nullable

## `case_frames`

Purpose:

- one case may contain multiple frames/images

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `frame_index` integer
- `source_name` text
- `image_storage_key` text
- `width` integer
- `height` integer
- `checksum_sha256` text
- `created_at` timestamptz

Constraints:

- unique (`case_id`, `frame_index`)

## `review_assignments`

Purpose:

- one record per case-stage assignment

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `review_stage` enum (`review_1`, `review_2`, `adjudication`)
- `assigned_to_user_id` FK -> `users.id`
- `status` enum
- `assigned_at` timestamptz
- `started_at` timestamptz nullable
- `submitted_at` timestamptz nullable
- `due_at` timestamptz nullable
- `previous_assignment_id` FK -> `review_assignments.id` nullable
- `reassigned_from_assignment_id` FK -> `review_assignments.id` nullable

Constraints:

- at most one active assignment per `case_id` + `review_stage`

Notes:

- `workflow_chain_steps` defines intended stage ownership
- `review_assignments` defines the actual activated work record for queueing and submission

## `review_submissions`

Purpose:

- immutable review outputs produced by a reviewer or adjudicator

Key fields:

- `id` UUID PK
- `assignment_id` FK -> `review_assignments.id`
- `case_id` FK -> `cases.id`
- `submitted_by_user_id` FK -> `users.id`
- `submission_type` enum (`draft`, `final_stage_submission`, `adjudication_final`)
- `leus_storage_key` text
- `annotation_summary_json` jsonb nullable
- `comment` text nullable
- `submitted_at` timestamptz
- `is_final_for_stage` boolean

Important rule:

- submissions are append-only
- never overwrite a prior `.leus` artifact in place

## `comment_threads`

Purpose:

- scoped in-app discussion containers for hosted workflow communication

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `assignment_id` FK -> `review_assignments.id` nullable
- `thread_type` enum (`assignment_clarification`, `admin_internal_note`, `case_operations_note`)
- `visibility_scope` enum
- `created_by_user_id` FK -> `users.id`
- `created_at` timestamptz
- `closed_at` timestamptz nullable

Recommended visibility values:

- `assignment_admin_and_assignee`
- `admin_only`

## `comments`

Purpose:

- persisted messages within a scoped hosted thread

Key fields:

- `id` UUID PK
- `thread_id` FK -> `comment_threads.id`
- `case_id` FK -> `cases.id`
- `assignment_id` FK -> `review_assignments.id` nullable
- `author_user_id` FK -> `users.id`
- `body` text
- `visibility_scope` enum
- `created_at` timestamptz
- `edited_at` timestamptz nullable
- `resolved_at` timestamptz nullable
- `resolved_by_user_id` FK -> `users.id` nullable

Rules:

- comment visibility must be enforced server-side
- Reviewer 2 must not see Reviewer 1 comments during active review
- Admin may see all threads and comments
- do not use one shared reviewer-visible case thread for both reviewers

## `case_decisions`

Purpose:

- final case outcome after adjudication or direct completion

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `final_submission_id` FK -> `review_submissions.id`
- `decision_type` enum (`completed_after_review_2`, `completed_after_adjudication`)
- `decided_by_user_id` FK -> `users.id`
- `decided_at` timestamptz
- `notes` text nullable

## `workflow_events`

Purpose:

- workflow-specific history of state changes and routing actions

Key fields:

- `id` UUID PK
- `case_id` FK -> `cases.id`
- `assignment_id` FK -> `review_assignments.id` nullable
- `actor_user_id` FK -> `users.id` nullable
- `event_type` text
- `from_state` text nullable
- `to_state` text nullable
- `payload_json` jsonb nullable
- `event_ts` timestamptz

## `audit_events`

Purpose:

- broader security and operations audit trail

Key fields:

- `id` UUID PK
- `actor_user_id` FK -> `users.id` nullable
- `object_type` text
- `object_id` text
- `action` text
- `payload_json` jsonb nullable
- `ip_hash` text nullable
- `user_agent_hash` text nullable
- `event_ts` timestamptz

## Relationships

```text
users --< user_roles >-- roles
users --< cases (uploaded_by_user_id)
users --< review_assignments
users --< review_submissions
users --< workflow_chain_steps
users --< comment_threads
users --< comments

cases --< case_packages
cases --< case_frames
cases --< workflow_chain_steps
cases --< review_assignments
cases --< review_submissions
cases --< comment_threads
cases --< comments
cases --< workflow_events
cases --< case_decisions

workflow_chain_steps --< review_assignments (by stage activation / lineage)
review_assignments --< review_submissions
review_assignments --< workflow_events
review_assignments --< comment_threads
review_assignments -- self-reference for previous/reassigned lineage
comment_threads --< comments
```

## What Lives In PostgreSQL vs Object Storage

PostgreSQL:

- case metadata
- frame metadata
- workflow chain stage ownership
- assignment ownership and state
- submission metadata
- comment threads and comment bodies
- workflow events
- audit events
- artifact storage keys

Object storage:

- uploaded source package
- frame image binaries
- immutable `.leus` submission artifacts

## `.leus` Snapshot Versioning Expectations

Versioning rules:

1. Every draft save or final submit that is persisted server-side creates a new artifact key.
2. The backend records a new `review_submissions` row for each persisted snapshot.
3. Final stage completion points to a specific immutable submission.
4. Prior reviewer outputs remain available for audit and adjudication policy, subject to permissions.

Recommended object key pattern:

```text
cases/{case_id}/assignments/{assignment_id}/submissions/{submission_id}.leus
```

Recommended draft variant pattern if draft saves are stored:

```text
cases/{case_id}/assignments/{assignment_id}/drafts/{timestamp}_{draft_id}.leus
```

## Notes On Current Local App Data

The current local annotator already produces `.leus` snapshots and browser-local annotation logs.

Hosted platform rules:

- `.leus` snapshots become durable server-tracked artifacts
- browser `localStorage` logs remain local-only convenience data
- hosted workflow must not depend on browser-local logs for correctness or audit completeness
- hosted comments and user assignment state live in the hosted data model, not in the standalone annotator
