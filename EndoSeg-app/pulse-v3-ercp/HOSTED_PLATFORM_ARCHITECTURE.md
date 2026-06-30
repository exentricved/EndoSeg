# Hosted Platform Architecture

Architecture freeze for the secure hosted review platform built around the existing AnnotateLiver EUS annotator.

## Purpose

This document defines the hosted system architecture for a platform where:

- Admin uploads or registers case packages
- Admin defines an ordered review chain per case
- authenticated reviewers work from a hosted To-Do queue
- reviewers can view a read-only report/reference before annotation
- Reviewer 1 completes the first review stage
- Reviewer 2 completes the second review stage while blinded to Reviewer 1 during active review
- the case returns to Admin for final ground-truth acceptance
- the current local annotator is reused as the annotation module

This document is design-only. It does not change the standalone local app.

## System Overview

Recommended system shape:

- Frontend hosted shell
  - authenticated reviewer/Admin web application
  - reviewer To-Do queue and case detail flow
  - Admin workflow dashboard and chain assignment UI
  - report/reference viewer
  - hosted review session shell that mounts the existing annotator
- Backend API
  - authenticated application API
  - workflow and assignment enforcement
  - chain-definition persistence
  - submission handling
  - audit event recording
  - report/reference access control
- PostgreSQL
  - system-of-record for users, cases, case workflow chains, assignments, submissions, and audit metadata
- Private object storage
  - original uploaded case packages
  - extracted frame images
  - read-only report/reference artifacts
  - submitted `.leus` review snapshots
  - later export bundles
- Authentication provider
  - OIDC/OAuth2-compatible identity provider with MFA support
- Background worker
  - intake/extraction jobs
  - report/reference normalization if needed
  - later notifications/export packaging

## Text Component Diagram

```text
[User Browser]
    |
    v
[Hosted Frontend Shell]
    |
    +---- authenticated API calls ----------------------+
    |                                                   |
    v                                                   v
[Backend API] ------------------------------> [PostgreSQL]
    |
    +---- signed/private artifact access ---> [Object Storage]
    |
    +---- identity verification ------------> [OIDC Auth Provider]
    |
    +---- async jobs -----------------------> [Worker]

Within the Hosted Frontend Shell:

[Reviewer To-Do Queue / Admin Workflow Dashboard / Case Detail]
                                  |
                                  +----> [Read-Only Report Viewer]
                                  |
                                  +----> [Hosted Review Session Shell]
                                                  |
                                                  v
                             [Embedded Existing Annotator Module]
```

## Responsibilities By Component

### Frontend Hosted Shell

Responsibilities:

- login/session handling
- reviewer To-Do queue and later history view
- Admin workflow dashboard with search/filter/reassign/priority visibility
- case detail and review entry flow
- read-only report/reference access before annotation
- chain assignment UI for ordered reviewer steps
- hosted review session page that embeds the existing annotator
- clear display of case state, assignment state, chain position, and finalization state

Must not own:

- core authorization decisions
- final workflow state enforcement
- durable audit system of record

### Backend API

Responsibilities:

- validate authenticated user identity and role claims
- enforce case-level authorization
- enforce reviewer blinding rules
- accept case package uploads or upload registrations
- create cases, case assets, workflow chains, assignments, submissions
- validate state transitions
- progress the case from Reviewer 1 to Reviewer 2 within the Admin-defined chain
- return the case to Admin for finalization
- record audit and workflow events
- issue time-limited access to private artifacts

### PostgreSQL

Responsibilities:

- durable system-of-record for:
  - users
  - roles
  - cases
  - case workflow chains
  - case assets and report/reference metadata
  - assignments
  - submissions
  - workflow events
  - audit events

Must not store:

- large binary frame data
- large `.leus` snapshot blobs
- large report/reference binaries

### Object/File Storage

Responsibilities:

