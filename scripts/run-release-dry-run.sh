#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 2 ]]; then
  printf 'usage: %s OUTPUT_DIRECTORY LOCAL_IMAGE\n' "$0" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="$1"
image="$2"
version="$(<"$repo_root/VERSION")"
revision="$(git -C "$repo_root" rev-parse HEAD)"
commit_epoch="$(git -C "$repo_root" show -s --format=%ct HEAD)"
build_date="$(date -u -d "@$commit_epoch" '+%Y-%m-%dT%H:%M:%SZ')"

[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
[[ "$image" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
[[ ! -e "$output_dir" && ! -L "$output_dir" ]]
install -d -m 0700 "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
cd "$repo_root"

test "$(node --version)" = v22.14.0
rustc --version | grep -Eq '^rustc 1\.88\.0 \('
cargo --version | grep -Eq '^cargo 1\.88\.0 \('
wasm-bindgen --version | grep -Fx 'wasm-bindgen 0.2.127'
syft version -o json | jq -e '.version == "1.50.0"' >/dev/null

node scripts/check-release-version.mjs
node --test scripts/test-third-party-notices.mjs
node scripts/test-release-contract.mjs
npm ci --prefix web
npm ci --prefix docs

node scripts/generate-third-party-notices.mjs \
  --output "$output_dir/THIRD_PARTY_NOTICES.md"
cmp THIRD_PARTY_NOTICES.md "$output_dir/THIRD_PARTY_NOTICES.md"
chmod 0644 "$output_dir/THIRD_PARTY_NOTICES.md"

bash -n scripts/*.sh
shellcheck scripts/*.sh
./scripts/test-docker-build-guards.sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p confdock-service --features embedded-web

npm run wasm:build --prefix web
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
node scripts/check-web-bundle-attribution.mjs
npm audit --prefix web
npm audit --prefix web --omit=dev

npm run docs:build --prefix docs
npm run docs:audit:test --prefix docs
npm run docs:audit --prefix docs
npm audit --prefix docs --omit=dev

./scripts/build-single-binary.sh
binary="target/confdock-rust-1.88.0/native/release/confdock"
./scripts/smoke-single-binary.sh "$binary"
./scripts/package-docker-bundle.sh "$output_dir/docker"

docker compose --env-file /dev/null -f deploy/docker/compose.yaml \
  --profile setup config --quiet
CONFDOCK_IMAGE="$image" docker compose --env-file /dev/null \
  -f deploy/docker/compose.yaml -f deploy/docker/compose.build.yaml \
  --profile setup config --quiet

docker buildx build \
  --platform linux/amd64 \
  --pull \
  --build-arg "VERSION=$version" \
  --build-arg "VCS_REF=$revision" \
  --build-arg "BUILD_DATE=$build_date" \
  --tag "$image" \
  --load \
  .

test "$(docker image inspect -f '{{.Architecture}}' "$image")" = amd64
test "$(docker image inspect -f '{{.Config.User}}' "$image")" = 10001:10001
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = "$version"
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.created"}}' "$image")" = "$build_date"

# The downloadable executable is copied from the exact final runtime image,
# so the binary Artifact and image cannot silently come from different builds.
image_binary_dir="$output_dir/image-binary"
install -d -m 0700 "$image_binary_dir"
image_container="$(docker create "$image" --version)"
cleanup_image_container() {
  docker rm -f "$image_container" >/dev/null 2>&1 || true
}
trap cleanup_image_container EXIT
docker cp "$image_container:/usr/local/bin/confdock" "$image_binary_dir/confdock"
docker rm "$image_container" >/dev/null
trap - EXIT
chmod 0755 "$image_binary_dir/confdock"
cmp "$image_binary_dir/confdock" <(
  docker run --rm --platform linux/amd64 --entrypoint /bin/sh "$image" \
    -c 'cat /usr/local/bin/confdock'
)
./scripts/package-single-binary.sh "$image_binary_dir/confdock" "$output_dir/binary"

CONFDOCK_IMAGE="$image" ./scripts/smoke-docker.sh
./scripts/generate-image-sbom.sh \
  "$image" "$output_dir/confdock-v${version}-linux-amd64.spdx.json" \
  "$version" "$revision"

find "$output_dir" -type l -print -quit | grep -q . && {
  printf '%s\n' 'release dry-run output contains a symbolic link' >&2
  exit 1
}
if grep -ERiq '(BEGIN .*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|CONFDOCK_BOOTSTRAP_PASSWORD|CONFDOCK_ADMIN_PASSWORD)' "$output_dir"; then
  printf '%s\n' 'release dry-run output contains secret-like content' >&2
  exit 1
fi

git diff --check
git diff --exit-code
git diff --cached --exit-code
[[ -z "$(git status --porcelain=v1 --untracked-files=no)" ]]
printf 'release dry-run passed: version=%s commit=%s platform=linux/amd64\n' \
  "$version" "$revision"
