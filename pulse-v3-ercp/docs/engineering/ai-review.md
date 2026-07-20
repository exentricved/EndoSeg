# AI Review Pipeline

## What it is

Every non-draft PR against `main` automatically gets:

1. **Deterministic CI gate** (`.github/workflows/ci.yml`) — must pass before merge.
2. **Advisory AI review** (`.github/workflows/ai-review.yml`) — posts a PR comment from Claude. Advisory only; does not block merge.

---

## CI gate

The CI workflow runs two independent jobs:

| Job | Working directory | Steps |
|---|---|---|
| `annotator` | repo root | `npm ci` → `npm run build` (tsc + vite) → `npm run lint` |
| `hosted-app` | `hosted-app/` | `npm ci` → `npm run build` (next build) |

Both jobs must pass for the PR to be mergeable (enforce via branch protection).

### Branch protection settings (recommended)

Go to **Settings → Branches → Add rule** for `main`:

- [x] Require status checks to pass before merging
  - Add: `Standalone annotator — build + lint`
  - Add: `Hosted platform — build`
- [x] Require branches to be up to date before merging
- [x] Do not allow bypassing the above settings

---

## AI review gate

### How it works

1. When a PR is marked ready for review (or opened/updated), the workflow runs `scripts/prepare-review-package.sh`.
2. The package contains: PR metadata, changed file list, full diff (capped at 1200 lines), changed source file contents (capped at 300 lines/file), and the first 80 lines of each relevant spec file.
3. If `ANTHROPIC_API_KEY` is configured as a repo secret, the package is sent to `claude-sonnet-4-6` and the response is posted as a PR comment.
4. If the secret is absent or the API call fails, a fallback comment is posted explaining the skip — **the workflow never fails the PR**.

### Setting up the API key

1. Go to **Settings → Secrets and variables → Actions**.
2. Add a new secret named `ANTHROPIC_API_KEY` with your Anthropic API key.

### Draft PRs

The workflow skips draft PRs (`if: github.event.pull_request.draft == false`). Mark the PR ready for review to trigger it.

---

## Review package script

`scripts/prepare-review-package.sh` can be run locally for manual review:

```bash
# From repo root — compare current branch against main
bash scripts/prepare-review-package.sh | less

# Compare against a different base
BASE_BRANCH=my-feature bash scripts/prepare-review-package.sh
```

This is useful for:
- Reviewing your own PR before requesting review
- Testing the script output before pushing
- Preparing context for a manual Claude.ai chat review

---

## What the AI reviewer is told

The system prompt instructs Claude to act as a principal engineer for this specific codebase and to flag:
- Correctness issues
- Security problems
- Type safety regressions
- Violations of frozen contracts (`.leus` schema, 9-label ontology, NRRD export byte output, `hostedReviewContract.ts`)

The review is **advisory**. The human reviewer and passing CI are the actual merge gate.

---

## Frozen contracts (never change without spec approval)

These are highlighted to the AI reviewer and must not change casually:

- `.leus` schema version and serialization format
- The 9-label liver ontology and label IDs
- Standalone annotator NRRD export byte output
- Hosted annotator integration contract (`src/hostedReviewContract.ts`)
