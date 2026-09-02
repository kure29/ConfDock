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
archive="${1:-}"
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

[[ -n "$archive" ]] || fail 'usage: restore-docker.sh BACKUP.tar.gz [RESTORE_CONFIG_DIR]'
command -v docker >/dev/null || fail 'docker is required'
for command_name in awk basename chmod chown date dirname find grep id mkdir mktemp od rm rmdir sed sort stat tar tr uniq wc; do
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
[[ -f "$archive" && ! -L "$archive" ]] || fail "backup archive is missing or a symlink: $archive"
[[ "$archive" != *$'\n'* && "$archive" != *$'\r'* && "$archive" != *$'\t'* \
  && "$archive" != *,* ]] || fail 'backup archive path contains unsafe characters'
archive_mode="$(stat -c '%a' "$archive" 2>/dev/null || stat -f '%Lp' "$archive")"
[[ "$archive_mode" == 600 ]] || fail 'backup archive must have mode 0600'

archive_dir="$(cd "$(dirname "$archive")" && pwd)" \
  || fail "backup directory does not exist: $(dirname "$archive")"
archive="${archive_dir}/$(basename "$archive")"

entries_file="$(mktemp -t confdock-restore-entries.XXXXXX)"
types_file="$(mktemp -t confdock-restore-types.XXXXXX)"
restore_dir=''
restore_dir_user_supplied=0
restore_volume=''
restore_marker=''
keep_restore_volume=0
keep_restore_dir=0
cleanup() {
  rm -f -- "$entries_file" "$types_file"
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
  # The restore directory contains at most the one config file created by this
  # invocation.  Remove that file and then the directory itself; never recurse
  # through a path that could have been replaced by a symlink or mount.
  if [[ "$keep_restore_dir" == 0 && "$restore_dir_user_supplied" == 0 \
    && -n "$restore_dir" && -d "$restore_dir" \
    && ! -L "$restore_dir" ]]; then
    if [[ -f "$restore_dir/config.toml" && ! -L "$restore_dir/config.toml" ]]; then
      rm -f -- "$restore_dir/config.toml"
    fi
    rmdir -- "$restore_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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
      [[ -n "$original_volume_container_id" && "$original_volume_container_id" != "$container_id" ]] \
        && fail 'the original data volume is mounted by another container'
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
  restore_dir_user_supplied=1
  restore_parent="$(cd "$(dirname "$restore_dir_arg")" && pwd)" \
    || fail "restore parent directory does not exist: $(dirname "$restore_dir_arg")"
  restore_dir="${restore_parent}/$(basename "$restore_dir_arg")"
else
  restore_dir="$archive_dir/confdock-restore-$stamp-$random_suffix"
fi
if [[ -e "$restore_dir" || -L "$restore_dir" ]]; then
  fail "restore config directory already exists: $restore_dir"
fi
mkdir -m 700 "$restore_dir"
actual_host_uid="$(id -u)"
actual_host_gid="$(id -g)"
if [[ "$host_uid" != "$actual_host_uid" || "$host_gid" != "$actual_host_gid" ]]; then
  [[ "$actual_host_uid" == 0 ]] \
    || fail 'CONFDOCK_HOST_UID/GID differs from the invoking user; run as that user or root'
  chown "$host_uid:$host_gid" "$restore_dir"
fi
volume_create=(docker volume create)
volume_create+=(--label "com.confdock.restore.id=$restore_marker")
if [[ -n "$restore_label_project" ]]; then
  volume_create+=(
    --label "com.docker.compose.project=$restore_label_project"
    --label 'com.docker.compose.volume=confdock-data'
  )
fi
if [[ -n "$restore_label_run" ]]; then
  volume_create+=(--label "com.confdock.smoke.run=$restore_label_run")
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
# path other than restore_dir is modified, and the active volume is never
# mounted.
docker run --rm "${helper_label_args[@]}" --platform linux/amd64 --user 0:0 --entrypoint /bin/sh \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,mode=700 --network none \
  --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges \
  --env "CONFDOCK_HOST_UID=$host_uid" --env "CONFDOCK_HOST_GID=$host_gid" \
  --mount "type=bind,source=$archive,destination=/input.tar.gz,readonly" \
  --mount "type=volume,source=$restore_volume,destination=/restore-data,volume-nocopy" \
  --mount "type=bind,source=$restore_dir,destination=/restore-config" \
  "$image_ref" -eu -c '
    test -d /restore-data
    test ! -L /restore-data
    test -d /restore-config
    test ! -L /restore-config
    if find /restore-data -mindepth 1 -print -quit | grep -q .; then exit 1; fi
    if find /restore-config -mindepth 1 -print -quit | grep -q .; then exit 1; fi
    # The archive paths were fully checked above. Extract the data subtree with
    # its leading `data/` component removed, then extract the one config file.
    # Both destinations are empty, and keep-old-files prevents an accidental
    # overwrite if that invariant ever changes.
    tar -xzf /input.tar.gz --no-same-owner --no-same-permissions --no-overwrite-dir --keep-old-files \
      --strip-components=1 -C /restore-data -- data
    tar -xzf /input.tar.gz --no-same-owner --no-same-permissions --no-overwrite-dir --keep-old-files \
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

assert_restore_volume_identity

# The isolated volume is intentionally writable for this read-only SQL check:
# SQLite WAL mode may need to update -shm lock bytes. No service is running,
# and the URI below still forbids database writes.
docker run --rm "${helper_label_args[@]}" --cap-drop ALL --security-opt no-new-privileges \
  --platform linux/amd64 --user 10001:10001 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --entrypoint /bin/sh \
  --network none \
  --mount "type=volume,source=$restore_volume,destination=/check,volume-nocopy" \
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
    test "$(sqlite3 "file:/check/confdock.db?mode=ro" "PRAGMA integrity_check;")" = ok
  '
assert_restore_volume_identity
[[ -f "$restore_dir/config.toml" && ! -L "$restore_dir/config.toml" ]] \
  || fail 'restored config.toml is missing or a symlink'
[[ -d "$restore_dir" && ! -L "$restore_dir" ]] \
  || fail 'restored configuration directory is missing or a symlink'
config_dir_mode="$(stat -c '%a' "$restore_dir" 2>/dev/null || stat -f '%Lp' "$restore_dir")"
config_dir_owner="$(stat -c '%u:%g' "$restore_dir" 2>/dev/null || stat -f '%u:%g' "$restore_dir")"
[[ "$config_dir_mode" == 700 && "$config_dir_owner" == "$host_uid:$host_gid" ]] \
  || fail 'restored configuration directory has unexpected permissions or ownership'
config_mode="$(stat -c '%a' "$restore_dir/config.toml" 2>/dev/null || stat -f '%Lp' "$restore_dir/config.toml")"
config_owner="$(stat -c '%u:%g' "$restore_dir/config.toml" 2>/dev/null || stat -f '%u:%g' "$restore_dir/config.toml")"
[[ "$config_mode" == 644 && "$config_owner" == "$host_uid:$host_gid" ]] \
  || fail 'restored config.toml has unexpected permissions or ownership'
docker run --rm "${helper_label_args[@]}" --cap-drop ALL --security-opt no-new-privileges \
  --platform linux/amd64 --user 10001:10001 --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/confdock:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700 --network none \
  --mount "type=bind,source=$restore_dir/config.toml,destination=/etc/confdock/config.toml,readonly" \
  "$image_ref" --config /etc/confdock/config.toml config check >/dev/null \
  || fail 'restored config.toml failed config check'

assert_restore_volume_identity

printf 'RESTORE_VOLUME_NAME=%s\n' "$restore_volume"
printf 'RESTORE_CONFIG_PATH=%s\n' "$restore_dir/config.toml"
printf 'ORIGINAL_VOLUME_NAME=%s\n' "$original_volume"
printf 'ORIGINAL_CONFIG_PATH=%s\n' "$original_config"
printf 'IMAGE_REF=%s\n' "$image_ref"
keep_restore_volume=1
keep_restore_dir=1
