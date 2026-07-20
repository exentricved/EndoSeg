# Hosted Platform Backlog

Implementation backlog after the current hosted MVP workflow baseline:

- Admin-controlled chain
- reviewer To-Do queue
- read-only report/reference access
- Reviewer 1 to Reviewer 2 progression
- Admin finalization as ground-truth

## Priority Order

1. Real user assignment and hosted user directory hardening
2. Assignment-scoped in-app comments
3. Admin-only notes and comment UX hardening
4. Notification-only email layer
5. Adjudication and advanced workflow features

## Backlog Items

### 1. Real User Assignment And User Directory

Scope:

- treat `review_1` and `review_2` as stage positions only
- assign actual hosted users by name/email/role to those positions
- harden user directory and active/disabled handling
- show actual assignee identity across workflow UI

Deliverables:

- durable user directory model
- workflow-chain steps referencing assigned user records
- Admin UI for assigning real users to stage positions
- active-stage reassignment rules that preserve audit history

### 2. Assignment-Scoped In-App Comments

Scope:

- add persisted in-app threads/comments as the communication system of record
- keep reviewer communication scoped to one assignment
- preserve Reviewer 2 blinding during active review

Deliverables:

- assignment-level reviewer/Admin clarification threads
- server-enforced visibility rules
- case detail UI for comments on the active assignment
- audit events for thread creation and comment activity

### 3. Admin-Only Notes And Comment UX Hardening

Scope:

- add Admin-only case notes
- separate Admin notes from reviewer-visible clarification threads
- improve workflow communication UX without weakening blinding

Deliverables:

- Admin-only notes panel
- unresolved/open thread indicators
- comment counts/badges in workflow views
- thread close/resolve behavior

### 4. Notification-Only Email Layer

Scope:

- add optional email notifications as secondary alerts
- keep in-app comments and workflow state as the authoritative record

Deliverables:

- assignment-created notification
- reassignment notification
- new Admin reply notification
- return-for-rework notification
- finalization notification

Guardrail:

- email must not carry workflow authority or replace in-app threaded communication

### 5. Adjudication And Advanced Workflow Features

Deferred until user assignment and communication flows are stable:

- adjudication assignment flow
- adjudication comparison UI
- branching workflow chains
- reviewer history analytics
- production OIDC wiring
- production PostgreSQL/object-storage deployment adapters
- cloud deployment/IaC

## Backlog Guardrails

- do not change standalone local annotator ontology or mask export behavior as part of hosted workflow work
- keep hosted workflow and comments authoritative on the server side
- do not depend on browser-local annotation logs for hosted workflow correctness
- do not use a single reviewer-shared case thread that breaks blinding
- keep Reviewer 2 blinded to Reviewer 1 comments during active review unless policy is explicitly changed later
