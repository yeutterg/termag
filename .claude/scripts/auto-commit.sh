#!/usr/bin/env bash
# Stop-hook: stage anything dirty in the project, commit with a checkpoint
# message, and push if an upstream is configured. Always exits 0 so a missing
# remote / detached HEAD / network blip never blocks the Claude turn.

set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0

# Bail early if not a git repo.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Nothing to do if working tree + index are clean.
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
  exit 0
fi

git add -A 2>/dev/null || exit 0
git -c commit.gpgsign=false commit -m "claude-code: auto checkpoint" >/dev/null 2>&1 || exit 0

# Push only if the current branch has an upstream and a reachable remote.
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git push --quiet 2>/dev/null || true
fi

exit 0
