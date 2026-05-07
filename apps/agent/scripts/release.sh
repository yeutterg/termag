#!/usr/bin/env bash
# Cut a new release of @yeutterg/agent.
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
# doesn't collide with future @yeutterg/* packages.
old_version="$(node -p "require('./package.json').version")"

# `npm version` makes a commit named "<new-version>"; override to a more
# searchable message.
new_version="$(npm version "$bump" --no-git-tag-version)"
# strip leading "v" — `npm version` returns "v0.1.1"
new_version="${new_version#v}"

echo "Bumping @yeutterg/agent: $old_version -> $new_version"

git -C "$repo_root" add "$agent_dir/package.json"
git -C "$repo_root" -c commit.gpgsign=false commit -m "agent: release v$new_version"
git -C "$repo_root" tag "agent-v$new_version"

if [ "${TERMAG_AGENT_DRY_RUN:-}" = "1" ]; then
  echo "[dry-run] skipping npm publish and git push"
else
  echo "Publishing to npm..."
  npm publish --access public
  echo "Pushing commit + tag..."
  git -C "$repo_root" push --follow-tags
fi

# Compute the brew formula's url + sha256 for the just-published tarball.
tarball_url="https://registry.npmjs.org/@yeutterg/agent/-/agent-${new_version}.tgz"
echo "Fetching tarball to compute sha256..."
sha="$(curl -sL "$tarball_url" | shasum -a 256 | awk '{print $1}')"

cat <<EOF

==============================================================
Brew formula update
==============================================================
File: yeutterg/homebrew-tap/Formula/termag-agent.rb

Replace the url and sha256 lines with:

  url "$tarball_url"
  sha256 "$sha"

Then in your tap repo:

  cd ~/repos/homebrew-tap
  git pull
  # edit Formula/termag-agent.rb with the lines above
  git add Formula/termag-agent.rb
  git commit -m "termag-agent $new_version"
  git push

==============================================================
EOF
