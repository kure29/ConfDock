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
  CONFDOCK_SMOKE_KIND CONFDOCK_SMOKE_RESOURCE CONFDOCK_SMOKE_NETWORK_KIND \
  CONFDOCK_SMOKE_NETWORK_RESOURCE CONFDOCK_SMOKE_VOLUME_INIT_KIND \
  CONFDOCK_SMOKE_VOLUME_INIT_RESOURCE CONFDOCK_ADMIN_PASSWORD CONFDOCK_SUB_TOKEN
export CONFDOCK_IMAGE="$image"
IFS=$'\n\t'
export LC_ALL=C
export COMPOSE_DISABLE_ENV_FILE=1
runtime_dir="$(mktemp -d -t confdock-docker-smoke.XXXXXX)"
reserved_volume_created=0
reserved_volume_name=''
reserved_volume_run=''
reserved_volume_created_at=''
reserved_volume_resource=''
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
    current_smoke_kind="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.kind"}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    current_resource="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.resource"}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    current_created_at="$(docker volume inspect -f '{{.CreatedAt}}' \
      "$reserved_volume_name" 2>/dev/null || true)"
    if [[ "$current_run" == "$reserved_volume_run" \
      && "$current_project" == "${smoke_project:-}" \
      && "$current_kind" == confdock-data \
      && "$current_smoke_kind" == volume \
      && "$current_resource" == "$reserved_volume_resource" \
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

# Never enable shell tracing in this test: it handles an administrator
# password and a one-time subscription token. A phase name and source line are
# enough to diagnose an otherwise silent assertion without echoing the command
# or any of its arguments.
smoke_phase='preflight'
report_unexpected_error() {
  local status="$?"
  printf 'docker smoke: unexpected failure in %s at line %s\n' \
    "$smoke_phase" "${BASH_LINENO[0]:-unknown}" >&2
  return "$status"
}
trap report_unexpected_error ERR

for command_name in awk base64 chmod cmp cp curl docker find grep install jq mkdir mkfifo mktemp mv od \
  python3 rm script sed sha256sum sleep sort stat tar tr; do
  command -v "$command_name" >/dev/null || fail "required command missing: $command_name"
done
real_curl="$(command -v curl)"
curl_wrapper_dir="$runtime_dir/curl-wrapper"
curl_argv_log="$runtime_dir/curl-argv.log"
mkdir -m 700 "$curl_wrapper_dir"
: >"$curl_argv_log"
chmod 0600 "$curl_argv_log"
cat >"$curl_wrapper_dir/curl" <<'CURL_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
umask 077
{
  printf '%s\n' 'CALL'
  for argument in "$@"; do
    printf 'ARGV\t%s\n' "$argument"
  done
  if [[ -r "/proc/$$/cmdline" ]]; then
    while IFS= read -r -d '' argument; do
      printf 'PROC\t%s\n' "$argument"
    done <"/proc/$$/cmdline"
  fi
} >>"$CONFDOCK_CURL_ARGV_LOG"
exec "$CONFDOCK_REAL_CURL" "$@"
CURL_WRAPPER
chmod 0700 "$curl_wrapper_dir/curl"
export CONFDOCK_REAL_CURL="$real_curl"
export CONFDOCK_CURL_ARGV_LOG="$curl_argv_log"
PATH="$curl_wrapper_dir:$PATH"
export PATH
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
service_resource="confdock-service-$(new_suffix)"
network_resource="confdock-network-$(new_suffix)"
volume_resource="confdock-volume-$(new_suffix)"
volume_init_resource="confdock-volume-init-$(new_suffix)"
export CONFDOCK_SMOKE_KIND=service
export CONFDOCK_SMOKE_RESOURCE="$service_resource"
export CONFDOCK_SMOKE_NETWORK_KIND=network
export CONFDOCK_SMOKE_NETWORK_RESOURCE="$network_resource"
export CONFDOCK_SMOKE_VOLUME_INIT_KIND=volume-init
export CONFDOCK_SMOKE_VOLUME_INIT_RESOURCE="$volume_init_resource"

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
  shift
  local -a ignored_volumes=("$@")

  # `compose run` may create the project's default network (and, briefly, a
  # one-off container) before the long-running service starts.  Those
  # resources carry the smoke run label from compose.yaml and are ours.  Any
  # resource that has the project identity without this exact run marker is an
  # external collision and must stop the test before `up` can attach to it.
  local container_ids container_id container_run container_project
  container_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project_name")" \
    || return 1
  container_ids+=$'\n'
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
  network_ids+=$'\n'
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
  local ignored_volume allowed_volume
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
    allowed_volume=0
    for ignored_volume in "${ignored_volumes[@]}"; do
      if [[ "$volume_name" == "$ignored_volume" ]]; then
        allowed_volume=1
        break
      fi
    done
    [[ "$allowed_volume" == 1 && "$volume_run" == "$smoke_run" \
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
reserved_volume_resource="$volume_resource"
docker volume create \
  --label "com.confdock.smoke.run=$smoke_run" \
  --label 'com.confdock.smoke.kind=volume' \
  --label "com.confdock.smoke.resource=$volume_resource" \
  --label "com.docker.compose.project=$smoke_project" \
  --label 'com.docker.compose.volume=confdock-data' \
  "$smoke_volume" >/dev/null \
  || fail 'could not reserve the smoke volume'
verified_volume_name="$(docker volume inspect -f '{{.Name}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_run="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.run"}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_project="$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_kind="$(docker volume inspect -f '{{index .Labels "com.docker.compose.volume"}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_smoke_kind="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.kind"}}' "$smoke_volume" 2>/dev/null || true)"
verified_volume_resource="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.resource"}}' "$smoke_volume" 2>/dev/null || true)"
reserved_volume_created_at="$(docker volume inspect -f '{{.CreatedAt}}' "$smoke_volume" 2>/dev/null || true)"
[[ "$verified_volume_name" == "$smoke_volume" && "$verified_volume_run" == "$smoke_run" \
  && "$verified_volume_project" == "$smoke_project" \
  && "$verified_volume_kind" == confdock-data \
  && "$verified_volume_smoke_kind" == volume \
  && "$verified_volume_resource" == "$volume_resource" \
  && -n "$reserved_volume_created_at" ]] \
  || fail 'smoke volume reservation labels could not be verified'

alt_project=''
missing_project=''
restore_project=''
restore_volume=''
toctou_pid=''
toctou_gate_open=0
resource_registry="$runtime_dir/resource-registry.tsv"
: >"$resource_registry"
chmod 0600 "$resource_registry"

register_resource() {
  local resource_type="$1" canonical_id="$2" resource_name="$3" project="$4"
  local run_label="$5" kind_label="$6" created="$7" resource_marker="$8"
  local registry_target="${resource_registry_target:-$resource_registry}"
  [[ -n "$resource_type" && -n "$canonical_id" && -n "$resource_name" \
    && -n "$project" && -n "$run_label" && -n "$kind_label" \
    && -n "$created" && -n "$resource_marker" ]] \
    || fail 'refusing to register incomplete Docker resource identity'
  if ! awk -F '\t' -v type="$resource_type" -v id="$canonical_id" \
    -v name="$resource_name" -v created_at="$created" \
    '$1 == type && $2 == id && $3 == name && $7 == created_at { found = 1 }
     END { exit(found ? 0 : 1) }' "$registry_target"; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$resource_type" "$canonical_id" "$resource_name" "$project" \
      "$run_label" "$kind_label" "$created" "$resource_marker" \
      >>"$registry_target"
  fi
}

register_container() {
  local id="$1" identity canonical_id name project run_label kind created resource_marker
  identity="$(docker inspect "$id" | jq -er '
    .[0] | [.Id, (.Name | ltrimstr("/")),
      .Config.Labels["com.docker.compose.project"],
      .Config.Labels["com.confdock.smoke.run"],
      .Config.Labels["com.confdock.smoke.kind"], .Created,
      .Config.Labels["com.confdock.smoke.resource"]] | @tsv
  ')" || fail 'container identity could not be inspected for registration'
  IFS=$'\t' read -r canonical_id name project run_label kind created resource_marker \
    <<<"$identity"
  [[ "$canonical_id" =~ ^[0-9a-f]{64}$ && "$run_label" == "$smoke_run" ]] \
    || fail 'container identity could not be registered'
  register_resource container "$canonical_id" "$name" "$project" \
    "$run_label" "$kind" "$created" "$resource_marker"
}

register_network() {
  local id="$1" identity canonical_id name project run_label kind created resource_marker
  identity="$(docker network inspect "$id" | jq -er '
    .[0] | [.Id, .Name, .Labels["com.docker.compose.project"],
      .Labels["com.confdock.smoke.run"],
      .Labels["com.confdock.smoke.kind"], .Created,
      .Labels["com.confdock.smoke.resource"]] | @tsv
  ')" || fail 'network identity could not be inspected for registration'
  IFS=$'\t' read -r canonical_id name project run_label kind created resource_marker \
    <<<"$identity"
  [[ -n "$canonical_id" && "$run_label" == "$smoke_run" ]] \
    || fail 'network identity could not be registered'
  register_resource network "$canonical_id" "$name" "$project" \
    "$run_label" "$kind" "$created" "$resource_marker"
}

register_volume() {
  local name="$1" identity inspected_name project run_label kind created resource_marker
  identity="$(docker volume inspect "$name" | jq -er '
    .[0] | [.Name, .Labels["com.docker.compose.project"],
      .Labels["com.confdock.smoke.run"],
      .Labels["com.confdock.smoke.kind"], .CreatedAt,
      .Labels["com.confdock.smoke.resource"]] | @tsv
  ')" || fail 'volume identity could not be inspected for registration'
  IFS=$'\t' read -r inspected_name project run_label kind created resource_marker \
    <<<"$identity"
  [[ "$inspected_name" == "$name" && "$run_label" == "$smoke_run" ]] \
    || fail 'volume identity could not be registered'
  register_resource volume - "$name" "$project" "$run_label" "$kind" "$created" "$resource_marker"
}

register_project_resources() {
  local project="$1" ids id
  ids="$(docker ps -aq --filter "label=com.confdock.smoke.run=$smoke_run" \
    --filter "label=com.docker.compose.project=$project")" \
    || fail 'could not enumerate project containers for registration'
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    register_container "$id"
  done <<<"$ids"
  ids="$(docker network ls -q --filter "label=com.confdock.smoke.run=$smoke_run" \
    --filter "label=com.docker.compose.project=$project")" \
    || fail 'could not enumerate project networks for registration'
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    register_network "$id"
  done <<<"$ids"
  ids="$(docker volume ls -q --filter "label=com.confdock.smoke.run=$smoke_run" \
    --filter "label=com.docker.compose.project=$project")" \
    || fail 'could not enumerate project volumes for registration'
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    register_volume "$id"
  done <<<"$ids"
}

register_volume "$smoke_volume"

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
  local registry_path="${1:-$resource_registry}"
  local cleanup_failed=0 cleanup_type resource_type canonical_id resource_name
  local project run_label kind_label created resource_marker current_ids
  local replacement_ids replacement_count replacement_id current_identity
  local expected_identity current_names
  # The registry is append-only. Old Compose incarnations that disappeared
  # naturally are skipped; a resource is removed only when every recorded
  # identity field still matches the live Docker object.
  for cleanup_type in container network volume; do
    # The registry is read-only for the duration of this loop. ShellCheck sees
    # nested awk reads of the same descriptor but no command here writes it.
    # shellcheck disable=SC2094
    while IFS=$'\t' read -r resource_type canonical_id resource_name project \
      run_label kind_label created resource_marker; do
      [[ "$resource_type" == "$cleanup_type" ]] || continue
      case "$resource_type" in
        container)
          current_ids="$(docker ps -aq --no-trunc 2>/dev/null)" \
            || {
              printf 'docker smoke: Docker container query failed; left registered resource for manual inspection: %s\n' \
                "$resource_name" >&2
              cleanup_failed=1
              continue
            }
          if ! grep -Fx "$canonical_id" <<<"$current_ids" >/dev/null; then
            replacement_ids="$(docker ps -aq --no-trunc \
              --filter "name=^/${resource_name}$" 2>/dev/null)" \
              || {
                printf 'docker smoke: Docker container replacement query failed; left resource for manual inspection: %s\n' \
                  "$resource_name" >&2
                cleanup_failed=1
                continue
              }
            if [[ -n "$replacement_ids" ]]; then
              replacement_count="$(printf '%s\n' "$replacement_ids" | awk 'NF { n += 1 } END { print n + 0 }')"
              replacement_id="$(printf '%s\n' "$replacement_ids" | awk 'NF { print; exit }')"
              if [[ "$replacement_count" != 1 ]] \
                || ! awk -F '\t' -v id="$replacement_id" -v name="$resource_name" \
                  '$1 == "container" && $2 == id && $3 == name { found = 1 }
                   END { exit(found ? 0 : 1) }' "$registry_path"; then
                printf 'docker smoke: registered container was replaced; left untouched for manual inspection: %s\n' \
                  "$resource_name" >&2
                cleanup_failed=1
              fi
            fi
            continue
          fi
          current_identity="$(docker inspect "$canonical_id" 2>/dev/null | jq -er '
            .[0] | [.Id, (.Name | ltrimstr("/")),
              .Config.Labels["com.docker.compose.project"],
              .Config.Labels["com.confdock.smoke.run"],
              .Config.Labels["com.confdock.smoke.kind"], .Created,
              .Config.Labels["com.confdock.smoke.resource"]] | @tsv
          ')" || {
            printf 'docker smoke: registered container inspection failed; left resource for manual inspection: %s\n' \
              "$resource_name" >&2
            cleanup_failed=1
            continue
          }
          expected_identity="$canonical_id"$'\t'"$resource_name"$'\t'"$project"$'\t'"$run_label"$'\t'"$kind_label"$'\t'"$created"$'\t'"$resource_marker"
          ;;
        network)
          current_ids="$(docker network ls -q --no-trunc 2>/dev/null)" \
            || {
              printf 'docker smoke: Docker network query failed; left registered resource for manual inspection: %s\n' \
                "$resource_name" >&2
              cleanup_failed=1
              continue
            }
          if ! grep -Fx "$canonical_id" <<<"$current_ids" >/dev/null; then
            replacement_ids="$(docker network ls -q --no-trunc \
              --filter "name=^${resource_name}$" 2>/dev/null)" \
              || {
                printf 'docker smoke: Docker network replacement query failed; left resource for manual inspection: %s\n' \
                  "$resource_name" >&2
                cleanup_failed=1
                continue
              }
            if [[ -n "$replacement_ids" ]]; then
              replacement_count="$(printf '%s\n' "$replacement_ids" | awk 'NF { n += 1 } END { print n + 0 }')"
              replacement_id="$(printf '%s\n' "$replacement_ids" | awk 'NF { print; exit }')"
              if [[ "$replacement_count" != 1 ]] \
                || ! awk -F '\t' -v id="$replacement_id" -v name="$resource_name" \
                  '$1 == "network" && $2 == id && $3 == name { found = 1 }
                   END { exit(found ? 0 : 1) }' "$registry_path"; then
                printf 'docker smoke: registered network was replaced; left untouched for manual inspection: %s\n' \
                  "$resource_name" >&2
                cleanup_failed=1
              fi
            fi
            continue
          fi
          current_identity="$(docker network inspect "$canonical_id" 2>/dev/null | jq -er '
            .[0] | [.Id, .Name, .Labels["com.docker.compose.project"],
              .Labels["com.confdock.smoke.run"],
              .Labels["com.confdock.smoke.kind"], .Created,
              .Labels["com.confdock.smoke.resource"]] | @tsv
          ')" || {
            printf 'docker smoke: registered network inspection failed; left resource for manual inspection: %s\n' \
              "$resource_name" >&2
            cleanup_failed=1
            continue
          }
          expected_identity="$canonical_id"$'\t'"$resource_name"$'\t'"$project"$'\t'"$run_label"$'\t'"$kind_label"$'\t'"$created"$'\t'"$resource_marker"
          ;;
        volume)
          current_names="$(docker volume ls -q 2>/dev/null)" \
            || {
              printf 'docker smoke: Docker volume query failed; left registered resource for manual inspection: %s\n' \
                "$resource_name" >&2
              cleanup_failed=1
              continue
            }
          if ! grep -Fx "$resource_name" <<<"$current_names" >/dev/null; then continue; fi
          current_identity="$(docker volume inspect "$resource_name" 2>/dev/null | jq -er '
            .[0] | [.Name, .Labels["com.docker.compose.project"],
              .Labels["com.confdock.smoke.run"],
              .Labels["com.confdock.smoke.kind"], .CreatedAt,
              .Labels["com.confdock.smoke.resource"]] | @tsv
          ')" || {
            printf 'docker smoke: registered volume inspection failed; left resource for manual inspection: %s\n' \
              "$resource_name" >&2
            cleanup_failed=1
            continue
          }
          expected_identity="$resource_name"$'\t'"$project"$'\t'"$run_label"$'\t'"$kind_label"$'\t'"$created"$'\t'"$resource_marker"
          ;;
      esac
      if [[ "$current_identity" != "$expected_identity" ]]; then
        printf 'docker smoke: registered %s identity changed; left untouched: %s\n' \
          "$resource_type" "$resource_name" >&2
        cleanup_failed=1
        continue
      fi
      case "$resource_type" in
        container)
          docker rm -f "$canonical_id" >/dev/null 2>&1 || {
            printf 'docker smoke: registered container removal failed; inspect manually: %s\n' \
              "$resource_name" >&2
            cleanup_failed=1
          }
          ;;
        network)
          docker network rm "$canonical_id" >/dev/null 2>&1 || {
            printf 'docker smoke: registered network removal failed; inspect manually: %s\n' \
              "$resource_name" >&2
            cleanup_failed=1
          }
          ;;
        volume)
          docker volume rm "$resource_name" >/dev/null 2>&1 || {
            printf 'docker smoke: registered volume removal failed; inspect manually: %s\n' \
              "$resource_name" >&2
            cleanup_failed=1
          }
          ;;
      esac
    done <"$registry_path"
  done
  return "$cleanup_failed"
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
  if [[ -n "${toctou_pid:-}" ]] && kill -0 "$toctou_pid" 2>/dev/null; then
    if [[ "${toctou_gate_open:-0}" == 1 ]]; then
      printf '%s\n' continue >&9 2>/dev/null || true
    fi
    kill "$toctou_pid" 2>/dev/null || true
    wait "$toctou_pid" 2>/dev/null || true
  fi
  if [[ "${toctou_gate_open:-0}" == 1 ]]; then
    exec 8>&-
    exec 9>&-
  fi
  if ! cleanup_resources; then
    status=1
  fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if ! resources_clean; then
      printf '%s\n' 'docker smoke: run-labelled resources remain after cleanup' >&2
      status=1
    elif [[ "$status" == 0 ]]; then
      printf '%s\n' 'docker smoke: registered cleanup completed with zero run-labelled resources' >&2
    fi
  fi
  rm -rf -- "$runtime_dir"
  exit "$status"
}
trap cleanup EXIT

