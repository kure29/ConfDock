#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  printf 'usage: %s SBOM VERSION COMMIT_SHA\n' "$0" >&2
  exit 2
fi

sbom="$1"
version="$2"
revision="$3"
test -s "$sbom"
test -f "$sbom"
test ! -L "$sbom"
jq -e --arg version "$version" --arg revision "$revision" '
  .spdxVersion == "SPDX-2.3" and
  (.creationInfo.creators | any(startswith("Tool: syft-"))) and
  ((.creationInfo.comment | fromjson) as $provenance |
    $provenance.product == "ConfDock" and
    $provenance.version == $version and
    $provenance.revision == $revision and
    $provenance.platform == "linux/amd64" and
    ($provenance.imageId | test("^sha256:[0-9a-f]{64}$"))) and
  (.packages | length > 0) and
  (.packages as $packages |
    [
      {name: "ca-certificates", version: "20250419~deb12u1"},
      {name: "curl", version: "7.88.1-10+deb12u15"},
      {name: "findutils", version: "4.9.0-4"},
      {name: "passwd", version: "1:4.13+dfsg1-1+deb12u2"},
      {name: "sqlite3", version: "3.40.1-2+deb12u2"},
      {name: "tar", version: "1.34+dfsg-1.2+deb12u1"}
    ] | all(. as $required |
      $packages | any(.name == $required.name and .versionInfo == $required.version)))
' "$sbom" >/dev/null
printf 'image SBOM verified: version=%s revision=%s platform=linux/amd64\n' \
  "$version" "$revision"
