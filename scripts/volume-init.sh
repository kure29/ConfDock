#!/bin/sh
set -eu

data_dir="${CONFDOCK_VOLUME_INIT_DIR:-/var/lib/confdock}"
expected_owner='10001:10001'
expected_mode='700'

fail() {
  printf 'ConfDock volume-init: %s\n' "$*" >&2
  exit 1
}

[ -d "$data_dir" ] || fail 'data mountpoint is not a directory'
[ ! -L "$data_dir" ] || fail 'data mountpoint must not be a symbolic link'

owner="$(stat -c '%u:%g' "$data_dir")" || fail 'could not inspect data mountpoint owner'
mode="$(stat -c '%a' "$data_dir")" || fail 'could not inspect data mountpoint mode'
first_entry="$(find "$data_dir" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" \
  || fail 'could not inspect data volume contents'

if [ -z "$first_entry" ]; then
  if [ "$owner" = "$expected_owner" ] && [ "$mode" = "$expected_mode" ]; then
    printf '%s\n' 'ConfDock volume-init: empty volume already has the required owner and mode'
    exit 0
  fi
  # Change only the empty mountpoint itself. chmod runs while the process owns
  # the root-created directory; CHOWN is the only write-capability added by
  # Compose. DAC_READ_SEARCH is read-only and permits validation of an existing
  # 0700 directory owned by UID 10001.
  # CAP_CHOWN is sufficient to make root the temporary owner before chmod;
  # this avoids granting CAP_FOWNER while still handling an arbitrary empty
  # volume mountpoint. No child entry exists to recurse into.
  chown 0:0 "$data_dir" || fail 'could not take ownership of empty volume mountpoint'
  chmod 0700 "$data_dir" || fail 'could not set empty volume mode'
  chown 10001:10001 "$data_dir" || fail 'could not set empty volume owner'
  [ "$(stat -c '%u:%g' "$data_dir")" = "$expected_owner" ] \
    || fail 'empty volume owner verification failed'
  [ "$(stat -c '%a' "$data_dir")" = "$expected_mode" ] \
    || fail 'empty volume mode verification failed'
  printf '%s\n' 'ConfDock volume-init: empty volume is ready for UID/GID 10001:10001'
  exit 0
fi

# A non-empty volume is never modified. It is accepted only when its root and
# every known SQLite file already belong to the runtime identity, have no
# group/other permission bits, and contain no links or unexpected entries.
[ "$owner" = "$expected_owner" ] || fail 'non-empty volume has an unexpected owner; left unchanged'
[ "$mode" = "$expected_mode" ] || fail 'non-empty volume has an unexpected mode; left unchanged'

find "$data_dir" -mindepth 1 -maxdepth 1 -print | while IFS= read -r entry; do
  name="${entry##*/}"
  case "$name" in
    confdock.db|confdock.db-wal|confdock.db-shm) ;;
    *) fail "non-empty volume contains an unexpected entry: $name" ;;
  esac
  if [ ! -f "$entry" ] || [ -L "$entry" ]; then
    fail "non-empty volume entry is not a regular non-link file: $name"
  fi
  [ "$(stat -c '%u:%g' "$entry")" = "$expected_owner" ] \
    || fail "non-empty volume entry has an unexpected owner: $name"
  permissions="$(stat -c '%a' "$entry")"
  case "$permissions" in
    400|440|444|600|640|644) ;;
    *) fail "non-empty volume entry has unsafe permissions: $name" ;;
  esac
  [ "$(stat -c '%h' "$entry")" = 1 ] \
    || fail "non-empty volume entry has multiple hard links: $name"
done

printf '%s\n' 'ConfDock volume-init: existing ConfDock data volume passed read-only validation'
