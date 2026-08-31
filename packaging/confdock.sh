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
  printf 'Error: %s\n' "$1" >&2
  return 1
}

usage() {
  cat <<'EOF'
ConfDock Linux management script

Usage:
  confdock.sh                         Open the management menu
  confdock.sh install binary          Install the bundled Linux binary
  confdock.sh install source          Build a release binary and install it
  confdock.sh service {status|start|stop|restart|logs}
  confdock.sh config {edit|check}
  confdock.sh admin set-password
  confdock.sh doctor
  confdock.sh uninstall

The installed command /usr/local/sbin/confdockctl accepts the same commands.
Docker, online updates, and backup/restore are intentionally not provided.
EOF
}

script_version() {
  printf 'confdock management script %s\n' "$SCRIPT_VERSION"
}

need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "this operation changes system files or services and requires root; run it with sudo"
}

detect_platform() {
  local os arch libc
  os="$(uname -s 2>/dev/null || true)"
  arch="$(uname -m 2>/dev/null || true)"
  [[ "$os" == "Linux" ]] || die "unsupported operating system: ${os:-unknown} (Linux is required)"
  case "$arch" in
    x86_64|amd64) ;;
    *) die "unsupported CPU architecture: ${arch:-unknown} (x86_64/amd64 is required)" ;;
  esac
  command -v "$SYSTEMCTL" >/dev/null 2>&1 || die "systemd is not available: systemctl was not found"
  libc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  if [[ "$libc" != glibc\ * ]]; then
    libc="$(ldd --version 2>&1 | head -1 || true)"
  fi
  [[ "$libc" == glibc\ * || "$libc" == *GLIBC* || "$libc" == *GNU\ libc* ]] || \
    die "glibc was not detected; this Linux x86-64 installer targets glibc"
  printf 'Platform: Linux %s, %s, %s\n' "$arch" "${libc%%$'\n'*}" "$SYSTEMCTL"
}

require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "required command is missing: $name"
}

validate_binary() {
  local binary="$1" description
  [[ -f "$binary" ]] || die "binary not found: $binary"
  [[ -x "$binary" ]] || die "binary is not executable: $binary"
  require_command file
  description="$(file -Lb -- "$binary" 2>/dev/null || true)"
  [[ "$description" == ELF\ 64-bit* && "$description" == *x86-64* && "$description" == *LSB* ]] || \
    die "binary is not a Linux x86-64 ELF executable: $description"
  "$binary" --version >/dev/null || die "binary --version failed: $binary"
}

validate_config() {
  local binary="$1" config="$2"
  [[ -f "$config" ]] || die "configuration file not found: $config"
  [[ ! -L "$config" ]] || die "configuration file must not be a symbolic link: $config"
  "$binary" config check --config "$config" >/dev/null || die "configuration validation failed: $config"
}

config_value() {
  local field="$1" binary="${2:-$BIN_PATH}" config="${3:-$CONFIG_PATH}"
  "$binary" config get "$field" --config "$config"
}

