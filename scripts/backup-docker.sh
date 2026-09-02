#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Back up the data and the exact configuration used by an existing Compose
# container. The archive is written by the host shell (the process therefore
# owns it) while a disposable root helper reads the volume. No project-name guessing
# is involved.
IFS=$'\n\t'
export LC_ALL=C
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${CONFDOCK_COMPOSE_FILE:-$repo_root/deploy/docker/compose.yaml}"
backup_dir="${1:-$PWD/backups}"

fail() {
  printf 'docker backup: %s\n' "$*" >&2
  exit 1
}

# The normal maintenance helper is intentionally ephemeral.  Docker Smoke can
# set this marker so even a helper that survives an interrupted client process
# is discoverable by the run-scoped cleanup trap.  Never accept an arbitrary
# value as a label fragment.
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

command -v docker >/dev/null || fail 'docker is required'
for command_name in awk basename chmod chown date dirname find grep id install mktemp mv rm sed sha256sum sort stat tar tr uniq wc; do
  command -v "$command_name" >/dev/null || fail "required command missing: $command_name"
done
[[ -f "$compose_file" ]] || fail "Compose file does not exist: $compose_file"
if [[ -n "${CONFDOCK_ENV_FILE:-}" ]]; then
  [[ -f "$CONFDOCK_ENV_FILE" && ! -L "$CONFDOCK_ENV_FILE" ]] \
    || fail "Compose env file is missing or a symlink: $CONFDOCK_ENV_FILE"
fi

backup_leaf="$(basename "$backup_dir")"
[[ -n "$backup_leaf" && "$backup_leaf" != . && "$backup_leaf" != .. ]] \
  || fail 'backup directory must name a dedicated child directory'
[[ "$backup_dir" != *$'\n'* && "$backup_dir" != *$'\r'* && "$backup_dir" != *$'\t'* ]] \
  || fail 'backup directory path contains control characters'
backup_parent="$(cd "$(dirname "$backup_dir")" && pwd -P)" \
  || fail "backup parent directory does not exist: $(dirname "$backup_dir")"
backup_dir="$backup_parent/$backup_leaf"
[[ "$backup_dir" != / ]] || fail 'refusing to use the filesystem root as a backup directory'

compose=(docker compose)
if [[ -n "${CONFDOCK_ENV_FILE:-}" ]]; then
  compose+=(--env-file "$CONFDOCK_ENV_FILE")
fi
compose+=(-f "$compose_file")

if ! container_ids="$("${compose[@]}" ps -aq confdock 2>/dev/null)"; then
  fail 'could not inspect the Compose confdock container'
fi
container_count="$(printf '%s\n' "$container_ids" | awk 'NF { n += 1 } END { print n + 0 }')"
[[ "$container_count" == 1 ]] || fail 'exactly one existing confdock container is required'
container_id="$(printf '%s\n' "$container_ids" | awk 'NF { print; exit }')"
[[ "$container_id" =~ ^[0-9a-fA-F]{12,64}$ ]] || fail 'Compose returned an invalid container identifier'

container_state="$(docker inspect -f '{{.State.Status}}' "$container_id")"
case "$container_state" in
  created|dead|exited) ;;
  *) fail "container must be stopped before backup (state: $container_state)" ;;
esac

mount_destinations="$(docker inspect -f '{{range .Mounts}}{{.Destination}}{{"\n"}}{{end}}' \
  "$container_id")"
while IFS= read -r mount_destination; do
  [[ -n "$mount_destination" ]] || continue
  case "$mount_destination" in
    /var/lib/confdock|/etc/confdock/config.toml|/tmp|/etc/hostname|/etc/hosts|/etc/resolv.conf) ;;
    *) fail "the confdock container has an unexpected mount: $mount_destination" ;;
  esac
done <<<"$mount_destinations"
data_mount_count="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}x{{end}}{{end}}' "$container_id" | tr -cd 'x' | wc -c | tr -d '[:space:]')"
[[ "$data_mount_count" == 1 ]] || fail 'the container data mount is missing or not unique'
mount_type="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.Type}}{{end}}{{end}}' "$container_id")"
volume_name="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.Name}}{{end}}{{end}}' "$container_id")"
volume_rw="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.RW}}{{end}}{{end}}' "$container_id")"
[[ "$mount_type" == volume && -n "$volume_name" && "$volume_rw" == true ]] \
  || fail 'container data mount is not a writable named volume'
