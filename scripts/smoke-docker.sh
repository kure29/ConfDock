#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/docker/compose.yaml"
image="${CONFDOCK_IMAGE:-confdock:local}"
# Never inherit a caller's production Compose identity or volume. The smoke
# owns all of these values and creates fresh identities below; only the image
# reference is an intentional input.
set +x
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR \
  COMPOSE_DISABLE_ENV_FILE \
  CONFDOCK_VOLUME_NAME CONFDOCK_CONFIG_PATH CONFDOCK_HOST_PORT CONFDOCK_ENV_FILE \
  CONFDOCK_COMPOSE_FILE CONFDOCK_RESTORE_VOLUME_NAME CONFDOCK_RESTORE_COMPOSE_PROJECT \
  CONFDOCK_RESTORE_SMOKE_RUN CONFDOCK_HOST_UID CONFDOCK_HOST_GID \
  CONFDOCK_SMOKE_RUN CONFDOCK_SMOKE_PROJECT CONFDOCK_BOOTSTRAP_PASSWORD \
  CONFDOCK_ADMIN_PASSWORD CONFDOCK_SUB_TOKEN
IFS=$'\n\t'
export LC_ALL=C
export COMPOSE_DISABLE_ENV_FILE=1
runtime_dir="$(mktemp -d -t confdock-docker-smoke.XXXXXX)"
reserved_volume_created=0
reserved_volume_name=''
reserved_volume_run=''
reserved_volume_created_at=''
# No Docker resource exists yet.  Once the random volume is reserved this trap
# is upgraded to the label-scoped cleanup below; until then it can only remove
# this invocation's private temporary directory and (if needed) its marker-
# matching reservation.
cleanup_preflight() {
  set +e
  if [[ "$reserved_volume_created" == 1 && -n "$reserved_volume_name" \
    && -n "$reserved_volume_run" ]] && command -v docker >/dev/null 2>&1; then
    current_run="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.run"}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    current_project="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    current_kind="$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    current_created_at="$(docker volume inspect -f '{{.CreatedAt}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    if [[ "$current_run" == "$reserved_volume_run" \
      && "$current_project" == "${smoke_project:-}" \
      && "$current_kind" == confdock-data \
      && -n "$current_created_at" \
      && ( -z "${reserved_volume_created_at:-}" \
        || "$current_created_at" == "$reserved_volume_created_at" ) ]]; then
      docker volume rm "$reserved_volume_name" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf -- "$runtime_dir"
}
trap cleanup_preflight EXIT
password="smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
cookie_file="$runtime_dir/cookie"
restore_cookie_file="$runtime_dir/restore-cookie"
response_file="$runtime_dir/response.json"
bad_config="$runtime_dir/bad.toml"
subscription_file="$runtime_dir/subscription.bin"
expected_subscription="$runtime_dir/expected-subscription.bin"
subscription_headers="$runtime_dir/subscription.headers"

fail() {
  printf 'docker smoke: %s\n' "$*" >&2
  exit 1
}

for command_name in awk base64 chmod cmp cp curl docker find grep install jq mkdir mktemp od \
  python3 rm script sed sha256sum sleep sort stat tar tr; do
  command -v "$command_name" >/dev/null || fail "required command missing: $command_name"
done
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
docker image inspect "$image" >/dev/null || fail "image is unavailable: $image"

new_suffix() {
  od -An -N8 -tx1 /dev/urandom | tr -d ' \n'
}

timestamp_ns() {
  local value
  value="$(date +%s%N)"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s' "$value"
  else
    printf '%s000000000' "$(date +%s)"
  fi
}
smoke_run="confdock-smoke-run-$(new_suffix)"
export CONFDOCK_SMOKE_RUN="$smoke_run"

assert_run_label_unused() {
  if [[ -n "$(docker ps -aq --filter "label=com.confdock.smoke.run=$smoke_run")" \
    || -n "$(docker volume ls -q --filter "label=com.confdock.smoke.run=$smoke_run")" \
    || -n "$(docker network ls -q --filter "label=com.confdock.smoke.run=$smoke_run")" ]]; then
    return 1
  fi
}

choose_identity() {
  local _attempt suffix candidate_project candidate_volume
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    suffix="$(new_suffix)"
    candidate_project="confdock-smoke-$suffix"
    candidate_volume="confdock-smoke-data-$suffix"
    if docker volume inspect "$candidate_volume" >/dev/null 2>&1; then
      continue
    fi
    if [[ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$candidate_project")" \
      || -n "$(docker ps -aq --filter "name=^/${candidate_project}-")" ]]; then
      continue
    fi
    if [[ -n "$(docker network ls -q --filter "label=com.docker.compose.project=$candidate_project")" \
      || -n "$(docker network ls -q --filter "name=^${candidate_project}_default$")" \
      || -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$candidate_project")" ]]; then
      continue
    fi
    smoke_project="$candidate_project"
    smoke_volume="$candidate_volume"
    return 0
  done
  return 1
}

choose_project() {
  local _attempt suffix candidate_project
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    suffix="$(new_suffix)"
    candidate_project="confdock-smoke-$suffix"
    if [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$candidate_project")" \
      && -z "$(docker ps -aq --filter "name=^/${candidate_project}-")" \
      && -z "$(docker network ls -q --filter "label=com.docker.compose.project=$candidate_project")" \
      && -z "$(docker network ls -q --filter "name=^${candidate_project}_default$")" \
      && -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$candidate_project")" ]]; then
      printf '%s' "$candidate_project"
      return 0
    fi
  done
  return 1
}

choose_restore_volume() {
  local _attempt suffix candidate_volume
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    suffix="$(new_suffix)"
    candidate_volume="confdock-restore-$suffix"
    if ! docker volume inspect "$candidate_volume" >/dev/null 2>&1; then
      printf '%s' "$candidate_volume"
      return 0
    fi
  done
  return 1
}

