#!/usr/bin/env bash
# One-time setup for the homebrew tap that hosts termag-agent.
#
# Creates yeutterg/homebrew-tap on GitHub (if missing), clones it under
# ~/repos/homebrew-tap, drops in the formula from infra/homebrew/, and
# pushes. After this runs, anyone can install with:
#
#   brew install yeutterg/tap/termag-agent
#
# Usage:
#   apps/agent/scripts/bootstrap-brew-tap.sh
#
# Env:
#   TERMAG_GH_USER=yeutterg    GitHub user owning the tap
#   TERMAG_TAP_DIR=~/repos     Where to clone the tap

set -euo pipefail

gh_user="${TERMAG_GH_USER:-yeutterg}"
tap_parent="${TERMAG_TAP_DIR:-$HOME/repos}"
tap_dir="$tap_parent/homebrew-tap"
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
formula_src="$repo_root/infra/homebrew/termag-agent.rb"

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required. Install it: brew install gh" >&2
  exit 1
fi
if [ ! -f "$formula_src" ]; then
  echo "Missing formula source at $formula_src" >&2
  exit 1
fi

mkdir -p "$tap_parent"

if [ -d "$tap_dir/.git" ]; then
  echo "Tap already cloned at $tap_dir — skipping create."
else
  if ! gh repo view "$gh_user/homebrew-tap" >/dev/null 2>&1; then
    echo "Creating GitHub repo $gh_user/homebrew-tap..."
    gh repo create "$gh_user/homebrew-tap" \
      --public \
      --description "Homebrew tap for termag-agent and friends" \
      --confirm 2>/dev/null || gh repo create "$gh_user/homebrew-tap" \
      --public \
      --description "Homebrew tap for termag-agent and friends"
  fi
  echo "Cloning $gh_user/homebrew-tap to $tap_dir..."
  gh repo clone "$gh_user/homebrew-tap" "$tap_dir"
fi

cd "$tap_dir"

mkdir -p Formula
cp "$formula_src" Formula/termag-agent.rb

if [ ! -f README.md ]; then
  cat >README.md <<EOF
# homebrew-tap

Personal Homebrew tap.

## Install

\`\`\`bash
brew tap $gh_user/tap
brew install termag-agent
\`\`\`
EOF
fi

if [ -n "$(git status --porcelain)" ]; then
  git add Formula/termag-agent.rb README.md
  git -c commit.gpgsign=false commit -m "Add termag-agent formula"
  git push -u origin "$(git branch --show-current 2>/dev/null || echo main)"
  echo
  echo "Tap pushed. Anyone can now run:"
  echo "  brew install $gh_user/tap/termag-agent"
  echo
  echo "Note: the formula's url + sha256 still point at v0.1.0 with a"
  echo "placeholder hash. Run apps/agent/scripts/release.sh to publish to"
  echo "npm and get the real sha256 to paste back in."
else
  echo "No changes to push — tap already up to date."
fi
