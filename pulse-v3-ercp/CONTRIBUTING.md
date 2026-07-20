# Contributing to PULSE v3 – Liver

## Branch strategy

- `main` is the stable, always-buildable branch.
- **No direct commits to `main`.** All work goes through a feature branch and a PR.
- One branch per scoped task. Branch names follow the pattern:

  ```
  <area>/<short-description>
  ```

  Examples:
  ```
  hosted-app/reviewer-crud
  export/nrrd-phase-1
  hosted-app/case-archive
  ```

## Commit message format

```
<area>: <concise change in imperative mood>
```

The `<area>` must be one of:

| Area | Use for |
|---|---|
| `repo` | Repository config, CI, workflow files |
| `hosted-app` | Hosted Next.js platform (any sub-feature) |
| `annotator` | Standalone Vite+React annotator (`src/`) |
| `export` | NRRD export or other derived-format work |
| `spec` | Specification and architecture documents |
| `seed` | Dev seed data only |

Examples:
```
repo: bootstrap github and contribution workflow
hosted-app: finalize reviewer CRUD and direct ingestion
hosted-app: polish sign-in page branding
export: add NRRD Phase 1 client-side export
hosted-app: add admin case archive and restore
spec: lock NRRD export decisions and add case archive spec
```

Rules:
- Imperative mood ("add", "fix", "remove" — not "added" or "adds")
- No trailing period
- 72 characters max on the subject line
- If context is needed, add a blank line then a body paragraph

## Pull request workflow

1. **Open a draft PR** as soon as the branch exists — before the work is done.
   This makes the scope visible early and allows early feedback.

2. **Before marking ready for review**, confirm all of the following:

   - [ ] `npm run build` passes from the repo root (standalone annotator)
   - [ ] `cd hosted-app && npm run build` passes (hosted platform)
   - [ ] No TypeScript errors (`tsc --noEmit` in both packages)
   - [ ] No regressions in existing behavior visible from a manual smoke test
   - [ ] PR description filled out using the PR template

3. **Mark the PR ready** — this triggers the AI review workflow, which posts an advisory comment. Wait for it before requesting human review (usually < 2 minutes).

4. **CI must pass** — the `CI` workflow runs `build` + `lint` for both packages. The branch cannot be merged until both jobs are green. If CI is red, fix it before requesting review.

5. Request review, then merge.

6. **Delete the branch** after merge.

## Commit discipline

- Keep commits atomic. Each commit should do exactly one logical thing.
- Do not bundle unrelated changes in one commit.
- Do not commit build artifacts, `node_modules`, `.next`, or dev-db files.
- Do not commit `.env` files or any file containing secrets or credentials.
- `vite.err` and `vite.out` are diagnostic files — never commit them.

## Spec references

All non-trivial features should reference a spec document in the PR description.
Current authoritative specs live at the repository root:

- `HOSTED_WORKFLOW_SPEC.md`
- `HOSTED_DATA_MODEL.md`
- `HOSTED_USER_ASSIGNMENT_AND_COMMENTS_SPEC.md`
- `HOSTED_PLATFORM_ARCHITECTURE.md`
- `ANNOTATOR_INTEGRATION_CONTRACT.md`
- `ROADMAP_STATUS.md`
- `HOSTED_BACKLOG.md`

## What must NOT change casually

These are frozen unless a spec change is explicitly approved:

- `.leus` schema version and serialization format
- The 9-label liver ontology and label IDs
- Standalone annotator NRRD export byte output
- Hosted annotator integration contract (`src/hostedReviewContract.ts`)
- `.leus` as the submission artifact in hosted workflow
