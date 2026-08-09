#!/bin/sh
set -eu

repo=${TERMINALZ_REPOSITORY:-yeutterg/terminalz}
install_dir=${TERMINALZ_INSTALL_DIR:-${HOME}/.local/bin}
version=${TERMINALZ_VERSION:-}

if [ -z "$version" ]; then
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest")
  version=${latest##*/}
fi
version=${version#v}

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=aarch64-apple-darwin ;;
  Darwin:x86_64) target=x86_64-apple-darwin ;;
  Linux:aarch64|Linux:arm64) target=aarch64-unknown-linux-gnu ;;
  Linux:x86_64|Linux:amd64) target=x86_64-unknown-linux-gnu ;;
  *) echo "unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

archive="terminalz-v${version}-${target}.tar.gz"
base="https://github.com/${repo}/releases/download/v${version}"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

curl -fsSL "$base/$archive" -o "$tmp_dir/$archive"
curl -fsSL "$base/SHA256SUMS" -o "$tmp_dir/SHA256SUMS"
expected=$(awk -v artifact="$archive" '$2 == artifact { print $1 }' "$tmp_dir/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "release checksum is missing $archive" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_dir/$archive" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$tmp_dir/$archive" | awk '{ print $1 }')
fi
if [ "$actual" != "$expected" ]; then
  echo "checksum verification failed for $archive" >&2
  exit 1
fi

tar -xzf "$tmp_dir/$archive" -C "$tmp_dir"
mkdir -p "$install_dir"
install -m 0755 "$tmp_dir/terminalz" "$install_dir/terminalz"
echo "installed terminalz ${version} to ${install_dir}/terminalz"
case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *) echo "add ${install_dir} to PATH before running terminalz" ;;
esac
echo "next: run 'terminalz bootstrap <claim-url>', then start the agent"
