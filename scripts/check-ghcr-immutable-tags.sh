#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 2 ]]; then
  printf 'usage: %s IMAGE TAG [TAG...]\n' "$0" >&2
  exit 2
fi

image="$1"
shift
for tag in "$@"; do
  output="$(mktemp)"
  if docker buildx imagetools inspect "$image:$tag" >"$output" 2>&1; then
    rm -f "$output"
    printf 'immutable GHCR tag already exists: %s:%s\n' "$image" "$tag" >&2
    exit 1
  fi
  if ! grep -Eiq '(manifest unknown|manifest.*not found|not found)' "$output"; then
    printf 'could not prove GHCR tag absence for %s:%s\n' "$image" "$tag" >&2
    sed -n '1,20p' "$output" >&2
    rm -f "$output"
    exit 1
  fi
  rm -f "$output"
done
printf '%s\n' 'immutable GHCR version and commit tags are absent'
