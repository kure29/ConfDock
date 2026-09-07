#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
set +x

# Prepare a new, isolated volume from a backup. This script never changes the
# active volume or starts a service; the caller validates the isolated Compose
# instance before switching CONFDOCK_VOLUME_NAME.
IFS=$'\n\t'
export LC_ALL=C
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${CONFDOCK_COMPOSE_FILE:-$repo_root/deploy/docker/compose.yaml}"
input_archive="${1:-}"
restore_dir_arg="${2:-}"
host_uid="${CONFDOCK_HOST_UID:-$(id -u)}"
host_gid="${CONFDOCK_HOST_GID:-$(id -g)}"
restore_label_project="${CONFDOCK_RESTORE_COMPOSE_PROJECT:-}"
restore_label_run="${CONFDOCK_RESTORE_SMOKE_RUN:-}"

fail() {
  printf 'docker restore: %s\n' "$*" >&2
  exit 1
}

helper_label_args=()
if [[ -n "${CONFDOCK_SMOKE_RUN:-}" ]]; then
  [[ "$CONFDOCK_SMOKE_RUN" =~ ^[A-Za-z0-9_.-]+$ ]] \
    || fail 'CONFDOCK_SMOKE_RUN is not a valid label value'
  helper_project="${CONFDOCK_SMOKE_PROJECT:-${COMPOSE_PROJECT_NAME:-}}"
  helper_label_args=(
    --label "com.confdock.smoke.run=$CONFDOCK_SMOKE_RUN"
    --label 'com.confdock.smoke.kind=helper'
  )
  if [[ -n "$helper_project" ]]; then
    [[ "$helper_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
      || fail 'CONFDOCK_SMOKE_PROJECT is not a valid Compose project name'
    helper_label_args+=(--label "com.docker.compose.project=$helper_project")
  fi
fi

[[ -n "$input_archive" ]] || fail 'usage: restore-docker.sh BACKUP.tar.gz [RESTORE_CONFIG_DIR]'
command -v docker >/dev/null || fail 'docker is required'
for command_name in awk basename chmod chown cp date dirname find grep id mkdir mktemp mv od rm rmdir sed sha256sum sort stat tar tr uniq wc; do
  command -v "$command_name" >/dev/null || fail "required command missing: $command_name"
done
[[ "$host_uid" =~ ^[0-9]+$ && "$host_gid" =~ ^[0-9]+$ ]] \
  || fail 'CONFDOCK_HOST_UID and CONFDOCK_HOST_GID must be numeric'
if [[ -n "$restore_label_project" \
  && ! "$restore_label_project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  fail 'CONFDOCK_RESTORE_COMPOSE_PROJECT is not a valid Compose project name'
fi
if [[ -n "$restore_label_run" && ! "$restore_label_run" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  fail 'CONFDOCK_RESTORE_SMOKE_RUN is not a valid label value'
fi
# A restore command must never inherit a bootstrap secret from the caller. The
# service image receives only the explicit, non-secret UID/GID values below.
unset CONFDOCK_BOOTSTRAP_PASSWORD CONFDOCK_ADMIN_PASSWORD CONFDOCK_SUB_TOKEN
[[ -f "$compose_file" ]] || fail "Compose file does not exist: $compose_file"
if [[ -n "${CONFDOCK_ENV_FILE:-}" ]]; then
  [[ -f "$CONFDOCK_ENV_FILE" && ! -L "$CONFDOCK_ENV_FILE" ]] \
    || fail "Compose env file is missing or a symlink: $CONFDOCK_ENV_FILE"
fi
[[ "$input_archive" != *$'\n'* && "$input_archive" != *$'\r'* \
  && "$input_archive" != *$'\t'* && "$input_archive" != *,* ]] \
  || fail 'backup archive path contains unsafe characters'
[[ -f "$input_archive" && ! -L "$input_archive" ]] \
  || fail "backup archive is missing or a symlink: $input_archive"
input_archive_dir="$(cd "$(dirname "$input_archive")" && pwd -P)" \
  || fail "backup directory does not exist: $(dirname "$input_archive")"
input_archive="${input_archive_dir}/$(basename "$input_archive")"
[[ -f "$input_archive" && ! -L "$input_archive" ]] \
  || fail 'backup archive changed while its parent directory was resolved'
input_archive_mode="$(stat -c '%a' "$input_archive" 2>/dev/null || stat -f '%Lp' "$input_archive")"
[[ "$input_archive_mode" == 600 ]] || fail 'backup archive must have mode 0600'
# Pin the verified regular file before copying. A pathname replacement between
# metadata validation and snapshot creation cannot redirect the copy to a
# different inode.
exec {input_archive_fd}<"$input_archive" \
  || fail 'backup archive could not be opened for private staging'
input_archive_fd_path="/proc/$$/fd/$input_archive_fd"
[[ -r "$input_archive_fd_path" ]] || input_archive_fd_path="/dev/fd/$input_archive_fd"
input_archive_path_identity="$(stat -c '%d:%i' "$input_archive" 2>/dev/null || stat -f '%d:%i' "$input_archive")"
input_archive_fd_identity="$(stat -Lc '%d:%i' "$input_archive_fd_path" 2>/dev/null || stat -Lf '%d:%i' "$input_archive_fd_path")"
input_archive_fd_type="$(stat -Lc '%F' "$input_archive_fd_path" 2>/dev/null || stat -Lf '%HT' "$input_archive_fd_path")"
input_archive_fd_mode="$(stat -Lc '%a' "$input_archive_fd_path" 2>/dev/null || stat -Lf '%Lp' "$input_archive_fd_path")"
[[ "$input_archive_path_identity" == "$input_archive_fd_identity" \
  && "$input_archive_fd_type" == 'regular file' && "$input_archive_fd_mode" == 600 ]] \
  || fail 'backup archive identity or type changed before private staging'

staging_root=''
staged_archive=''
staged_archive_sha256=''
entries_file=''
types_file=''
config_stage_dir=''
config_stage_identity=''
restore_dir=''
restore_parent=''
restore_parent_identity=''
restore_dir_identity=''
restore_dir_reserved=0
restore_volume=''
restore_marker=''
keep_restore_volume=0
keep_restore_dir=0
cleanup() {
  [[ -z "$entries_file" || ! -e "$entries_file" ]] || rm -f -- "$entries_file"
  [[ -z "$types_file" || ! -e "$types_file" ]] || rm -f -- "$types_file"
  [[ -z "$staged_archive" || ! -e "$staged_archive" ]] || rm -f -- "$staged_archive"
  if [[ -n "$config_stage_dir" && -n "$config_stage_identity" \
    && "$(path_identity "$config_stage_dir" 2>/dev/null || true)" == "$config_stage_identity" \
    && -d "$config_stage_dir" && ! -L "$config_stage_dir" ]]; then
    if [[ -f "$config_stage_dir/config.toml" || -L "$config_stage_dir/config.toml" ]]; then
      rm -f -- "$config_stage_dir/config.toml"
    fi
    rmdir -- "$config_stage_dir" 2>/dev/null || true
  fi
  if [[ -n "$staging_root" && -d "$staging_root" && ! -L "$staging_root" ]]; then
    rmdir -- "$staging_root" 2>/dev/null || true
  fi
  if [[ "$keep_restore_volume" == 0 && -n "$restore_volume" && -n "$restore_marker" ]]; then
    # A volume name can be raced after a failed operation. Only remove the
    # volume carrying this invocation's marker; never remove an unrelated
    # volume that happens to reuse the requested name.
    current_marker="$(docker volume inspect -f '{{index .Labels "com.confdock.restore.id"}}' \
      "$restore_volume" 2>/dev/null || true)"
    if [[ -n "$restore_marker" && "$current_marker" == "$restore_marker" ]]; then
      docker volume rm "$restore_volume" >/dev/null 2>&1 || true
    fi
  fi
  # Remove only the exact empty/config-only directory reserved by this
  # invocation. If its inode changed, leave the replacement untouched and
  # report it for manual inspection instead of following a raced path.
  if [[ "$keep_restore_dir" == 0 && "$restore_dir_reserved" == 1 \
    && -n "$restore_dir" && -n "$restore_dir_identity" ]]; then
    current_restore_identity="$(path_identity "$restore_dir" 2>/dev/null || true)"
    if [[ "$current_restore_identity" == "$restore_dir_identity" \
      && -d "$restore_dir" && ! -L "$restore_dir" ]]; then
      if [[ -f "$restore_dir/config.toml" && ! -L "$restore_dir/config.toml" ]]; then
        rm -f -- "$restore_dir/config.toml"
      fi
      rmdir -- "$restore_dir" 2>/dev/null || true
    elif [[ -e "$restore_dir" || -L "$restore_dir" ]]; then
      printf 'docker restore: restore target identity changed; left untouched for manual inspection: %s\n' \
        "$restore_dir" >&2
    fi
  fi
}
trap cleanup EXIT

path_identity() {
  local path="$1"
  stat -c '%d:%i' "$path" 2>/dev/null || stat -f '%d:%i' "$path"
}

# Snapshot the caller-supplied archive before inspecting any archive content.
# All later tar and Docker operations use only this private, unpredictable copy,
# so replacing the original pathname cannot substitute unvalidated bytes.
staging_root="$(mktemp -d -t confdock-restore-stage.XXXXXX)"
chmod 0700 "$staging_root"
staging_mode="$(stat -c '%a' "$staging_root" 2>/dev/null || stat -f '%Lp' "$staging_root")"
staging_owner="$(stat -c '%u:%g' "$staging_root" 2>/dev/null || stat -f '%u:%g' "$staging_root")"
[[ "$staging_mode" == 700 && "$staging_owner" == "$(id -u):$(id -g)" ]] \
  || fail 'restore staging directory has unsafe permissions or ownership'
[[ "$staging_root" != *,* ]] || fail 'restore staging path contains an unsupported comma'
staged_archive="$(mktemp "$staging_root/archive.XXXXXX.tar.gz")"
cp -- "$input_archive_fd_path" "$staged_archive"
exec {input_archive_fd}<&-
chmod 0600 "$staged_archive"
[[ -f "$staged_archive" && ! -L "$staged_archive" ]] \
  || fail 'could not create a private regular-file archive snapshot'
staged_mode="$(stat -c '%a' "$staged_archive" 2>/dev/null || stat -f '%Lp' "$staged_archive")"
staged_owner="$(stat -c '%u:%g' "$staged_archive" 2>/dev/null || stat -f '%u:%g' "$staged_archive")"
[[ "$staged_mode" == 600 && "$staged_owner" == "$(id -u):$(id -g)" ]] \
  || fail 'staged backup archive has unsafe permissions or ownership'
staged_archive_sha256="$(sha256sum "$staged_archive" | awk '{print $1}')"
[[ "$staged_archive_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'could not fingerprint the staged backup archive'

# Retain only the resolved parent for the default output location. The original
# archive pathname is deliberately discarded and is never passed to tar or
# Docker after the snapshot above.
archive_dir="$input_archive_dir"
unset input_archive input_archive_dir input_archive_mode input_archive_fd_path \
  input_archive_path_identity input_archive_fd_identity input_archive_fd_type \
  input_archive_fd_mode
archive="$staged_archive"

assert_staged_archive_unchanged() {
  local current_mode current_owner current_sha256
  [[ -f "$archive" && ! -L "$archive" ]] || fail 'staged backup archive changed type'
  current_mode="$(stat -c '%a' "$archive" 2>/dev/null || stat -f '%Lp' "$archive")"
  current_owner="$(stat -c '%u:%g' "$archive" 2>/dev/null || stat -f '%u:%g' "$archive")"
  current_sha256="$(sha256sum "$archive" | awk '{print $1}')"
  [[ "$current_mode" == 600 && "$current_owner" == "$(id -u):$(id -g)" \
    && "$current_sha256" == "$staged_archive_sha256" ]] \
    || fail 'staged backup archive changed after validation'
}

entries_file="$(mktemp "$staging_root/entries.XXXXXX")"
types_file="$(mktemp "$staging_root/types.XXXXXX")"

tar -tzf "$archive" >"$entries_file" \
  || fail 'backup archive is not a valid gzip tar archive'
[[ -s "$entries_file" ]] || fail 'backup archive is empty'
duplicate_entries="$(sort "$entries_file" | uniq -d)"
if [[ -n "$duplicate_entries" ]]; then
  fail 'backup archive contains duplicate paths'
fi
duplicate_normalized_entries="$(sed 's#/$##' "$entries_file" | sort | uniq -d)"
if [[ -n "$duplicate_normalized_entries" ]]; then
  fail 'backup archive contains duplicate paths'
fi

# Inspect archive entry types before extraction.  Rejecting symlink, hardlink,
# and device entries up front prevents a malicious archive from creating a
# symlink parent and then writing a later regular file through it.
tar -tvzf "$archive" >"$types_file" \
  || fail 'backup archive could not be inspected'
while IFS= read -r listing; do
  [[ -n "$listing" ]] || continue
  case "${listing:0:1}" in
    -|d) ;;
    *) fail 'backup archive contains a link or special file' ;;
  esac
done <"$types_file"
assert_staged_archive_unchanged

has_db=0
has_config=0
while IFS= read -r entry; do
  [[ -n "$entry" ]] || continue
  if [[ "$entry" == *$'\n'* || "$entry" == *$'\r'* || "$entry" == *$'\t'* ]]; then
    fail 'backup contains control characters in a path'
  fi
  case "$entry" in
    ''|/*|./*|*\\*|*//*|*/./*|*/.) fail 'backup contains a non-canonical path' ;;
  esac
  case "/$entry/" in
    */../*) fail 'backup contains an unsafe path' ;;
  esac
  case "$entry" in
    data|data/*)
      [[ "$entry" == 'data/confdock.db' ]] && has_db=1
      ;;
    config.toml) has_config=1 ;;
    *) fail 'backup contains a path outside data/ and config.toml' ;;
  esac
done <"$entries_file"
[[ "$has_db" == 1 ]] || fail 'backup does not contain data/confdock.db'
[[ "$has_config" == 1 ]] || fail 'backup does not contain config.toml'

compose=(docker compose)
if [[ -n "${CONFDOCK_ENV_FILE:-}" ]]; then
  compose+=(--env-file "$CONFDOCK_ENV_FILE")
fi
compose+=(-f "$compose_file")

# Require the stopped container's image and mount metadata. Keeping this
# requirement fail-closed ensures a restore can never silently operate on an
# unknown volume or configuration after a project-name change.
if ! container_ids="$("${compose[@]}" ps -aq confdock 2>/dev/null)"; then
  fail 'could not inspect the Compose confdock container'
fi
container_count="$(printf '%s\n' "$container_ids" | awk 'NF { n += 1 } END { print n + 0 }')"
image_ref=''
original_volume=''
original_config=''
case "$container_count" in
  0) fail 'exactly one stopped Compose confdock container is required' ;;
  1)
    container_id="$(printf '%s\n' "$container_ids" | awk 'NF { print; exit }')"
    [[ "$container_id" =~ ^[0-9a-fA-F]{12,64}$ ]] \
      || fail 'Compose returned an invalid container identifier'
    container_id="$(docker inspect -f '{{.Id}}' "$container_id" 2>/dev/null)" \
      || fail 'the Compose confdock container could not be inspected'
    [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] \
      || fail 'Docker returned an invalid canonical container identifier'
    container_state="$(docker inspect -f '{{.State.Status}}' "$container_id")"
    case "$container_state" in
      created|dead|exited) ;;
      *) fail "stop the original container before restore (state: $container_state)" ;;
    esac
    # Pin helper operations to the exact image used by the stopped service;
    # mutable tags must not silently change the restore tooling.
    image_ref="$(docker inspect -f '{{.Image}}' "$container_id")"
    original_mount_destinations="$(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' \
      "$container_id")"
    while IFS= read -r original_mount_destination; do
      [[ -n "$original_mount_destination" ]] || continue
      case "$original_mount_destination" in
        /var/lib/confdock|/etc/confdock/config.toml|/tmp|/etc/hostname|/etc/hosts|/etc/resolv.conf) ;;
        *) fail "the original container has an unexpected mount: $original_mount_destination" ;;
      esac
    done <<<"$original_mount_destinations"
    original_data_mount_count="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}x{{end}}{{end}}' "$container_id" | tr -cd 'x' | wc -c | tr -d '[:space:]')"
    original_config_mount_count="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}x{{end}}{{end}}' "$container_id" | tr -cd 'x' | wc -c | tr -d '[:space:]')"
    [[ "$original_data_mount_count" == 1 && "$original_config_mount_count" == 1 ]] \
      || fail 'original container data or configuration mount is missing or not unique'
    original_volume_type="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.Type}}{{end}}{{end}}' "$container_id")"
    original_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.Name}}{{end}}{{end}}' "$container_id")"
    original_volume_rw="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.RW}}{{end}}{{end}}' "$container_id")"
    original_config_type="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.Type}}{{end}}{{end}}' "$container_id")"
    original_config="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.Source}}{{end}}{{end}}' "$container_id")"
    original_config_rw="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.RW}}{{end}}{{end}}' "$container_id")"
    [[ "$original_volume_type" == volume && -n "$original_volume" && "$original_volume_rw" == true ]] \
      || fail 'original container does not have the expected writable named volume'
    [[ "$original_config_type" == bind && -n "$original_config" && "$original_config_rw" == false ]] \
      || fail 'original container does not have the expected read-only config bind mount'
    [[ "$original_config" = /* && "$original_config" != *$'\n'* \
      && "$original_config" != *$'\r'* && "$original_config" != *$'\t'* \
      && "$original_config" != *,* ]] \
      || fail 'original configuration path contains unsafe characters'
    [[ -f "$original_config" && ! -L "$original_config" ]] \
      || fail 'original configuration file is missing or a symlink'
    original_volume_exists="$(docker volume inspect -f '{{.Name}}' "$original_volume" 2>/dev/null)" \
      || fail 'the original data volume does not exist'
    [[ "$original_volume_exists" == "$original_volume" ]] \
      || fail 'the original data volume name could not be verified'
    [[ "$original_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
      || fail 'the original data volume name is invalid'
    if ! original_volume_container_ids="$(docker ps -aq --filter "volume=$original_volume")"; then
      fail 'could not inspect containers using the original data volume'
    fi
    while IFS= read -r original_volume_container_id; do
      [[ -n "$original_volume_container_id" ]] || continue
      original_volume_container_canonical_id="$(docker inspect -f '{{.Id}}' \
        "$original_volume_container_id" 2>/dev/null)" \
        || fail 'a container using the original data volume could not be inspected'
      [[ "$original_volume_container_canonical_id" =~ ^[0-9a-f]{64}$ ]] \
        || fail 'Docker returned an invalid container identifier for the original data volume'
      [[ "$original_volume_container_canonical_id" == "$container_id" ]] \
        || fail 'the original data volume is mounted by another container'
    done <<<"$original_volume_container_ids"
    ;;
  *) fail 'multiple Compose confdock containers found; isolate or remove them before restore' ;;
esac
[[ "$image_ref" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || fail 'the stopped container image cannot be resolved to an immutable ID'

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
random_suffix=''
restore_marker=''
restore_volume=''
if [[ -n "${CONFDOCK_RESTORE_VOLUME_NAME:-}" ]]; then
  random_suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  [[ -n "$random_suffix" ]] || fail 'could not generate a restore name marker'
  restore_marker="confdock-restore-$stamp-$random_suffix"
  restore_volume="$CONFDOCK_RESTORE_VOLUME_NAME"
else
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    random_suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    [[ -n "$random_suffix" ]] || continue
    restore_marker="confdock-restore-$stamp-$random_suffix"
    restore_volume="$restore_marker"
    if ! docker volume inspect "$restore_volume" >/dev/null 2>&1; then
      break
    fi
    restore_marker=''
    restore_volume=''
  done
  [[ -n "$restore_volume" && -n "$restore_marker" ]] \
    || fail 'could not allocate a unique restore volume name'
fi
[[ "$restore_volume" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fail "invalid restore volume name: $restore_volume"
[[ "${#restore_volume}" -le 255 ]] || fail 'restore volume name is too long'
[[ "$restore_volume" != . && "$restore_volume" != .. ]] \
  || fail 'restore volume name is not a usable Docker volume name'
[[ "$restore_volume" != "$original_volume" ]] \
  || fail 'restore volume must be different from the original volume'
if [[ -n "${CONFDOCK_RESTORE_VOLUME_NAME:-}" ]] \
  && docker volume inspect "$restore_volume" >/dev/null 2>&1; then
  fail "restore volume already exists: $restore_volume"
fi

if [[ -n "$restore_dir_arg" ]]; then
  [[ "$restore_dir_arg" != *$'\n'* && "$restore_dir_arg" != *$'\r'* \
    && "$restore_dir_arg" != *$'\t'* && "$restore_dir_arg" != *,* ]] \
    || fail 'restore configuration path contains unsafe characters'
  restore_parent="$(cd "$(dirname "$restore_dir_arg")" && pwd -P)" \
    || fail "restore parent directory does not exist: $(dirname "$restore_dir_arg")"
  restore_dir="${restore_parent}/$(basename "$restore_dir_arg")"
else
  restore_parent="$archive_dir"
  restore_dir="$restore_parent/confdock-restore-$stamp-$random_suffix"
fi
[[ -d "$restore_parent" && ! -L "$restore_parent" ]] \
  || fail 'restore configuration parent is not a real directory'
restore_parent_identity="$(path_identity "$restore_parent")" \
  || fail 'could not record restore configuration parent identity'
if [[ -e "$restore_dir" || -L "$restore_dir" ]]; then
  fail "restore config directory already exists: $restore_dir"
fi
actual_host_uid="$(id -u)"
actual_host_gid="$(id -g)"
if [[ "$host_uid" != "$actual_host_uid" || "$host_gid" != "$actual_host_gid" ]]; then
  [[ "$actual_host_uid" == 0 ]] \
    || fail 'CONFDOCK_HOST_UID/GID differs from the invoking user; run as that user or root'
fi
# Create the configuration staging directory beside its final target. GNU
# rename with `-T -n` can then publish the entire verified directory atomically
# without ever overwriting an existing path.
config_stage_dir="$(mktemp -d "$restore_parent/.confdock-restore-config.XXXXXX")"
chmod 0700 "$config_stage_dir"
if [[ "$host_uid" != "$actual_host_uid" || "$host_gid" != "$actual_host_gid" ]]; then
  chown "$host_uid:$host_gid" "$config_stage_dir"
fi
[[ -d "$config_stage_dir" && ! -L "$config_stage_dir" ]] \
  || fail 'could not create a private configuration staging directory'
config_stage_identity="$(path_identity "$config_stage_dir")" \
  || fail 'could not record configuration staging identity'
volume_create=(docker volume create)
volume_create+=(--label "com.confdock.restore.id=$restore_marker")
if [[ -n "$restore_label_project" ]]; then
  volume_create+=(
    --label "com.docker.compose.project=$restore_label_project"
    --label 'com.docker.compose.volume=confdock-data'
  )
fi
if [[ -n "$restore_label_run" ]]; then
  volume_create+=(
    --label "com.confdock.smoke.run=$restore_label_run"
    --label 'com.confdock.smoke.kind=volume'
    --label "com.confdock.smoke.resource=$restore_marker"
  )
fi
"${volume_create[@]}" "$restore_volume" >/dev/null
# Keep every successfully-created isolated volume for operator inspection and
# an explicit cut-over/rollback decision. Smoke labels these resources and
# removes only its own labelled volume in its run-scoped cleanup trap.
keep_restore_volume=1
restore_volume_driver="$(docker volume inspect -f '{{.Driver}}' "$restore_volume" 2>/dev/null)" \
  || fail 'restore volume disappeared immediately after creation'
restore_volume_created_at="$(docker volume inspect -f '{{.CreatedAt}}' "$restore_volume" 2>/dev/null)" \
  || fail 'could not read the restore volume creation time'
[[ -n "$restore_volume_driver" && -n "$restore_volume_created_at" ]] \
  || fail 'restore volume metadata is incomplete'

assert_restore_volume_identity() {
  local current_name current_marker current_driver current_created_at
  current_name="$(docker volume inspect -f '{{.Name}}' "$restore_volume" 2>/dev/null)" \
    || fail 'restore volume disappeared during extraction or validation'
  current_marker="$(docker volume inspect -f '{{index .Labels "com.confdock.restore.id"}}' \
    "$restore_volume" 2>/dev/null)" \
    || fail 'could not read the restore volume marker'
  current_driver="$(docker volume inspect -f '{{.Driver}}' "$restore_volume" 2>/dev/null)" \
    || fail 'could not read the restore volume driver'
  current_created_at="$(docker volume inspect -f '{{.CreatedAt}}' "$restore_volume" 2>/dev/null)" \
    || fail 'could not read the restore volume creation time'
  [[ "$current_name" == "$restore_volume" && "$current_marker" == "$restore_marker" \
    && "$current_driver" == "$restore_volume_driver" \
    && "$current_created_at" == "$restore_volume_created_at" ]] \
    || fail 'restore volume identity changed during extraction or validation'
}

assert_restore_volume_identity
if ! restore_volume_container_ids="$(docker ps -aq --filter "volume=$restore_volume")"; then
  fail 'could not inspect containers using the restore volume'
fi
[[ -z "$restore_volume_container_ids" ]] \
  || fail 'restore volume became mounted before extraction'

# Extraction is done directly into the newly-created volume by the runtime
# image's official Debian tar.  Direct extraction avoids a fixed-size staging
# tmpfs, so a valid backup is not rejected merely because the data directory is
# larger than an arbitrary temporary limit. Root is used only inside this
# disposable helper to set the volume's required application ownership; no host
# path other than the private config staging directory is modified, and the active volume is never
# mounted.
assert_staged_archive_unchanged
docker run --rm "${helper_label_args[@]}" --platform linux/amd64 --user 0:0 --entrypoint /bin/sh \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,mode=700 --network none \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges \
  --env "CONFDOCK_HOST_UID=$host_uid" --env "CONFDOCK_HOST_GID=$host_gid" \
  --mount "type=bind,source=$archive,destination=/input.tar.gz,readonly" \
  --mount "type=volume,source=$restore_volume,destination=/restore-data,volume-nocopy" \
  --mount "type=bind,source=$config_stage_dir,destination=/restore-config" \
  "$image_ref" -eu -c '
    test -d /restore-data
    test ! -L /restore-data
    test -d /restore-config
    test ! -L /restore-config
    if find /restore-data -mindepth 1 -print -quit | grep -q .; then exit 1; fi
    if find /restore-config -mindepth 1 -print -quit | grep -q .; then exit 1; fi
    # The archive paths were fully checked above. Extract the data subtree with
    # its leading `data/` component removed, then extract the one config file.
    # Both destinations are empty, and keep-old-files fails rather than
    # overwriting an entry if that invariant ever changes. GNU tar rejects
    # keep-old-files combined with no-overwrite-dir, so use the stronger
    # fail-on-any-existing-member behavior on its own.
    tar -xzf /input.tar.gz --no-same-owner --no-same-permissions --keep-old-files \
      --strip-components=1 -C /restore-data -- data
    tar -xzf /input.tar.gz --no-same-owner --no-same-permissions --keep-old-files \
      -C /restore-config -- config.toml
    test -s /restore-data/confdock.db
    test ! -L /restore-data/confdock.db
    test -f /restore-config/config.toml
    test ! -L /restore-config/config.toml
    if find /restore-data \( -type l -o ! -type f -a ! -type d \) -print -quit | grep -q .; then exit 1; fi
    if find /restore-data -type f -links +1 -print -quit | grep -q .; then exit 1; fi
    chown -R 10001:10001 /restore-data
    find /restore-data -type d -exec chmod 700 {} +
    find /restore-data -type f -exec chmod 600 {} +
    if find /restore-data \( ! -user 10001 -o ! -group 10001 \) -print -quit | grep -q .; then exit 1; fi
    if find /restore-data -type d ! -perm 700 -print -quit | grep -q .; then exit 1; fi
    if find /restore-data -type f ! -perm 600 -print -quit | grep -q .; then exit 1; fi
    chown "$CONFDOCK_HOST_UID:$CONFDOCK_HOST_GID" /restore-config/config.toml
    chmod 0644 /restore-config/config.toml
  '

assert_staged_archive_unchanged
assert_restore_volume_identity

# Keep the restored database and its WAL/SHM sidecars byte-for-byte unchanged
# during this pre-start integrity check. SQLite runs on a tmpfs copy because a
# read-only WAL database may legitimately need to create a new SHM file.
docker run --rm "${helper_label_args[@]}" --cap-drop ALL --security-opt no-new-privileges \
  --platform linux/amd64 --user 10001:10001 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --entrypoint /bin/sh \
  --network none \
  --mount "type=volume,source=$restore_volume,destination=/check,readonly,volume-nocopy" \
  "$image_ref" -eu -c '
    test -d /check
    test "$(stat -c "%u:%g" /check)" = 10001:10001
    test -s /check/confdock.db
    test ! -L /check/confdock.db
    if find /check \( -type l -o ! -type f -a ! -type d \) -print -quit | grep -q .; then exit 1; fi
    if find /check -type f -links +1 -print -quit | grep -q .; then exit 1; fi
    if find /check \( ! -user 10001 -o ! -group 10001 \) -print -quit | grep -q .; then exit 1; fi
    if find /check -type d ! -perm 700 -print -quit | grep -q .; then exit 1; fi
    if find /check -type f ! -perm 600 -print -quit | grep -q .; then exit 1; fi
    scratch=/var/lib/confdock/integrity
    mkdir -m 700 "$scratch"
    for name in confdock.db confdock.db-wal confdock.db-shm; do
      if test -e "/check/$name" || test -L "/check/$name"; then
        test -f "/check/$name" && test ! -L "/check/$name"
        cp -- "/check/$name" "$scratch/$name"
      fi
    done
    test "$(sqlite3 "file:$scratch/confdock.db?mode=rw" "PRAGMA integrity_check;")" = ok
  '
assert_restore_volume_identity
[[ -f "$config_stage_dir/config.toml" && ! -L "$config_stage_dir/config.toml" ]] \
  || fail 'restored config.toml is missing or a symlink'
config_stage_mode="$(stat -c '%a' "$config_stage_dir" 2>/dev/null || stat -f '%Lp' "$config_stage_dir")"
[[ "$config_stage_mode" == 700 ]] \
  || fail 'restored configuration staging directory has unexpected permissions'
config_mode="$(stat -c '%a' "$config_stage_dir/config.toml" 2>/dev/null || stat -f '%Lp' "$config_stage_dir/config.toml")"
config_owner="$(stat -c '%u:%g' "$config_stage_dir/config.toml" 2>/dev/null || stat -f '%u:%g' "$config_stage_dir/config.toml")"
[[ "$config_mode" == 644 && "$config_owner" == "$host_uid:$host_gid" ]] \
  || fail 'restored config.toml has unexpected permissions or ownership'
docker run --rm "${helper_label_args[@]}" --cap-drop ALL --security-opt no-new-privileges \
  --platform linux/amd64 --user 10001:10001 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  --mount "type=bind,source=$config_stage_dir/config.toml,destination=/etc/confdock/config.toml,readonly" \
  "$image_ref" --config /etc/confdock/config.toml config check >/dev/null \
  || fail 'restored config.toml failed config check'

assert_staged_archive_unchanged
assert_restore_volume_identity

assert_restore_destination_available() {
  local current_parent_identity current_stage_identity current_mode current_owner
  current_parent_identity="$(path_identity "$restore_parent" 2>/dev/null || true)"
  current_stage_identity="$(path_identity "$config_stage_dir" 2>/dev/null || true)"
  [[ "$current_parent_identity" == "$restore_parent_identity" \
    && "$current_stage_identity" == "$config_stage_identity" \
    && -d "$config_stage_dir" && ! -L "$config_stage_dir" ]] \
    || fail 'restore configuration parent or staging identity changed before publication'
  [[ ! -e "$restore_dir" && ! -L "$restore_dir" ]] \
    || fail 'restore configuration target appeared before publication'
  current_mode="$(stat -c '%a' "$config_stage_dir" 2>/dev/null || stat -f '%Lp' "$config_stage_dir")"
  current_owner="$(stat -c '%u:%g' "$config_stage_dir" 2>/dev/null || stat -f '%u:%g' "$config_stage_dir")"
  [[ "$current_mode" == 700 && "$current_owner" == "$host_uid:$host_gid" ]] \
    || fail 'restore configuration staging permissions or ownership changed'
  [[ "$(find "$config_stage_dir" -mindepth 1 -maxdepth 1 -print)" \
    == "$config_stage_dir/config.toml" ]] \
    || fail 'restore configuration staging contains unexpected entries'
}

assert_restore_destination_available
staged_config_sha256="$(sha256sum "$config_stage_dir/config.toml" | awk '{print $1}')"
[[ "$staged_config_sha256" =~ ^[0-9a-f]{64}$ ]] \
  || fail 'could not fingerprint staged config.toml'
# Both paths have the same verified parent. GNU `mv -T -n` maps to a no-replace
# directory rename, so a target raced into place is never traversed or overwritten.
mv -T -n "$config_stage_dir" "$restore_dir"
[[ ! -e "$config_stage_dir" && ! -L "$config_stage_dir" ]] \
  || fail 'restore configuration target appeared during atomic publication'
restore_dir_reserved=1
restore_dir_identity="$config_stage_identity"
config_stage_dir=''
config_stage_identity=''
[[ "$(path_identity "$restore_dir")" == "$restore_dir_identity" \
  && -f "$restore_dir/config.toml" && ! -L "$restore_dir/config.toml" ]] \
  || fail 'published config.toml or its target directory changed identity'
published_config_sha256="$(sha256sum "$restore_dir/config.toml" | awk '{print $1}')"
published_config_mode="$(stat -c '%a' "$restore_dir/config.toml" 2>/dev/null || stat -f '%Lp' "$restore_dir/config.toml")"
published_config_owner="$(stat -c '%u:%g' "$restore_dir/config.toml" 2>/dev/null || stat -f '%u:%g' "$restore_dir/config.toml")"
[[ "$published_config_sha256" == "$staged_config_sha256" \
  && "$published_config_mode" == 644 \
  && "$published_config_owner" == "$host_uid:$host_gid" ]] \
  || fail 'published config.toml differs from the validated staging file'
assert_staged_archive_unchanged

printf 'RESTORE_VOLUME_NAME=%s\n' "$restore_volume"
printf 'RESTORE_CONFIG_PATH=%s\n' "$restore_dir/config.toml"
printf 'ORIGINAL_VOLUME_NAME=%s\n' "$original_volume"
printf 'ORIGINAL_CONFIG_PATH=%s\n' "$original_config"
printf 'IMAGE_REF=%s\n' "$image_ref"
keep_restore_volume=1
keep_restore_dir=1