assert_project_unused() {
  local project_name="$1"
  local ignored_volume="${2:-}"

  # `compose run` may create the project's default network (and, briefly, a
  # one-off container) before the long-running service starts.  Those
  # resources carry the smoke run label from compose.yaml and are ours.  Any
  # resource that has the project identity without this exact run marker is an
  # external collision and must stop the test before `up` can attach to it.
  local container_ids container_id container_run container_project
  container_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project_name")" \
    || return 1
  container_ids+="$(docker ps -aq --filter "name=^/${project_name}-")" \
    || return 1
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    container_run="$(docker inspect -f '{{index .Config.Labels "com.confdock.smoke.run"}}' \
      "$container_id" 2>/dev/null)" || return 1
    container_project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' \
      "$container_id" 2>/dev/null)" || return 1
    [[ "$container_run" == "$smoke_run" && "$container_project" == "$project_name" ]] \
      || return 1
  done < <(printf '%s\n' "$container_ids" | awk 'NF && !seen[$0]++')

  local network_ids network_id network_run network_project network_kind network_name
  network_ids="$(docker network ls -q --filter "label=com.docker.compose.project=$project_name")" \
    || return 1
  network_ids+="$(docker network ls -q --filter "name=^${project_name}_default$")" \
    || return 1
  while IFS= read -r network_id; do
    [[ -n "$network_id" ]] || continue
    network_run="$(docker network inspect -f '{{index .Labels "com.confdock.smoke.run"}}' \
      "$network_id" 2>/dev/null)" || return 1
    network_project="$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' \
      "$network_id" 2>/dev/null)" || return 1
    network_kind="$(docker network inspect -f '{{index .Labels "com.docker.compose.network"}}' \
      "$network_id" 2>/dev/null)" || return 1
    network_name="$(docker network inspect -f '{{.Name}}' "$network_id" 2>/dev/null)" \
      || return 1
    [[ "$network_run" == "$smoke_run" && "$network_project" == "$project_name" \
      && "$network_kind" == default && "$network_name" == "${project_name}_default" ]] \
      || return 1
  done < <(printf '%s\n' "$network_ids" | awk 'NF && !seen[$0]++')

  local project_volumes volume_name volume_run volume_project volume_kind
  project_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$project_name")" \
    || return 1
  while IFS= read -r volume_name; do
    [[ -n "$volume_name" ]] || continue
    volume_run="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.run"}}' \
      "$volume_name" 2>/dev/null)" || return 1
    volume_project="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' \
      "$volume_name" 2>/dev/null)" || return 1
    volume_kind="$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' \
      "$volume_name" 2>/dev/null)" || return 1
    [[ "$volume_name" == "$ignored_volume" && "$volume_run" == "$smoke_run" \
      && "$volume_project" == "$project_name" && "$volume_kind" == confdock-data ]] \
      || return 1
  done <<<"$project_volumes"
}

choose_identity || fail 'could not allocate an unused smoke project and volume'
assert_run_label_unused || fail 'smoke run label is already in use'
export CONFDOCK_SMOKE_PROJECT="$smoke_project"
smoke_helper_args=()
set_helper_project() {
  local project_name="$1"
  smoke_helper_args=(
    --label "com.confdock.smoke.run=$smoke_run"
    --label 'com.confdock.smoke.kind=helper'
    --label "com.docker.compose.project=$project_name"
  )
}
set_helper_project "$smoke_project"
# Disposable inspection helpers do not need the default Docker capability set.
# The one ownership-preparation helper adds back only the capabilities it
# needs to change the empty external volume's mountpoint metadata.
smoke_helper_security=(--cap-drop ALL --security-opt no-new-privileges)

# Compose treats the data volume as an external resource so that a project-name
# change cannot trigger a new volume or a label mismatch. Reserve the random
# name ourselves and verify the marker immediately; if another process wins the
# race, never attach to its volume.
if docker volume inspect "$smoke_volume" >/dev/null 2>&1; then
  fail 'smoke volume became occupied during reservation'
fi
# Record the ownership marker before the create call. If the client is
# interrupted in the tiny window after Docker creates the volume, the preflight
# trap can still remove it only when all of the run/project/kind labels match.
reserved_volume_created=1
reserved_volume_name="$smoke_volume"
reserved_volume_run="$smoke_run"
docker volume create \
  --label "com.confdock.smoke.run=$smoke_run" \
  --label "com.docker.compose.project=$smoke_project" \
  --label 'com.docker.compose.volume=confdock-data' \
  "$smoke_volume" >/dev/null \
  || fail 'could not reserve the smoke volume'
verified_volume_name="$(docker volume inspect -f '{{.Name}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_run="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.run"}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_project="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_kind="$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' "$smoke_volume" 2>/dev/null || true)"
reserved_volume_created_at="$(docker volume inspect -f '{{.CreatedAt}}' "$smoke_volume" 2>/dev/null || true)"
[[ "$verified_volume_name" == "$smoke_volume" && "$verified_volume_run" == "$smoke_run" \
  && "$verified_volume_project" == "$smoke_project" \
  && "$verified_volume_kind" == confdock-data \
  && -n "$reserved_volume_created_at" ]] \
  || fail 'smoke volume reservation labels could not be verified'

# External volumes do not receive the image directory's ownership through
# Compose. Prepare the empty test volume explicitly before the non-root service
# ever opens SQLite; only the mountpoint metadata is changed.
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --platform linux/amd64 --user 0:0 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$smoke_volume,destination=/var/lib/confdock,volume-nocopy" \
  "$image" -eu -c \
  'test -d /var/lib/confdock
   chown 10001:10001 /var/lib/confdock
   chmod 700 /var/lib/confdock' \
  || fail 'could not prepare the smoke volume ownership'

alt_project=''
missing_project=''
restore_project=''
restore_volume=''

is_owned_project() {
  [[ "$1" == "$smoke_project" ]] && return 0
  [[ -n "$alt_project" && "$1" == "$alt_project" ]] && return 0
  [[ -n "$missing_project" && "$1" == "$missing_project" ]] && return 0
  [[ -n "$restore_project" && "$1" == "$restore_project" ]] && return 0
  return 1
}

is_owned_volume() {
  [[ "$1" == "$smoke_volume" ]] && return 0
  [[ -n "$restore_volume" && "$1" == "$restore_volume" ]] && return 0
  return 1
}

config_file="$runtime_dir/config.toml"
cp "$repo_root/deploy/docker/config.toml" "$config_file"
chmod 0644 "$config_file"
original_config_copy="$runtime_dir/original-config.toml"
cp "$config_file" "$original_config_copy"
export CONFDOCK_CONFIG_PATH="$config_file"
export CONFDOCK_VOLUME_NAME="$smoke_volume"
export CONFDOCK_HOST_PORT=8787
export COMPOSE_PROJECT_NAME="$smoke_project"

# `COMPOSE_DISABLE_ENV_FILE` is supported by current Compose releases; the
# explicit empty env file also prevents an older client from loading a
# production .env from the caller's working directory.
compose=(docker compose --env-file /dev/null --project-name "$smoke_project" -f "$compose_file")