- store original uploaded case packages
- store extracted source frames
- store report/reference artifacts
- store submitted `.leus` snapshots for each review stage
- preserve versioned artifacts instead of in-place overwrite

Recommended properties:

- private bucket/container only
- encryption at rest
- object versioning enabled
- short-lived signed URL access

### Authentication Provider

Responsibilities:

- login
- MFA enforcement
- identity lifecycle
- group/role claims source

Recommended options:

- Auth0
- Microsoft Entra ID
- Keycloak
- another OIDC-compatible provider

### Worker

Responsibilities:

- ingest uploaded case package
- extract frame and manifest metadata
- validate package completeness
- register report/reference artifacts if present
- later perform notifications and export packaging

### Audit Layer

Responsibilities:

- append-only server-side record of security-relevant and workflow-relevant actions
- trace actor, timestamp, object, action, and context
- record report viewing, chain-definition, reassignment, workflow progression, and finalization actions

Important note:

The current browser `localStorage` annotation log is not the hosted audit trail and must not be treated as the compliance/system record.

## Hosted Shell vs Existing Annotator Boundary

The hosted shell owns:

- authentication
- authorization
- case routing
- chain assignment
- reviewer queueing
- read-only report/reference presentation
- stage transitions
- assignment ownership
- Admin finalization
- durable persistence
- server-side audit events

The existing annotator owns:

- image/frame rendering
- label editing
- mask drawing/erasing
- `.leus` snapshot serialization/deserialization
- current local-only annotation telemetry

The hosted system treats the annotator as a bounded annotation module. It must not move report viewing, queue management, or workflow logic into the standalone annotator.

## Deployment Assumptions

Recommended baseline assumptions:

- frontend and backend deployed separately but within the same trusted environment
- PostgreSQL in a managed or hardened private deployment
- private object storage in the same security boundary
- TLS everywhere
- private network paths between backend, DB, and storage where possible
- secrets stored in a dedicated secret manager

Cloud-neutral reference deployment:

- frontend: managed web hosting
- backend: containerized service
- DB: managed PostgreSQL
- storage: S3-compatible private bucket
- auth: managed OIDC provider
- worker: queue-triggered container/job

## MVP Scope

Hosted MVP includes:

- secure login
- Admin case upload/intake
- Admin-controlled workflow chain definition per case
- Admin-triggered assignment creation
- reviewer To-Do queue limited to assigned work
- case detail page with read-only report/reference access before annotation
- embedded existing annotator in a hosted review session
- final submission of hosted `.leus` review artifacts
- automatic progression from Reviewer 1 to Reviewer 2 within the defined chain
- return to Admin for explicit ground-truth finalization
- Admin workflow dashboard with search/filter/open/reassign/priority visibility
- server-side workflow and audit events
- versioned storage of submitted `.leus` snapshots

Hosted MVP does not require:

- branching workflows
- adjudication comparison UI
- durable server-side draft save
- server-side NRRD generation

## Deferred Scope

Deferred until after MVP:

- branching or conditional workflow chains
- adjudication comparison UI
- advanced reviewer history analytics
- queue balancing automation without Admin confirmation
- automated disagreement scoring from masks
- real-time collaborative editing
- advanced notification engine
- external hospital-system integration
- bulk export/report packaging
- advanced compliance/reporting controls beyond core audit/RBAC

## Architecture Decisions Frozen Here

1. The existing annotator is reused, not rewritten.
2. PostgreSQL is the workflow system of record.
3. Object storage holds uploaded packages, report/reference artifacts, frames, and submitted `.leus` snapshots.
4. Hosted workflow correctness depends on server-side state and audit events, not browser-local logs.
5. Review routing is sequential and linear in MVP: Reviewer 1 -> Reviewer 2 -> Admin finalization.
6. Reviewer 2 remains blinded to Reviewer 1 during active review unless a later policy change explicitly alters that rule.
7. Report/reference access is a hosted-shell feature, not a standalone annotator feature.
