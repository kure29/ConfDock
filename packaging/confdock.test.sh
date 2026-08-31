#!/usr/bin/env bash
set -Eeuo pipefail

script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/confdock.sh"
test -x "$script"
bash -n "$script"

help_output="$($script --help)"
grep -F 'confdock.sh install binary' <<<"$help_output" >/dev/null
grep -F 'confdock.sh doctor' <<<"$help_output" >/dev/null
version_output="$($script --version)"
grep -F 'confdock management script' <<<"$version_output" >/dev/null
grep -F 'ConfDock is not installed.' <<<"$($script service status)" >/dev/null
grep -F 'ConfDock installation: not installed' <<<"$($script doctor)" >/dev/null

menu_output="$(printf '0\n' | "$script")"
grep -F 'ConfDock Management' <<<"$menu_output" >/dev/null
grep -F '0. Exit' <<<"$menu_output" >/dev/null

unit="$(cd -- "$(dirname -- "$script")/../deploy/systemd" && pwd)/confdock.service"
grep -F 'User=confdock' "$unit" >/dev/null
grep -F 'Group=confdock' "$unit" >/dev/null
grep -F 'ExecStart=/usr/local/bin/confdock --config /etc/confdock/config.toml' "$unit" >/dev/null
! grep -F 'EnvironmentFile=' "$unit" >/dev/null
! grep -F 'BOOTSTRAP_PASSWORD' "$unit" >/dev/null

error_file="$(mktemp -t confdock-test-error.XXXXXX)"
trap 'rm -f -- "$error_file"' EXIT
if "$script" install binary >"$error_file" 2>&1; then
  printf 'install unexpectedly succeeded without root\n' >&2
  exit 1
fi
grep -F 'requires root' "$error_file" >/dev/null

printf 'confdock management script tests passed\n'
