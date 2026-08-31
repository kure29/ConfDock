#!/usr/bin/env bash
set -Eeuo pipefail

script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/confdock.sh"
test -x "$script"
bash -n "$script"

help_output="$($script --help)"
grep -F 'confdock.sh install binary' <<<"$help_output" >/dev/null
grep -F 'confdock.sh doctor' <<<"$help_output" >/dev/null
grep -F 'ConfDock Linux 管理脚本' <<<"$help_output" >/dev/null
if grep -Eq '(^|[：: ])(Error|Usage|Install|Select|Status|Version|Configuration|Administrator|Operating|Invalid|Uninstall)' <<<"$help_output"; then
  printf '帮助文本包含未本地化内容\n' >&2
  exit 1
fi
version_output="$($script --version)"
grep -F 'confdock 管理脚本' <<<"$version_output" >/dev/null
grep -F 'ConfDock 未安装' <<<"$($script service status)" >/dev/null
doctor_output="$($script doctor)"
grep -F 'ConfDock 安装状态：未安装' <<<"$doctor_output" >/dev/null
grep -F 'file 诊断：' <<<"$doctor_output" >/dev/null

menu_output="$(printf '0\n' | "$script")"
grep -F 'ConfDock 管理' <<<"$menu_output" >/dev/null
grep -F '0. 退出' <<<"$menu_output" >/dev/null
grep -F '1. 安装预编译二进制（推荐）' <<<"$menu_output" >/dev/null
if grep -Eq '(^|[：: ])(Management|Status|Mode|Service|Select|Exit|Invalid)' <<<"$menu_output"; then
  printf '菜单文本包含未本地化内容\n' >&2
  exit 1
fi

unit="$(cd -- "$(dirname -- "$script")/../deploy/systemd" && pwd)/confdock.service"
grep -F 'User=confdock' "$unit" >/dev/null
grep -F 'Group=confdock' "$unit" >/dev/null
grep -F 'ExecStart=/usr/local/bin/confdock --config /etc/confdock/config.toml' "$unit" >/dev/null
if grep -F 'EnvironmentFile=' "$unit" >/dev/null || grep -F 'BOOTSTRAP_PASSWORD' "$unit" >/dev/null; then
  exit 1
fi

# validate_binary must not depend on the optional file command.  A regular
# non-ELF executable is rejected with one accurate Chinese diagnostic.
test_root="$(mktemp -d -t confdock-script-test.XXXXXX)"
trap 'rm -rf -- "$test_root"' EXIT
printf '#!/bin/sh\nprintf "confdock 0.1.0\\n"\n' >"$test_root/not-elf"
chmod 0755 "$test_root/not-elf"
if CONFDOCK_TEST_MODE=1 CONFDOCK_BIN_PATH="$test_root/bin" CONFDOCK_CTL_PATH="$test_root/ctl" CONFDOCK_CONFIG_DIR="$test_root/etc" CONFDOCK_UNIT_PATH="$test_root/unit" \
  bash -c 'source "$1"; validate_binary "$2"' _ "$script" "$test_root/not-elf" >"$test_root/validate.log" 2>&1; then
  printf '非 ELF 文件意外通过校验\n' >&2
  exit 1
fi
grep -F '二进制文件不是 Linux x86-64 ELF 可执行文件' "$test_root/validate.log" >/dev/null
if grep -F 'required command is missing: file' "$test_root/validate.log" >/dev/null; then
  printf '校验仍依赖 file\n' >&2
  exit 1
fi

# A protected non-empty data directory is checked before any partial-install
# recovery and remains byte-for-byte unchanged.
data_dir="$test_root/data"
mkdir -p "$data_dir"
printf 'legacy\n' >"$data_dir/legacy.db"
before_hash="$(shasum -a 256 "$data_dir/legacy.db" | awk '{print $1}')"
if CONFDOCK_TEST_MODE=1 CONFDOCK_BIN_PATH="$test_root/bin" CONFDOCK_CTL_PATH="$test_root/ctl" CONFDOCK_CONFIG_DIR="$test_root/etc" CONFDOCK_UNIT_PATH="$test_root/unit" \
  bash -c 'source "$1"; check_existing_install "$2"' _ "$script" "$data_dir" >"$test_root/data.log" 2>&1; then
  printf '非空数据目录意外通过检查\n' >&2
  exit 1
