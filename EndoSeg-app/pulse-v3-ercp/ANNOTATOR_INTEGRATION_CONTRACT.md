# Annotator Integration Contract

Integration freeze for embedding the current AnnotateLiver EUS app inside the future hosted shell.

## Purpose

This document defines the boundary contract between:

- the hosted frontend/backend system
- the existing local annotator module

The goal is to reuse the current annotator as the annotation engine while moving authentication, workflow, persistence, and audit into the hosted system.

## Integration Principle

The annotator is a bounded module.

It should receive a hosted review session manifest, allow annotation editing, and return `.leus` snapshots for save/submit actions.

It should not become responsible for:

- authentication
- assignment routing
- server-side authorization
- hosted audit completeness

## What The Hosted Shell Passes Into The Annotator

The hosted shell should pass a review-session manifest containing:

- current authenticated user context needed for display
- case metadata
- assignment metadata
- frame/image manifest
- policy flags about stage behavior
- optional prior server-stored draft snapshot for the current assignment

## Expected Hosted Manifest Shape

Illustrative TypeScript-like shape:

```ts
type HostedAnnotatorManifest = {
  caseId: string;
  displayCaseId: string;
  assignmentId: string;
  reviewStage: "review_1" | "review_2" | "adjudication";
  actor: {
    userId: string;
    displayName: string;
    role: "reviewer" | "adjudicator";
  };
  permissions: {
    canSaveDraft: boolean;
    canSubmit: boolean;
    readOnly: boolean;
    mayViewPriorStageOutputs: boolean;
  };
  frames: Array<{
    frameId: string;
    frameIndex: number;
    sourceName: string;
    imageUrl: string;
    width: number;
    height: number;
    checksumSha256?: string;
  }>;
  existingDraft?: {
    submissionId: string;
    leusJson: unknown;
    savedAt: string;
  } | null;
  priorStageOutputs?: Array<{
    submissionId: string;
    reviewStage: "review_1" | "review_2";
    leusJson?: unknown;
    submittedAt: string;
    submittedByDisplayName: string;
  }>;
  serverPolicy: {
    submissionCommentRequired: boolean;
    allowEscalateToAdjudication: boolean;
  };
};
```

Notes:

- `imageUrl` should be time-limited or otherwise access-controlled
- the hosted shell may transform server payloads into the annotator’s preferred runtime shape
- the current annotator still uses the same 9-label ontology and `.leus` structure already implemented locally

## What The Annotator Returns

On save draft or submit, the annotator should return:

- current `.leus` project JSON snapshot
- basic summary metadata useful to the hosted shell

## Expected Save/Submit Output Shape

```ts
type HostedAnnotatorOutput = {
  caseId: string;
  assignmentId: string;
  reviewStage: "review_1" | "review_2" | "adjudication";
  outputType: "draft_save" | "stage_submit";
  leusJson: unknown;
  summary: {
    imageCount: number;
    labelsObserved?: Array<{ id: number; name: string }>;
    stationsUsed?: Array<"TG" | "TD" | "">;
  };
  clientContext?: {
    localLogExportIncluded: boolean;
    appVersion?: string;
  };
};
```

Important:

- the hosted backend should treat `leusJson` as the primary artifact to persist
- the server may compute or validate summary fields independently

## Snapshot / Output Expectations

Hosted persistence rules:

- save draft may create a persisted draft artifact if the product chooses durable draft saves
- stage submit always creates a new immutable `.leus` artifact
- server assigns artifact key and submission ID
- prior artifacts remain available for audit and adjudication policy

## What Remains Local

Remains local to the annotator/browser:

- current in-session canvas state before a save occurs
- current browser `localStorage` annotation activity log
- local temporary UI state such as selected tool, panel layout, and unsaved draft state

## What Becomes Server-Tracked

Server-tracked hosted data:

- case identity and frame manifest
- assignment ownership
- workflow stage
- draft-save metadata if durable drafts are enabled
- final stage submissions
- adjudication result
- workflow events
- audit events

## Explicit Logging Rule

Hosted workflow must not depend on the current local browser `localStorage` annotation log.

Reason:

- the local log is browser-local only
- it can be exported/reset by the user
- it is not guaranteed durable
- it is not suitable as the authoritative hosted audit trail

The hosted platform must maintain its own server-side audit and workflow event history.

## Integration Constraints

The hosted integration must not change the local annotator’s:

- ontology
- `.leus` schema
- mask export format
- compatibility-safe project opening behavior

The hosted shell should adapt to the existing annotator contract, not force unrelated annotation-tool changes during initial integration.

## Recommended MVP Integration Approach

1. Hosted frontend fetches review-session manifest from backend.
2. Hosted shell resolves signed/private frame URLs.
3. Hosted shell mounts annotator with manifest-derived input data.
4. Annotator returns `.leus` JSON on save/submit.
5. Hosted shell sends output to backend.
6. Backend stores artifact in object storage and records submission/workflow events in PostgreSQL.

## Open Integration Questions

Human decisions still required before implementation:

- whether Reviewer 2 sees Reviewer 1 output during review or only after submission
- whether durable draft saves are required in MVP or only final-stage submit persistence
- whether adjudicators load both prior final outputs directly in the annotator or through a comparison shell around it