volume_inspected_name="$(docker volume inspect -f '{{.Name}}' "$volume_name" 2>/dev/null)" \
  || fail "data volume does not exist: $volume_name"
[[ "$volume_inspected_name" == "$volume_name" ]] || fail 'data volume name could not be verified'
[[ "$volume_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
  || fail 'data volume name is not a valid Docker volume name'
volume_driver="$(docker volume inspect -f '{{.Driver}}' "$volume_name" 2>/dev/null)" \
  || fail "could not read data volume driver: $volume_name"
volume_created_at="$(docker volume inspect -f '{{.CreatedAt}}' "$volume_name" 2>/dev/null)" \
  || fail "could not read data volume creation time: $volume_name"
[[ -n "$volume_driver" && -n "$volume_created_at" ]] \
  || fail 'data volume metadata is incomplete'
config_mount_count="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}x{{end}}{{end}}' "$container_id" | tr -cd 'x' | wc -c | tr -d '[:space:]')"
[[ "$config_mount_count" == 1 ]] || fail 'the container configuration mount is missing or not unique'
config_type="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.Type}}{{end}}{{end}}' "$container_id")"
config_source="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.Source}}{{end}}{{end}}' "$container_id")"
config_rw="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.RW}}{{end}}{{end}}' "$container_id")"
[[ "$config_type" == bind && -n "$config_source" && "$config_rw" == false ]] \
  || fail 'container configuration mount is not a read-only bind mount'
[[ "$config_source" = /* && "$config_source" != *$'\n'* && "$config_source" != *$'\r'* \
  && "$config_source" != *$'\t'* && "$config_source" != *,* ]] \
  || fail 'configuration mount path contains unsafe characters'
[[ -f "$config_source" && ! -L "$config_source" ]] || fail "configuration file is missing or a symlink: $config_source"

image_ref="$(docker inspect -f '{{.Image}}' "$container_id")"
[[ "$image_ref" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'container image cannot be resolved to an immutable ID'

assert_source_identity() {
  local current_state current_image current_volume current_config current_config_sha256
  current_state="$(docker inspect -f '{{.State.Status}}' "$container_id" 2>/dev/null)" \
    || fail 'the stopped source container disappeared during backup'
  case "$current_state" in
    created|dead|exited) ;;
    *) fail "source container state changed during backup (state: $current_state)" ;;
  esac
  current_image="$(docker inspect -f '{{.Image}}' "$container_id")"
  current_volume="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/confdock"}}{{.Name}}{{end}}{{end}}' "$container_id")"
  current_config="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/confdock/config.toml"}}{{.Source}}{{end}}{{end}}' "$container_id")"
  [[ "$current_image" == "$image_ref" && "$current_volume" == "$volume_name" \
    && "$current_config" == "$config_source" ]] \
    || fail 'source container mounts or image changed during backup'

  [[ -f "$current_config" && ! -L "$current_config" ]] \
    || fail 'source configuration file changed or became a symlink'
  current_config_sha256="$(sha256sum "$current_config" | awk '{print $1}')" \
    || fail 'could not re-read the source configuration fingerprint'
  [[ "$current_config_sha256" == "$config_sha256" ]] \
    || fail 'source configuration changed during backup'

  local current_name current_driver current_created_at
  current_name="$(docker volume inspect -f '{{.Name}}' "$volume_name" 2>/dev/null)" \
    || fail "data volume disappeared during backup: $volume_name"
  current_driver="$(docker volume inspect -f '{{.Driver}}' "$volume_name" 2>/dev/null)" \
    || fail "could not re-read data volume driver: $volume_name"
  current_created_at="$(docker volume inspect -f '{{.CreatedAt}}' "$volume_name" 2>/dev/null)" \
    || fail "could not re-read data volume creation time: $volume_name"
  [[ "$current_name" == "$volume_name" && "$current_driver" == "$volume_driver" \
    && "$current_created_at" == "$volume_created_at" ]] \
    || fail 'data volume changed during backup'

  assert_volume_exclusive
}

if [[ -e "$backup_dir" || -L "$backup_dir" ]]; then
  [[ -d "$backup_dir" && ! -L "$backup_dir" ]] \
    || fail "backup path is not a real directory: $backup_dir"
  backup_dir_mode="$(stat -c '%a' "$backup_dir" 2>/dev/null || stat -f '%Lp' "$backup_dir")"
  [[ "$backup_dir_mode" == 700 ]] \
    || fail 'existing backup directory must already have mode 0700'
else
  install -d -m 700 "$backup_dir"
fi
backup_dir_mode="$(stat -c '%a' "$backup_dir" 2>/dev/null || stat -f '%Lp' "$backup_dir")"
[[ "$backup_dir_mode" == 700 ]] || fail 'backup directory could not be secured to mode 0700'
expected_owner="$(id -u):$(id -g)"
backup_dir_owner="$(stat -c '%u:%g' "$backup_dir" 2>/dev/null || stat -f '%u:%g' "$backup_dir")"
[[ "$backup_dir_owner" == "$expected_owner" ]] \
  || fail 'backup directory is not owned by the invoking host user'

config_sha256="$(sha256sum "$config_source" | awk '{print $1}')" \
  || fail 'could not fingerprint the configuration file'
[[ "$config_sha256" =~ ^[0-9a-f]{64}$ ]] || fail 'configuration fingerprint is invalid'

assert_volume_exclusive() {
  local current_ids current_id
  if ! current_ids="$(docker ps -aq --filter "volume=$volume_name")"; then
    fail 'could not inspect containers using the data volume'
  fi
  while IFS= read -r current_id; do
    [[ -n "$current_id" && "$current_id" != "$container_id" ]] \
      && fail 'data volume is also mounted by another container'
  done <<<"$current_ids"
}

assert_volume_exclusive

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$backup_dir/confdock-data-$stamp.tar.gz"
[[ ! -e "$archive" && ! -L "$archive" ]] || fail "backup already exists: $archive"
temporary_archive=''
archive_listing=''
archive_types=''
cleanup() {
  if [[ -n "${temporary_archive:-}" && -e "$temporary_archive" ]]; then
    rm -f -- "$temporary_archive"
  fi
  if [[ -n "${archive_listing:-}" && -e "$archive_listing" ]]; then
    rm -f -- "$archive_listing"
  fi
  if [[ -n "${archive_types:-}" && -e "$archive_types" ]]; then
    rm -f -- "$archive_types"
  fi
}
trap cleanup EXIT
temporary_archive="$(mktemp "$backup_dir/.confdock-backup.XXXXXX")"
archive_listing="$(mktemp "$backup_dir/.confdock-listing.XXXXXX")"
archive_types="$(mktemp "$backup_dir/.confdock-types.XXXXXX")"

# SQLite's WAL VFS may need to update its shared-memory lock bytes even for a
# read-only SQL connection.  Run the integrity check as the application UID
# through the already-validated source container's exact mounts (the source is
# stopped and no other container may use the volume).  The volume is writable
# only for this check; the SQL URI is still `mode=ro`, and the subsequent archive
# helper uses a read-only `--volumes-from` mount.  Any sidecar created by SQLite
# is therefore included in the archive.
integrity_status=0
docker run --rm "${helper_label_args[@]}" --platform linux/amd64 --user 10001:10001 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --network none --cap-drop ALL --security-opt no-new-privileges \
  --volumes-from "$container_id" --entrypoint /bin/sh \
  "$image_ref" -eu -c \
  'test -s /var/lib/confdock/confdock.db && test ! -L /var/lib/confdock/confdock.db &&
   test "$(sqlite3 "file:/var/lib/confdock/confdock.db?mode=ro" "PRAGMA integrity_check;")" = ok' \
  || integrity_status=$?
assert_source_identity
[[ "$integrity_status" == 0 ]] || fail 'SQLite integrity check failed before backup'

# The shell redirection creates the file as the host user. The disposable root
# helper inherits the exact read-only mounts from the already-validated stopped
# container.  `--volumes-from` therefore cannot silently create a different
# named volume if a caller concurrently removes the source container.  The
# helper can read a deliberately private host config file, but it has no
# writable host mount and uses a read-only root filesystem.
helper_status=0
docker run --rm "${helper_label_args[@]}" --platform linux/amd64 --user 0:0 --entrypoint /bin/sh \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --network none \
  --cap-drop ALL --cap-add DAC_READ_SEARCH \
  --security-opt no-new-privileges \
  --volumes-from "$container_id:ro" \
  --mount "type=bind,source=$config_source,destination=/bundle/config.toml,readonly" \
  "$image_ref" -eu -c \
  'test -d /var/lib/confdock &&
   test -s /var/lib/confdock/confdock.db && test ! -L /var/lib/confdock/confdock.db &&
   if find /var/lib/confdock -type l -print -quit | grep -q .; then exit 1; fi &&
   if find /var/lib/confdock -type f -links +1 -print -quit | grep -q .; then exit 1; fi &&
   if find /var/lib/confdock ! -type f ! -type d -print -quit | grep -q .; then exit 1; fi &&
   test -f /bundle/config.toml &&
   test ! -L /bundle/config.toml &&
   tar --create --gzip --file=- --transform="s#^\\./#data/#" \
     --directory=/var/lib/confdock . --directory=/bundle config.toml' \
  >"$temporary_archive" || helper_status=$?

assert_source_identity
[[ "$helper_status" == 0 ]] || fail 'could not read and archive the complete data volume'

[[ -s "$temporary_archive" ]] || fail 'archive is empty'
tar -tzf "$temporary_archive" | sed 's#^\./##' >"$archive_listing" \
  || fail 'archive is not readable'
[[ -s "$archive_listing" ]] || fail 'archive is empty'
archive_config_sha256="$(tar -xOzf "$temporary_archive" config.toml | sha256sum | awk '{print $1}')" \
  || fail 'could not read the archived configuration file'
[[ "$archive_config_sha256" == "$config_sha256" ]] \
  || fail 'archived configuration changed during backup'
duplicate_normalized_entries="$(sed 's#/$##' "$archive_listing" | sort | uniq -d)"
if [[ -n "$duplicate_normalized_entries" ]]; then
  fail 'archive contains duplicate paths'
fi

# The helper already rejects links and special files in the live volume.  Keep
# an independent archive-path check as a second boundary before publishing the
# file, so a future helper change cannot turn an archive into a traversal
# primitive for restore.
while IFS= read -r entry; do
  [[ -n "$entry" ]] || continue
  case "$entry" in
    *$'\n'*|*$'\r'*|*$'\t'*|/*|./*|*//*|*/./*|*/../*|*/.)
      fail 'archive contains an unsafe path'
      ;;
    data|data/*|config.toml) ;;
    *) fail 'archive contains a path outside data/ and config.toml' ;;
  esac
done <"$archive_listing"
tar -tvzf "$temporary_archive" >"$archive_types" \
  || fail 'archive could not be inspected'
while IFS= read -r listing; do
  [[ -n "$listing" ]] || continue
  case "${listing:0:1}" in
    -|d) ;;
    *) fail 'archive contains a link or special file' ;;
  esac
done <"$archive_types"
if ! grep -Fx 'data/confdock.db' "$archive_listing" >/dev/null; then
  fail 'archive does not contain data/confdock.db'
fi
if ! grep -Fx 'config.toml' "$archive_listing" >/dev/null; then
  fail 'archive does not contain config.toml'
fi

# Keep the stopped container alive as the volume reference until the last
# possible moment.  This second identity check closes the validation-to-publish
# window and prevents a verified archive from being attributed to a replaced
# container or volume.
assert_source_identity
chmod 600 "$temporary_archive"
# The archive is created by the host shell's redirection, so it already belongs
# to the invoking user. Do not call chown unconditionally: an unprivileged owner
# cannot portably chown even its own file on every supported host. If a future
# implementation changes the writer, fail closed unless the caller is root and
# can repair the ownership explicitly.
temporary_owner="$(stat -c '%u:%g' "$temporary_archive" 2>/dev/null || stat -f '%u:%g' "$temporary_archive")"
if [[ "$temporary_owner" != "$expected_owner" ]]; then
  if [[ "$(id -u)" == 0 ]]; then
    chown "$expected_owner" "$temporary_archive"
  else
    fail 'temporary backup archive is not owned by the invoking host user'
  fi
fi
# Both paths are in the same backup directory, so this rename is atomic.
mv -n "$temporary_archive" "$archive"
[[ ! -e "$temporary_archive" ]] || fail 'backup target appeared during atomic publish'
[[ -f "$archive" && ! -L "$archive" ]] || fail 'published backup is not a regular file'
temporary_archive=''
chmod 600 "$archive"
archive_mode="$(stat -c '%a' "$archive" 2>/dev/null || stat -f '%Lp' "$archive")"
archive_owner="$(stat -c '%u:%g' "$archive" 2>/dev/null || stat -f '%u:%g' "$archive")"
[[ "$archive_mode" == 600 && "$archive_owner" == "$expected_owner" ]] \
  || fail 'published backup has unsafe permissions or ownership'
printf 'Docker backup created: %s\n' "$archive"