fi
grep -F '检测到非空数据目录' "$test_root/data.log" >/dev/null
after_hash="$(shasum -a 256 "$data_dir/legacy.db" | awk '{print $1}')"
test "$before_hash" = "$after_hash"

# Residual-config recovery is explicit and delegates TOML parsing to the
# current binary's config check/get commands.
residual_root="$(if [[ -d /private/tmp ]]; then mktemp -d /private/tmp/confdock-residual-test.XXXXXX; else mktemp -d -t confdock-residual-test.XXXXXX; fi)"
trap 'rm -rf -- "$test_root" "$residual_root"' EXIT
mkdir -p "$residual_root/etc" "$residual_root/data-valid" "$residual_root/data-old"
fake_binary="$residual_root/confdock"
fake_package="$residual_root/package.toml"
cat >"$fake_binary" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}:${2:-}:${3:-}" in
  --version::) printf 'confdock 0.1.0\n' ;;
  config:check:*)
    if [[ "${CONFDOCK_FAKE_INVALID:-0}" == 1 ]]; then exit 1; fi
    if [[ -n "${CONFDOCK_FAKE_COUNT_FILE:-}" ]]; then
      count=0
      [[ -f "$CONFDOCK_FAKE_COUNT_FILE" ]] && count="$(<"$CONFDOCK_FAKE_COUNT_FILE")"
      count=$((count + 1))
      printf '%s\n' "$count" >"$CONFDOCK_FAKE_COUNT_FILE"
      [[ "$count" -lt 2 ]] || exit 1
    fi
    ;;
  config:get:data_dir) printf '%s\n' "${CONFDOCK_FAKE_DATA:?}" ;;
  config:get:listen) printf '127.0.0.1:8787\n' ;;
  config:get:public_url) printf 'http://127.0.0.1:8787\n' ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$fake_binary"
printf 'package\n' >"$fake_package"
residual_env=(CONFDOCK_TEST_MODE=1 CONFDOCK_BIN_PATH="$residual_root/native" CONFDOCK_CTL_PATH="$residual_root/ctl" CONFDOCK_CONFIG_DIR="$residual_root/etc" CONFDOCK_CONFIG_PATH="$residual_root/etc/config.toml" CONFDOCK_UNIT_PATH="$residual_root/unit" CONFDOCK_SYSTEMCTL="$residual_root/systemctl" CONFDOCK_FAKE_DATA="$residual_root/data-valid")
printf '# old config\n' >"$residual_root/etc/config.toml"
valid_output="$residual_root/valid.log"
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if ! printf '1\n' | env "${residual_env[@]}" bash -c 'source "$1"; prepare_residual_config "$2" "$3"' _ "$script" "$fake_binary" "$fake_package" >"$valid_output" 2>&1; then
  printf '有效残留配置未能继续\n' >&2
  exit 1
fi
grep -F '检测到上次安装留下的配置文件：' "$valid_output" >/dev/null
grep -F '监听地址：127.0.0.1:8787' "$valid_output" >/dev/null
grep -F '公开地址：http://127.0.0.1:8787' "$valid_output" >/dev/null
test -f "$residual_root/etc/config.toml"

# Invalid config, symlink config, and explicit cancellation all stop without
# moving or modifying the old file.
printf '# invalid config\n' >"$residual_root/etc/config.toml"
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if printf '1\n' | env "${residual_env[@]}" CONFDOCK_FAKE_INVALID=1 bash -c 'source "$1"; prepare_residual_config "$2" "$3"' _ "$script" "$fake_binary" "$fake_package" >"$residual_root/invalid.log" 2>&1; then
  printf '无效残留配置意外通过\n' >&2
  exit 1
fi
grep -F '配置校验失败' "$residual_root/invalid.log" >/dev/null
test -f "$residual_root/etc/config.toml"
ln -s "$residual_root/etc/config.toml" "$residual_root/etc/config-link.toml"
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if printf '1\n' | env "${residual_env[@]}" CONFDOCK_CONFIG_PATH="$residual_root/etc/config-link.toml" bash -c 'source "$1"; prepare_residual_config "$2" "$3"' _ "$script" "$fake_binary" "$fake_package" >"$residual_root/link.log" 2>&1; then
  printf '符号链接残留配置意外通过\n' >&2
  exit 1