safe_data_dir() {
  local path="$1" resolved
  [[ "$path" == /* ]] || die "data_dir must be an absolute path for a native systemd install"
  [[ ! -L "$path" ]] || die "data_dir must not be a symbolic link: $path"
  [[ "$path" != *$'\n'* && "$path" != *$'\r'* && "$path" != *$'\t'* ]] || die "data_dir contains control characters"
  [[ "$path" != */../* && "$path" != */.. && "$path" != .. ]] || die "data_dir must not contain parent traversal"
  case "$path" in
    /|/etc|/usr|/var|/home|/root|/bin|/sbin|/lib|/lib64)
      die "refusing unsafe broad data_dir: $path" ;;
  esac
  if [[ -n "${HOME:-}" && "$path" == "${HOME%/}"/* ]]; then
    die "refusing data_dir below the user home directory: $path"
  fi
  if [[ "$path" == "$REPO_ROOT"/* ]]; then
    die "refusing data_dir inside the source worktree: $path"
  fi
  if [[ -e "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || die "data_dir must be a real directory, not a file or symlink: $path"
    resolved="$(readlink -f -- "$path" 2>/dev/null || true)"
    [[ -n "$resolved" && "$resolved" == "$path" ]] || die "data_dir resolves through a symlink: $path"
  fi
  printf '%s\n' "$path"
}

show_config_summary() {
  local binary="$1" config="$2" data_dir
  data_dir="$(config_value data_dir "$binary" "$config")" || die "could not read data_dir from configuration"
  safe_data_dir "$data_dir" >/dev/null
  printf 'Version: %s\n' "$($binary --version | head -1)"
  printf 'Listen: %s\n' "$(config_value listen "$binary" "$config")"
  printf 'Public URL: %s\n' "$(config_value public_url "$binary" "$config")"
  printf 'Data directory: %s\n' "$data_dir"
  printf 'Service: %s\n' "$SERVICE_NAME"
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

check_existing_install() {
  local data_dir="$1"
  [[ ! -L "$CONFIG_DIR" && ! -L "$(dirname -- "$UNIT_PATH")" && ! -L "$(dirname -- "$BIN_PATH")" && ! -L "$(dirname -- "$CTL_PATH")" ]] || \
    die "refusing to install through a symbolic-link system directory"
  if native_marker_exists; then
    die "an existing or partial native installation was detected; use confdockctl instead of overwriting it"
  fi
  if [[ -e "$data_dir" ]] && data_dir_has_entries "$data_dir"; then
    die "data directory is non-empty but no valid ConfDock installation could be confirmed: $data_dir (nothing was changed)"
  fi
}

atomic_copy_safe() {
  local source="$1" destination="$2" mode="$3" tmp
  [[ -f "$source" ]] || die "source file not found: $source"
  mkdir -p -- "$(dirname -- "$destination")"
  tmp="$(mktemp "$(dirname -- "$destination")/.confdock-install.XXXXXX")"
  TMP_FILES+=("$tmp")
  cp -- "$source" "$tmp"
  chmod "$mode" "$tmp"
  mv -f -- "$tmp" "$destination"
}

write_unit() {
  local data_dir="$1" tmp rw_path
  require_command systemd-escape
  rw_path="$(systemd-escape --path -- "$data_dir")" || die "could not safely encode data_dir for systemd"
  mkdir -p -- "$(dirname -- "$UNIT_PATH")"
  tmp="$(mktemp "$(dirname -- "$UNIT_PATH")/.confdock-unit.XXXXXX")"
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
  chmod 0644 "$tmp"
  mv -f -- "$tmp" "$UNIT_PATH"
}

service_user_setup() {
  local data_dir="$1"
  local nologin
  require_command getent
  require_command groupadd
  require_command useradd
  nologin="$(command -v nologin 2>/dev/null || printf '/usr/sbin/nologin')"
  if getent group "$SERVICE_GROUP" >/dev/null; then
    :
  else
    groupadd --system "$SERVICE_GROUP"
  fi
  if getent passwd "$SERVICE_USER" >/dev/null; then
    local shell primary_group
    shell="$(getent passwd "$SERVICE_USER" | awk -F: '{print $7}')"
    [[ "$shell" == "$nologin" || "$shell" == /sbin/nologin || "$shell" == /usr/sbin/nologin ]] || \
      die "existing service user $SERVICE_USER does not use nologin; refusing to modify it"
    primary_group="$(id -gn "$SERVICE_USER" 2>/dev/null || true)"
    [[ "$primary_group" == "$SERVICE_GROUP" ]] || \
      die "existing service user $SERVICE_USER does not use group $SERVICE_GROUP; refusing to modify it"
  else
    useradd --system --gid "$SERVICE_GROUP" --shell "$nologin" --home-dir "$data_dir" --no-create-home "$SERVICE_USER"
  fi
}

run_as_service_user() {
  require_command runuser
  runuser -u "$SERVICE_USER" -- "$@"
}

health_check() {
  local url="$1"
  require_command curl
  curl --fail --silent --show-error --max-time 5 "$url/healthz" >/dev/null
}

health_url_for_config() {
  local listen="$1" port
  port="${listen##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || die "listen address has no valid port: $listen"
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
  editor="$(choose_editor)" || die "no editor found; set EDITOR or install nano/vi"
  temp_dir="$(mktemp -d -t confdock-config.XXXXXX)"
  TMP_DIRS+=("$temp_dir")
  temp="$temp_dir/config.toml"
  cp -- "$original" "$temp"
  chmod 0640 "$temp"
  "$editor" "$temp"
  "$binary" config check --config "$temp" >/dev/null || die "edited configuration is invalid; original configuration was preserved"
  EDITED_CONFIG_PATH="$temp"
}

install_native() {
  local source_binary="$1" source_config="$2" data_dir public_url listen health_url answer
  local edited_config="$source_config"
  detect_platform
  validate_binary "$source_binary"
  validate_config "$source_binary" "$source_config"
  data_dir="$(config_value data_dir "$source_binary" "$source_config")"
  data_dir="$(safe_data_dir "$data_dir")"
  [[ -z "$DATA_DIR_OVERRIDE" ]] || data_dir="$(safe_data_dir "$DATA_DIR_OVERRIDE")"
  check_existing_install "$data_dir"
  show_config_summary "$source_binary" "$source_config"
  if [[ -t 0 ]]; then
    read -r -p 'Use the default configuration? [Y/n] ' answer || answer=''
    if [[ "$answer" =~ ^[Nn]([Oo])?$ ]]; then
      edit_config_file "$source_config" "$source_binary"
      edited_config="$EDITED_CONFIG_PATH"
      validate_config "$source_binary" "$edited_config"
      data_dir="$(safe_data_dir "$(config_value data_dir "$source_binary" "$edited_config")")"
    fi
  fi
  check_existing_install "$data_dir"
  public_url="$(config_value public_url "$source_binary" "$edited_config")"
  listen="$(config_value listen "$source_binary" "$edited_config")"
  health_url="$(health_url_for_config "$listen")"
  service_user_setup "$data_dir"
  mkdir -p -- "$CONFIG_DIR" "$data_dir"
  chmod 0750 "$CONFIG_DIR" "$data_dir"
  chown "root:$SERVICE_GROUP" "$CONFIG_DIR"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$data_dir"
  atomic_copy_safe "$source_binary" "$BIN_PATH" 0755
  atomic_copy_safe "$edited_config" "$CONFIG_PATH" 0640
  chown "root:$SERVICE_GROUP" "$CONFIG_PATH"
  # Install this exact script, rather than trusting a similarly named file in
  # the current directory.  A root-owned copy is used by future invocations.
  atomic_copy_safe "$SCRIPT_FILE" "$CTL_PATH" 0755
  write_unit "$data_dir"
  "$SYSTEMCTL" daemon-reload
  if ! run_as_service_user "$BIN_PATH" admin init --config "$CONFIG_PATH"; then
    "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
    rm -f -- "$UNIT_PATH" "$BIN_PATH" "$CTL_PATH"
    printf 'Administrator initialization failed. Configuration and data directory were preserved; the service was not started.\n' >&2
    return 1
  fi
  if ! "$SYSTEMCTL" enable "$SERVICE_NAME" || ! "$SYSTEMCTL" start "$SERVICE_NAME"; then
    "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
    printf 'Service failed to start; inspect systemctl status %s and journalctl -u %s.\n' "$SERVICE_NAME" "$SERVICE_NAME" >&2
    return 1
  fi
  if ! wait_for_health "$health_url"; then
    printf 'Service started but /healthz did not become ready. Inspect systemctl status %s and journalctl -u %s.\n' "$SERVICE_NAME" "$SERVICE_NAME" >&2
    return 1
  fi
  printf 'ConfDock installed successfully.\nAccess: %s\nManagement: sudo confdockctl\n' "$public_url"
}

install_binary() {
  need_root
  [[ "$SCRIPT_NAME" == "confdockctl" ]] && die "the installed management command cannot install a bundled binary"
  [[ -f "$ARTIFACT_BINARY" && -f "$ARTIFACT_CONFIG" ]] || die "release directory must contain confdock and config.toml beside confdock.sh"
  install_native "$ARTIFACT_BINARY" "$ARTIFACT_CONFIG"
}

install_source() {
  local missing=() command_name node_major wasm_version
  need_root
  [[ "$SCRIPT_NAME" != "confdockctl" ]] || die "run source installation from a complete ConfDock source tree"
  for command_name in git cargo rustc node npm wasm-bindgen; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done
  if (( ${#missing[@]} > 0 )); then
    printf 'Source installation is missing required tools: %s\n' "${missing[*]}" >&2
    printf 'Required versions: Node.js 22+, Rust stable, npm, wasm-bindgen-cli 0.2.127.\n' >&2
    return 1
  fi
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$node_major" -ge 22 ]] || die "Node.js 22 or newer is required (found $(node --version))"
  wasm_version="$(wasm-bindgen --version | awk '{print $2}')"
  [[ "$wasm_version" == 0.2.127 ]] || die "wasm-bindgen-cli 0.2.127 is required (found $wasm_version)"
  git -C "$REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 || die "source installation requires a complete Git checkout"
  [[ -x "$REPO_ROOT/scripts/build-single-binary.sh" ]] || die "scripts/build-single-binary.sh is missing"
  (cd "$REPO_ROOT" && ./scripts/build-single-binary.sh)
  [[ -x "$REPO_ROOT/target/release/confdock" ]] || die "release binary was not produced"
  (cd "$REPO_ROOT" && ./scripts/smoke-single-binary.sh target/release/confdock)
  install_native "$REPO_ROOT/target/release/confdock" "$REPO_ROOT/packaging/config.toml"
}

is_installed() {
  [[ -f "$BIN_PATH" && -f "$CTL_PATH" && -f "$CONFIG_PATH" && -f "$UNIT_PATH" ]]
}

service_status() {
  if ! is_installed; then printf 'ConfDock is not installed.\n'; return 0; fi
  printf 'Version: '; "$BIN_PATH" --version | head -1
  printf 'Service: '
  "$SYSTEMCTL" is-active "$SERVICE_NAME" 2>/dev/null || printf 'inactive\n'
  "$SYSTEMCTL" status "$SERVICE_NAME" --no-pager --lines=20 2>/dev/null || true
}

service_action() {
  local action="$1"
  if ! is_installed; then
    if [[ "$action" == status ]]; then
      printf 'ConfDock is not installed.\n'
      return 0
    fi
    die "ConfDock is not installed; install it first"
  fi
  case "$action" in
    status) service_status ;;
    start|restart)
      need_root
      "$SYSTEMCTL" "$action" "$SERVICE_NAME"
      local listen health_url
      listen="$(config_value listen)"
      health_url="$(health_url_for_config "$listen")"
      wait_for_health "$health_url" || die "service did not become healthy; inspect systemctl status $SERVICE_NAME and journalctl -u $SERVICE_NAME"
      ;;
    stop)
      need_root
      "$SYSTEMCTL" stop "$SERVICE_NAME"
      ;;
    logs)
      "$JOURNALCTL" -u "$SERVICE_NAME" -n 80 --no-pager
      ;;
    *) die "unknown service action: $action" ;;
  esac
}

config_check_installed() {
  is_installed || die "ConfDock is not installed; install it first"
  validate_config "$BIN_PATH" "$CONFIG_PATH"
  printf 'Configuration is valid.\n'
}

config_edit_installed() {
  local edited backup listen health_url answer
  is_installed || die "ConfDock is not installed; install it first"
  need_root
  edit_config_file "$CONFIG_PATH" "$BIN_PATH"
  edited="$EDITED_CONFIG_PATH"
  backup="${CONFIG_PATH}.previous"
  cp -- "$CONFIG_PATH" "$backup"
  chmod 0640 "$backup"
  chown "root:$SERVICE_GROUP" "$backup"
  mv -f -- "$edited" "$CONFIG_PATH"
  chown "root:$SERVICE_GROUP" "$CONFIG_PATH"
  "$SYSTEMCTL" daemon-reload
  if [[ -t 0 ]]; then
    read -r -p 'Restart ConfDock with this configuration? [y/N] ' answer || answer=''
    if [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]; then
      listen="$(config_value listen)"
      health_url="$(health_url_for_config "$listen")"
      if ! "$SYSTEMCTL" restart "$SERVICE_NAME" || ! wait_for_health "$health_url"; then
        mv -f -- "$backup" "$CONFIG_PATH"
        chmod 0640 "$CONFIG_PATH"
        "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
        "$SYSTEMCTL" restart "$SERVICE_NAME" >/dev/null 2>&1 || true
        die "restart failed; previous configuration was restored"
      fi
    fi
  fi
  printf 'Configuration updated; previous version saved as %s.\n' "$backup"
}

admin_set_password() {
  is_installed || die "ConfDock is not installed; install it first"
  need_root
  run_as_service_user "$BIN_PATH" admin set-password --config "$CONFIG_PATH" || die "administrator password update failed"
  printf 'Administrator password updated. Existing login sessions were invalidated.\n'
}

stat_mode() {
  local path="$1"
  if [[ -e "$path" ]]; then
    stat -c '%A %U:%G' -- "$path" 2>/dev/null || stat -f '%Sp %Su:%Sg' -- "$path" 2>/dev/null || printf 'present\n'
  else
    printf 'missing\n'
  fi
}

doctor() {
  local data_dir listen health_url state
  printf 'Operating system: %s\n' "$(uname -s 2>/dev/null || printf unknown)"
  printf 'CPU architecture: %s\n' "$(uname -m 2>/dev/null || printf unknown)"
  printf 'glibc: %s\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null || printf 'not detected')"
  printf 'systemd: %s\n' "$(command -v "$SYSTEMCTL" 2>/dev/null || printf 'not detected')"
  if ! is_installed; then printf 'ConfDock installation: not installed\n'; return 0; fi
  printf 'ConfDock installation: native binary\n'
  printf 'Installed version: '; "$BIN_PATH" --version | head -1
  printf 'Binary permissions: '; stat_mode "$BIN_PATH"
  printf 'Config permissions: '; stat_mode "$CONFIG_PATH"
  if "$BIN_PATH" config check --config "$CONFIG_PATH" >/dev/null 2>&1; then printf 'Config validation: valid\n'; else printf 'Config validation: failed\n'; fi
  if getent passwd "$SERVICE_USER" >/dev/null 2>&1; then printf 'Service user: %s\n' "$SERVICE_USER"; else printf 'Service user: missing\n'; fi
  data_dir="$(config_value data_dir 2>/dev/null || true)"
  if [[ -n "$data_dir" ]]; then printf 'Data directory: %s (%s)\n' "$data_dir" "$(stat_mode "$data_dir")"; else printf 'Data directory: unavailable\n'; fi
  printf 'systemd unit: '; stat_mode "$UNIT_PATH"
  state="$($SYSTEMCTL is-active "$SERVICE_NAME" 2>/dev/null || printf inactive)"
  printf 'Service state: %s\n' "$state"
  listen="$(config_value listen 2>/dev/null || true)"; printf 'Listen address: %s\n' "${listen:-unavailable}"
  if [[ -n "$listen" ]] && command -v curl >/dev/null 2>&1; then
    health_url="$(health_url_for_config "$listen" 2>/dev/null || true)"
    if [[ -n "$health_url" ]] && health_check "$health_url" 2>/dev/null; then
      printf 'Port status: reachable\nHealth check: healthy\n'
    else
      printf 'Port status: unreachable\nHealth check: failed\n'
    fi
  else
    printf 'Port status: skipped\nHealth check: skipped (curl unavailable or listen address unreadable)\n'
  fi
  printf 'Recent security errors: omitted; inspect journalctl -u %s for a bounded summary.\n' "$SERVICE_NAME"
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

uninstall() {
  local answer data_dir delete_answer confirm
  is_installed || { printf 'ConfDock is not installed; no files were removed.\n'; return 0; }
  need_root
  data_dir="$(config_value data_dir 2>/dev/null || true)"
  if [[ -t 0 ]]; then
    read -r -p 'Uninstall ConfDock but preserve configuration and data? [y/N] ' answer || answer=''
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || { printf 'Uninstall cancelled.\n'; return 0; }
  elif [[ "${CONFDOCK_ASSUME_YES:-}" != 1 ]]; then
    die 'non-interactive uninstall requires CONFDOCK_ASSUME_YES=1'
  fi
  "$SYSTEMCTL" stop "$SERVICE_NAME" >/dev/null 2>&1 || true
  "$SYSTEMCTL" disable "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f -- "$UNIT_PATH" "$BIN_PATH" "$CTL_PATH"
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
  printf 'Configuration and data were preserved.\nConfig: %s\n' "$CONFIG_PATH"
  [[ -z "$data_dir" ]] || printf 'Data: %s\n' "$data_dir"
  if [[ -t 0 ]]; then
    read -r -p 'Permanently delete the preserved configuration and data? Type DELETE to continue: ' delete_answer || delete_answer=''
    if [[ "$delete_answer" == DELETE ]]; then
      confirm=''
      read -r -p 'This cannot be undone. Type DELETE again: ' confirm || confirm=''
      if [[ "$confirm" == DELETE ]] && dangerous_delete_path "$CONFIG_DIR" && { [[ -z "$data_dir" ]] || dangerous_delete_path "$data_dir"; }; then
        [[ ! -L "$CONFIG_DIR" ]] && rm -rf -- "$CONFIG_DIR"
        [[ -z "$data_dir" || ! -L "$data_dir" ]] || die 'refusing to delete a symlink data directory'
        [[ -z "$data_dir" ]] || rm -rf -- "$data_dir"
        printf 'Configuration and data were permanently deleted. They are not recoverable.\n'
      else
        printf 'Permanent deletion refused; configuration and data remain.\n'
      fi
    fi
  fi
}

menu() {
  local choice
  while true; do
    printf '\n================================\n        ConfDock Management\n================================\n'
    if is_installed; then
      printf 'Status: Installed\nMode: Native binary\nVersion: %s\nService: %s\n\n' "$($BIN_PATH --version 2>/dev/null | head -1 || printf unknown)" "$($SYSTEMCTL is-active "$SERVICE_NAME" 2>/dev/null || printf Stopped)"
    else
      printf 'Status: Not installed\nMode: —\nVersion: —\nService: —\n\n'
    fi
    cat <<'EOF'
1. Install prebuilt binary (recommended)
2. Build from source and install (advanced)
3. Service management
4. Edit and validate configuration
5. Change administrator password
6. Diagnostics
7. Uninstall ConfDock
0. Exit

Select an option:
EOF
    read -r choice || return 0
    case "$choice" in
      1) install_binary || true ;;
      2) install_source || true ;;
      3) service_menu || true ;;
      4) config_edit_installed || true ;;
      5) admin_set_password || true ;;
      6) doctor || true ;;
      7) uninstall || true ;;
      0) return 0 ;;
      *) printf 'Invalid selection. Choose a number from 0 to 7.\n' ;;
    esac
  done
}

service_menu() {
  local choice
  is_installed || { printf 'ConfDock is not installed; install it first.\n'; return 0; }
  while true; do
    printf '\nService management\n1. Status\n2. Start\n3. Stop\n4. Restart\n5. Recent logs\n6. Follow logs\n0. Back\n\nSelect an option: '
    read -r choice || return 0
    case "$choice" in
      1) service_action status || true ;;
      2) service_action start || true ;;
      3) service_action stop || true ;;
      4) service_action restart || true ;;
      5) service_action logs || true ;;
      6) "$JOURNALCTL" -u "$SERVICE_NAME" -f || true ;;
      0) return 0 ;;
      *) printf 'Invalid selection.\n' ;;
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
      [[ $# -eq 2 ]] || die 'usage: confdock.sh install {binary|source}'
      case "$2" in binary) install_binary ;; source) install_source ;; *) die "unknown install mode: $2" ;; esac
      ;;
    service)
      [[ $# -eq 2 ]] || die 'usage: confdock.sh service {status|start|stop|restart|logs}'
      service_action "$2"
      ;;
    config)
      [[ $# -eq 2 ]] || die 'usage: confdock.sh config {edit|check}'
      case "$2" in edit) config_edit_installed ;; check) config_check_installed ;; *) die "unknown config action: $2" ;; esac
      ;;
    admin)
      [[ $# -eq 2 && "$2" == set-password ]] || die 'usage: confdock.sh admin set-password'
      admin_set_password ;;
    doctor) [[ $# -eq 1 ]] || die 'usage: confdock.sh doctor'; doctor ;;
    uninstall) [[ $# -eq 1 ]] || die 'usage: confdock.sh uninstall'; uninstall ;;
    *) die "unknown command: $command (use --help)" ;;
  esac
}

main "$@"
