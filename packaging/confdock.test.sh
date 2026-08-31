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

# The root check is still fail-fast for a normal non-root invocation.
error_file="$test_root/root-error.log"
if "$script" install binary >"$error_file" 2>&1; then
  printf '非 root 安装意外成功\n' >&2
  exit 1
fi
grep -F '需要 root 权限' "$error_file" >/dev/null

printf 'confdock 管理脚本测试通过\n'