cleanup_resources() {
  set +e
  # A broad Compose teardown that removes volumes is intentionally not used:
  # the physical volume name is user-controlled and could point at production data. Every
  # resource created by this script carries the unpredictable run label.  Remove
  # only resources carrying that label, and require the expected Compose kind
  # before touching a volume.
  container_names="$(docker ps -aq --filter "label=com.confdock.smoke.run=$smoke_run" 2>/dev/null || true)"
  if [[ -n "$container_names" ]]; then
    while IFS= read -r container_name; do
      [[ -n "$container_name" ]] || continue
      container_project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' \
        "$container_name" 2>/dev/null || true)"
      container_kind="$(docker inspect -f '{{index .Config.Labels "com.confdock.smoke.kind"}}' \
        "$container_name" 2>/dev/null || true)"
      if [[ "$container_kind" == helper ]]; then
        # A run label is intentionally unpredictable, but it is still paired
        # with one of this invocation's project labels before removing a
        # helper. This prevents a separately-created container carrying a
        # copied label from being treated as ours.
        is_owned_project "$container_project" || continue
        docker rm -f "$container_name" >/dev/null 2>&1 || true
        continue
      fi
      is_owned_project "$container_project" || continue
      container_service="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' \
        "$container_name" 2>/dev/null || true)"
      [[ "$container_service" == confdock ]] || continue
      docker rm -f "$container_name" >/dev/null 2>&1 || true
    done <<<"$container_names"
  fi

  network_names="$(docker network ls -q --filter "label=com.confdock.smoke.run=$smoke_run" 2>/dev/null || true)"
  if [[ -n "$network_names" ]]; then
    while IFS= read -r network_name; do
      [[ -n "$network_name" ]] || continue
      network_project="$(docker network inspect -f '{{index .Labels "com.docker.compose.project"}}' \
        "$network_name" 2>/dev/null || true)"
      is_owned_project "$network_project" || continue
      network_kind="$(docker network inspect -f '{{index .Labels "com.docker.compose.network"}}' \
        "$network_name" 2>/dev/null || true)"
      [[ "$network_kind" == default ]] || continue
      network_actual_name="$(docker network inspect -f '{{.Name}}' "$network_name" 2>/dev/null || true)"
      [[ "$network_actual_name" == "${network_project}_default" ]] || continue
      docker network rm "$network_name" >/dev/null 2>&1 || true
    done <<<"$network_names"
  fi

  volume_names="$(docker volume ls -q --filter "label=com.confdock.smoke.run=$smoke_run" 2>/dev/null || true)"
  if [[ -n "$volume_names" ]]; then
    while IFS= read -r volume_name; do
      [[ -n "$volume_name" ]] || continue
      is_owned_volume "$volume_name" || continue
      volume_kind="$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' \
        "$volume_name" 2>/dev/null || true)"
      [[ "$volume_kind" == confdock-data ]] || continue
      volume_project="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' \
        "$volume_name" 2>/dev/null || true)"
      is_owned_project "$volume_project" || continue
      volume_created_at="$(docker volume inspect -f '{{.CreatedAt}}' \
        "$volume_name" 2>/dev/null || true)"
      if [[ "$volume_name" == "$smoke_volume" \
        && "$volume_created_at" != "${reserved_volume_created_at:-}" ]]; then
        continue
      fi
      docker volume rm "$volume_name" >/dev/null 2>&1 || true
    done <<<"$volume_names"
  fi
}

resources_clean() {
  local remaining
  if ! remaining="$(docker ps -aq --filter "label=com.confdock.smoke.run=$smoke_run" 2>/dev/null)"; then
    return 1
  fi
  [[ -z "$remaining" ]] || return 1
  if ! remaining="$(docker network ls -q --filter "label=com.confdock.smoke.run=$smoke_run" 2>/dev/null)"; then
    return 1
  fi
  [[ -z "$remaining" ]] || return 1
  if ! remaining="$(docker volume ls -q --filter "label=com.confdock.smoke.run=$smoke_run" 2>/dev/null)"; then
    return 1
  fi
  [[ -z "$remaining" ]] || return 1
}

cleanup() {
  status="$?"
  set +e
  cleanup_resources
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if ! resources_clean; then
      printf '%s\n' 'docker smoke: run-labelled resources remain after cleanup' >&2
      status=1
    fi
  fi
  rm -rf -- "$runtime_dir"
  exit "$status"
}
trap cleanup EXIT

if [[ -n "$(docker ps --filter publish=8787 -q)" ]]; then
  fail 'host port 127.0.0.1:8787 is already in use'
fi

