#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 VERSION CHECKSUMS OUTPUT" >&2
  exit 2
fi

version=${1#v}
checksums=$2
output=$3
template=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)/packaging/homebrew/terminalz.rb.tmpl

checksum() {
  artifact=$1
  value=$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$checksums")
  if [ -z "$value" ]; then
    echo "missing checksum for $artifact" >&2
    exit 1
  fi
  printf '%s' "$value"
}

macos_arm64=$(checksum "terminalz-v${version}-aarch64-apple-darwin.tar.gz")
macos_x64=$(checksum "terminalz-v${version}-x86_64-apple-darwin.tar.gz")
linux_arm64=$(checksum "terminalz-v${version}-aarch64-unknown-linux-gnu.tar.gz")
linux_x64=$(checksum "terminalz-v${version}-x86_64-unknown-linux-gnu.tar.gz")

sed \
  -e "s/__VERSION__/${version}/g" \
  -e "s/__SHA_MACOS_ARM64__/${macos_arm64}/g" \
  -e "s/__SHA_MACOS_X64__/${macos_x64}/g" \
  -e "s/__SHA_LINUX_ARM64__/${linux_arm64}/g" \
  -e "s/__SHA_LINUX_X64__/${linux_x64}/g" \
  "$template" > "$output"
