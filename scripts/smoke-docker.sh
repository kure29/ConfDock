#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/docker/compose.yaml"
image="${CONFDOCK_IMAGE:-confdock:local}"
project="${COMPOSE_PROJECT_NAME:-confdock-smoke}"
export COMPOSE_PROJECT_NAME="$project"

for command_name in docker curl jq script; do
  command -v "$command_name" >/dev/null || {
    printf 'required command missing: %s\n' "$command_name" >&2
    exit 1
  }
done

compose=(docker compose -f "$compose_file")
runtime_dir="$(mktemp -d -t confdock-docker-smoke.XXXXXX)"
password="smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
cookie_file="$runtime_dir/cookie"
response_file="$runtime_dir/response.json"
bad_config="$runtime_dir/bad.toml"

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$runtime_dir"
}
trap cleanup EXIT

docker image inspect "$image" >/dev/null

# Verify the final image is the source-free, fixed-UID runtime stage.
printf '%s\n' 'docker smoke: runtime image boundary' >&2
test "$(docker image inspect -f '{{.Config.User}}' "$image")" = '10001:10001'
docker run --rm --platform linux/amd64 --entrypoint /bin/sh "$image" -eu -c '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test "$(stat -c "%u:%g" /var/lib/confdock)" = 10001:10001
  test -f /LICENSE
  test -f /usr/local/bin/confdock
  for path in /src /workspace /usr/local/cargo /usr/local/rustup /usr/local/lib/node_modules /Cargo.toml /web; do
    test ! -e "$path"
  done
  ! command -v node
  ! command -v npm
  ! command -v cargo
  ! command -v rustc
'

printf '%s\n' 'docker smoke: CLI checks' >&2
docker run --rm --platform linux/amd64 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  "$image" --help >/dev/null
docker run --rm --platform linux/amd64 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  "$image" --version >/dev/null
docker run --rm --platform linux/amd64 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  "$image" --config /etc/confdock/config.toml config check >/dev/null

printf '%s\n' 'docker smoke: compose config' >&2
"${compose[@]}" config --quiet

# A malformed config fails closed without changing the persistent volume.
printf '%s\n' 'docker smoke: invalid config' >&2
printf '%s\n' 'listen = "not-an-address"' >"$bad_config"
if "${compose[@]}" run --rm --no-deps -T \
  -v "$bad_config:/etc/confdock/config.toml:ro" confdock \
  --config /etc/confdock/config.toml config check >"$runtime_dir/bad-config.out" 2>&1; then
  printf 'invalid config unexpectedly passed\n' >&2
  exit 1
fi
grep -F 'configuration file' "$runtime_dir/bad-config.out" >/dev/null

# A read-only data directory fails with a clear SQLite-open error instead of
# silently falling back to an ephemeral location.
printf '%s\n' 'docker smoke: read-only data directory' >&2
if docker run --rm --platform linux/amd64 --read-only \
  --mount type=tmpfs,destination=/var/lib/confdock,readonly \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m "$image" \
  --config /etc/confdock/config.toml >"$runtime_dir/read-only-data.out" 2>&1; then
  printf 'read-only data directory unexpectedly passed\n' >&2
  exit 1
fi
grep -F 'SQLite database could not be opened' "$runtime_dir/read-only-data.out" >/dev/null

# Before admin init, a non-interactive serve must fail with the real CLI
# contract. Do not print its output: it can contain deployment paths.
printf '%s\n' 'docker smoke: uninitialized service' >&2
if "${compose[@]}" run --rm --no-deps -T confdock \
  --config /etc/confdock/config.toml >"$runtime_dir/uninitialized.out" 2>&1; then
  printf 'uninitialized service unexpectedly passed\n' >&2
  exit 1
fi
grep -F 'not initialized' "$runtime_dir/uninitialized.out" >/dev/null

# `admin init` requires a TTY. util-linux `script` supplies a disposable PTY
# while the password is piped to it; the password never appears in output.
printf '%s\n' 'docker smoke: admin init' >&2
printf '%s\n%s\n' "$password" "$password" | \
  script -qec "${compose[*]} run --rm -it --no-deps confdock --config /etc/confdock/config.toml admin init" /dev/null \
  >"$runtime_dir/admin-init.out" 2>&1
grep -F 'initialized successfully' "$runtime_dir/admin-init.out" >/dev/null

