# AnnotateLiver EUS Roadmap Status

Repository status freeze as of hosted Phase 3 integration work in March 2026.

## Executive Summary

The repository now contains two related tracks:

- a stable standalone browser-based liver EUS annotator
- a separate hosted platform shell under `hosted-app` that has progressed through scaffold, durable development persistence, and initial annotator embedding

The standalone annotator remains the system of record for local annotation behavior and currently supports the 9-label liver workflow, compatibility-safe project opening, MITK 4D multi-label NRRD export, and local annotation activity logging with export/reset utilities.

The hosted platform has advanced beyond planning: it now has a Next.js shell, mock/dev auth boundary, durable dev persistence, hosted case intake, reviewer/admin dashboards, and hosted review submission of real `.leus` snapshots. Hosted workflow execution is still partial and remains under active phased development.

## Standalone Local Annotator Status

### Implemented

1. Pancreas-to-liver adaptation
2. TG/TD station workflow
3. Compatibility-safe legacy handling
   - `legacy-v1`
   - `restricted-v2`
4. Tier 2A liver landmarks
5. Pen performance improvements
6. Tier 2B hepatic veins
7. Gallbladder as label `9` / `GB`
8. Documentation baseline for the 9-label liver workflow
9. Local annotation activity logging MVP
10. Annotation log export/reset utilities

### Active Label Set

1. `Liver`
2. `Portal Vein Main Trunk`
3. `Portal Vein Left Branch`
4. `Portal Vein Right Branch`
5. `Inferior Vena Cava`
6. `Left Hepatic Vein`
7. `Middle Hepatic Vein`
8. `Right Hepatic Vein`
9. `Gallbladder`

### Compatibility Behavior

- native liver `.leus` projects load normally
- `legacy-v1` opens older `.eus` / v1 data in compatibility mode
- `restricted-v2` opens schema-v2 files with canonical ID/name collisions in compatibility mode
- compatibility mode preserves stored labels and exposes only label ID `1` in the current active workflow

### Local Logging Status

- storage backend: browser `localStorage`
- logging is local-only and not authoritative for hosted workflow/audit
- manual export/reset utilities are implemented

## Hosted Platform Status

### Completed Hosted Phases

1. Hosted architecture freeze
   - architecture, data model, workflow, and annotator integration contract documents exist
2. Hosted Phase 1
   - separate `hosted-app` shell
   - auth/session scaffold
   - Admin case intake skeleton
   - reviewer/adjudicator dashboard skeleton
3. Hosted Phase 2
   - durable file-backed dev persistence
   - persistent Admin intake path
   - persistent dashboard data
   - persistent hosted audit events
4. Hosted Phase 3
   - annotator embedded into hosted review flow
   - hosted case assets loaded into the annotator
   - final `.leus` submission persisted server-side
   - hosted review open/submit audit events added

### Hosted Features Present Now

- separate hosted app under `hosted-app`
- mock/dev auth boundary with role separation
- Admin case list and upload flow
- reviewer dashboard
- adjudicator placeholder dashboard
- hosted case detail page
- hosted review route for reviewer assignments
- durable dev persistence for cases, assets, assignments, submissions, and audit events
- real `.leus` submission persistence for hosted review sessions

## Hosted Workflow Direction Now Frozen

The next hosted workflow direction is now clarified as:

1. Admin controls the ordered workflow chain per case
2. Reviewer 1 completes the first review
3. case automatically progresses to Reviewer 2
4. Reviewer 2 completes the second review while blinded to Reviewer 1 during active review
5. case returns to Admin
6. Admin explicitly finalizes the case as ground-truth

Hosted MVP workflow additions now required in the plan:

- read-only report/reference access before opening the annotator
- Admin-controlled chain assignment
- reviewer To-Do queue
- Admin workflow dashboard with search/filter/reassign/priority/chain visibility
- explicit Admin finalization state

## Deferred / Not Yet Implemented

### Deferred Anatomy

- portal vein umbilical portion
- more distal portal subdivisions such as P5/8 and P6/7
- aorta
- hepatic artery branches
- ligamentum teres
- ligamentum venosum
- diaphragm
- Couinaud segment context metadata
- frame quality flags

### Deferred Hosted Platform Work

- Admin chain assignment UI
- reviewer To-Do queue and later completed/history view
- report/reference button and read-only viewer
- Reviewer 1 -> Reviewer 2 automatic workflow progression
- Admin finalization as ground-truth acceptance
- richer Admin workflow dashboard controls
- adjudication comparison UI
- real OIDC wiring
- production PostgreSQL and object-storage adapters
- cloud deployment/IaC

## Recommended Next Hosted Build Order

Recommended implementation order:

1. workflow chain model + Admin assignment UI
2. reviewer To-Do queue
3. report/reference button
4. Reviewer 1 -> Reviewer 2 automatic progression
5. Admin finalization as ground-truth
6. adjudication and more advanced features after that

## Roadmap Freeze Statement

Current planning priority is hosted workflow completion, not new liver anatomy expansion.

Until the hosted workflow phases above are delivered, the repository should be treated as:

- ontology-frozen for the current 9-label local workflow
- `.leus` schema-frozen unless explicitly re-opened
- compatibility-behavior-frozen
- local mask export behavior unchanged