test_cleanup_identity_guards() {
  local test_project container_name original_id replacement_id network_name
  local original_network_id replacement_network_id volume_name query_wrapper_dir saved_path
  local old_registry="$runtime_dir/registry-old.tsv"
  local current_registry="$runtime_dir/registry-current.tsv"
  local query_registry="$runtime_dir/registry-query.tsv"
  : >"$old_registry"
  : >"$current_registry"
  : >"$query_registry"
  chmod 0600 "$old_registry" "$current_registry" "$query_registry"
  test_project="confdock-registry-$(new_suffix)"

  container_name="$test_project-container"
  original_id="$(docker create --name "$container_name" \
    --label "com.docker.compose.project=$test_project" \
    --label "com.confdock.smoke.run=$smoke_run" \
    --label 'com.confdock.smoke.kind=helper' \
    --label 'com.confdock.smoke.resource=container-replacement-test' \
    "$image" --help)"
  register_container "$original_id"
  resource_registry_target="$old_registry" register_container "$original_id"
  docker rm "$original_id" >/dev/null
  replacement_id="$(docker create --name "$container_name" \
    --label "com.docker.compose.project=$test_project" \
    --label "com.confdock.smoke.run=$smoke_run" \
    --label 'com.confdock.smoke.kind=helper' \
    --label 'com.confdock.smoke.resource=container-replacement-test' \
    "$image" --help)"
  register_container "$replacement_id"
  if cleanup_resources "$old_registry"; then
    fail 'cleanup accepted a same-name container with a different canonical ID'
  fi
  docker inspect "$replacement_id" >/dev/null \
    || fail 'cleanup deleted an unregistered same-name container replacement'

  network_name="$test_project-network"
  original_network_id="$(docker network create \
    --label "com.docker.compose.project=$test_project" \
    --label "com.confdock.smoke.run=$smoke_run" \
    --label 'com.confdock.smoke.kind=network' \
    --label 'com.confdock.smoke.resource=network-replacement-test' \
    "$network_name")"
  register_network "$original_network_id"
  resource_registry_target="$old_registry" register_network "$original_network_id"
  docker network rm "$original_network_id" >/dev/null
  replacement_network_id="$(docker network create \
    --label "com.docker.compose.project=$test_project" \
    --label "com.confdock.smoke.run=$smoke_run" \
    --label 'com.confdock.smoke.kind=network' \
    --label 'com.confdock.smoke.resource=network-replacement-test' \
    "$network_name")"
  register_network "$replacement_network_id"
  if cleanup_resources "$old_registry"; then
    fail 'cleanup accepted a same-name network with a different canonical ID'
  fi
  docker network inspect "$replacement_network_id" >/dev/null \
    || fail 'cleanup deleted an unregistered same-name network replacement'

  volume_name="$test_project-volume"
  docker volume create \
    --label "com.docker.compose.project=$test_project" \
    --label "com.confdock.smoke.run=$smoke_run" \
    --label 'com.confdock.smoke.kind=volume' \
    --label 'com.confdock.smoke.resource=original-volume-marker' \
    "$volume_name" >/dev/null
  register_volume "$volume_name"
  resource_registry_target="$old_registry" register_volume "$volume_name"
  docker volume rm "$volume_name" >/dev/null
  docker volume create \
    --label "com.docker.compose.project=$test_project" \
    --label "com.confdock.smoke.run=$smoke_run" \
    --label 'com.confdock.smoke.kind=volume' \
    --label 'com.confdock.smoke.resource=recreated-volume-marker' \
    "$volume_name" >/dev/null
  register_volume "$volume_name"
  if cleanup_resources "$old_registry"; then
    fail 'cleanup accepted a recreated volume with a changed creation identity'
  fi
  docker volume inspect "$volume_name" >/dev/null \
    || fail 'cleanup deleted a recreated volume with mismatched identity'

  # Once the replacements themselves are explicitly registered, exact-identity
  # cleanup removes them and only them.
  resource_registry_target="$current_registry" register_container "$replacement_id"
  resource_registry_target="$current_registry" register_network "$replacement_network_id"
  resource_registry_target="$current_registry" register_volume "$volume_name"
  cleanup_resources "$current_registry" || fail 'exact registered replacement cleanup failed'

  # A Docker query failure is never treated as natural disappearance.
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    container "$(printf '0%.0s' {1..64})" query-test "$test_project" \
    "$smoke_run" helper 1970-01-01T00:00:00Z query-test >"$query_registry"
  query_wrapper_dir="$runtime_dir/docker-query-failure"
  mkdir -m 700 "$query_wrapper_dir"
  cat >"$query_wrapper_dir/docker" <<'DOCKER_QUERY_FAILURE'
#!/usr/bin/env sh
exit 125
DOCKER_QUERY_FAILURE
  chmod 0700 "$query_wrapper_dir/docker"
  saved_path="$PATH"
  PATH="$query_wrapper_dir:$PATH"
  if cleanup_resources "$query_registry"; then
    PATH="$saved_path"
    fail 'cleanup treated a Docker query failure as zero resources'
  fi
  PATH="$saved_path"

  # A registered resource that disappeared without a same-name replacement is
  # the only missing-object case cleanup may silently skip.
  : >"$old_registry"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    container "$(printf 'f%.0s' {1..64})" naturally-gone "$test_project" \
    "$smoke_run" helper 1970-01-01T00:00:00Z naturally-gone >"$old_registry"
  cleanup_resources "$old_registry" \
    || fail 'cleanup rejected a registered resource that disappeared naturally'
}

