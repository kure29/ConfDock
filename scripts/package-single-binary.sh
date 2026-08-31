#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'usage: %s /path/to/confdock output-directory\n' "$0" >&2
  exit 2
fi

binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
output_dir="$2"
test -x "$binary"
mkdir -p "$output_dir"

staging_dir="$(mktemp -d -t confdock-package.XXXXXX)"
verify_dir="$(mktemp -d -t confdock-package-verify.XXXXXX)"
cleanup() {
  rm -rf -- "$staging_dir" "$verify_dir"
}
trap cleanup EXIT

install -m 755 "$binary" "$staging_dir/confdock"
if command -v sha256sum >/dev/null; then
  (cd "$staging_dir" && sha256sum confdock > SHA256SUMS)
else
  (cd "$staging_dir" && shasum -a 256 confdock | sed 's#  confdock$#  confdock#' > SHA256SUMS)
fi

archive="$output_dir/confdock-linux-x86_64.tar.gz"
archive_sha="$output_dir/confdock-linux-x86_64.tar.gz.sha256"
tar -czf "$archive" -C "$staging_dir" confdock SHA256SUMS
if command -v sha256sum >/dev/null; then
  (cd "$output_dir" && sha256sum "$(basename "$archive")" > "$(basename "$archive_sha")")
else
  (cd "$output_dir" && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive_sha")")
fi
(
  cd "$output_dir"
  if command -v sha256sum >/dev/null; then
    sha256sum -c "$(basename "$archive_sha")"
  else
    shasum -a 256 -c "$(basename "$archive_sha")"
  fi
)

# Verify exactly what will be uploaded, including mode, digest, and a
# source-free runtime smoke test from the extracted executable.
tar -xzf "$archive" -C "$verify_dir"
test -x "$verify_dir/confdock"
(cd "$verify_dir" && if command -v sha256sum >/dev/null; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi)
"$(cd "$(dirname "$0")" && pwd)/smoke-single-binary.sh" "$verify_dir/confdock"

printf 'archive=%s\n' "$archive"
printf 'archive_sha256=%s\n' "$(awk '{print $1}' "$archive_sha")"
printf 'binary_sha256=%s\n' "$(awk '{print $1}' "$staging_dir/SHA256SUMS")"
printf 'binary_bytes=%s\n' "$(wc -c < "$verify_dir/confdock" | tr -d ' ')"
