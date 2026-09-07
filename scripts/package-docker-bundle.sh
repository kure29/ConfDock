#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  printf 'usage: %s output-directory\n' "$0" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(<"$repo_root/VERSION")"
output_dir="$1"
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
archive="$output_dir/confdock-v${version}-docker-amd64.tar.gz"
archive_sha="$archive.sha256"
[[ ! -e "$archive" && ! -L "$archive" && ! -e "$archive_sha" && ! -L "$archive_sha" ]] || {
  printf 'Docker bundle output already exists; refusing to overwrite\n' >&2
  exit 1
}

staging_root="$(mktemp -d -t confdock-docker-bundle.XXXXXX)"
verify_root="$(mktemp -d -t confdock-docker-bundle-verify.XXXXXX)"
bundle_name="confdock-v${version}-docker-amd64"
bundle_dir="$staging_root/$bundle_name"
cleanup() {
  rm -rf -- "$staging_root" "$verify_root"
}
trap cleanup EXIT
install -d -m 0755 "$bundle_dir"
install -m 0644 "$repo_root/deploy/docker/compose.yaml" "$bundle_dir/compose.yaml"
install -m 0644 "$repo_root/deploy/docker/.env.example" "$bundle_dir/.env.example"
install -m 0644 "$repo_root/deploy/docker/config.toml" "$bundle_dir/config.toml"
install -m 0644 "$repo_root/deploy/docker/QUICKSTART.md" "$bundle_dir/README.md"
install -m 0644 "$repo_root/LICENSE" "$bundle_dir/LICENSE"
install -m 0644 "$repo_root/THIRD_PARTY_NOTICES.md" "$bundle_dir/THIRD_PARTY_NOTICES.md"

(
  cd "$bundle_dir"
  sha256sum compose.yaml .env.example config.toml README.md LICENSE THIRD_PARTY_NOTICES.md >SHA256SUMS
  chmod 0644 compose.yaml .env.example config.toml README.md LICENSE THIRD_PARTY_NOTICES.md SHA256SUMS
)
tar -czf "$archive" -C "$staging_root" "$bundle_name"
(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" >"$(basename "$archive_sha")"
  chmod 0644 "$(basename "$archive")" "$(basename "$archive_sha")"
  sha256sum -c "$(basename "$archive_sha")"
)

tar -xzf "$archive" -C "$verify_root"
verify_dir="$verify_root/$bundle_name"
test -d "$verify_dir" && test ! -L "$verify_dir"
expected_entries=$'.env.example\nLICENSE\nREADME.md\nSHA256SUMS\nTHIRD_PARTY_NOTICES.md\ncompose.yaml\nconfig.toml'
actual_entries="$(find "$verify_dir" -mindepth 1 -maxdepth 1 -exec basename {} \; | LC_ALL=C sort)"
[[ "$actual_entries" == "$expected_entries" ]] || {
  printf 'Docker bundle contains an unexpected entry\n' >&2
  exit 1
}
if find "$verify_dir" -mindepth 1 \( -type l -o -type d \) -print -quit | grep -q .; then
  printf 'Docker bundle contains a link or nested directory\n' >&2
  exit 1
fi
(
  cd "$verify_dir"
  sha256sum -c SHA256SUMS
  docker compose --env-file /dev/null -f compose.yaml --profile setup config --quiet
)
if grep -ERiq '(BEGIN .*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_|PASSWORD[[:space:]]*=|TOKEN[[:space:]]*=)' "$verify_dir"; then
  printf 'Docker bundle contains secret-like content\n' >&2
  exit 1
fi
grep -F "ghcr.io/kure29/confdock:$version" "$verify_dir/compose.yaml" >/dev/null
# shellcheck disable=SC2016 # Compose interpolation must remain literal in the bundle.
grep -F '127.0.0.1:${CONFDOCK_HOST_PORT:-8787}:8787' "$verify_dir/compose.yaml" >/dev/null
grep -F 'external: true' "$verify_dir/compose.yaml" >/dev/null

printf 'docker_bundle=%s\n' "$archive"
printf 'docker_bundle_sha256=%s\n' "$(awk '{print $1}' "$archive_sha")"
