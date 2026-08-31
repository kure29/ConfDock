#!/usr/bin/env bash
set -Eeuo pipefail

# ConfDock's small, dependency-free Linux management entry point.  The same
# file is shipped in the release archive as confdock.sh and installed as
# confdockctl.  All paths are derived from this file, never from $PWD.

SCRIPT_VERSION="0.1.0"
SCRIPT_FILE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_FILE")"
SCRIPT_NAME="$(basename -- "$SCRIPT_FILE")"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

SERVICE_NAME="confdock"
SERVICE_USER="confdock"
SERVICE_GROUP="confdock"
INSTALL_ROOT="${CONFDOCK_INSTALL_ROOT:-}"

rooted_path() {
  local path="$1"
  if [[ -n "$INSTALL_ROOT" && "$path" == /* ]]; then
    printf '%s%s\n' "${INSTALL_ROOT%/}" "$path"
  else
    printf '%s\n' "$path"
  fi
}

BIN_PATH="${CONFDOCK_BIN_PATH:-$(rooted_path /usr/local/bin/confdock)}"
CTL_PATH="${CONFDOCK_CTL_PATH:-$(rooted_path /usr/local/sbin/confdockctl)}"
CONFIG_DIR="${CONFDOCK_CONFIG_DIR:-$(rooted_path /etc/confdock)}"
CONFIG_PATH="${CONFDOCK_CONFIG_PATH:-$CONFIG_DIR/config.toml}"
UNIT_PATH="${CONFDOCK_UNIT_PATH:-$(rooted_path /etc/systemd/system/confdock.service)}"
DATA_DIR_OVERRIDE="${CONFDOCK_DATA_DIR_PATH:-}"
SYSTEMCTL="${CONFDOCK_SYSTEMCTL:-systemctl}"
JOURNALCTL="${CONFDOCK_JOURNALCTL:-journalctl}"

# A release archive has its binary/config beside this script.  A source tree
# has them under target/ and packaging/.  An installed ctl always uses the
# native locations above.
if [[ "$SCRIPT_NAME" == "confdockctl" ]]; then
  ARTIFACT_BINARY="$BIN_PATH"
  ARTIFACT_CONFIG="$CONFIG_PATH"
else
  ARTIFACT_BINARY="${CONFDOCK_ARTIFACT_BINARY:-$SCRIPT_DIR/confdock}"
  ARTIFACT_CONFIG="${CONFDOCK_ARTIFACT_CONFIG:-$SCRIPT_DIR/config.toml}"
fi

TMP_FILES=()
TMP_DIRS=()
cleanup() {
  local item
  for item in "${TMP_FILES[@]:-}"; do
    if [[ -n "$item" ]]; then rm -f -- "$item" 2>/dev/null || true; fi
  done
  for item in "${TMP_DIRS[@]:-}"; do
    if [[ -n "$item" ]]; then rm -rf -- "$item" 2>/dev/null || true; fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT TERM

die() {
  printf '错误：%s\n' "$1" >&2
  return 1
}

usage() {
  cat <<'EOF'
ConfDock Linux 管理脚本

用法：
  confdock.sh                         打开管理菜单
  confdock.sh install binary          安装随附的 Linux 二进制文件
  confdock.sh install source          从源码构建并安装
  confdock.sh service {status|start|stop|restart|logs}
  confdock.sh config {edit|check}
  confdock.sh admin set-password
  confdock.sh doctor                  运行诊断
  confdock.sh uninstall               卸载 ConfDock

安装后的命令 /usr/local/sbin/confdockctl 接受相同的参数。
本脚本不提供 Docker、在线更新或备份/恢复功能。
EOF
}

script_version() {
  printf 'confdock 管理脚本 %s\n' "$SCRIPT_VERSION"
}

need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "此操作会修改系统文件或服务，需要 root 权限；请使用 sudo 运行"
}

detect_platform() {
  local os arch libc
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  if [[ "$os" != "Linux" ]]; then
    die "不支持的操作系统：${os:-未知}（需要 Linux）"
    return 1
  fi
  case "$arch" in
    x86_64|amd64) ;;
    *) die "不支持的 CPU 架构：${arch:-未知}（需要 x86_64/amd64）"; return 1 ;;
  esac
  if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
    die "未找到 systemctl，无法使用 systemd"
    return 1
  fi
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  if [[ "$libc" != glibc\ * ]]; then
    libc="$(ldd --version 2>&1 | head -1 || true)"
  fi
  if [[ "$libc" != glibc\ * && "$libc" != *GLIBC* && "$libc" != *GNU\ libc* ]]; then
    die "未检测到 glibc；此 Linux x86-64 安装程序需要 glibc"
    return 1
  fi
  printf '平台：Linux %s，%s，%s\n' "$arch" "${libc%%$'\n'*}" "$SYSTEMCTL"
}

require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "缺少必需命令：$name"
}

validate_binary() {
  local binary="$1" header version_output version_line
  [[ -e "$binary" ]] || { die "未找到二进制文件：$binary"; return 1; }
  [[ -f "$binary" ]] || { die "二进制文件不是普通文件：$binary"; return 1; }
  [[ ! -L "$binary" ]] || { die "二进制文件不能是符号链接：$binary"; return 1; }
  [[ -x "$binary" ]] || { die "二进制文件没有执行权限：$binary"; return 1; }

  # Read the small ELF identification header with od, which is part of the
  # Debian base system.  `file` is deliberately not a runtime dependency.
  header="$(od -An -t u1 -N 20 -- "$binary" 2>/dev/null)" || {
    die "无法读取二进制文件头：$binary"
    return 1
  }
  local -a bytes=()
  read -r -a bytes <<<"$header"
  if (( ${#bytes[@]} < 20 )) || \
    [[ "${bytes[0]}" != 127 || "${bytes[1]}" != 69 || "${bytes[2]}" != 76 || "${bytes[3]}" != 70 || \
       "${bytes[4]}" != 2 || "${bytes[5]}" != 1 || "${bytes[18]}" != 62 || "${bytes[19]}" != 0 ]]; then
    die "二进制文件不是 Linux x86-64 ELF 可执行文件：$binary"
    return 1
  fi

  version_output="$("$binary" --version 2>&1)" || {
    die "执行二进制文件的 --version 失败：$binary"
    return 1
  }
  version_line="${version_output%%$'\n'*}"
  [[ "$version_line" =~ ^confdock[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+([.-][[:alnum:].+-]+)?([[:space:]]|$) ]] || {
    die "二进制文件的版本输出格式不正确：$version_line"
    return 1
  }
}

validate_config() {
  local binary="$1" config="$2"
  [[ -f "$config" ]] || { die "未找到配置文件：$config"; return 1; }
  [[ ! -L "$config" ]] || { die "配置文件不能是符号链接：$config"; return 1; }
  "$binary" config check --config "$config" >/dev/null 2>&1 || {
    die "配置校验失败：$config"
    return 1
  }
}

config_value() {
  local field="$1" binary="${2:-$BIN_PATH}" config="${3:-$CONFIG_PATH}"
  "$binary" config get "$field" --config "$config"
}

safe_data_dir() {
  local path="$1" resolved
  [[ "$path" == /* ]] || { die "原生 systemd 安装要求 data_dir 使用绝对路径"; return 1; }
  [[ ! -L "$path" ]] || { die "data_dir 不能是符号链接：$path"; return 1; }
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* ]] || { die "data_dir 不能包含控制字符"; return 1; }
  [[ "$path" != */../* && "$path" != */.. && "$path" != ../* && "$path" != .. ]] || { die "data_dir 不能包含父目录遍历"; return 1; }
  case "$path" in
    /|/etc|/usr|/var|/home|/root|/bin|/sbin|/lib|/lib64)
      die "拒绝使用范围过大的不安全 data_dir：$path"; return 1 ;;
  esac
  if [[ -n "${HOME:-}" && "$path" == "${HOME%/}"/* ]]; then
    die "拒绝使用用户主目录下的 data_dir：$path"; return 1
  fi
  if [[ "$path" == "$REPO_ROOT"/* ]]; then
    die "拒绝使用源码 Worktree 内的 data_dir：$path"; return 1
  fi
  if [[ -e "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || { die "data_dir 必须是真实目录，不能是文件或符号链接：$path"; return 1; }
    resolved="$(readlink -f -- "$path" 2>/dev/null || true)"
    [[ -n "$resolved" && "$resolved" == "$path" ]] || { die "data_dir 通过符号链接解析：$path"; return 1; }
  fi
  printf '%s\n' "$path"
}

show_config_summary() {
  local binary="$1" config="$2" data_dir
  data_dir="$(config_value data_dir "$binary" "$config")" || { die "无法从配置中读取 data_dir"; return 1; }
  safe_data_dir "$data_dir" >/dev/null || return 1
  printf '版本：%s\n' "$($binary --version | head -1)"
  printf '监听地址：%s\n' "$(config_value listen "$binary" "$config")"
  printf '公开地址：%s\n' "$(config_value public_url "$binary" "$config")"
  printf '数据目录：%s\n' "$data_dir"
  printf '服务：%s\n' "$SERVICE_NAME"
}

native_marker_exists() {
  [[ -e "$BIN_PATH" || -e "$CTL_PATH" || -e "$CONFIG_PATH" || -e "$UNIT_PATH" ]]
}

data_dir_has_entries() {
  local path="$1" entry
  [[ -d "$path" ]] || return 1
  while IFS= read -r -d '' entry; do
    [[ -n "$entry" ]] && return 0
  done < <(find "$path" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
  return 1
}

partial_file_owned() {
  local path="$1" kind="$2" source_binary="${3:-}"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  case "$kind" in
    ctl) grep -F 'ConfDock Linux 管理脚本' "$path" >/dev/null 2>&1 ;;
    unit) grep -F 'User=confdock' "$path" >/dev/null 2>&1 && \
      grep -F 'ExecStart=/usr/local/bin/confdock --config /etc/confdock/config.toml' "$path" >/dev/null 2>&1 ;;
    binary) [[ -n "$source_binary" ]] && cmp -s -- "$source_binary" "$path" ;;
    *) return 1 ;;
  esac
}

recover_partial_install() {
  local source_binary="$1" answer
  printf '检测到未完成的 ConfDock 安装（部分系统文件仍存在）。\n' >&2
  printf '配置和数据将始终保留；只清理能够确认由当前脚本创建的二进制、管理脚本和未启用的 systemd unit。\n' >&2
  if [[ "${CONFDOCK_RECOVER_PARTIAL:-}" != 1 ]]; then
    if [[ ! -t 0 ]]; then
      die "无法确认未完成安装来源；未修改任何文件。确认来源后设置 CONFDOCK_RECOVER_PARTIAL=1 再重试"
      return 1
    fi
    read -r -p '确认清理可识别的未完成安装文件？[y/N] ' answer || answer=''
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || { die "已取消，未修改任何文件"; return 1; }
  fi
  if [[ -e "$CTL_PATH" ]] && ! partial_file_owned "$CTL_PATH" ctl; then
    die "无法确认管理脚本来源：${CTL_PATH}；未修改任何文件"
    return 1
  fi
  if [[ -e "$UNIT_PATH" ]]; then
    partial_file_owned "$UNIT_PATH" unit || { die "无法确认 systemd unit 来源：${UNIT_PATH}；未修改任何文件"; return 1; }
    if "$SYSTEMCTL" is-enabled "$SERVICE_NAME" >/dev/null 2>&1; then
      die "检测到已启用的 systemd 服务；请先使用 confdockctl uninstall，未修改任何文件"
      return 1
    fi
  fi
  if [[ -e "$BIN_PATH" ]] && ! partial_file_owned "$BIN_PATH" binary "$source_binary"; then
    die "无法确认二进制文件来源：${BIN_PATH}；未修改任何文件"
    return 1
  fi
  local -a removable=()
  [[ -e "$BIN_PATH" ]] && removable+=("$BIN_PATH")
  [[ -e "$CTL_PATH" ]] && removable+=("$CTL_PATH")
  [[ -e "$UNIT_PATH" ]] && removable+=("$UNIT_PATH")
  if ((${#removable[@]} > 0)); then
    rm -f -- "${removable[@]}" || { die "清理未完成安装文件失败"; return 1; }
  fi
  printf '已清理可确认的未完成安装文件；配置和数据保持不变。\n'
}

check_existing_install() {
  local data_dir="$1" source_binary="${2:-}"
  [[ "$BIN_PATH" == /* && "$CTL_PATH" == /* && "$CONFIG_DIR" == /* && "$UNIT_PATH" == /* ]] || {
    die "原生安装路径必须是绝对路径"
    return 1
  }
  [[ ! -L "$CONFIG_DIR" && ! -L "$(dirname -- "$UNIT_PATH")" && ! -L "$(dirname -- "$BIN_PATH")" && ! -L "$(dirname -- "$CTL_PATH")" ]] || {
    die "拒绝通过符号链接的系统目录安装"
    return 1
  }
  if is_installed; then
    die "检测到 ConfDock 已安装，请使用 confdockctl 管理，不能覆盖现有安装"
    return 1
  fi
  if [[ -e "$data_dir" ]] && data_dir_has_entries "$data_dir"; then
    die "检测到非空数据目录：${data_dir}；其中可能包含旧数据库。为保护数据，本次安装已停止，未修改任何文件；请先备份该目录，或在 config.toml 中选择新的空数据目录"
    return 1
  fi
  if native_marker_exists; then
    recover_partial_install "$source_binary" || return 1
  fi
}

atomic_copy_safe() {
  local source="$1" destination="$2" mode="$3" tmp
  [[ -f "$source" ]] || { die "未找到源文件：$source"; return 1; }
  mkdir -p -- "$(dirname -- "$destination")" || { die "无法创建目录：$(dirname -- "$destination")"; return 1; }
  tmp="$(mktemp "$(dirname -- "$destination")/.confdock-install.XXXXXX")" || { die "无法创建临时安装文件"; return 1; }
  TMP_FILES+=("$tmp")
  cp -- "$source" "$tmp" || { die "复制文件失败：$destination"; return 1; }
  chmod "$mode" "$tmp" || { die "设置文件权限失败：$destination"; return 1; }
  mv -f -- "$tmp" "$destination" || { die "安装文件失败：$destination"; return 1; }
}

write_unit() {
  local data_dir="$1" tmp rw_path
  require_command systemd-escape || return 1
  rw_path="$(systemd-escape --path -- "$data_dir")" || { die "无法安全编码 systemd 的 data_dir"; return 1; }
  mkdir -p -- "$(dirname -- "$UNIT_PATH")" || { die "无法创建 systemd unit 目录"; return 1; }
  tmp="$(mktemp "$(dirname -- "$UNIT_PATH")/.confdock-unit.XXXXXX")" || { die "无法创建 systemd unit 临时文件"; return 1; }
  TMP_FILES+=("$tmp")
  cat >"$tmp" <<EOF
[Unit]
Description=ConfDock configuration service
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
ExecStart=/usr/local/bin/confdock --config /etc/confdock/config.toml
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/confdock
ReadWritePaths=$rw_path

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$tmp" || { die "设置 systemd unit 权限失败"; return 1; }
  mv -f -- "$tmp" "$UNIT_PATH" || { die "写入 systemd unit 失败：$UNIT_PATH"; return 1; }
}

service_user_setup() {
  local data_dir="$1"
  local nologin
  require_command getent || return 1
  require_command groupadd || return 1
  require_command useradd || return 1
  nologin="$(command -v nologin 2>/dev/null || printf '/usr/sbin/nologin')"
  if getent group "$SERVICE_GROUP" >/dev/null; then
    :
  else
    groupadd --system "$SERVICE_GROUP" || { die "创建系统组失败：$SERVICE_GROUP"; return 1; }
  fi
  if getent passwd "$SERVICE_USER" >/dev/null; then
    local shell primary_group
    shell="$(getent passwd "$SERVICE_USER" | awk -F: '{print $7}')"
    if [[ "$shell" != "$nologin" && "$shell" != /sbin/nologin && "$shell" != /usr/sbin/nologin ]]; then
      die "现有服务用户 ${SERVICE_USER} 未使用 nologin，拒绝修改"
      return 1
    fi
    primary_group="$(id -gn "$SERVICE_USER" 2>/dev/null || true)"
    if [[ "$primary_group" != "$SERVICE_GROUP" ]]; then
      die "现有服务用户 ${SERVICE_USER} 未使用组 ${SERVICE_GROUP}，拒绝修改"
      return 1
    fi
  else
    useradd --system --gid "$SERVICE_GROUP" --shell "$nologin" --home-dir "$data_dir" --no-create-home "$SERVICE_USER" || {
      die "创建系统用户失败：$SERVICE_USER"
      return 1
    }
  fi
}

run_as_service_user() {
  require_command runuser || return 1
  runuser -u "$SERVICE_USER" -- /bin/sh -c 'umask 0077; exec "$@"' confdock-service-user "$@"
}

health_check() {
  local url="$1"
  require_command curl
  curl --fail --silent --show-error --max-time 5 "$url/healthz" >/dev/null
}

health_url_for_config() {
  local listen="$1" port
  port="${listen##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || { die "监听地址没有有效端口：$listen"; return 1; }
  printf 'http://127.0.0.1:%s\n' "$port"
}

wait_for_health() {
  local url="$1"
  for _ in $(seq 1 40); do
    if health_check "$url" 2>/dev/null; then return 0; fi
    sleep 0.25
  done
  return 1
}

choose_editor() {
  if [[ -n "${EDITOR:-}" ]]; then
    printf '%s\n' "$EDITOR"
  elif command -v nano >/dev/null 2>&1; then
    printf 'nano\n'
  elif command -v vi >/dev/null 2>&1; then
    printf 'vi\n'
  else
    return 1
  fi
}

edit_config_file() {
  local original="$1" binary="$2" temp_dir temp editor
  editor="$(choose_editor)" || { die "未找到编辑器；请设置 EDITOR 或安装 nano/vi"; return 1; }
  temp_dir="$(mktemp -d -t confdock-config.XXXXXX)" || { die "无法创建配置临时目录"; return 1; }
  TMP_DIRS+=("$temp_dir")
  temp="$temp_dir/config.toml"
  cp -- "$original" "$temp" || { die "无法复制配置文件"; return 1; }
  chmod 0640 "$temp" || { die "无法设置临时配置权限"; return 1; }
  "$editor" "$temp" || { die "配置编辑器执行失败"; return 1; }
  "$binary" config check --config "$temp" >/dev/null 2>&1 || { die "编辑后的配置无效，原配置已保留"; return 1; }
  EDITED_CONFIG_PATH="$temp"
}

install_native() {
  local source_binary="$1" source_config="$2" data_dir public_url listen health_url answer
  local edited_config="$source_config"
  detect_platform || return 1
  require_command curl || return 1
  validate_binary "$source_binary" || return 1
  validate_config "$source_binary" "$source_config" || return 1
  if ! data_dir="$(config_value data_dir "$source_binary" "$source_config")"; then
    die "无法从配置中读取 data_dir"
    return 1
  fi
  if ! data_dir="$(safe_data_dir "$data_dir")"; then return 1; fi
  if [[ -n "$DATA_DIR_OVERRIDE" ]] && ! data_dir="$(safe_data_dir "$DATA_DIR_OVERRIDE")"; then return 1; fi
  check_existing_install "$data_dir" "$source_binary" || return 1
  show_config_summary "$source_binary" "$source_config" || return 1
  if [[ -t 0 ]]; then
    read -r -p '是否使用默认配置？[Y/n] ' answer || answer=''
    if [[ "$answer" =~ ^[Nn]([Oo])?$ ]]; then
      edit_config_file "$source_config" "$source_binary" || return 1
      edited_config="$EDITED_CONFIG_PATH"
      validate_config "$source_binary" "$edited_config" || return 1
      if ! data_dir="$(config_value data_dir "$source_binary" "$edited_config")" || ! data_dir="$(safe_data_dir "$data_dir")"; then return 1; fi
    fi
  fi
  check_existing_install "$data_dir" "$source_binary" || return 1
  if ! public_url="$(config_value public_url "$source_binary" "$edited_config")"; then die "无法从配置中读取 public_url"; return 1; fi
  if ! listen="$(config_value listen "$source_binary" "$edited_config")"; then die "无法从配置中读取 listen"; return 1; fi
  if ! health_url="$(health_url_for_config "$listen")"; then return 1; fi
  service_user_setup "$data_dir" || return 1
  mkdir -p -- "$CONFIG_DIR" "$data_dir" || { die "无法创建配置或数据目录"; return 1; }
  chmod 0750 "$CONFIG_DIR" "$data_dir" || { die "无法设置配置或数据目录权限"; return 1; }
  chown "root:$SERVICE_GROUP" "$CONFIG_DIR" || { die "无法设置配置目录所有者"; return 1; }
  chown "$SERVICE_USER:$SERVICE_GROUP" "$data_dir" || { die "无法设置数据目录所有者"; return 1; }
  atomic_copy_safe "$source_binary" "$BIN_PATH" 0755 || return 1
  atomic_copy_safe "$edited_config" "$CONFIG_PATH" 0640 || return 1
  chown "root:$SERVICE_GROUP" "$CONFIG_PATH" || { die "无法设置配置文件所有者"; return 1; }
  # Install this exact script, rather than trusting a similarly named file in
  # the current directory.  A root-owned copy is used by future invocations.
  atomic_copy_safe "$SCRIPT_FILE" "$CTL_PATH" 0755 || return 1
  write_unit "$data_dir" || return 1
  "$SYSTEMCTL" daemon-reload || { die "systemd daemon-reload 失败"; return 1; }
  if ! run_as_service_user "$BIN_PATH" admin init --config "$CONFIG_PATH"; then
    "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
    rm -f -- "$UNIT_PATH" "$BIN_PATH" "$CTL_PATH"
    printf '管理员初始化失败。配置和数据目录已保留，服务未启动。\n' >&2
    return 1
  fi
  if ! "$SYSTEMCTL" enable "$SERVICE_NAME" || ! "$SYSTEMCTL" start "$SERVICE_NAME"; then
    "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    printf '服务启动失败；请检查 systemctl status %s 和 journalctl -u %s。\n' "$SERVICE_NAME" "$SERVICE_NAME" >&2
    return 1
  fi
  if ! wait_for_health "$health_url"; then
    "$SYSTEMCTL" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    printf '服务已启动，但 /healthz 未就绪；请检查 systemctl status %s 和 journalctl -u %s。\n' "$SERVICE_NAME" "$SERVICE_NAME" >&2
    return 1
  fi
  printf 'ConfDock 安装成功。\n访问地址：%s\n管理命令：sudo confdockctl\n' "$public_url"
}

install_binary() {
  need_root || return 1
  if [[ "$SCRIPT_NAME" == "confdockctl" ]]; then
    die "安装后的管理命令不能安装随附二进制文件"
    return 1
  fi
  [[ -f "$ARTIFACT_BINARY" && -f "$ARTIFACT_CONFIG" ]] || {
    die "发布目录中必须在 confdock.sh 旁包含 confdock 和 config.toml"
    return 1
  }
  install_native "$ARTIFACT_BINARY" "$ARTIFACT_CONFIG" || return 1
}

install_source() {
  local missing=() command_name node_major wasm_version
  need_root || return 1
  [[ "$SCRIPT_NAME" != "confdockctl" ]] || { die "源码安装必须从完整 ConfDock 源码树运行"; return 1; }
  for command_name in git cargo rustc node npm wasm-bindgen; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  if (( ${#missing[@]} > 0 )); then
    printf '无法从源码构建，缺少以下工具：\n\n' >&2
    printf '%s\n' "${missing[@]/#/- }" >&2
    printf '\n需要：\n- Node.js 22+\n- npm\n- Rust stable\n- wasm-bindgen-cli 0.2.127\n\n脚本不会自动安装开发工具。安装所需工具后再重试。\n' >&2
    return 1
  fi
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" -ge 22 ]] || { die "需要 Node.js 22 或更高版本（当前为 $(node --version)）"; return 1; }
  wasm_version="$(wasm-bindgen --version | awk '{print $2}')"
  [[ "$wasm_version" == 0.2.127 ]] || { die "需要 wasm-bindgen-cli 0.2.127（当前为 ${wasm_version}）"; return 1; }
  git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 || { die "源码安装需要完整的 Git Checkout"; return 1; }
  [[ -x "$REPO_ROOT/scripts/build-single-binary.sh" ]] || { die "缺少 scripts/build-single-binary.sh"; return 1; }
  (cd "$REPO_ROOT" && ./scripts/build-single-binary.sh) || { die "源码构建失败"; return 1; }
  [[ -x "$REPO_ROOT/target/release/confdock" ]] || { die "未生成 release 二进制文件"; return 1; }
  (cd "$REPO_ROOT" && ./scripts/smoke-single-binary.sh target/release/confdock) || { die "单二进制 Smoke 检查失败"; return 1; }
  install_native "$REPO_ROOT/target/release/confdock" "$REPO_ROOT/packaging/config.toml" || return 1
}

is_installed() {
  [[ -f "$BIN_PATH" && -f "$CTL_PATH" && -f "$CONFIG_PATH" && -f "$UNIT_PATH" ]]
}

service_status() {
  if ! is_installed; then printf 'ConfDock 未安装。\n'; return 0; fi
  printf '版本：'; "$BIN_PATH" --version | head -1
  printf '服务：'
  "$SYSTEMCTL" is-active "$SERVICE_NAME" 2>/dev/null || printf '未运行\n'
  "$SYSTEMCTL" status "$SERVICE_NAME" --no-pager --lines=20 2>/dev/null || true
}

service_action() {
  local action="$1"
  if ! is_installed; then
    if [[ "$action" == status ]]; then
      printf 'ConfDock 未安装。\n'
      return 0
    fi
    die "ConfDock 未安装，请先安装"
    return 1
  fi
  case "$action" in
    status) service_status ;;
    start|restart)
      need_root
      "$SYSTEMCTL" "$action" "$SERVICE_NAME"
      local listen health_url
      listen="$(config_value listen)"
      health_url="$(health_url_for_config "$listen")"
      wait_for_health "$health_url" || { die "服务未达到健康状态，请检查 systemctl status $SERVICE_NAME 和 journalctl -u $SERVICE_NAME"; return 1; }
      ;;
    stop)
      need_root
      "$SYSTEMCTL" stop "$SERVICE_NAME"
      ;;
    logs)
      "$JOURNALCTL" -u "$SERVICE_NAME" -n 80 --no-pager
      ;;
    *) die "未知服务操作：$action"; return 1 ;;
  esac
}

config_check_installed() {
  is_installed || { die "ConfDock 未安装，请先安装"; return 1; }
  validate_config "$BIN_PATH" "$CONFIG_PATH" || return 1
  printf '配置有效。\n'
}

config_edit_installed() {
  local edited backup listen health_url answer
  is_installed || { die "ConfDock 未安装，请先安装"; return 1; }
  need_root || return 1
  edit_config_file "$CONFIG_PATH" "$BIN_PATH" || return 1
  edited="$EDITED_CONFIG_PATH"
  backup="${CONFIG_PATH}.previous"
  cp -- "$CONFIG_PATH" "$backup"
  chmod 0640 "$backup"
  chown "root:$SERVICE_GROUP" "$backup"
  mv -f -- "$edited" "$CONFIG_PATH"
  chown "root:$SERVICE_GROUP" "$CONFIG_PATH"
  "$SYSTEMCTL" daemon-reload
  if [[ -t 0 ]]; then
    read -r -p '是否使用此配置重启 ConfDock？[y/N] ' answer || answer=''
    if [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
      listen="$(config_value listen)"
      health_url="$(health_url_for_config "$listen")"
      if ! "$SYSTEMCTL" restart "$SERVICE_NAME" || ! wait_for_health "$health_url"; then
        mv -f -- "$backup" "$CONFIG_PATH"
        chmod 0640 "$CONFIG_PATH"
        "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
        "$SYSTEMCTL" restart "$SERVICE_NAME" >/dev/null 2>&1 || true
        die "重启失败，已恢复之前的配置"
        return 1
      fi
    fi
  fi
  printf '配置已更新；之前的版本已保存为 %s。\n' "$backup"
}

admin_set_password() {
  is_installed || { die "ConfDock 未安装，请先安装"; return 1; }
  need_root || return 1
  run_as_service_user "$BIN_PATH" admin set-password --config "$CONFIG_PATH" || { die "管理员密码更新失败"; return 1; }
  printf '管理员密码已更新，现有登录会话已失效。\n'
}

stat_mode() {
  local path="$1"
  if [[ -e "$path" ]]; then
    stat -c '%A %U:%G' -- "$path" 2>/dev/null || stat -f '%Sp %Su:%Sg' -- "$path" 2>/dev/null || printf '存在\n'
  else
    printf '缺失\n'
  fi
}

doctor() {
  local data_dir listen health_url state
  printf '操作系统：%s\n' "$(uname -s 2>/dev/null || printf '未知')"
  printf 'CPU 架构：%s\n' "$(uname -m 2>/dev/null || printf '未知')"
  printf 'glibc：%s\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null || printf '未检测到')"
  printf 'systemd：%s\n' "$(command -v "$SYSTEMCTL" 2>/dev/null || printf '未检测到')"
  if command -v file >/dev/null 2>&1; then
    if [[ -e "$BIN_PATH" ]]; then
      printf 'file 诊断：%s\n' "$(file -Lb -- "$BIN_PATH" 2>/dev/null || printf '读取失败')"
    else
      printf 'file 诊断：已跳过（二进制尚未安装）\n'
    fi
  else
    printf 'file 诊断：已跳过（未安装 file）\n'
  fi
  if ! is_installed; then printf 'ConfDock 安装状态：未安装\n'; return 0; fi
  printf 'ConfDock 安装方式：原生二进制\n'
  printf '已安装版本：'; "$BIN_PATH" --version | head -1
  printf '二进制权限：'; stat_mode "$BIN_PATH"
  printf '配置权限：'; stat_mode "$CONFIG_PATH"
  if "$BIN_PATH" config check --config "$CONFIG_PATH" >/dev/null 2>&1; then printf '配置校验：有效\n'; else printf '配置校验：失败\n'; fi
  if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then printf '服务用户：%s\n' "$SERVICE_USER"; else printf '服务用户：缺失\n'; fi
  data_dir="$(config_value data_dir 2>/dev/null || true)"
  if [[ -n "$data_dir" ]]; then printf '数据目录：%s（%s）\n' "$data_dir" "$(stat_mode "$data_dir")"; else printf '数据目录：不可用\n'; fi
  printf 'systemd unit：'; stat_mode "$UNIT_PATH"
  state="$($SYSTEMCTL is-active "$SERVICE_NAME" 2>/dev/null || printf '未运行')"
  printf '服务状态：%s\n' "$state"
  listen="$(config_value listen 2>/dev/null || true)"; printf '监听地址：%s\n' "${listen:-不可用}"
  if [[ -n "$listen" ]] && command -v curl >/dev/null 2>&1; then
    health_url="$(health_url_for_config "$listen" 2>/dev/null || true)"
    if [[ -n "$health_url" ]] && health_check "$health_url" 2>/dev/null; then
      printf '端口状态：可访问\n健康检查：正常\n'
    else
      printf '端口状态：不可访问\n健康检查：失败\n'
    fi
  else
    printf '端口状态：已跳过\n健康检查：已跳过（curl 不可用或无法读取监听地址）\n'
  fi
  printf '安全错误摘要：未展开；请检查 journalctl -u %s。\n' "$SERVICE_NAME"
}

dangerous_delete_path() {
  local path="$1" home
  home="${HOME:-}"
  case "$path" in
    /|/etc|/usr|/var|/home|/root|/bin|/sbin|/lib|/lib64|"$home"|"$REPO_ROOT") return 0 ;;
  esac
  if [[ -n "$home" && "$home" == /* && "$path" == "$home"/* ]]; then return 0; fi
  if [[ -n "$REPO_ROOT" && "$path" == "$REPO_ROOT"/* ]]; then return 0; fi
  [[ "$path" == /* && "$path" != *$'\n'* && ! -L "$path" ]]
}

remove_owned_files() {
  local directory="$1" entry name allowed allowed_name
  [[ -d "$directory" && ! -L "$directory" ]] || { die "拒绝删除未知目录：$directory"; return 1; }
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    allowed=0
    for allowed_name in "${@:2}"; do
      if [[ "$name" == "$allowed_name" ]]; then allowed=1; break; fi
    done
    if [[ "$allowed" -ne 1 || -L "$entry" || ! -f "$entry" ]]; then
      die "拒绝删除目录中的未识别数据：$directory/$name"
      return 1
    fi
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -print0)
  while IFS= read -r -d '' entry; do
    rm -f -- "$entry"
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -type f -print0)
  rmdir -- "$directory" 2>/dev/null || true
}

uninstall() {
  local answer data_dir delete_answer confirm
  is_installed || { printf 'ConfDock 未安装，未删除文件。\n'; return 0; }
  need_root || return 1
  data_dir="$(config_value data_dir 2>/dev/null || true)"
  if [[ -t 0 ]]; then
    read -r -p '卸载 ConfDock 但保留配置和数据？[y/N] ' answer || answer=''
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || { printf '已取消卸载。\n'; return 0; }
  elif [[ "${CONFDOCK_ASSUME_YES:-}" != 1 ]]; then
    die '非交互卸载需要设置 CONFDOCK_ASSUME_YES=1'
    return 1
  fi
  "$SYSTEMCTL" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  if [[ "$($SYSTEMCTL is-active "$SERVICE_NAME" 2>/dev/null || true)" == active ]]; then
    die "服务仍在运行，拒绝删除文件"
    return 1
  fi
  rm -f -- "$UNIT_PATH" "$BIN_PATH" "$CTL_PATH"
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
  printf '配置和数据已保留。\n配置：%s\n' "$CONFIG_PATH"
  [[ -z "$data_dir" ]] || printf '数据：%s\n' "$data_dir"
  if [[ -t 0 ]]; then
    read -r -p '要永久删除保留的配置和数据吗？输入 DELETE 继续：' delete_answer || delete_answer=''
    if [[ "$delete_answer" == DELETE ]]; then
      confirm=''
      read -r -p '此操作无法撤销。再次输入 DELETE：' confirm || confirm=''
      if [[ "$confirm" == DELETE ]] && dangerous_delete_path "$CONFIG_DIR" && { [[ -z "$data_dir" ]] || dangerous_delete_path "$data_dir"; }; then
        remove_owned_files "$CONFIG_DIR" config.toml config.toml.previous
        [[ -z "$data_dir" ]] || remove_owned_files "$data_dir" confdock.db confdock.db-wal confdock.db-shm
        printf '配置和数据已永久删除，无法恢复。\n'
      else
        printf '已拒绝永久删除，配置和数据仍保留。\n'
      fi
    fi
  fi
}

wait_for_menu() {
  if [[ -t 0 ]]; then
    read -r -p '按回车键返回主菜单……' _ || true
  else
    printf '按回车键返回主菜单……\n'
  fi
}

menu_action() {
  local status=0
  set +e
  (set -Eeuo pipefail; "$@")
  status=$?
  set -e
  if ((status != 0)); then
    :
  fi
  wait_for_menu
  return 0
}

menu() {
  local choice
  while true; do
    printf '\n================================\n          ConfDock 管理\n================================\n\n'
    if is_installed; then
      printf '安装状态：已安装\n安装方式：原生二进制\n当前版本：%s\n服务状态：%s\n\n' "$($BIN_PATH --version 2>/dev/null | head -1 || printf '未知')" "$($SYSTEMCTL is-active "$SERVICE_NAME" 2>/dev/null || printf '未运行')"
    else
      printf '安装状态：未安装\n安装方式：—\n当前版本：—\n服务状态：—\n\n'
    fi
    cat <<'EOF'
1. 安装预编译二进制（推荐）
2. 从源码构建并安装（高级）
3. 服务管理
4. 编辑并检查配置
5. 修改管理员密码
6. 运行诊断
7. 卸载 ConfDock
0. 退出

请选择：
EOF
    read -r choice || return 0
    case "$choice" in
      1) menu_action install_binary ;;
      2) menu_action install_source ;;
      3) menu_action service_menu ;;
      4) menu_action config_edit_installed ;;
      5) menu_action admin_set_password ;;
      6) menu_action doctor ;;
      7) menu_action uninstall ;;
      0) return 0 ;;
      *) printf '选择无效，请输入 0 到 7 之间的数字。\n'; wait_for_menu ;;
    esac
  done
}

service_menu() {
  local choice
  is_installed || { printf 'ConfDock 未安装，请先安装。\n'; return 0; }
  while true; do
    printf '\n服务管理\n1. 状态\n2. 启动\n3. 停止\n4. 重启\n5. 查看近期日志\n6. 持续查看日志\n0. 返回\n\n请选择：'
    read -r choice || return 0
    case "$choice" in
      1) menu_action service_action status ;;
      2) menu_action service_action start ;;
      3) menu_action service_action stop ;;
      4) menu_action service_action restart ;;
      5) menu_action service_action logs ;;
      6) menu_action "$JOURNALCTL" -u "$SERVICE_NAME" -f ;;
      0) return 0 ;;
      *) printf '选择无效。\n'; wait_for_menu ;;
    esac
  done
}

main() {
  local command="${1:-}"
  case "$command" in
    '' ) menu ;;
    --help|-h) usage ;;
    --version) script_version ;;
    install)
      [[ $# -eq 2 ]] || { die '用法：confdock.sh install {binary|source}'; return 1; }
      case "$2" in binary) install_binary ;; source) install_source ;; *) die "未知安装模式：$2"; return 1 ;; esac
      ;;
    service)
      [[ $# -eq 2 ]] || { die '用法：confdock.sh service {status|start|stop|restart|logs}'; return 1; }
      service_action "$2"
      ;;
    config)
      [[ $# -eq 2 ]] || { die '用法：confdock.sh config {edit|check}'; return 1; }
      case "$2" in edit) config_edit_installed ;; check) config_check_installed ;; *) die "未知配置操作：$2"; return 1 ;; esac
      ;;
    admin)
      [[ $# -eq 2 && "$2" == set-password ]] || { die '用法：confdock.sh admin set-password'; return 1; }
      admin_set_password ;;
    doctor) [[ $# -eq 1 ]] || { die '用法：confdock.sh doctor'; return 1; }; doctor ;;
    uninstall) [[ $# -eq 1 ]] || { die '用法：confdock.sh uninstall'; return 1; }; uninstall ;;
    *) die "未知命令：${command}（使用 --help 查看帮助）"; return 1 ;;
  esac
}

if [[ "${CONFDOCK_TEST_MODE:-}" != 1 ]]; then
  main "$@"
fi