printf '%s\n' 'docker smoke: cleanup identity replacement guards' >&2
smoke_phase='cleanup identity replacement guards'
test_cleanup_identity_guards
printf '%s\n' 'docker smoke: registered cleanup identity guards passed' >&2

# Route every subsequent Docker resource creation through a small registrar.
# Direct `docker run` and `docker compose run` helpers are kept until their
# canonical identity has been recorded, then removed by that exact ID. Compose
# `up` is observed while it creates the service/network so an interrupted or
# partially failed command still leaves an identity record for fail-closed
# cleanup.
real_docker_binary="$(command -v docker)"
resource_registrar="$runtime_dir/register-docker-resource"
docker_registry_wrapper_dir="$runtime_dir/docker-registry-wrapper"
mkdir -m 700 "$docker_registry_wrapper_dir"
cat >"$resource_registrar" <<'RESOURCE_REGISTRAR'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
resource_type="${1:?resource type is required}"
resource_key="${2:?resource key is required}"
docker_binary="${CONFDOCK_REAL_DOCKER_BINARY:?real Docker path is required}"
registry="${CONFDOCK_RESOURCE_REGISTRY:?resource registry is required}"
smoke_run_value="${CONFDOCK_SMOKE_RUN:?smoke run is required}"

append_identity() {
  local type="$1" canonical_id="$2" name="$3" project="$4" run_label="$5"
  local kind="$6" created="$7" marker="$8" field
  for field in "$type" "$canonical_id" "$name" "$project" "$run_label" \
    "$kind" "$created" "$marker"; do
    [[ -n "$field" && "$field" != *$'\n'* && "$field" != *$'\r'* \
      && "$field" != *$'\t'* ]] || exit 1
  done
  [[ "$run_label" == "$smoke_run_value" ]] || exit 1
  if ! awk -F '\t' -v type="$type" -v id="$canonical_id" \
    -v name="$name" -v created_at="$created" \
    '$1 == type && $2 == id && $3 == name && $7 == created_at { found = 1 }
     END { exit(found ? 0 : 1) }' "$registry"; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$type" "$canonical_id" "$name" "$project" "$run_label" \
      "$kind" "$created" "$marker" >>"$registry"
  fi
}

register_one() {
  local type="$1" key="$2" identity canonical_id name project run_label kind created marker
  case "$type" in
    container)
      identity="$("$docker_binary" inspect "$key" 2>/dev/null | jq -er '
        .[0] | [.Id, (.Name | ltrimstr("/")),
          .Config.Labels["com.docker.compose.project"],
          .Config.Labels["com.confdock.smoke.run"],
          .Config.Labels["com.confdock.smoke.kind"], .Created,
          .Config.Labels["com.confdock.smoke.resource"]] | @tsv
      ')" || return 1
      IFS=$'\t' read -r canonical_id name project run_label kind created marker \
        <<<"$identity"
      [[ "$canonical_id" =~ ^[0-9a-f]{64}$ ]]
      append_identity container "$canonical_id" "$name" "$project" \
        "$run_label" "$kind" "$created" "$marker"
      ;;
    network)
      identity="$("$docker_binary" network inspect "$key" 2>/dev/null | jq -er '
        .[0] | [.Id, .Name, .Labels["com.docker.compose.project"],
          .Labels["com.confdock.smoke.run"],
          .Labels["com.confdock.smoke.kind"], .Created,
          .Labels["com.confdock.smoke.resource"]] | @tsv
      ')" || return 1
      IFS=$'\t' read -r canonical_id name project run_label kind created marker \
        <<<"$identity"
      append_identity network "$canonical_id" "$name" "$project" \
        "$run_label" "$kind" "$created" "$marker"
      ;;
    volume)
      identity="$("$docker_binary" volume inspect "$key" 2>/dev/null | jq -er '
        .[0] | [.Name, .Labels["com.docker.compose.project"],
          .Labels["com.confdock.smoke.run"],
          .Labels["com.confdock.smoke.kind"], .CreatedAt,
          .Labels["com.confdock.smoke.resource"]] | @tsv
      ')" || return 1
      IFS=$'\t' read -r name project run_label kind created marker <<<"$identity"
      append_identity volume - "$name" "$project" "$run_label" "$kind" "$created" "$marker"
      ;;
    *) exit 1 ;;
  esac
}

register_enumerated() {
  local type="$1" key="$2" current
  if register_one "$type" "$key"; then
    return 0
  fi
  # Compose may remove an old incarnation between enumeration and inspect while
  # force-recreating a service. A second complete list distinguishes that
  # expected disappearance from an inspect or daemon failure. Query failures
  # and objects that still exist both fail closed.
  case "$type" in
    container) current="$("$docker_binary" ps -aq --no-trunc)" || return 1 ;;
    network) current="$("$docker_binary" network ls -q --no-trunc)" || return 1 ;;
    volume) current="$("$docker_binary" volume ls -q)" || return 1 ;;
    *) return 1 ;;
  esac
  if grep -Fx "$key" <<<"$current" >/dev/null; then
    return 1
  fi
}

