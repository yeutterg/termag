#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || ! "$1" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "Usage: bash scripts/archive.sh TEAM_ID [BUNDLE_ID] [BUILD_NUMBER]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
team_id="$1"
bundle_id="${2:-app.terminalz.client}"
build_number="${3:-$(git rev-list --count HEAD)}"
if [[ ! "$bundle_id" =~ ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ || ! "$build_number" =~ ^[1-9][0-9]{0,3}(\.[0-9]{1,2}){0,2}$ ]]; then
  echo "Invalid bundle identifier or build number." >&2
  exit 1
fi

xcodebuild -version
xcodegen generate
bash scripts/prepare-renderer.sh Release
xcodebuild -project Terminalz.xcodeproj -scheme Terminalz \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "build/Terminalz-${build_number}.xcarchive" \
  -derivedDataPath build \
  -skipPackagePluginValidation \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$team_id" PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
  CURRENT_PROJECT_VERSION="$build_number" archive
open "build/Terminalz-${build_number}.xcarchive"
