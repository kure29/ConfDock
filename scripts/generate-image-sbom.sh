#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 4 ]]; then
  printf 'usage: %s IMAGE OUTPUT VERSION COMMIT_SHA\n' "$0" >&2
  exit 2
fi

image="$1"
output="$2"
version="$3"
revision="$4"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
command -v syft >/dev/null
command -v jq >/dev/null

actual_version="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")"
actual_revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
actual_architecture="$(docker image inspect -f '{{.Architecture}}' "$image")"
image_id="$(docker image inspect -f '{{.Id}}' "$image")"
[[ "$actual_version" == "$version" ]]
[[ "$actual_revision" == "$revision" ]]
[[ "$actual_architecture" == amd64 ]]
[[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]]

output_parent="$(cd "$(dirname "$output")" && pwd)"
output="$output_parent/$(basename "$output")"
[[ ! -e "$output" && ! -L "$output" ]]
raw="$(mktemp "$output_parent/.confdock-sbom.raw.XXXXXX")"
staged="$(mktemp "$output_parent/.confdock-sbom.staged.XXXXXX")"
cleanup() {
  rm -f -- "$raw" "$staged"
}
trap cleanup EXIT

syft scan "docker:$image" -o spdx-json="$raw"
jq --arg version "$version" --arg revision "$revision" \
  --arg platform 'linux/amd64' --arg image_id "$image_id" '
    .creationInfo.comment = ({
      product: "ConfDock",
      version: $version,
      revision: $revision,
      platform: $platform,
      imageId: $image_id
    } | tojson)
  ' "$raw" >"$staged"
chmod 0644 "$staged"
mv -n "$staged" "$output"
"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-image-sbom.sh" \
  "$output" "$version" "$revision"
