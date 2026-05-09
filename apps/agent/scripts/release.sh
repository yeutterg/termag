#!/usr/bin/env bash
# Cut a new release of termag-agent.
#
# Usage:
#   apps/agent/scripts/release.sh patch    # 0.1.0 -> 0.1.1
#   apps/agent/scripts/release.sh minor    # 0.1.0 -> 0.2.0
#   apps/agent/scripts/release.sh major    # 0.1.0 -> 1.0.0
#   apps/agent/scripts/release.sh 0.2.5    # exact version
#
# What it does:
#   1. Refuses if the working tree is dirty.
#   2. Bumps the version in apps/agent/package.json (creating a git tag).
#   3. Runs `npm publish --access public` (also fires `prepublishOnly` -> tsc).
#   4. Pushes the version-bump commit + tag.
#   5. Downloads the published tarball, computes its sha256, and prints the
#      Formula update block ready to paste into yeutterg/homebrew-tap's
#      Formula/termag-agent.rb.
#
# Env:
#   TERMAG_AGENT_DRY_RUN=1     skip `npm publish` and `git push`; useful for
#                              rehearsing the version bump.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <patch|minor|major|x.y.z>" >&2
  exit 2
fi

bump="$1"
script_dir="$(cd "$(dirname "$0")" && pwd)"
agent_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$agent_dir/../.." && pwd)"

cd "$agent_dir"

if [ -n "$(git -C "$repo_root" status --porcelain "$agent_dir")" ]; then
  echo "Working tree under $agent_dir is dirty. Commit or stash first." >&2
  git -C "$repo_root" status --short "$agent_dir"
  exit 1
fi

# `npm version` runs in this package and rewrites package.json + creates a tag
# named v<new-version> by default. We want the tag scoped per-package so it
# doesn't collide with other tags in this repo.
old_version="$(node -p "require('./package.json').version")"

# In workspace contexts npm version prints the package name on stdout
# alongside the version, plus any `npm install` chatter that the version
# bump triggers. Don't try to parse that — re-read package.json after
# the bump for a single source of truth.
npm version "$bump" --no-git-tag-version >/dev/null
new_version="$(node -p "require('./package.json').version")"

echo "Bumping termag-agent: $old_version -> $new_version"

git -C "$repo_root" add "$agent_dir/package.json" package-lock.json
git -C "$repo_root" -c commit.gpgsign=false commit -m "agent: release v$new_version"
# Annotated (-a) so `git push --follow-tags` actually pushes it.
# Lightweight tags get skipped by --follow-tags and stay local-only.
git -C "$repo_root" tag -a "agent-v$new_version" -m "agent v$new_version"

if [ "${TERMAG_AGENT_DRY_RUN:-}" = "1" ]; then
  echo "[dry-run] skipping npm publish and git push"
else
  echo "Publishing to npm..."
  npm publish --access public
  echo "Pushing commit + tag..."
  git -C "$repo_root" push --follow-tags
fi

# Compute the brew formula's url + sha256 for the just-published tarball.
tarball_url="https://registry.npmjs.org/termag-agent/-/termag-agent-${new_version}.tgz"
echo "Fetching tarball to compute sha256..."
sha="$(curl -sL "$tarball_url" | shasum -a 256 | awk '{print $1}')"

# If the tap is checked out at ~/repos/homebrew-tap, patch + push it
# automatically so we don't risk a stale formula. Use `sed -E` (BSD-compatible
# extended regex) — plain `\+` is interpreted literally by macOS sed.
tap_dir="${HOME}/repos/homebrew-tap"
formula="$tap_dir/Formula/termag-agent.rb"
if [ "${TERMAG_AGENT_DRY_RUN:-}" != "1" ] && [ -f "$formula" ]; then
  echo "Updating brew formula at $formula..."
  (
    cd "$tap_dir"
    git pull --quiet
    sed -i.bak -E \
      -e "s|/termag-agent-[0-9]+\.[0-9]+\.[0-9]+\.tgz|/termag-agent-${new_version}.tgz|" \
      -e "s|sha256 \"[a-f0-9]{64}\"|sha256 \"${sha}\"|" \
      "$formula"
    rm -f "${formula}.bak"
    if [ -n "$(git status --porcelain "$formula")" ]; then
      git add "$formula"
      git -c commit.gpgsign=false commit -m "termag-agent ${new_version}" --quiet
      git push --quiet
      echo "Tap pushed: $(git rev-parse --short HEAD)"
    else
      echo "Formula already at ${new_version}; nothing to push."
    fi
  )
else
  cat <<EOF

==============================================================
Brew formula update (no local tap found at $tap_dir)
==============================================================

  url "$tarball_url"
  sha256 "$sha"

Paste those into your tap's Formula/termag-agent.rb, then commit+push.
==============================================================
EOF
fi
