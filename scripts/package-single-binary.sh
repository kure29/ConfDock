#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'usage: %s /path/to/confdock output-directory\n' "$0" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
output_dir="$2"
version="$(<"$repo_root/VERSION")"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
test -x "$binary"
command -v file >/dev/null

binary_description="$(file -b "$binary")"
[[ "$binary_description" == *ELF\ 64-bit* && "$binary_description" == *x86-64* ]] || {
  printf 'release binary is not a Linux x86-64 ELF: %s\n' "$binary_description" >&2
  exit 1
}
[[ "$($binary --version)" == "confdock $version" ]] || {
  printf 'release binary version does not match VERSION=%s\n' "$version" >&2
  exit 1
}

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
archive="$output_dir/confdock-v${version}-linux-x86_64.tar.gz"
archive_sha="$archive.sha256"
[[ ! -e "$archive" && ! -L "$archive" && ! -e "$archive_sha" && ! -L "$archive_sha" ]] || {
  printf 'release output already exists; refusing to overwrite\n' >&2
  exit 1
}

staging_dir="$(mktemp -d -t confdock-package.XXXXXX)"
verify_dir="$(mktemp -d -t confdock-package-verify.XXXXXX)"
cleanup() {
  rm -rf -- "$staging_dir" "$verify_dir"
}
trap cleanup EXIT

install -m 0755 "$binary" "$staging_dir/confdock"
install -m 0644 "$repo_root/packaging/config.toml" "$staging_dir/config.toml"
install -m 0644 "$repo_root/LICENSE" "$staging_dir/LICENSE"
install -m 0644 "$repo_root/THIRD_PARTY_NOTICES.md" "$staging_dir/THIRD_PARTY_NOTICES.md"

(
  cd "$staging_dir"
  sha256sum confdock config.toml LICENSE THIRD_PARTY_NOTICES.md >SHA256SUMS
  chmod 0644 config.toml LICENSE THIRD_PARTY_NOTICES.md SHA256SUMS
)

tar -czf "$archive" -C "$staging_dir" \
  confdock config.toml LICENSE THIRD_PARTY_NOTICES.md SHA256SUMS
(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" >"$(basename "$archive_sha")"
  chmod 0644 "$(basename "$archive")" "$(basename "$archive_sha")"
  sha256sum -c "$(basename "$archive_sha")"
)

# The verification directory itself is private (mktemp under umask 077). Extract
# with no permission mask so the following mode checks validate the tar headers,
# rather than modes narrowed by this script's process-wide umask.
(
  umask 000
  tar -xzf "$archive" -C "$verify_dir"
)
expected_entries=$'LICENSE\nSHA256SUMS\nTHIRD_PARTY_NOTICES.md\nconfdock\nconfig.toml'
actual_entries="$(find "$verify_dir" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)"
[[ "$actual_entries" == "$expected_entries" ]] || {
  printf 'release archive contains an unexpected entry\n' >&2
  exit 1
}
if find "$verify_dir" -mindepth 1 \( -type l -o -type d \) -print -quit | grep -q .; then
  printf 'release archive contains a link or nested directory\n' >&2
  exit 1
fi
for release_file in confdock config.toml LICENSE THIRD_PARTY_NOTICES.md SHA256SUMS; do
  test -f "$verify_dir/$release_file"
  test ! -L "$verify_dir/$release_file"
done
[[ "$(stat -c '%a' "$verify_dir/confdock")" == 755 ]]
for release_file in config.toml LICENSE THIRD_PARTY_NOTICES.md SHA256SUMS; do
  [[ "$(stat -c '%a' "$verify_dir/$release_file")" == 644 ]]
done
(
  cd "$verify_dir"
  sha256sum -c SHA256SUMS
)

for forbidden in .git Cargo.toml Cargo.lock node_modules target web docs '*.db' '*.db-wal' '*.db-shm'; do
  if find "$verify_dir" -name "$forbidden" -print -quit | grep -q .; then
    printf 'release archive contains forbidden content: %s\n' "$forbidden" >&2
    exit 1
  fi
done
"$repo_root/scripts/smoke-single-binary.sh" "$verify_dir/confdock"

printf 'archive=%s\n' "$archive"
printf 'archive_sha256=%s\n' "$(awk '{print $1}' "$archive_sha")"
printf 'binary_sha256=%s\n' "$(awk '$2 == "confdock" {print $1}' "$staging_dir/SHA256SUMS")"
printf 'binary_bytes=%s\n' "$(wc -c <"$verify_dir/confdock" | tr -d ' ')"
