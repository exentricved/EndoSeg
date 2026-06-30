#!/usr/bin/env bash
# prepare-review-package.sh
#
# Produces a self-contained review context block for use by the AI review
# workflow or for manual review. Output goes to stdout.
#
# Usage (CI):  bash scripts/prepare-review-package.sh > /tmp/review-package.txt
# Usage (local):  bash scripts/prepare-review-package.sh | less
#
# Requires: git

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-main}"
MAX_DIFF_LINES="${MAX_DIFF_LINES:-1200}"
MAX_FILE_LINES="${MAX_FILE_LINES:-300}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

section() {
  printf '\n\n## %s\n\n' "$1"
}

fence() {
  local lang="${1:-}"
  printf '```%s\n' "$lang"
}

endfence() {
  printf '```\n'
}

# ---------------------------------------------------------------------------
# PR metadata (available in CI via env; graceful fallback for local use)
# ---------------------------------------------------------------------------

section "PR metadata"
printf 'Branch:   %s\n' "$(git rev-parse --abbrev-ref HEAD)"
printf 'Base:     %s\n' "$BASE_BRANCH"
printf 'Commits:  %s\n' "$(git rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 'unknown')"
if [ -n "${GITHUB_HEAD_REF:-}" ]; then
  printf 'PR title: %s\n' "${PR_TITLE:-}"
fi

# ---------------------------------------------------------------------------
# Changed file list
# ---------------------------------------------------------------------------

section "Changed files"
git diff --name-status "${BASE_BRANCH}..HEAD" 2>/dev/null || git diff --name-status HEAD~1..HEAD

# ---------------------------------------------------------------------------
# Diff (truncated if very large)
# ---------------------------------------------------------------------------

section "Diff"
DIFF=$(git diff "${BASE_BRANCH}..HEAD" 2>/dev/null || git diff HEAD~1..HEAD)
DIFF_LINES=$(echo "$DIFF" | wc -l)

fence diff
if [ "$DIFF_LINES" -gt "$MAX_DIFF_LINES" ]; then
  echo "$DIFF" | head -n "$MAX_DIFF_LINES"
  printf '\n... [diff truncated at %d lines — full diff has %d lines] ...\n' "$MAX_DIFF_LINES" "$DIFF_LINES"
else
  echo "$DIFF"
fi
endfence

# ---------------------------------------------------------------------------
# Changed source files (full content, capped per file)
# ---------------------------------------------------------------------------

section "Changed source file contents"

CHANGED_FILES=$(git diff --name-only "${BASE_BRANCH}..HEAD" 2>/dev/null || git diff --name-only HEAD~1..HEAD)

while IFS= read -r f; do
  # Skip deleted files, binaries, generated files
  [ -f "$f" ] || continue
  case "$f" in
    *.lock|*.png|*.jpg|*.nrrd|*.gz|*.pdf|dist/*|.next/*|node_modules/*) continue ;;
  esac

  printf '\n### %s\n\n' "$f"
  FILE_LINES=$(wc -l < "$f")
  fence
  if [ "$FILE_LINES" -gt "$MAX_FILE_LINES" ]; then
    head -n "$MAX_FILE_LINES" "$f"
    printf '\n... [truncated at %d lines — file has %d lines] ...\n' "$MAX_FILE_LINES" "$FILE_LINES"
  else
    cat "$f"
  fi
  endfence
done <<< "$CHANGED_FILES"

# ---------------------------------------------------------------------------
# Relevant spec excerpts (always included for context)
# ---------------------------------------------------------------------------

SPEC_FILES=(
  HOSTED_WORKFLOW_SPEC.md
  HOSTED_DATA_MODEL.md
  HOSTED_USER_ASSIGNMENT_AND_COMMENTS_SPEC.md
  ANNOTATOR_INTEGRATION_CONTRACT.md
)

section "Spec context"
for spec in "${SPEC_FILES[@]}"; do
  [ -f "$spec" ] || continue
  printf '\n### %s\n\n' "$spec"
  fence markdown
  head -n 80 "$spec"
  SPEC_LINES=$(wc -l < "$spec")
  if [ "$SPEC_LINES" -gt 80 ]; then
    printf '\n... [first 80 of %d lines shown] ...\n' "$SPEC_LINES"
  fi
  endfence
done
