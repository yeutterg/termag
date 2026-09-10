#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
configuration="${1:-Release}"
if [[ "$configuration" != Release && "$configuration" != Debug ]]; then
  echo "Expected Release or Debug configuration" >&2
  exit 1
fi
xcodebuild -resolvePackageDependencies -project Terminalz.xcodeproj -scheme Terminalz -derivedDataPath build
renderer="build/SourcePackages/checkouts/SwiftTerm"
if [[ "$(git -C "$renderer" rev-parse HEAD)" != 5d14406844143538cd8f8851d2d8a67c1fe443e5 ]]; then
  echo "Unexpected SwiftTerm revision; review its build generator before changing the pin." >&2
  exit 1
fi
# Xcode's iOS Release build can omit this host executable even though the package
# plugin declares it. Build the pinned Foundation-only generator for the host Mac.
mkdir -p "build/Build/Products/$configuration"
xcrun --sdk macosx swiftc -parse-as-library -O \
  "$renderer/Sources/SwiftTermBuildInfoGenerator/BuildInfoGenerator.swift" \
  -o "build/Build/Products/$configuration/SwiftTermBuildInfoGenerator"