printf '%s\n' 'docker smoke: compose contract' >&2
compose_json="$runtime_dir/compose.json"
"${compose[@]}" config --format json >"$compose_json"
if ! jq -e --arg volume "$smoke_volume" --arg config "$CONFDOCK_CONFIG_PATH" '
  .services.confdock.user == "10001:10001" and
  .services.confdock.platform == "linux/amd64" and
  .services.confdock.read_only == true and
  .services.confdock.init == true and
  .services.confdock.restart == "unless-stopped" and
  .services.confdock.stop_grace_period == "30s" and
  .services.confdock.stop_signal == "SIGTERM" and
  (.services.confdock.ports | length == 1) and
  .services.confdock.ports[0].host_ip == "127.0.0.1" and
  (.services.confdock.ports[0].target == 8787) and
  (.services.confdock.ports[0].published == "8787") and
  .services.confdock.ports[0].protocol == "tcp" and
  (.services.confdock.tmpfs | any(. == "/tmp:rw,noexec,nosuid,nodev,size=16m")) and
  ((.services.confdock.cap_drop // []) | index("ALL") != null) and
  ((.services.confdock.cap_add // []) | length == 0) and
  ((.services.confdock.security_opt // []) | index("no-new-privileges:true") != null) and
  .services.confdock.healthcheck.test == ["CMD","curl","--fail","--silent","--show-error","http://127.0.0.1:8787/healthz"] and
  ((.services.confdock.volumes // []) | any(.type == "volume" and .source == "confdock-data" and .target == "/var/lib/confdock" and ((.read_only // false) == false) and .volume.nocopy == true)) and
  ((.services.confdock.volumes // []) | any(.type == "bind" and .target == "/etc/confdock/config.toml" and .source == $config and .read_only == true and ((.bind.create_host_path == false) or ((.bind // {}) | has("create_host_path") | not)))) and
  ((.services.confdock.volumes // []) | all(.type != "volume" or (.source == "confdock-data" and .target == "/var/lib/confdock"))) and
  .volumes["confdock-data"].name == $volume and
  .volumes["confdock-data"].external == true and
  ((.services.confdock.volumes // []) | all(.target != "/var/run/docker.sock" and .source != "/var/run/docker.sock")) and
  ((.services.confdock.privileged // false) == false) and
  ((.services.confdock.network_mode // "") != "host")
' "$compose_json" >/dev/null; then
  # Keep a failed contract diagnosable without dumping arbitrary environment
  # values or any service output that could contain credentials.
  jq '{service: (.services.confdock | {user, platform, read_only, init, restart,
      stop_grace_period, stop_signal, ports, tmpfs, cap_drop, cap_add,
      security_opt, healthcheck, volumes, privileged, network_mode}),
      volume: .volumes["confdock-data"], network: .networks.default}' \
    "$compose_json" >&2 || true
  fail 'Compose contract assertion failed'
fi

printf '%s\n' 'docker smoke: runtime image boundary' >&2
test "$(docker image inspect -f '{{.Config.User}}' "$image")" = '10001:10001'
test "$(docker image inspect -f '{{.Architecture}}' "$image")" = 'amd64'
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" --platform linux/amd64 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 \
  --network none --entrypoint /bin/sh "$image" -eu -c '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test "$(stat -c "%u:%g" /var/lib/confdock)" = 10001:10001
  test -f /LICENSE
  test -f /usr/local/bin/confdock
  command -v find >/dev/null
  command -v sha256sum >/dev/null
  command -v sqlite3 >/dev/null
  command -v sort >/dev/null
  command -v tar >/dev/null
  for path in /src /workspace /target /app /repo /usr/local/cargo /usr/local/rustup \
    /root/.cargo /root/.rustup /usr/local/lib/node_modules /node_modules \
    /Cargo.toml /Cargo.lock /rust-toolchain.toml /package.json /package-lock.json \
    /web /docs /.git; do
    test ! -e "$path"
  done
  ! command -v node
  ! command -v npm
  ! command -v cargo
  ! command -v rustc
  ! command -v rustup
  ! command -v wasm-bindgen
  ! command -v git
  ! command -v make
  ! command -v cc
  ! command -v gcc
'

printf '%s\n' 'docker smoke: CLI checks' >&2
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" --platform linux/amd64 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  "$image" --help >/dev/null
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" --platform linux/amd64 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  "$image" --version >/dev/null
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" --platform linux/amd64 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  "$image" --config /etc/confdock/config.toml config check >/dev/null

printf '%s\n' 'docker smoke: invalid config and missing initialization' >&2
missing_config="$runtime_dir/missing-config.toml"
if CONFDOCK_CONFIG_PATH="$missing_config" "${compose[@]}" run --rm --no-deps -T confdock \
  --config /etc/confdock/config.toml config check >"$runtime_dir/missing-config.out" 2>&1; then
  fail 'missing configuration unexpectedly passed'
fi
if [[ -e "$missing_config" || -L "$missing_config" ]]; then
  fail 'Compose created a host path for a missing configuration'
fi
grep -Eiq '(bind source path does not exist|does not exist|no such file)' \
  "$runtime_dir/missing-config.out" || fail 'missing configuration error was not actionable'

printf '%s\n' 'listen = "not-an-address"' >"$bad_config"
if CONFDOCK_CONFIG_PATH="$bad_config" "${compose[@]}" run --rm --no-deps -T confdock \
  --config /etc/confdock/config.toml config check >"$runtime_dir/bad-config.out" 2>&1; then
  fail 'invalid config unexpectedly passed'
fi
grep -F 'configuration file' "$runtime_dir/bad-config.out" >/dev/null

if docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --read-only \
  --mount type=tmpfs,destination=/var/lib/confdock,readonly \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --network none "$image" \
  --config /etc/confdock/config.toml >"$runtime_dir/read-only-data.out" 2>&1; then
  fail 'read-only data directory unexpectedly passed'
fi
grep -Eq 'SQLite (database could not be opened|parent directory could not be created|migrations could not be applied|database files)' \
  "$runtime_dir/read-only-data.out" >/dev/null

if "${compose[@]}" run --rm --no-deps -T confdock \
  --config /etc/confdock/config.toml >"$runtime_dir/uninitialized.out" 2>&1; then
  fail 'uninitialized service unexpectedly passed'
fi
grep -F 'not initialized' "$runtime_dir/uninitialized.out" >/dev/null

printf '%s\n' 'docker smoke: admin init failure modes' >&2
if "${compose[@]}" run --rm --no-deps -T confdock \
  --config /etc/confdock/config.toml admin init >"$runtime_dir/admin-no-tty.out" 2>&1; then
  fail 'admin init unexpectedly accepted a non-TTY'
fi
grep -F 'interactive terminal' "$runtime_dir/admin-no-tty.out" >/dev/null

run_admin_init() {
  local first_password="$1" second_password="$2" output_file="$3" compose_command
  compose_command="$(printf '%q ' "${compose[@]}")run --rm -it --no-deps confdock --config /etc/confdock/config.toml admin init"
  printf '%s\n%s\n' "$first_password" "$second_password" | \
    script -qec "$compose_command" /dev/null >"$output_file" 2>&1
}

if run_admin_init "$password" "${password}-mismatch" "$runtime_dir/admin-mismatch.out"; then
  fail 'mismatched admin init unexpectedly passed'
fi
grep -F 'passwords do not match' "$runtime_dir/admin-mismatch.out" >/dev/null

run_admin_init "$password" "$password" "$runtime_dir/admin-init.out" \
  || fail 'admin init failed in a TTY'
grep -F 'initialized successfully' "$runtime_dir/admin-init.out" >/dev/null

if run_admin_init "$password" "$password" "$runtime_dir/admin-repeat.out"; then
  fail 'repeat admin init unexpectedly passed'
fi
grep -F 'already initialized' "$runtime_dir/admin-repeat.out" >/dev/null

wait_healthy() {
  local _attempt status
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 \
    21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 \
    41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 \
    61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 \
    81 82 83 84 85 86 87 88 89 90; do
    container_id="$("${compose[@]}" ps -q confdock)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect -f '{{.State.Health.Status}}' "$container_id")"
      [[ "$status" == healthy ]] && return 0
      [[ "$status" == unhealthy ]] && return 1
    fi
    sleep 1
  done
  return 1
}

assert_runtime_contract() {
  local inspect_file
  inspect_file="$runtime_dir/inspect-$(printf '%s' "${COMPOSE_PROJECT_NAME}" | tr -c '[:alnum:]_.-' '_').json"
  docker inspect "$container_id" >"$inspect_file"
  jq -e --arg volume "$CONFDOCK_VOLUME_NAME" --arg config "$CONFDOCK_CONFIG_PATH" '
    .[0].Config.User == "10001:10001" and
    .[0].HostConfig.ReadonlyRootfs == true and
    ((.[0].HostConfig.CapDrop // []) | index("ALL") != null) and
    ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true") != null) and
    .[0].HostConfig.RestartPolicy.Name == "unless-stopped" and
    .[0].HostConfig.Init == true and
    ((.[0].HostConfig.Tmpfs["/tmp"] // "") | contains("noexec,nosuid,nodev")) and
    ((.[0].HostConfig.Tmpfs // {}) | keys == ["/tmp"]) and
    ((.[0].HostConfig.PortBindings // {}) | keys | length == 1) and
    ((.[0].HostConfig.PortBindings["8787/tcp"] // []) | length == 1) and
    (.[0].HostConfig.PortBindings["8787/tcp"][0].HostIp == "127.0.0.1") and
    (.[0].HostConfig.PortBindings["8787/tcp"][0].HostPort == "8787") and
    (.[0].HostConfig.PublishAllPorts == false) and
    (.[0].HostConfig.StopTimeout == 30 or .[0].Config.StopTimeout == 30) and
    .[0].Config.StopSignal == "SIGTERM" and
    .[0].Config.Healthcheck.Test == ["CMD","curl","--fail","--silent","--show-error","http://127.0.0.1:8787/healthz"] and
    .[0].HostConfig.Privileged == false and
    .[0].HostConfig.NetworkMode != "host" and
    ((.[0].HostConfig.CapAdd // []) | length == 0) and
    ((.[0].Mounts // []) | all(.[];
      .Destination == "/var/lib/confdock" or
      .Destination == "/etc/confdock/config.toml" or
      .Destination == "/tmp" or
      .Destination == "/etc/hostname" or
      .Destination == "/etc/hosts" or
      .Destination == "/etc/resolv.conf")) and
    ((.[0].Mounts // []) | length >= 2) and
    ((.[0].Mounts // []) | map(select(.Destination == "/var/lib/confdock")) | length == 1) and
    ((.[0].Mounts // []) | map(select(.Destination == "/etc/confdock/config.toml")) | length == 1) and
    (any(.[0].Mounts[]?; .Destination == "/var/lib/confdock" and .Type == "volume" and .Name == $volume and .RW == true)) and
    (all(.[0].Mounts[]?; .Type != "volume" or (.Destination == "/var/lib/confdock" and .Name == $volume and .RW == true))) and
    (any(.[0].Mounts[]?; .Destination == "/etc/confdock/config.toml" and .Type == "bind" and .Source == $config and .RW == false)) and
    (all(.[0].Mounts[]?; .Type != "bind" or
      ((.Destination == "/etc/confdock/config.toml" and .Source == $config and .RW == false) or
       (.Destination == "/etc/hostname" or .Destination == "/etc/hosts" or .Destination == "/etc/resolv.conf")))) and
    (all(.[0].Mounts[]?; .Source != "/var/run/docker.sock" and .Destination != "/var/run/docker.sock"))
  ' "$inspect_file" >/dev/null
}

stop_and_assert() {
  local started elapsed_ns exit_code state oom_killed dead state_error shutdown_log
  started="$(timestamp_ns)"
  "${compose[@]}" stop >/dev/null
  elapsed_ns="$(( $(timestamp_ns) - started ))"
  [[ "$elapsed_ns" -le 30000000000 ]] || fail 'container exceeded the 30 second stop grace period'
  state="$(docker inspect -f '{{.State.Status}}' "$container_id")"
  exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$container_id")"
  oom_killed="$(docker inspect -f '{{.State.OOMKilled}}' "$container_id")"
  dead="$(docker inspect -f '{{.State.Dead}}' "$container_id")"
  state_error="$(docker inspect -f '{{.State.Error}}' "$container_id")"
  shutdown_log="$runtime_dir/shutdown-$(printf '%s' "${COMPOSE_PROJECT_NAME}" | tr -c '[:alnum:]_.-' '_').log"
  docker logs "$container_id" >"$shutdown_log" 2>&1 || fail 'could not read shutdown log'
  grep -F 'ConfDock is shutting down' "$shutdown_log" >/dev/null \
    || fail 'shutdown log did not contain a graceful shutdown message'
  [[ "$state" == exited && "$exit_code" == 0 && "$exit_code" != 137 \
    && "$exit_code" != 9 \
    && "$oom_killed" == false && "$dead" == false && -z "$state_error" ]] \
    || fail 'container did not stop cleanly with exit code 0'
}

assert_sqlite_integrity() {
  local volume_name="$1" integrity
  # A WAL-mode database can need writable lock bytes in -shm even when the
  # SQLite connection is `mode=ro`. This helper mounts only the already-owned
  # smoke volume read-write; the SQL URI remains read-only and the service is
  # stopped, so no application writes can occur.
  integrity="$(docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
    --platform linux/amd64 --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$volume_name,destination=/data,volume-nocopy" "$image" -eu -c \
    'test -s /data/confdock.db
     test -z "$(find /data -type l -print -quit)"
     test -z "$(find /data ! -type f ! -type d -print -quit)"
     sqlite3 "file:/data/confdock.db?mode=ro" "PRAGMA integrity_check;"' | tr -d '\r')" \
    || fail 'SQLite integrity check could not run'
  [[ "$integrity" == ok ]] || fail 'SQLite integrity check failed'
}

request_subscription() {
  local token="$1" headers_file="$2" body_file="$3" error_file="$runtime_dir/subscription.error"
  if ! curl -fsS -D "$headers_file" -o "$body_file" \
    "$base_url/sub/$token" 2>"$error_file"; then
    fail 'subscription request failed'
  fi
}

login_with_password() {
  local password_value="$1" cookie_jar="$2"
  # Keep the password on a pipe rather than passing it as a process argument.
  printf '%s' "$password_value" | jq -Rs '{password: rtrimstr("\n")}' | \
    curl -fsS -c "$cookie_jar" -o "$response_file" \
      -H 'content-type: application/json' --data-binary @- \
      "$base_url/api/session" >/dev/null
}

assert_volume_manifest() {
  local volume_name="$1" output_file="$2"
  docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
    --platform linux/amd64 --user 10001:10001 \
    --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$volume_name,destination=/data,readonly,volume-nocopy" "$image" -eu -c \
    'test -s /data/confdock.db
     test -z "$(find /data -type l -print -quit)"
     test -z "$(find /data ! -type f ! -type d -print -quit)"
     test -z "$(find /data -type f -links +1 -print -quit)"
     find /data -type f -exec sha256sum {} + | sort' >"$output_file" \
    || fail 'could not inspect volume contents'
}

printf '%s\n' 'docker smoke: start service' >&2
assert_project_unused "$smoke_project" "$smoke_volume" \
  || fail 'smoke project became occupied before startup'
reserved_volume_run="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.run"}}' "$smoke_volume" 2>/dev/null || true)"
[[ "$reserved_volume_run" == "$smoke_run" ]] || fail 'smoke volume reservation was lost'
"${compose[@]}" up -d --no-build >/dev/null
wait_healthy || fail 'container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
assert_runtime_contract

if run_admin_init "$password" "$password" "$runtime_dir/admin-running.out"; then
  fail 'admin init unexpectedly accepted a running, initialized instance'
fi
grep -F 'already initialized' "$runtime_dir/admin-running.out" >/dev/null

base_url='http://127.0.0.1:8787'
printf '%s\n' 'docker smoke: project, revision, publish, settings, and subscription' >&2
curl -fsS "$base_url/healthz" | jq -e '.status == "ok"' >/dev/null
curl -fsS "$base_url/" | grep -F '<div id="root"></div>' >/dev/null

login_with_password "$password" "$cookie_file"
jq -e '.createdAt != null' "$response_file" >/dev/null

source_v1='{}'
source_v2='{"log":{"level":"info"}}'
source_b64="$(printf '%s' "$source_v1" | base64 | tr -d '\n')"
curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg source "$source_b64" '{name:"Docker smoke",targetId:"sing-box",fileName:"config.json",source:$source}')" \
  "$base_url/api/projects" >/dev/null
project_id="$(jq -er '.id' "$response_file")"
revision_v1="$(jq -er '.currentRevisionId' "$response_file")"
served_v1="$(jq -er '.servedRevisionId' "$response_file")"

source_b64_v2="$(printf '%s' "$source_v2" | base64 | tr -d '\n')"
curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg source "$source_b64_v2" --arg expected "$revision_v1" '{source:$source,expectedRevisionId:$expected}')" \
  "$base_url/api/projects/$project_id/revisions" >/dev/null
revision_v2="$(jq -er '.project.currentRevisionId' "$response_file")"

curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d "$(jq -nc --arg current "$revision_v2" --arg served "$served_v1" '{expectedCurrentRevisionId:$current,expectedServedRevisionId:$served}')" \
  -X POST "$base_url/api/projects/$project_id/publish" >/dev/null
jq -e --arg revision "$revision_v2" \
  '.project.servedRevisionId == $revision and .project.hasUnpublishedChanges == false' \
  "$response_file" >/dev/null

curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' \
  -d '{"publicUrl":"https://docker-smoke.example.test"}' \
  -X PATCH "$base_url/api/settings" >/dev/null
jq -e '.publicUrl == "https://docker-smoke.example.test"' "$response_file" >/dev/null

curl -fsS -b "$cookie_file" -o "$response_file" \
  -H 'content-type: application/json' -d '{}' \
  -X POST "$base_url/api/projects/$project_id/tokens" >/dev/null
token_plain="$(jq -er '.plaintext' "$response_file")"
test -n "$token_plain"
# Do not leave the one-time plaintext in the generic response fixture.
: >"$response_file"

printf '%s' "$source_v2" >"$expected_subscription"
request_subscription "$token_plain" "$subscription_headers" "$subscription_file"
cmp "$expected_subscription" "$subscription_file" >/dev/null
grep -Eiq '^content-type: application/octet-stream' "$subscription_headers"
grep -Eiq '^cache-control: no-store' "$subscription_headers"
grep -Eiq '^x-content-type-options: nosniff' "$subscription_headers"

test "$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/api/projects")" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/sub/not-a-token")" = 404
for path in /api/not-found /assets/missing.js; do
  status="$(curl -sS -o "$runtime_dir/boundary.body" -w '%{http_code}' "$base_url$path")"
  [[ "$status" == 404 ]] || fail "unexpected status for $path: $status"
  if grep -F '<div id="root"></div>' "$runtime_dir/boundary.body" >/dev/null; then
    fail "SPA fallback leaked into $path"
  fi
done

"${compose[@]}" up -d --force-recreate --no-build >/dev/null
wait_healthy || fail 'recreated container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
assert_runtime_contract
curl -fsS -b "$cookie_file" "$base_url/api/projects/$project_id" -o "$response_file"
jq -e --arg id "$project_id" --arg rev "$revision_v2" \
  '.id == $id and .currentRevisionId == $rev and .servedRevisionId == $rev' "$response_file" >/dev/null
curl -fsS -b "$cookie_file" "$base_url/api/settings" | \
  jq -e '.publicUrl == "https://docker-smoke.example.test"' >/dev/null

printf '%s\n' 'docker smoke: production stop and cross-project volume persistence' >&2
stop_and_assert
assert_sqlite_integrity "$smoke_volume"
# The backup helper deliberately refuses a volume mounted by any other
# container, including an exited one.  Remove this stopped, uniquely-labelled
# smoke container before exercising the same volume under another project.
docker rm "$container_id" >/dev/null
alt_project="$(choose_project)" || fail 'could not allocate alternate project'
assert_project_unused "$alt_project" || fail 'alternate project became occupied before startup'
export COMPOSE_PROJECT_NAME="$alt_project"
export CONFDOCK_VOLUME_NAME="$smoke_volume"
export CONFDOCK_SMOKE_PROJECT="$alt_project"
set_helper_project "$alt_project"
compose=(docker compose --project-name "$alt_project" -f "$compose_file")
"${compose[@]}" config --quiet
"${compose[@]}" run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check >/dev/null
"${compose[@]}" up -d --no-build >/dev/null
wait_healthy || fail 'cross-project container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
assert_runtime_contract
curl -fsS -b "$cookie_file" "$base_url/api/projects/$project_id" -o "$response_file"
jq -e --arg id "$project_id" --arg rev "$revision_v2" \
  '.id == $id and .currentRevisionId == $rev and .servedRevisionId == $rev' "$response_file" >/dev/null
curl -fsS -b "$cookie_file" "$base_url/api/settings" | \
  jq -e '.publicUrl == "https://docker-smoke.example.test"' >/dev/null
request_subscription "$token_plain" "$subscription_headers" "$subscription_file"
cmp "$expected_subscription" "$subscription_file" >/dev/null
grep -Eiq '^content-type: application/octet-stream' "$subscription_headers"
grep -Eiq '^cache-control: no-store' "$subscription_headers"
grep -Eiq '^x-content-type-options: nosniff' "$subscription_headers"

if COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/running-backup" \
  >"$runtime_dir/running-backup.out" 2>&1; then
  fail 'backup unexpectedly accepted a running container'
fi
stop_and_assert
assert_sqlite_integrity "$smoke_volume"

printf '%s\n' 'docker smoke: backup failure and archive checks' >&2
missing_project="$(choose_project)" || fail 'could not allocate missing-project identity'
if COMPOSE_PROJECT_NAME="$missing_project" CONFDOCK_SMOKE_PROJECT="$missing_project" \
  CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/missing-backup" \
  >"$runtime_dir/missing-backup.out" 2>&1; then
  fail 'backup unexpectedly passed without a container'
fi

backup_output="$(COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/backups")"
backup_file="$(printf '%s\n' "$backup_output" | sed -n 's/^Docker backup created: //p')"
[[ -f "$backup_file" ]] || fail 'backup script did not return an archive'
backup_mode="$(stat -c '%a' "$backup_file" 2>/dev/null || stat -f '%Lp' "$backup_file")"
backup_owner="$(stat -c '%u:%g' "$backup_file" 2>/dev/null || stat -f '%u:%g' "$backup_file")"
backup_dir_mode="$(stat -c '%a' "$runtime_dir/backups" 2>/dev/null || stat -f '%Lp' "$runtime_dir/backups")"
expected_owner="$(id -u):$(id -g)"
[[ "$backup_mode" == 600 && "$backup_dir_mode" == 700 && "$backup_owner" == "$expected_owner" ]] \
  || fail 'backup permissions or ownership are unsafe'
printf '%s\n' 'not-a-directory' >"$runtime_dir/backup-target"
if COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/backup-target" \
  >"$runtime_dir/backup-permission.out" 2>&1; then
  fail 'backup unexpectedly accepted a non-directory target'
fi
tar -tzf "$backup_file" | sed 's#^\./##' | grep -Fx 'data/confdock.db' >/dev/null
tar -tzf "$backup_file" | sed 's#^\./##' | grep -Fx 'config.toml' >/dev/null

if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  CONFDOCK_RESTORE_VOLUME_NAME='invalid/volume-name' \
  "$repo_root/scripts/restore-docker.sh" "$backup_file" \
  "$runtime_dir/invalid-name-config" >"$runtime_dir/invalid-name.out" 2>&1; then
  fail 'restore unexpectedly accepted an invalid volume name'
fi
grep -F 'invalid restore volume name' "$runtime_dir/invalid-name.out" >/dev/null

permission_archive="$runtime_dir/permission.tar.gz"
cp "$backup_file" "$permission_archive"
chmod 644 "$permission_archive"
if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/restore-docker.sh" "$permission_archive" \
  "$runtime_dir/permission-restore-config" >"$runtime_dir/permission-restore.out" 2>&1; then
  fail 'restore unexpectedly accepted a world-readable archive'
fi
grep -F 'mode 0600' "$runtime_dir/permission-restore.out" >/dev/null

ln -s "$backup_file" "$runtime_dir/archive-link.tar.gz"
if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/restore-docker.sh" "$runtime_dir/archive-link.tar.gz" \
  "$runtime_dir/link-restore-config" >"$runtime_dir/link-restore.out" 2>&1; then
  fail 'restore unexpectedly accepted a symlink archive'
fi
grep -F 'symlink' "$runtime_dir/link-restore.out" >/dev/null

docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 10001:10001 \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$smoke_volume,destination=/data,readonly,volume-nocopy" "$image" -eu -c \
  'find /data -type f -printf "%P\n"' | sort >"$runtime_dir/original-files"
tar -tzf "$backup_file" | sed -n 's#^data/##p' | awk 'NF' | sort >"$runtime_dir/archive-files"
cmp "$runtime_dir/original-files" "$runtime_dir/archive-files" >/dev/null
for sidecar in confdock.db-wal confdock.db-shm; do
  if grep -Fx "$sidecar" "$runtime_dir/original-files" >/dev/null; then
    grep -Fx "data/$sidecar" <(tar -tzf "$backup_file" | sed 's#^\./##') >/dev/null \
      || fail "backup omitted SQLite sidecar: $sidecar"
  fi
done
if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  CONFDOCK_RESTORE_VOLUME_NAME="$smoke_volume" \
  "$repo_root/scripts/restore-docker.sh" "$backup_file" \
  "$runtime_dir/colliding-restore-config" >"$runtime_dir/colliding-restore.out" 2>&1; then
  fail 'restore unexpectedly accepted an existing volume name'
fi

empty_dir="$runtime_dir/empty"
mkdir -m 700 "$empty_dir"
tar -czf "$runtime_dir/empty.tar.gz" -C "$empty_dir" . >/dev/null
if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/restore-docker.sh" "$runtime_dir/empty.tar.gz" \
  "$runtime_dir/empty-restore-config" >"$runtime_dir/empty-restore.out" 2>&1; then
  fail 'empty archive unexpectedly passed restore validation'
fi

unsafe_archive_root="$runtime_dir/unsafe-archive"
mkdir -p "$unsafe_archive_root/data"
: >"$unsafe_archive_root/data/confdock.db"
ln -s /etc/passwd "$unsafe_archive_root/data/escape"
cp "$repo_root/deploy/docker/config.toml" "$unsafe_archive_root/config.toml"
tar -czf "$runtime_dir/unsafe.tar.gz" -C "$unsafe_archive_root" data config.toml >/dev/null
if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/restore-docker.sh" "$runtime_dir/unsafe.tar.gz" \
  "$runtime_dir/unsafe-restore-config" >"$runtime_dir/unsafe-restore.out" 2>&1; then
  fail 'restore unexpectedly accepted a symlinked data entry'
fi

make_unsafe_archive() {
  local kind="$1" output="$2"
  python3 - "$kind" "$output" <<'PY'
import io
import sys
import tarfile

kind, output = sys.argv[1:]
with tarfile.open(output, mode="w:gz") as archive:
    def add_file(name, data):
        info = tarfile.TarInfo(name)
        info.mode = 0o600
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))

    if kind != "empty-db":
        add_file("data/confdock.db", b"not-a-real-database")
    add_file("config.toml", b'listen = "0.0.0.0:8787"\n')
    if kind == "empty-db":
        info = tarfile.TarInfo("data/confdock.db")
        info.mode = 0o600
        info.size = 0
        archive.addfile(info)
    elif kind == "traversal":
        add_file("data/../escape", b"escape")
    elif kind == "hardlink":
        info = tarfile.TarInfo("data/hardlink")
        info.type = tarfile.LNKTYPE
        info.linkname = "data/confdock.db"
        archive.addfile(info)
    elif kind == "device":
        info = tarfile.TarInfo("data/device")
        info.type = tarfile.CHRTYPE
        info.devmajor = 1
        info.devminor = 3
        archive.addfile(info)
    elif kind == "symlink":
        info = tarfile.TarInfo("data/link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        archive.addfile(info)
    else:
        raise SystemExit("unknown archive variant")
PY
}

for unsafe_kind in empty-db traversal hardlink device; do
  unsafe_archive="$runtime_dir/unsafe-$unsafe_kind.tar.gz"
  make_unsafe_archive "$unsafe_kind" "$unsafe_archive"
  if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
    "$repo_root/scripts/restore-docker.sh" "$unsafe_archive" \
    "$runtime_dir/$unsafe_kind-restore-config" >"$runtime_dir/$unsafe_kind-restore.out" 2>&1; then
    fail "restore unexpectedly accepted $unsafe_kind archive"
  fi
done

# Capture the source volume immediately before the isolated restore, after all
# normal cross-project startup/stop and backup work has completed.  The source
# remains stopped throughout the isolated validation below.
assert_volume_manifest "$smoke_volume" "$runtime_dir/pre-restore-original-manifest"

printf '%s\n' 'docker smoke: isolated restore and verification' >&2
planned_restore_volume="$(choose_restore_volume)" || fail 'could not allocate an unused restore volume'
restore_project="$(choose_project)" || fail 'could not allocate restore project'
restore_volume="$planned_restore_volume"
restore_output="$(COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
 CONFDOCK_SMOKE_PROJECT="$restore_project" \
 CONFDOCK_IMAGE="$image" CONFDOCK_RESTORE_VOLUME_NAME="$planned_restore_volume" \
 CONFDOCK_RESTORE_COMPOSE_PROJECT="$restore_project" \
 CONFDOCK_RESTORE_SMOKE_RUN="$smoke_run" \
 "$repo_root/scripts/restore-docker.sh" "$backup_file" \
 "$runtime_dir/restored-config")"
restore_volume="$(printf '%s\n' "$restore_output" | sed -n 's/^RESTORE_VOLUME_NAME=//p')"
restore_config="$(printf '%s\n' "$restore_output" | sed -n 's/^RESTORE_CONFIG_PATH=//p')"
[[ -n "$restore_volume" && -f "$restore_config" ]] || fail 'restore did not return a usable isolated volume'
cmp "$original_config_copy" "$restore_config" >/dev/null \
  || fail 'restored configuration bytes differ from the backup source'
export COMPOSE_PROJECT_NAME="$restore_project"
set_helper_project "$restore_project"
assert_project_unused "$restore_project" "$restore_volume" \
  || fail 'restore project became occupied before startup'
export CONFDOCK_VOLUME_NAME="$restore_volume"
export CONFDOCK_CONFIG_PATH="$restore_config"
compose=(docker compose --project-name "$restore_project" -f "$compose_file")
"${compose[@]}" config --quiet
"${compose[@]}" run --rm --no-deps confdock \
  --config /etc/confdock/config.toml config check >/dev/null
"${compose[@]}" up -d --no-build >/dev/null
wait_healthy || fail 'restored container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
assert_runtime_contract
curl -fsS "$base_url/healthz" | jq -e '.status == "ok"' >/dev/null
login_with_password "$password" "$restore_cookie_file"
jq -e '.createdAt != null' "$response_file" >/dev/null
curl -fsS -b "$restore_cookie_file" "$base_url/api/projects/$project_id" -o "$response_file"
jq -e --arg id "$project_id" --arg rev "$revision_v2" \
  '.id == $id and .currentRevisionId == $rev and .servedRevisionId == $rev' "$response_file" >/dev/null
curl -fsS -b "$restore_cookie_file" "$base_url/api/settings" | \
  jq -e '.publicUrl == "https://docker-smoke.example.test"' >/dev/null
request_subscription "$token_plain" "$subscription_headers" "$subscription_file"
cmp "$expected_subscription" "$subscription_file" >/dev/null
grep -Eiq '^content-type: application/octet-stream' "$subscription_headers"
grep -Eiq '^cache-control: no-store' "$subscription_headers"
grep -Eiq '^x-content-type-options: nosniff' "$subscription_headers"
stop_and_assert

assert_sqlite_integrity "$restore_volume"

# Compare the original while it is still stopped and before rollback creates
# any new sessions or token-use timestamps. This proves the isolated restore
# never touched the source volume without treating those later, intentional
# writes as corruption.
assert_volume_manifest "$smoke_volume" "$runtime_dir/post-restore-original-manifest"
cmp "$runtime_dir/pre-restore-original-manifest" \
  "$runtime_dir/post-restore-original-manifest" >/dev/null \
  || fail 'original volume changed during isolated restore'

printf '%s\n' 'docker smoke: rollback to the untouched original volume' >&2
# The isolated instance is now stopped.  Recreate the original project against
# its original physical volume and configuration, proving that a failed
# cutover can be reversed without deleting or mutating either side.
export COMPOSE_PROJECT_NAME="$alt_project"
set_helper_project "$alt_project"
export CONFDOCK_VOLUME_NAME="$smoke_volume"
export CONFDOCK_CONFIG_PATH="$config_file"
compose=(docker compose --project-name "$alt_project" -f "$compose_file")
"${compose[@]}" up -d --force-recreate --no-build >/dev/null
wait_healthy || fail 'rollback container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
assert_runtime_contract
login_with_password "$password" "$restore_cookie_file"
curl -fsS -b "$restore_cookie_file" "$base_url/api/projects/$project_id" -o "$response_file"
jq -e --arg id "$project_id" --arg rev "$revision_v2" \
  '.id == $id and .currentRevisionId == $rev and .servedRevisionId == $rev' \
  "$response_file" >/dev/null
curl -fsS -b "$restore_cookie_file" "$base_url/api/settings" | \
  jq -e '.publicUrl == "https://docker-smoke.example.test"' >/dev/null
request_subscription "$token_plain" "$subscription_headers" "$subscription_file"
cmp "$expected_subscription" "$subscription_file" >/dev/null
grep -Eiq '^content-type: application/octet-stream' "$subscription_headers"
grep -Eiq '^cache-control: no-store' "$subscription_headers"
grep -Eiq '^x-content-type-options: nosniff' "$subscription_headers"
stop_and_assert
assert_sqlite_integrity "$smoke_volume"

# Inspect every temporary capture, not just the files whose names happen to
# be logs.  The check is quiet on success and never prints the matched value.
while IFS= read -r -d '' output_file; do
  if grep -aF -- "$password" "$output_file" >/dev/null \
    || grep -aF -- "$token_plain" "$output_file" >/dev/null; then
    fail 'smoke output contains a password or token'
  fi
done < <(find "$runtime_dir" -type f -print0)

printf 'docker smoke test passed\n'