remove_registered_container() {
  local key="$1" canonical_id name project run_label kind created marker
  canonical_id="$("$docker_binary" inspect -f '{{.Id}}' "$key")"
  name="$("$docker_binary" inspect -f '{{.Name}}' "$canonical_id")"
  name="${name#/}"
  project="$("$docker_binary" inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$canonical_id")"
  run_label="$("$docker_binary" inspect -f '{{index .Config.Labels "com.confdock.smoke.run"}}' "$canonical_id")"
  kind="$("$docker_binary" inspect -f '{{index .Config.Labels "com.confdock.smoke.kind"}}' "$canonical_id")"
  marker="$("$docker_binary" inspect -f '{{index .Config.Labels "com.confdock.smoke.resource"}}' "$canonical_id")"
  created="$("$docker_binary" inspect -f '{{.Created}}' "$canonical_id")"
  awk -F '\t' -v id="$canonical_id" -v name="$name" -v project="$project" \
    -v run="$run_label" -v kind="$kind" -v created="$created" -v marker="$marker" '
      $1 == "container" && $2 == id && $3 == name && $4 == project &&
        $5 == run && $6 == kind && $7 == created && $8 == marker { found = 1 }
      END { exit(found ? 0 : 1) }
    ' "$registry"
  "$docker_binary" rm "$canonical_id" >/dev/null
}

if [[ "$resource_type" == remove-container ]]; then
  remove_registered_container "$resource_key"
elif [[ "$resource_type" == project ]]; then
  project="$resource_key"
  container_ids="$("$docker_binary" ps -aq --no-trunc \
    --filter "label=com.confdock.smoke.run=$smoke_run_value" \
    --filter "label=com.docker.compose.project=$project")"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    register_enumerated container "$id"
  done <<<"$container_ids"
  network_ids="$("$docker_binary" network ls -q --no-trunc \
    --filter "label=com.confdock.smoke.run=$smoke_run_value" \
    --filter "label=com.docker.compose.project=$project")"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    register_enumerated network "$id"
  done <<<"$network_ids"
  volume_names="$("$docker_binary" volume ls -q \
    --filter "label=com.confdock.smoke.run=$smoke_run_value" \
    --filter "label=com.docker.compose.project=$project")"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    register_enumerated volume "$name"
  done <<<"$volume_names"
else
  register_one "$resource_type" "$resource_key"
fi
RESOURCE_REGISTRAR
chmod 0700 "$resource_registrar"

cat >"$docker_registry_wrapper_dir/docker" <<'DOCKER_REGISTRY_WRAPPER'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
real_docker="${CONFDOCK_REAL_DOCKER_BINARY:?real Docker path is required}"
registrar="${CONFDOCK_RESOURCE_REGISTRAR:?resource registrar is required}"
runtime="${CONFDOCK_SMOKE_RUNTIME:?smoke runtime is required}"

new_marker() {
  od -An -N8 -tx1 /dev/urandom | tr -d ' \n'
}

compose_project() {
  local previous='' argument
  for argument in "$@"; do
    if [[ "$previous" == --project-name || "$previous" == -p ]]; then
      printf '%s' "$argument"
      return 0
    fi
    case "$argument" in
      --project-name=*) printf '%s' "${argument#--project-name=}"; return 0 ;;
    esac
    previous="$argument"
  done
  printf '%s' "${COMPOSE_PROJECT_NAME:-}"
}

register_project() {
  local project="$1"
  [[ -n "$project" ]] || return 1
  "$registrar" project "$project"
}

