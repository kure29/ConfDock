#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 3 ]]; then
  printf 'usage: %s VERSION COMMIT_SHA CONFIRMATION\n' "$0" >&2
  exit 2
fi

version="$1"
commit_sha="$2"
confirmation="$3"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'release preflight: %s\n' "$*" >&2
  exit 1
}

[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail 'version must be a stable SemVer without a v prefix'
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'commit SHA must be 40 lowercase hexadecimal characters'
[[ "$confirmation" == "release-v$version" ]] || fail 'confirmation string does not match release-vVERSION'
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || fail 'manual Release workflow must run from main'
[[ "${GITHUB_SHA:-}" == "$commit_sha" ]] || fail 'input SHA must equal the selected main workflow ref SHA'
[[ "$(git rev-parse HEAD)" == "$commit_sha" ]] || fail 'checkout HEAD does not equal input SHA'
[[ "$(git rev-parse origin/main)" == "$commit_sha" ]] || fail 'origin/main does not equal input SHA'
git merge-base --is-ancestor "$commit_sha" origin/main \
  || fail 'input SHA is not contained in origin/main'
[[ "$(<VERSION)" == "$version" ]] || fail 'VERSION does not equal the requested release version'
node scripts/check-release-version.mjs

tag="v$version"
if git show-ref --verify --quiet "refs/tags/$tag"; then
  fail "local checkout already contains tag $tag"
fi
set +e
remote_tag_output="$(git ls-remote --exit-code --tags origin "refs/tags/$tag" 2>&1)"
remote_tag_status=$?
set -e
case "$remote_tag_status" in
  0) fail "remote tag already exists: $tag" ;;
  2) ;;
  *) fail "could not prove remote tag absence: $remote_tag_output" ;;
esac

release_error="$(mktemp)"
trap 'rm -f "$release_error"' EXIT
if gh api "repos/${GITHUB_REPOSITORY:?}/releases/tags/$tag" >/dev/null 2>"$release_error"; then
  fail "GitHub Release already exists: $tag"
fi
grep -F 'HTTP 404' "$release_error" >/dev/null \
  || fail "could not prove GitHub Release absence: $(<"$release_error")"

[[ -z "$(git status --porcelain=v1 --untracked-files=all)" ]] \
  || fail 'checkout is not clean before release validation'
printf 'release preflight passed: version=%s commit=%s tag=%s\n' \
  "$version" "$commit_sha" "$tag"