fi
grep -F '必须是普通文件且不能是符号链接' "$residual_root/link.log" >/dev/null
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if printf '0\n' | env "${residual_env[@]}" bash -c 'source "$1"; prepare_residual_config "$2" "$3"' _ "$script" "$fake_binary" "$fake_package" >"$residual_root/cancel.log" 2>&1; then
  printf '取消残留配置意外继续\n' >&2
  exit 1
fi
grep -F '已取消' "$residual_root/cancel.log" >/dev/null

# Backup names are timestamped and get a suffix when the timestamped path is
# already present; the existing backup is never overwritten.
printf '# old config\n' >"$residual_root/etc/config.toml"
printf 'existing backup\n' >"$residual_root/etc/config.toml.backup.20260101000000"
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if ! printf '2\n' | env "${residual_env[@]}" CONFDOCK_BACKUP_TIMESTAMP=20260101000000 bash -c 'source "$1"; prepare_residual_config "$2" "$3"' _ "$script" "$fake_binary" "$fake_package" >"$residual_root/backup.log" 2>&1; then
  printf '残留配置备份失败\n' >&2
  exit 1
fi
test ! -e "$residual_root/etc/config.toml"
test -f "$residual_root/etc/config.toml.backup.20260101000000.1"
grep -F 'existing backup' "$residual_root/etc/config.toml.backup.20260101000000" >/dev/null
grep -F '# old config' "$residual_root/etc/config.toml.backup.20260101000000.1" >/dev/null

# A second package-config validation failure leaves the backup in place.
printf '# old config\n' >"$residual_root/etc/config.toml"
count_file="$residual_root/check-count"
rm -f "$count_file"
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if printf '2\n' | env "${residual_env[@]}" CONFDOCK_BACKUP_TIMESTAMP=20260101000001 CONFDOCK_FAKE_COUNT_FILE="$count_file" bash -c 'source "$1"; prepare_residual_config "$2" "$3"' _ "$script" "$fake_binary" "$fake_package" >"$residual_root/revalidate.log" 2>&1; then
  printf '安装包配置二次校验失败路径意外成功\n' >&2
  exit 1
fi
test -f "$residual_root/etc/config.toml.backup.20260101000001"
grep -F '残留配置备份：' "$residual_root/revalidate.log" >/dev/null

# Choice 1 never bypasses the unknown non-empty data-directory guard.
printf '# old config\n' >"$residual_root/etc/config.toml"
printf 'legacy database\n' >"$residual_root/data-old/legacy.db"
before_old="$(shasum -a 256 "$residual_root/data-old/legacy.db" | awk '{print $1}')"
# shellcheck disable=SC2016 # positional parameters are intentionally expanded by the child bash
if printf '1\n' | env "${residual_env[@]}" CONFDOCK_FAKE_DATA="$residual_root/data-old" bash -c 'source "$1"; prepare_residual_config "$2" "$3"; check_existing_install "$CONFDOCK_FAKE_DATA" "$2"' _ "$script" "$fake_binary" "$fake_package" >"$residual_root/nonempty.log" 2>&1; then
  printf '非空未知数据目录意外继续\n' >&2
  exit 1
fi
grep -F '检测到非空数据目录' "$residual_root/nonempty.log" >/dev/null
after_old="$(shasum -a 256 "$residual_root/data-old/legacy.db" | awk '{print $1}')"
test "$before_old" = "$after_old"

# The main menu reports a residual config instead of pretending the host is
# completely uninstalled.
menu_residual="$(printf '0\n' | env "${residual_env[@]}" CONFDOCK_TEST_MODE=0 "$script")"
grep -F '安装状态：检测到残留配置' <<<"$menu_residual" >/dev/null

# The root check is still fail-fast for a normal non-root invocation.
error_file="$test_root/root-error.log"
if "$script" install binary >"$error_file" 2>&1; then
  printf '非 root 安装意外成功\n' >&2
  exit 1
fi
grep -F '需要 root 权限' "$error_file" >/dev/null

printf 'confdock 管理脚本测试通过\n'