validate_volume_init_container() {
  local id="$1" service
  service="$("$real_docker" inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")"
  [[ "$service" == volume-init ]] || return 0
  "$real_docker" inspect "$id" | jq -e --arg image "${CONFDOCK_IMAGE:?}" '
    .[0].Config.Image == $image and
    .[0].Config.User == "0:0" and
    .[0].Config.Entrypoint == ["/usr/local/libexec/confdock-volume-init"] and
    .[0].HostConfig.NetworkMode == "none" and
    .[0].HostConfig.ReadonlyRootfs == true and
    ((.[0].HostConfig.CapDrop // []) | map(sub("^CAP_"; "")) | index("ALL") != null) and
    ((.[0].HostConfig.CapAdd // []) | map(sub("^CAP_"; "")) | sort) == ["CHOWN", "DAC_READ_SEARCH"] and
    ((.[0].HostConfig.SecurityOpt // []) | index("no-new-privileges:true") != null) and
    .[0].HostConfig.Privileged == false and
    .[0].HostConfig.RestartPolicy.Name == "no" and
    ((.[0].HostConfig.PortBindings // {}) | length == 0) and
    ((.[0].HostConfig.Tmpfs // {}) | keys == ["/tmp"]) and
    ((.[0].HostConfig.Tmpfs["/tmp"] // "") | contains("noexec,nosuid,nodev")) and
    ((.[0].Mounts // []) | length == 1) and
    (.[0].Mounts[0].Type == "volume") and
    (.[0].Mounts[0].Destination == "/var/lib/confdock") and
    (.[0].Mounts[0].RW == true)
  ' >/dev/null
}

run_direct_helper() {
  local suffix marker name cid_dir cid_file child status=0 id='' registered=0 argument
  local -a arguments=()
  suffix="$(new_marker)"
  marker="confdock-helper-$suffix"
  name="confdock-helper-$suffix"
  cid_dir="$(mktemp -d "$runtime/docker-cid.XXXXXX")"
  cid_file="$cid_dir/id"
  for argument in "$@"; do
    [[ "$argument" == --rm ]] || arguments+=("$argument")
  done
  "$real_docker" run --cidfile "$cid_file" --name "$name" \
    --label "com.confdock.smoke.resource=$marker" "${arguments[@]}" <&0 &
  child=$!
  for _attempt in {1..3000}; do
    if [[ -s "$cid_file" ]]; then
      id="$(<"$cid_file")"
      "$registrar" container "$id"
      registered=1
      break
    fi
    kill -0 "$child" 2>/dev/null || break
    sleep 0.01
  done
  wait "$child" || status=$?
  if [[ "$registered" == 0 && -s "$cid_file" ]]; then
    id="$(<"$cid_file")"
    "$registrar" container "$id"
    registered=1
  fi
  if [[ "$registered" == 1 ]]; then
    "$registrar" remove-container "$id" || status=125
  elif [[ "$status" == 0 ]]; then
    status=125
  fi
  rm -f -- "$cid_file"
  rmdir -- "$cid_dir" 2>/dev/null || true
  return "$status"
}

run_compose_oneoff() {
  local project suffix name child status=0 id='' registered=0 argument seen_run=0
  local -a arguments=()
  project="$(compose_project "$@")"
  suffix="$(new_marker)"
  name="confdock-oneoff-$suffix"
  for argument in "$@"; do
    if [[ "$argument" == run ]]; then
      seen_run=1
      arguments+=(run --name "$name")
    elif [[ "$seen_run" == 1 && "$argument" == --rm ]]; then
      continue
    else
      arguments+=("$argument")
    fi
  done
  "$real_docker" "${arguments[@]}" <&0 &
  child=$!
  for _attempt in {1..3000}; do
    id="$("$real_docker" ps -aq --no-trunc --filter "name=^/${name}$")"
    if [[ -n "$id" ]]; then
      "$registrar" container "$id"
      register_project "$project"
      validate_volume_init_container "$id" || status=125
      registered=1
      break
    fi
    kill -0 "$child" 2>/dev/null || break
    sleep 0.01
  done
  wait "$child" || status=$?
  register_project "$project" || status=125
  if [[ "$registered" == 0 ]]; then
    id="$("$real_docker" ps -aq --no-trunc --filter "name=^/${name}$")"
    if [[ -n "$id" ]]; then
      "$registrar" container "$id"
      validate_volume_init_container "$id" || status=125
      registered=1
    fi
  fi
  if [[ "$registered" == 1 ]]; then
    "$registrar" remove-container "$id" || status=125
  elif [[ "$status" == 0 ]]; then
    status=125
  fi
  return "$status"
}

run_compose_up() {
  local project child status=0 ids=''
  project="$(compose_project "$@")"
  "$real_docker" "$@" <&0 &
  child=$!
  for _attempt in {1..3000}; do
    register_project "$project" || status=125
    ids="$("$real_docker" ps -aq --no-trunc \
      --filter "label=com.confdock.smoke.run=${CONFDOCK_SMOKE_RUN}" \
      --filter "label=com.docker.compose.project=$project")"
    [[ -n "$ids" ]] && break
    kill -0 "$child" 2>/dev/null || break
    sleep 0.01
  done
  wait "$child" || status=$?
  register_project "$project" || status=125
  return "$status"
}

if [[ "${1:-}" == run ]]; then
  shift
  run_direct_helper "$@"
  exit $?
fi

if [[ "${1:-}" == compose ]]; then
  compose_subcommand=''
  for argument in "$@"; do
    case "$argument" in
      run|up) compose_subcommand="$argument"; break ;;
    esac
  done
  case "$compose_subcommand" in
    run) run_compose_oneoff "$@"; exit $? ;;
    up) run_compose_up "$@"; exit $? ;;
  esac
fi

if [[ "${1:-}" == volume && "${2:-}" == create ]]; then
  output="$("$real_docker" "$@")"
  status=$?
  printf '%s\n' "$output"
  [[ "$status" == 0 ]] || exit "$status"
  "$registrar" volume "${@: -1}"
  exit $?
fi

if [[ "${1:-}" == network && "${2:-}" == create ]]; then
  output="$("$real_docker" "$@")"
  status=$?
  printf '%s\n' "$output"
  [[ "$status" == 0 ]] || exit "$status"
  "$registrar" network "$output"
  exit $?
fi

if [[ "${1:-}" == create ]]; then
  output="$("$real_docker" "$@")"
  status=$?
  printf '%s\n' "$output"
  [[ "$status" == 0 ]] || exit "$status"
  "$registrar" container "$output"
  exit $?
fi

exec "$real_docker" "$@"
DOCKER_REGISTRY_WRAPPER
chmod 0700 "$docker_registry_wrapper_dir/docker"
export CONFDOCK_REAL_DOCKER_BINARY="$real_docker_binary"
export CONFDOCK_RESOURCE_REGISTRAR="$resource_registrar"
export CONFDOCK_RESOURCE_REGISTRY="$resource_registry"
export CONFDOCK_SMOKE_RUNTIME="$runtime_dir"
PATH="$docker_registry_wrapper_dir:$PATH"
export PATH

# The production setup profile prepares only an empty external volume root.
# Run it twice to prove the operation is safe and idempotent before the
# non-root service creates SQLite.
printf '%s\n' 'docker smoke: volume-init empty and idempotent cases' >&2
"${compose[@]}" --profile setup run --rm --no-deps volume-init \
  || fail 'volume-init could not prepare an empty smoke volume'
register_project_resources "$smoke_project"
"${compose[@]}" --profile setup run --rm --no-deps volume-init \
  || fail 'volume-init was not idempotent on an already prepared empty volume'
register_project_resources "$smoke_project"
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 10001:10001 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$smoke_volume,destination=/var/lib/confdock,volume-nocopy" \
  "$image" -eu -c \
  'test "$(stat -c "%u:%g" /var/lib/confdock)" = 10001:10001
   test "$(stat -c "%a" /var/lib/confdock)" = 700
   test -z "$(find /var/lib/confdock -mindepth 1 -maxdepth 1 -print -quit)"' \
  || fail 'volume-init empty-volume result is incorrect'

# A missing external volume must not be auto-created.
missing_setup_volume="confdock-volume-init-missing-$(new_suffix)"
if CONFDOCK_VOLUME_NAME="$missing_setup_volume" \
  "${compose[@]}" --profile setup run --rm --no-deps volume-init \
  >"$runtime_dir/volume-init-missing.out" 2>&1; then
  fail 'volume-init accepted a missing external volume'
fi
register_project_resources "$smoke_project"
if docker volume inspect "$missing_setup_volume" >/dev/null 2>&1; then
  fail 'volume-init created a missing external volume'
fi

# A non-empty unknown volume must remain byte-for-byte and metadata unchanged.
bad_setup_volume="confdock-volume-init-bad-$(new_suffix)"
bad_setup_resource="confdock-volume-init-bad-resource-$(new_suffix)"
docker volume create \
  --label "com.confdock.smoke.run=$smoke_run" \
  --label 'com.confdock.smoke.kind=volume' \
  --label "com.confdock.smoke.resource=$bad_setup_resource" \
  --label "com.docker.compose.project=$smoke_project" \
  --label 'com.docker.compose.volume=confdock-data' \
  "$bad_setup_volume" >/dev/null
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 0:0 --read-only --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$bad_setup_volume,destination=/var/lib/confdock,volume-nocopy" \
  "$image" -eu -c 'printf unknown-volume > /var/lib/confdock/unexpected' \
  || fail 'could not create the volume-init negative fixture'
bad_setup_before="$runtime_dir/volume-init-bad-before"
bad_setup_after="$runtime_dir/volume-init-bad-after"
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 0:0 --read-only --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$bad_setup_volume,destination=/var/lib/confdock,volume-nocopy" \
  "$image" -eu -c \
  'stat -c "%u:%g %a %n" /var/lib/confdock /var/lib/confdock/unexpected
   sha256sum /var/lib/confdock/unexpected' >"$bad_setup_before"
if CONFDOCK_VOLUME_NAME="$bad_setup_volume" \
  "${compose[@]}" --profile setup run --rm --no-deps volume-init \
  >"$runtime_dir/volume-init-bad.out" 2>&1; then
  fail 'volume-init modified or accepted an unknown non-empty volume'
fi
register_project_resources "$smoke_project"
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 0:0 --read-only --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$bad_setup_volume,destination=/var/lib/confdock,volume-nocopy" \
  "$image" -eu -c \
  'stat -c "%u:%g %a %n" /var/lib/confdock /var/lib/confdock/unexpected
   sha256sum /var/lib/confdock/unexpected' >"$bad_setup_after"
cmp "$bad_setup_before" "$bad_setup_after" \
  || fail 'volume-init changed an unknown non-empty volume'

if [[ -n "$(docker ps --filter publish=8787 -q)" ]]; then
  fail 'host port 127.0.0.1:8787 is already in use'
fi

printf '%s\n' 'docker smoke: compose contract' >&2
compose_json="$runtime_dir/compose.json"
"${compose[@]}" --profile setup config --format json >"$compose_json"
if ! jq -e --arg volume "$smoke_volume" --arg config "$CONFDOCK_CONFIG_PATH" --arg image "$image" '
  .services.confdock.image == $image and
  ((.services.confdock | has("build")) | not) and
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
  ((.services.confdock.network_mode // "") != "host") and
  .services["volume-init"].image == $image and
  .services["volume-init"].profiles == ["setup"] and
  .services["volume-init"].platform == "linux/amd64" and
  .services["volume-init"].user == "0:0" and
  .services["volume-init"].network_mode == "none" and
  .services["volume-init"].read_only == true and
  .services["volume-init"].restart == "no" and
  ((.services["volume-init"].ports // []) | length == 0) and
  .services["volume-init"].entrypoint == ["/usr/local/libexec/confdock-volume-init"] and
  .services["volume-init"].labels["com.confdock.smoke.kind"] == "volume-init" and
  ((.services["volume-init"].tmpfs // []) | any(. == "/tmp:rw,noexec,nosuid,nodev,size=4m")) and
  .services["volume-init"].cap_drop == ["ALL"] and
  ((.services["volume-init"].cap_add // []) | sort) == ["CHOWN", "DAC_READ_SEARCH"] and
  ((.services["volume-init"].security_opt // []) | index("no-new-privileges:true") != null) and
  ((.services["volume-init"].privileged // false) == false) and
  ((.services["volume-init"].volumes // []) | length == 1) and
  (.services["volume-init"].volumes[0].type == "volume") and
  (.services["volume-init"].volumes[0].source == "confdock-data") and
  (.services["volume-init"].volumes[0].target == "/var/lib/confdock") and
  ((.services["volume-init"].volumes[0].read_only // false) == false) and
  (.services["volume-init"].volumes[0].volume.nocopy == true)
' "$compose_json" >/dev/null; then
  # Keep a failed contract diagnosable without dumping arbitrary environment
  # values or any service output that could contain credentials.
  jq '{service: (.services.confdock | {user, platform, read_only, init, restart,
      stop_grace_period, stop_signal, ports, tmpfs, cap_drop, cap_add,
      security_opt, healthcheck, volumes, privileged, network_mode}),
      volume_init: .services["volume-init"],
      volume: .volumes["confdock-data"], network: .networks.default}' \
    "$compose_json" >&2 || true
  fail 'Compose contract assertion failed'
fi

printf '%s\n' 'docker smoke: runtime image boundary' >&2
test "$(docker image inspect -f '{{.Config.User}}' "$image")" = '10001:10001'
test "$(docker image inspect -f '{{.Architecture}}' "$image")" = 'amd64'
test "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = '1.0.0'
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" --platform linux/amd64 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 \
  --network none --entrypoint /bin/sh "$image" -eu -c '
  test "$(id -u)" = 10001
  test "$(id -g)" = 10001
  test "$(stat -c "%u:%g" /var/lib/confdock)" = 10001:10001
  test -f /LICENSE
  test -s /THIRD_PARTY_NOTICES.md
  test -f /usr/share/doc/ca-certificates/copyright
  test -f /usr/share/doc/curl/copyright
  test -f /usr/share/doc/findutils/copyright
  test -f /usr/share/doc/passwd/copyright
  test -f /usr/share/doc/sqlite3/copyright
  test -f /usr/share/doc/tar/copyright
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
register_project_resources "$smoke_project"
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
register_project_resources "$smoke_project"
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
register_project_resources "$smoke_project"
grep -F 'not initialized' "$runtime_dir/uninitialized.out" >/dev/null

printf '%s\n' 'docker smoke: admin init failure modes' >&2
if "${compose[@]}" run --rm --no-deps -T confdock \
  --config /etc/confdock/config.toml admin init >"$runtime_dir/admin-no-tty.out" 2>&1; then
  fail 'admin init unexpectedly accepted a non-TTY'
fi
register_project_resources "$smoke_project"
grep -F 'interactive terminal' "$runtime_dir/admin-no-tty.out" >/dev/null

run_admin_init() {
  local first_password="$1" second_password="$2" output_file="$3" compose_command
  compose_command="$(printf '%q ' "${compose[@]}")run --rm -it --no-deps confdock --config /etc/confdock/config.toml admin init"
  # Supplying both values before rpassword has printed its prompts races the
  # container PTY's echo setup.  Drive the session one prompt at a time so no
  # secret reaches the PTY until the application has disabled terminal echo.
  # Secrets arrive on Python's stdin, never in argv or the environment.
  printf '%s\0%s\0' "$first_password" "$second_password" | python3 -c '
import os
import select
import subprocess
import sys
import time

output_path, command = sys.argv[1:]
parts = sys.stdin.buffer.read().split(b"\0")
if len(parts) != 3 or parts[2] != b"":
    raise SystemExit("invalid secret input")
secrets = parts[:2]
prompts = [b"Enter administrator password: ", b"Confirm administrator password: "]
process = subprocess.Popen(
    ["script", "-q", "--echo=never", "-e", "-c", command, "/dev/null"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
deadline = time.monotonic() + 30
pending = b""
next_prompt = 0
try:
    with open(output_path, "wb") as output:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("admin init prompt timed out")
            ready, _, _ = select.select([process.stdout], [], [], min(remaining, 1))
            if not ready:
                if process.poll() is not None:
                    break
                continue
            chunk = os.read(process.stdout.fileno(), 4096)
            if not chunk:
                break
            output.write(chunk)
            output.flush()
            pending = (pending + chunk)[-4096:]
            if next_prompt < len(prompts) and prompts[next_prompt] in pending:
                process.stdin.write(secrets[next_prompt] + b"\n")
                process.stdin.flush()
                next_prompt += 1
                pending = b""
        if process.stdin:
            process.stdin.close()
        status = process.wait(timeout=max(1, deadline - time.monotonic()))
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
raise SystemExit(status)
' "$output_file" "$compose_command"
}

run_admin_init_without_password() {
  local output_file="$1" compose_command
  compose_command="$(printf '%q ' "${compose[@]}")run --rm -it --no-deps confdock --config /etc/confdock/config.toml admin init"
  # An already initialized instance rejects the command before prompting.  Do
  # not preload a password into Docker's pseudo-terminal: if the process exits
  # before disabling terminal echo, those bytes would otherwise be captured by
  # `script` even though ConfDock never consumed them.
  script -q --echo=never -e -c "$compose_command" /dev/null \
    </dev/null >"$output_file" 2>&1
}

if run_admin_init "$password" "${password}-mismatch" "$runtime_dir/admin-mismatch.out"; then
  fail 'mismatched admin init unexpectedly passed'
fi
grep -F 'passwords do not match' "$runtime_dir/admin-mismatch.out" >/dev/null

run_admin_init "$password" "$password" "$runtime_dir/admin-init.out" \
  || fail 'admin init failed in a TTY'
grep -F 'initialized successfully' "$runtime_dir/admin-init.out" >/dev/null

if run_admin_init_without_password "$runtime_dir/admin-repeat.out"; then
  fail 'repeat admin init unexpectedly passed'
fi
grep -F 'already initialized' "$runtime_dir/admin-repeat.out" >/dev/null

printf '%s\n' 'docker smoke: volume-init validates non-empty ConfDock data without mutation' >&2
nonempty_before="$runtime_dir/volume-init-nonempty-before.sha256"
nonempty_after="$runtime_dir/volume-init-nonempty-after.sha256"
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 10001:10001 --read-only --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$smoke_volume,destination=/var/lib/confdock,readonly" \
  "$image" -eu -c \
  'find /var/lib/confdock -mindepth 1 -maxdepth 1 -type f -print0 | sort -z | xargs -0 sha256sum' \
  >"$nonempty_before"
"${compose[@]}" --profile setup run --rm --no-deps volume-init \
  || fail 'volume-init rejected a valid non-empty ConfDock volume'
register_project_resources "$smoke_project"
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 10001:10001 --read-only --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$smoke_volume,destination=/var/lib/confdock,readonly" \
  "$image" -eu -c \
  'find /var/lib/confdock -mindepth 1 -maxdepth 1 -type f -print0 | sort -z | xargs -0 sha256sum' \
  >"$nonempty_after"
cmp "$nonempty_before" "$nonempty_after" \
  || fail 'volume-init changed a valid non-empty ConfDock volume'

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
  printf 'docker smoke: graceful stop elapsed_ms=%s exit_code=%s oom_killed=%s dead=%s\n' \
    "$(( elapsed_ns / 1000000 ))" "$exit_code" "$oom_killed" "$dead" >&2
}

assert_sqlite_integrity() {
  local volume_name="$1" integrity
  # Mount the source volume read-only, copy its SQLite set to tmpfs, and let
  # SQLite operate only on the copy. A clean WAL shutdown may remove SHM; a
  # direct read-only open would then fail when SQLite tries to recreate it.
  integrity="$(docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
    --platform linux/amd64 --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$volume_name,destination=/data,readonly,volume-nocopy" "$image" -eu -c \
    'test -s /data/confdock.db
     test -z "$(find /data -type l -print -quit)"
     test -z "$(find /data ! -type f ! -type d -print -quit)"
     scratch=/var/lib/confdock/integrity
     mkdir -m 700 "$scratch"
     for name in confdock.db confdock.db-wal confdock.db-shm; do
       if test -e "/data/$name" || test -L "/data/$name"; then
         test -f "/data/$name" && test ! -L "/data/$name"
         cp -- "/data/$name" "$scratch/$name"
       fi
     done
     sqlite3 "file:$scratch/confdock.db?mode=rw" "PRAGMA integrity_check;"' | tr -d '\r')" \
    || fail 'SQLite integrity check could not run'
  [[ "$integrity" == ok ]] || fail 'SQLite integrity check failed'
}

create_recovery_wal() {
  local volume_name="$1"
  # Commit a real WAL transaction and kill only the sqlite3 process before it
  # can close normally. The outer helper remains alive to verify both sidecars,
  # then exits and is removed, leaving no process with the database open.
  docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
    --platform linux/amd64 --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --network none \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$volume_name,destination=/data,volume-nocopy" "$image" -eu -c '
      set +e
      sqlite3 /data/confdock.db >/dev/null <<SQL
PRAGMA journal_mode=WAL;
PRAGMA wal_autocheckpoint=0;
BEGIN IMMEDIATE;
UPDATE access_tokens SET last_used_at = COALESCE(last_used_at, 0) + 1
  WHERE id = (SELECT id FROM access_tokens LIMIT 1);
COMMIT;
.shell kill -KILL \$PPID
SQL
      sqlite_status=$?
      set -e
      test "$sqlite_status" -eq 137
      test -f /data/confdock.db-wal
      test ! -L /data/confdock.db-wal
      test -s /data/confdock.db-wal
      test -f /data/confdock.db-shm
      test ! -L /data/confdock.db-shm
      test -s /data/confdock.db-shm
    '
}

capture_db_sidecar_hashes() {
  local volume_name="$1" output_file="$2"
  docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
    --platform linux/amd64 --user 10001:10001 --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m --network none \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$volume_name,destination=/data,readonly,volume-nocopy" \
    "$image" -eu -c '
      for name in confdock.db confdock.db-wal confdock.db-shm; do
        test -f "/data/$name"
        test ! -L "/data/$name"
        test -s "/data/$name"
        digest="$(sha256sum "/data/$name")"
        digest="${digest%% *}"
        printf "%s  %s\n" "$digest" "$name"
      done
    ' >"$output_file"
}

request_subscription() {
  local token="$1" headers_file="$2" body_file="$3" error_file="$runtime_dir/subscription.error"
  # Keep the bearer token out of curl's argv and /proc/<pid>/cmdline. `printf`
  # is a Bash builtin, and curl receives the complete URL only through its
  # config parser on stdin.
  if ! printf 'url = "%s"\n' "$base_url/sub/$token" | \
    curl --config - -fsS -D "$headers_file" -o "$body_file" 2>"$error_file"; then
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
assert_project_unused "$smoke_project" "$smoke_volume" "$bad_setup_volume" \
  || fail 'smoke project became occupied before startup'
reserved_volume_run="$(docker volume inspect -f '{{index .Labels "com.confdock.smoke.run"}}' "$smoke_volume" 2>/dev/null || true)"
[[ "$reserved_volume_run" == "$smoke_run" ]] || fail 'smoke volume reservation was lost'
"${compose[@]}" up -d --no-build >/dev/null
wait_healthy || fail 'container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
register_project_resources "$smoke_project"
assert_runtime_contract

if run_admin_init_without_password "$runtime_dir/admin-running.out"; then
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
register_project_resources "$smoke_project"
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
"$resource_registrar" remove-container "$container_id" \
  || fail 'could not remove the exact registered stopped service container'
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
register_project_resources "$alt_project"
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
printf '%s\n' 'docker smoke: create real SQLite WAL/SHM recovery state' >&2
smoke_phase='real SQLite WAL and SHM generation'
[[ -z "$(docker ps -q --filter "volume=$smoke_volume")" ]] \
  || fail 'a process still has the source database volume open'
create_recovery_wal "$smoke_volume"
[[ -z "$(docker ps -q --filter "volume=$smoke_volume")" ]] \
  || fail 'the WAL generator left a process with the database open'
wal_source_hashes="$runtime_dir/wal-source.sha256"
  wal_after_integrity_hashes="$runtime_dir/wal-after-integrity.sha256"
  capture_db_sidecar_hashes "$smoke_volume" "$wal_source_hashes"
  sed 's/^/docker smoke: source SQLite SHA-256: /' "$wal_source_hashes" >&2
  assert_sqlite_integrity "$smoke_volume"
capture_db_sidecar_hashes "$smoke_volume" "$wal_after_integrity_hashes"
cmp "$wal_source_hashes" "$wal_after_integrity_hashes" >/dev/null \
  || fail 'SQLite integrity check changed DB/WAL/SHM bytes before backup'

printf '%s\n' 'docker smoke: backup failure and archive checks' >&2
smoke_phase='missing-container backup rejection'
missing_project="$(choose_project)" || fail 'could not allocate missing-project identity'
if COMPOSE_PROJECT_NAME="$missing_project" CONFDOCK_SMOKE_PROJECT="$missing_project" \
  CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/missing-backup" \
  >"$runtime_dir/missing-backup.out" 2>&1; then
  fail 'backup unexpectedly passed without a container'
fi

smoke_phase='backup creation and permissions'
backup_output="$(COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/backups")"
backup_file="$(printf '%s\n' "$backup_output" | sed -n 's/^Docker backup created: //p')"
[[ -f "$backup_file" ]] || fail 'backup script did not return an archive'
capture_db_sidecar_hashes "$smoke_volume" "$runtime_dir/wal-after-backup.sha256"
cmp "$wal_source_hashes" "$runtime_dir/wal-after-backup.sha256" >/dev/null \
  || fail 'backup changed DB/WAL/SHM bytes'
backup_mode="$(stat -c '%a' "$backup_file" 2>/dev/null || stat -f '%Lp' "$backup_file")"
backup_owner="$(stat -c '%u:%g' "$backup_file" 2>/dev/null || stat -f '%u:%g' "$backup_file")"
backup_dir_mode="$(stat -c '%a' "$runtime_dir/backups" 2>/dev/null || stat -f '%Lp' "$runtime_dir/backups")"
expected_owner="$(id -u):$(id -g)"
[[ "$backup_mode" == 600 && "$backup_dir_mode" == 700 && "$backup_owner" == "$expected_owner" ]] \
  || fail 'backup permissions or ownership are unsafe'
smoke_phase='backup target rejection'
printf '%s\n' 'not-a-directory' >"$runtime_dir/backup-target"
if COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  "$repo_root/scripts/backup-docker.sh" "$runtime_dir/backup-target" \
  >"$runtime_dir/backup-permission.out" 2>&1; then
  fail 'backup unexpectedly accepted a non-directory target'
fi
smoke_phase='backup archive contents'
tar -tzf "$backup_file" | sed 's#^\./##' | grep -Fx 'data/confdock.db' >/dev/null
tar -tzf "$backup_file" | sed 's#^\./##' | grep -Fx 'config.toml' >/dev/null
for sidecar in confdock.db-wal confdock.db-shm; do
  tar -tzf "$backup_file" | sed 's#^\./##' | grep -Fx "data/$sidecar" >/dev/null \
    || fail "backup omitted required SQLite sidecar: $sidecar"
done
for database_file in confdock.db confdock.db-wal confdock.db-shm; do
  archive_digest="$(tar -xOzf "$backup_file" "data/$database_file" | sha256sum)"
  archive_digest="${archive_digest%% *}"
  expected_digest="$(awk -v name="$database_file" '$2 == name { print $1 }' "$wal_source_hashes")"
  [[ -n "$expected_digest" && "$archive_digest" == "$expected_digest" ]] \
    || fail "archived SQLite bytes differ: $database_file"
done

printf '%s\n' 'docker smoke: deterministic restore staging race guards' >&2
smoke_phase='original archive replacement after private staging'
source_config_before_races="$(sha256sum "$config_file" | awk '{print $1}')"
backup_before_races="$(sha256sum "$backup_file" | awk '{print $1}')"
toctou_input="$runtime_dir/toctou-input.tar.gz"
toctou_saved="$runtime_dir/toctou-input.saved.tar.gz"
cp "$backup_file" "$toctou_input"
chmod 0600 "$toctou_input"
toctou_input_sha="$(sha256sum "$toctou_input" | awk '{print $1}')"
tar_wrapper_dir="$runtime_dir/tar-gate-wrapper"
mkdir -m 700 "$tar_wrapper_dir"
tar_ready_fifo="$runtime_dir/tar-stage-ready.fifo"
tar_release_fifo="$runtime_dir/tar-stage-release.fifo"
mkfifo "$tar_ready_fifo" "$tar_release_fifo"
real_tar="$(command -v tar)"
cat >"$tar_wrapper_dir/tar" <<'TAR_GATE_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
if mkdir "$CONFDOCK_TAR_GATE_LOCK" 2>/dev/null; then
  for argument in "$@"; do
    case "$argument" in
      */confdock-restore-stage.*/archive.*.tar.gz)
        printf '%s\n' "$argument" >"$CONFDOCK_TAR_READY_FIFO"
        IFS= read -r release <"$CONFDOCK_TAR_RELEASE_FIFO"
        [[ "$release" == continue ]]
        break
        ;;
    esac
  done
fi
exec "$CONFDOCK_REAL_TAR" "$@"
TAR_GATE_WRAPPER
chmod 0700 "$tar_wrapper_dir/tar"
toctou_volume="confdock-toctou-$(new_suffix)"
toctou_target="$runtime_dir/toctou-restored-config"
toctou_output="$runtime_dir/toctou-restore.out"
toctou_error="$runtime_dir/toctou-restore.err"
  exec 8<>"$tar_ready_fifo"
  exec 9<>"$tar_release_fifo"
  toctou_gate_open=1
PATH="$tar_wrapper_dir:$PATH" CONFDOCK_REAL_TAR="$real_tar" \
  CONFDOCK_TAR_GATE_LOCK="$runtime_dir/tar-gate.lock" \
  CONFDOCK_TAR_READY_FIFO="$tar_ready_fifo" \
  CONFDOCK_TAR_RELEASE_FIFO="$tar_release_fifo" \
  COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  CONFDOCK_SMOKE_PROJECT="$alt_project" CONFDOCK_IMAGE="$image" \
  CONFDOCK_RESTORE_VOLUME_NAME="$toctou_volume" \
  CONFDOCK_RESTORE_COMPOSE_PROJECT="$alt_project" \
  CONFDOCK_RESTORE_SMOKE_RUN="$smoke_run" \
  "$repo_root/scripts/restore-docker.sh" "$toctou_input" "$toctou_target" \
  >"$toctou_output" 2>"$toctou_error" &
toctou_pid=$!
if ! IFS= read -r -t 30 -u 8 toctou_staged_archive; then
  kill "$toctou_pid" 2>/dev/null || true
    wait "$toctou_pid" 2>/dev/null || true
    exec 8>&-
    exec 9>&-
    toctou_gate_open=0
    toctou_pid=''
    fail 'restore did not reach the deterministic post-staging gate'
fi
[[ "$toctou_staged_archive" != "$toctou_input" \
  && "$toctou_staged_archive" == */confdock-restore-stage.*/archive.*.tar.gz ]] \
  || fail 'restore tar validation did not use the private staged archive'
mv "$toctou_input" "$toctou_saved"
printf '%s\n' 'replacement bytes that are not a tar archive' >"$toctou_input"
chmod 0600 "$toctou_input"
printf '%s\n' continue >&9
if wait "$toctou_pid"; then
  toctou_status=0
else
  toctou_status=$?
fi
  exec 8>&-
  exec 9>&-
  toctou_gate_open=0
  toctou_pid=''
rm -f -- "$toctou_input"
mv "$toctou_saved" "$toctou_input"
[[ "$toctou_status" == 0 ]] || fail 'restore reopened the replaced original archive path'
[[ "$(sha256sum "$toctou_input" | awk '{print $1}')" == "$toctou_input_sha" ]] \
  || fail 'the original archive fixture was not restored byte-for-byte'
[[ ! -e "$toctou_staged_archive" && ! -L "$toctou_staged_archive" ]] \
  || fail 'private restore archive staging was not cleaned'
toctou_restored_volume="$(sed -n 's/^RESTORE_VOLUME_NAME=//p' "$toctou_output")"
toctou_restored_config="$(sed -n 's/^RESTORE_CONFIG_PATH=//p' "$toctou_output")"
[[ "$toctou_restored_volume" == "$toctou_volume" && -f "$toctou_restored_config" ]] \
  || fail 'post-staging archive replacement test did not complete a valid restore'
cmp "$original_config_copy" "$toctou_restored_config" >/dev/null
register_volume "$toctou_volume"

smoke_phase='staged archive mutation detection'
docker_wrapper_dir="$runtime_dir/docker-stage-wrapper"
mkdir -m 700 "$docker_wrapper_dir"
real_docker="$(command -v docker)"
tampered_stage_path_file="$runtime_dir/tampered-stage-path"
cat >"$docker_wrapper_dir/docker" <<'DOCKER_STAGE_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  case "$argument" in
    type=bind,source=*,destination=/input.tar.gz,readonly)
      staged_path="${argument#type=bind,source=}"
      staged_path="${staged_path%,destination=/input.tar.gz,readonly}"
      # Flip the gzip OS metadata byte. The archive remains fully extractable,
      # but its SHA-256 changes after the restore script's pre-extract check.
      python3 - "$staged_path" <<'PY'
import sys

path = sys.argv[1]
with open(path, "r+b") as archive:
    archive.seek(9)
    value = archive.read(1)
    if len(value) != 1:
        raise SystemExit("staged archive is unexpectedly short")
    archive.seek(9)
    archive.write(bytes([value[0] ^ 1]))
PY
      printf '%s\n' "$staged_path" >"$CONFDOCK_TAMPERED_STAGE_PATH_FILE"
      break
      ;;
  esac
done
exec "$CONFDOCK_REAL_DOCKER" "$@"
DOCKER_STAGE_WRAPPER
chmod 0700 "$docker_wrapper_dir/docker"
tamper_volume="confdock-tamper-$(new_suffix)"
tamper_target="$runtime_dir/tamper-restored-config"
if PATH="$docker_wrapper_dir:$PATH" CONFDOCK_REAL_DOCKER="$real_docker" \
  CONFDOCK_TAMPERED_STAGE_PATH_FILE="$tampered_stage_path_file" \
  COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  CONFDOCK_SMOKE_PROJECT="$alt_project" CONFDOCK_IMAGE="$image" \
  CONFDOCK_RESTORE_VOLUME_NAME="$tamper_volume" \
  CONFDOCK_RESTORE_COMPOSE_PROJECT="$alt_project" \
  CONFDOCK_RESTORE_SMOKE_RUN="$smoke_run" \
  "$repo_root/scripts/restore-docker.sh" "$backup_file" "$tamper_target" \
  >"$runtime_dir/tamper-restore.out" 2>"$runtime_dir/tamper-restore.err"; then
  fail 'restore unexpectedly accepted a mutated staged archive'
fi
grep -F 'staged backup archive changed after validation' \
  "$runtime_dir/tamper-restore.err" >/dev/null
tampered_stage_path="$(sed -n '1p' "$tampered_stage_path_file")"
[[ -n "$tampered_stage_path" && ! -e "$tampered_stage_path" ]] \
  || fail 'mutated private archive staging was not cleaned'
[[ ! -e "$tamper_target" && ! -L "$tamper_target" ]] \
  || fail 'failed staged-archive validation published a restore configuration'
register_volume "$tamper_volume"

smoke_phase='restore configuration target replacement rejection'
target_wrapper_dir="$runtime_dir/docker-target-wrapper"
mkdir -m 700 "$target_wrapper_dir"
target_volume="confdock-target-race-$(new_suffix)"
target_restore_dir="$runtime_dir/target-race-config"
cat >"$target_wrapper_dir/docker" <<'DOCKER_TARGET_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  case "$argument" in
    type=bind,source=*,destination=/etc/confdock/config.toml,readonly)
      if [[ ! -e "$CONFDOCK_TARGET_GATE_ONCE" ]]; then
        : >"$CONFDOCK_TARGET_GATE_ONCE"
        mkdir -m 700 "$CONFDOCK_RESTORE_TARGET"
        : >"$CONFDOCK_RESTORE_TARGET/replacement-marker"
      fi
      break
      ;;
  esac
done
exec "$CONFDOCK_REAL_DOCKER" "$@"
DOCKER_TARGET_WRAPPER
chmod 0700 "$target_wrapper_dir/docker"
if PATH="$target_wrapper_dir:$PATH" CONFDOCK_REAL_DOCKER="$real_docker" \
  CONFDOCK_TARGET_GATE_ONCE="$runtime_dir/target-gate.once" \
  CONFDOCK_RESTORE_TARGET="$target_restore_dir" \
  COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
  CONFDOCK_SMOKE_PROJECT="$alt_project" CONFDOCK_IMAGE="$image" \
  CONFDOCK_RESTORE_VOLUME_NAME="$target_volume" \
  CONFDOCK_RESTORE_COMPOSE_PROJECT="$alt_project" \
  CONFDOCK_RESTORE_SMOKE_RUN="$smoke_run" \
  "$repo_root/scripts/restore-docker.sh" "$backup_file" "$target_restore_dir" \
  >"$runtime_dir/target-race.out" 2>"$runtime_dir/target-race.err"; then
  fail 'restore unexpectedly published into a replaced configuration target'
fi
grep -F 'restore configuration target appeared before publication' \
  "$runtime_dir/target-race.err" >/dev/null
[[ -f "$target_restore_dir/replacement-marker" ]] \
  || fail 'restore cleanup modified a replacement configuration target'
  register_volume "$target_volume"
  rm -f -- "$target_restore_dir/replacement-marker"
  rmdir "$target_restore_dir"

  smoke_phase='restore configuration parent replacement rejection'
  parent_wrapper_dir="$runtime_dir/docker-parent-wrapper"
  mkdir -m 700 "$parent_wrapper_dir"
  parent_volume="confdock-parent-race-$(new_suffix)"
  parent_restore_root="$runtime_dir/parent-race-root"
  parent_restore_saved="$runtime_dir/parent-race-root.saved"
  parent_restore_target="$parent_restore_root/restored-config"
  mkdir -m 700 "$parent_restore_root"
  cat >"$parent_wrapper_dir/docker" <<'DOCKER_PARENT_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
replace_parent=0
for argument in "$@"; do
  case "$argument" in
    type=bind,source=*,destination=/etc/confdock/config.toml,readonly)
      replace_parent=1
      break
      ;;
  esac
done
"$CONFDOCK_NEXT_DOCKER" "$@"
status=$?
if [[ "$replace_parent" == 1 && ! -e "$CONFDOCK_PARENT_GATE_ONCE" ]]; then
  : >"$CONFDOCK_PARENT_GATE_ONCE"
  mv "$CONFDOCK_RESTORE_PARENT" "$CONFDOCK_RESTORE_PARENT_SAVED"
  mkdir -m 700 "$CONFDOCK_RESTORE_PARENT"
  : >"$CONFDOCK_RESTORE_PARENT/replacement-marker"
fi
exit "$status"
DOCKER_PARENT_WRAPPER
  chmod 0700 "$parent_wrapper_dir/docker"
  if PATH="$parent_wrapper_dir:$PATH" \
    CONFDOCK_NEXT_DOCKER="$docker_registry_wrapper_dir/docker" \
    CONFDOCK_PARENT_GATE_ONCE="$runtime_dir/parent-gate.once" \
    CONFDOCK_RESTORE_PARENT="$parent_restore_root" \
    CONFDOCK_RESTORE_PARENT_SAVED="$parent_restore_saved" \
    COMPOSE_PROJECT_NAME="$alt_project" CONFDOCK_COMPOSE_FILE="$compose_file" \
    CONFDOCK_SMOKE_PROJECT="$alt_project" CONFDOCK_IMAGE="$image" \
    CONFDOCK_RESTORE_VOLUME_NAME="$parent_volume" \
    CONFDOCK_RESTORE_COMPOSE_PROJECT="$alt_project" \
    CONFDOCK_RESTORE_SMOKE_RUN="$smoke_run" \
    "$repo_root/scripts/restore-docker.sh" "$backup_file" "$parent_restore_target" \
    >"$runtime_dir/parent-race.out" 2>"$runtime_dir/parent-race.err"; then
    fail 'restore unexpectedly published through a replaced configuration parent'
  fi
  grep -F 'restore configuration parent or staging identity changed before publication' \
    "$runtime_dir/parent-race.err" >/dev/null
  [[ -f "$parent_restore_root/replacement-marker" \
    && ! -e "$parent_restore_target" && ! -L "$parent_restore_target" ]] \
    || fail 'restore cleanup modified or published through a replacement parent'
  register_volume "$parent_volume"
  rm -f -- "$parent_restore_root/replacement-marker"
  rmdir "$parent_restore_root"
  mv "$parent_restore_saved" "$parent_restore_root"
  [[ ! -e "$parent_restore_target" && ! -L "$parent_restore_target" ]] \
    || fail 'failed parent-identity validation published a restore configuration'

  [[ "$(sha256sum "$backup_file" | awk '{print $1}')" == "$backup_before_races" \
    && "$(sha256sum "$config_file" | awk '{print $1}')" == "$source_config_before_races" ]] \
    || fail 'restore race tests changed the source archive or production configuration'
  printf '%s\n' 'docker smoke: restore staging, staged-byte, target, and parent race guards passed' >&2

smoke_phase='invalid restore volume rejection'
if CONFDOCK_IMAGE="$image" CONFDOCK_COMPOSE_FILE="$compose_file" \
  CONFDOCK_RESTORE_VOLUME_NAME='invalid/volume-name' \
  "$repo_root/scripts/restore-docker.sh" "$backup_file" \
  "$runtime_dir/invalid-name-config" >"$runtime_dir/invalid-name.out" 2>&1; then
  fail 'restore unexpectedly accepted an invalid volume name'
fi
if ! grep -F 'invalid restore volume name' "$runtime_dir/invalid-name.out" >/dev/null; then
  # Restore diagnostics are deliberately prefixed and never contain database
  # rows, passwords, sessions, or tokens. Show only that controlled error
  # class when an earlier fail-closed boundary masks the assertion under test.
  sed -n 's/^docker restore: /docker smoke: restore diagnostic: /p' \
    "$runtime_dir/invalid-name.out" >&2
  fail 'invalid restore volume rejection did not reach the name validator'
fi

smoke_phase='unsafe restore archive rejection'
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

smoke_phase='backup and source manifest comparison'
docker run --rm "${smoke_helper_args[@]}" "${smoke_helper_security[@]}" \
  --platform linux/amd64 --user 10001:10001 \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$smoke_volume,destination=/data,readonly,volume-nocopy" "$image" -eu -c \
  'find /data -type f -printf "%P\n"' | sort >"$runtime_dir/original-files"
tar -tzf "$backup_file" | sed -n 's#^data/##p' | awk 'NF' | sort >"$runtime_dir/archive-files"
cmp "$runtime_dir/original-files" "$runtime_dir/archive-files" >/dev/null
grep -Fx 'confdock.db-wal' "$runtime_dir/original-files" >/dev/null
grep -Fx 'confdock.db-shm' "$runtime_dir/original-files" >/dev/null
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
smoke_phase='pre-restore source manifest'
assert_volume_manifest "$smoke_volume" "$runtime_dir/pre-restore-original-manifest"

printf '%s\n' 'docker smoke: isolated restore and verification' >&2
smoke_phase='isolated restore creation'
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
register_volume "$restore_volume"
cmp "$original_config_copy" "$restore_config" >/dev/null \
  || fail 'restored configuration bytes differ from the backup source'
capture_db_sidecar_hashes "$restore_volume" "$runtime_dir/wal-restored-before-start.sha256"
sed 's/^/docker smoke: restored pre-start SQLite SHA-256: /' \
  "$runtime_dir/wal-restored-before-start.sha256" >&2
cmp "$wal_source_hashes" "$runtime_dir/wal-restored-before-start.sha256" >/dev/null \
  || fail 'restored DB/WAL/SHM bytes differ before first startup'
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
smoke_phase='isolated restore service verification'
wait_healthy || fail 'restored container did not become healthy'
container_id="$("${compose[@]}" ps -q confdock)"
register_project_resources "$restore_project"
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
printf '%s\n' 'docker smoke: original volume manifest unchanged during isolated restore' >&2

printf '%s\n' 'docker smoke: rollback to the untouched original volume' >&2
smoke_phase='original volume rollback'
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
register_project_resources "$alt_project"
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

# The controlled wrapper records both the shell wrapper argv and Linux procfs
# cmdline before exec. Successful subscription byte/header checks above prove
# curl received the URL through stdin, while these assertions prove it was not
# also present in either process argument view.
config_argv_count="$(grep -Fc $'ARGV\t--config' "$curl_argv_log" || true)"
config_proc_count="$(grep -Fc $'PROC\t--config' "$curl_argv_log" || true)"
[[ "$config_argv_count" -ge 4 && "$config_proc_count" -ge 4 ]] \
  || fail 'subscription curl argv/proc capture did not observe the safe config-stdin path'
if printf '%s\n' "$token_plain" | grep -aF -f - "$curl_argv_log" >/dev/null; then
  fail 'subscription token appeared in curl argv or procfs cmdline capture'
fi
printf 'docker smoke: subscription curl config-stdin calls=%s procfs_captures=%s token_in_argv=false\n' \
  "$config_argv_count" "$config_proc_count" >&2

# Inspect every temporary capture, not just the files whose names happen to
# be logs.  The check is quiet on success and never prints the matched value.
while IFS= read -r -d '' output_file; do
  output_name="${output_file#"$runtime_dir"/}"
  # Rejected malicious restore fixtures may intentionally leave root-owned,
  # mode-0600 archive members behind until the run-scoped trap removes them.
  # They are not command output and are unreadable to the runner; scan every
  # readable capture without emitting permission errors or secret values.
  [[ -r "$output_file" ]] || continue
  if printf '%s\n' "$password" | grep -aF -f - "$output_file" >/dev/null; then
    fail "private smoke output still contains the administrator password: $output_name"
  fi
  if printf '%s\n' "$token_plain" | grep -aF -f - "$output_file" >/dev/null; then
    fail "private smoke output still contains the subscription token: $output_name"
  fi
done < <(find "$runtime_dir" -type f -print0)

printf 'docker smoke test passed\n'