printf '%s\n' 'docker smoke: start service' >&2
"${compose[@]}" up -d --no-build >/dev/null
for _ in $(seq 1 90); do
  container_id="$("${compose[@]}" ps -q confdock)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$container_id")"
  if [[ "$status" == healthy ]]; then break; fi
  if [[ "$status" == unhealthy ]]; then
    printf 'container healthcheck became unhealthy\n' >&2
    exit 1
  fi
  sleep 1
done
container_id="$("${compose[@]}" ps -q confdock)"
test "$(docker inspect -f '{{.State.Health.Status}}' "$container_id")" = healthy

printf '%s\n' 'docker smoke: HTTP and persistence checks' >&2
base_url='http://127.0.0.1:8787'
curl -fsS "$base_url/healthz" | jq -e '.status == "ok"' >/dev/null
curl -fsS "$base_url/" | grep -F '<div id="root"></div>' >/dev/null

# Login and exercise a protected API without ever echoing the cookie, token,
# password, or response bodies. The created project/revision/settings are then
# checked after a container rebuild against the same named volume.
curl -fsS -c "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg password "$password" '{password:$password}')" \
  "$base_url/api/session" >/dev/null
jq -e '.createdAt != null' "$response_file" >/dev/null

source_b64="$(printf '%s' '{}' | base64 | tr -d '\n')"
curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg source "$source_b64" '{name:"Docker smoke",targetId:"sing-box",fileName:"config.json",source:$source}')" \
  "$base_url/api/projects" >/dev/null
project_id="$(jq -er '.id' "$response_file")"
revision_id="$(jq -er '.currentRevisionId' "$response_file")"

source_b64_v2="$(printf '%s' '{"log":{"level":"info"}}' | base64 | tr -d '\n')"
curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg source "$source_b64_v2" --arg expected "$revision_id" '{source:$source,expectedRevisionId:$expected}')" \
  "$base_url/api/projects/$project_id/revisions" >/dev/null
revision_id="$(jq -er '.project.currentRevisionId' "$response_file")"

curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d '{"publicUrl":"https://docker-smoke.example.test"}' \
  -X PATCH "$base_url/api/settings" >/dev/null
jq -e '.publicUrl == "https://docker-smoke.example.test"' "$response_file" >/dev/null

"${compose[@]}" up -d --force-recreate --no-build >/dev/null
for _ in $(seq 1 90); do
  container_id="$("${compose[@]}" ps -q confdock)"
  status="$(docker inspect -f '{{.State.Health.Status}}' "$container_id")"
  [[ "$status" == healthy ]] && break
  [[ "$status" == unhealthy ]] && { printf 'recreated container unhealthy\n' >&2; exit 1; }
  sleep 1
done
container_id="$("${compose[@]}" ps -q confdock)"
test "$(docker inspect -f '{{.State.Health.Status}}' "$container_id")" = healthy

curl -fsS -b "$cookie_file" "$base_url/api/projects/$project_id" -o "$response_file"
jq -e --arg id "$project_id" --arg rev "$revision_id" \
  '.id == $id and .currentRevisionId == $rev' "$response_file" >/dev/null
curl -fsS -b "$cookie_file" "$base_url/api/settings" | jq -e '.publicUrl == "https://docker-smoke.example.test"' >/dev/null

# The subscription boundary remains unauthenticated while management routes
# remain protected. No token plaintext is created or printed in this smoke.
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/projects")" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/sub/not-a-token")" = 404

printf '%s\n' 'docker smoke: stop and SQLite integrity' >&2
"${compose[@]}" stop -t 30 >/dev/null
test "$(docker inspect -f '{{.State.Status}}' "$container_id")" = exited

# SQLite WAL/SHM and database all live in the named volume. Check integrity
# from a disposable SQLite client container without exposing database bytes.
volume="${project}_confdock-data"
docker run --rm -v "$volume:/var/lib/confdock:ro" debian:bookworm-slim \
  sh -c 'apt-get update >/dev/null 2>&1 && apt-get install --no-install-recommends --yes sqlite3 >/dev/null 2>&1 && sqlite3 /var/lib/confdock/confdock.db "PRAGMA integrity_check;"' \
  | grep -Fx 'ok' >/dev/null

printf 'docker smoke test passed\n'
