#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d -t confdock-build-guards.XXXXXX)"
trap 'rm -rf "$test_root"' EXIT
guard_mode="${CONFDOCK_BUILD_GUARD_MODE:-all}"
case "$guard_mode" in
  all|cargo|npm) ;;
  *)
    printf 'unknown CONFDOCK_BUILD_GUARD_MODE: %s\n' "$guard_mode" >&2
    exit 2
    ;;
esac

native_build_lines="$(grep -F 'build -p confdock-service' \
  "$repo_root/scripts/build-single-binary.sh" || true)"
[[ "$(printf '%s\n' "$native_build_lines" | awk 'NF { n += 1 } END { print n + 0 }')" == 2 ]] \
  || {
    printf '%s\n' 'expected two locked native Cargo builds' >&2
    exit 1
  }
if printf '%s\n' "$native_build_lines" | grep -Fv -- '--locked' >/dev/null; then
  printf '%s\n' 'a native Cargo build is missing --locked' >&2
  exit 1
fi
grep -F "'--locked'" "$repo_root/web/scripts/build-wasm.mjs" >/dev/null
grep -F 'cargo install wasm-bindgen-cli --version 0.2.127 --locked' \
  "$repo_root/Dockerfile" >/dev/null
grep -F 'npm ci --prefix web' "$repo_root/scripts/build-single-binary.sh" >/dev/null
grep -F "[ \"\${NODE_VERSION}\" != \"22.14.0\" ]" "$repo_root/Dockerfile" >/dev/null
grep -F "[ \"\${RUST_VERSION}\" != \"1.88.0\" ]" "$repo_root/Dockerfile" >/dev/null
grep -F "cargo --version | grep -Eq '^cargo 1\\.88\\.0 \\('" "$repo_root/Dockerfile" >/dev/null
grep -F "\$(node --version)" "$repo_root/Dockerfile" >/dev/null
grep -F 'CONFDOCK_REQUIRE_NODE_VERSION' "$repo_root/Dockerfile" >/dev/null
grep -F 'ARG TARGETARCH' "$repo_root/Dockerfile" >/dev/null
grep -F 'ARG TARGETOS' "$repo_root/Dockerfile" >/dev/null
grep -F 'ARG TARGETPLATFORM' "$repo_root/Dockerfile" >/dev/null
grep -F "[ \"\${TARGETPLATFORM}\" != \"linux/amd64\" ]" "$repo_root/Dockerfile" >/dev/null
grep -F 'support Linux amd64 only' "$repo_root/Dockerfile" >/dev/null
grep -F 'Node.js 22.14.0 is required for this build' "$repo_root/scripts/build-single-binary.sh" >/dev/null
grep -F 'external: true' "$repo_root/deploy/docker/compose.yaml" >/dev/null
grep -F "name: \"\${CONFDOCK_VOLUME_NAME:-confdock-data}\"" \
  "$repo_root/deploy/docker/compose.yaml" >/dev/null
grep -F 'stop_grace_period: 30s' "$repo_root/deploy/docker/compose.yaml" >/dev/null
grep -F "127.0.0.1:\${CONFDOCK_HOST_PORT:-8787}:8787" "$repo_root/deploy/docker/compose.yaml" >/dev/null
grep -F 'nocopy: true' "$repo_root/deploy/docker/compose.yaml" >/dev/null
grep -F 'create_host_path: false' "$repo_root/deploy/docker/compose.yaml" >/dev/null
grep -F 'unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PATH_SEPARATOR' \
  "$repo_root/scripts/smoke-docker.sh" >/dev/null
grep -F 'CONFDOCK_ENV_FILE' "$repo_root/scripts/smoke-docker.sh" >/dev/null
grep -F "find \"\$runtime_dir\" -type f -print0" "$repo_root/scripts/smoke-docker.sh" >/dev/null
grep -F -- "--volumes-from \"\$container_id:ro\"" "$repo_root/scripts/backup-docker.sh" >/dev/null
grep -F -- 'install -d -m 700' "$repo_root/scripts/backup-docker.sh" >/dev/null
grep -F -- '--strip-components=1' "$repo_root/scripts/restore-docker.sh" >/dev/null
if grep -F "type=volume,source=\$volume_name" "$repo_root/scripts/backup-docker.sh" >/dev/null; then
  printf '%s\n' 'backup must not mount a volume by name (it can auto-create a volume)' >&2
  exit 1
fi
grep -F 'USER 10001:10001' "$repo_root/Dockerfile" >/dev/null
grep -F 'STOPSIGNAL SIGTERM' "$repo_root/Dockerfile" >/dev/null
grep -F 'sqlite3 tar' "$repo_root/Dockerfile" >/dev/null
grep -F 'findutils' "$repo_root/Dockerfile" >/dev/null
if grep -Eiq '^[[:space:]]*(PASSWORD|TOKEN|SECRET|PRIVATE_KEY)[A-Za-z0-9_]*[[:space:]]*=' \
  "$repo_root/deploy/docker/.env.example"; then
  printf '%s\n' '.env.example contains a secret-like assignment' >&2
  exit 1
fi
if grep -F 'docker system prune' "$repo_root/scripts/smoke-docker.sh" >/dev/null \
  || grep -F 'down --volumes' "$repo_root/scripts/smoke-docker.sh" >/dev/null; then
  printf '%s\n' 'Docker smoke contains a broad cleanup command' >&2
  exit 1
fi

# Exercise the fail-closed backup branch without requiring a Docker daemon.
# The fake client returns a stopped Compose container whose inspected volume is
# missing; the script must stop before creating a backup directory or emitting
# a success line.  This is deliberately a tiny protocol fixture, not a second
# Docker implementation.
mock_docker_dir="$test_root/mock-docker"
mkdir -p "$mock_docker_dir"
cat >"$mock_docker_dir/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == compose ]]; then
  printf '%s\n' 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  exit 0
fi
if [[ "${1:-}" == inspect && "${2:-}" == -f ]]; then
  template="${3:-}"
  object="${4:-}"
  if [[ "$object" == 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef ]]; then
    case "$template" in
      *State.Status*) printf 'exited' ;;
      *len*Mounts*) printf '2' ;;
      *Destination*'x'*) printf 'x' ;;
      *Destination*Type*) printf 'volume' ;;
      *Destination*Name*) printf 'missing-volume' ;;
      *Destination*RW*) printf 'true' ;;
      *) printf '' ;;
    esac
    exit 0
  fi
fi
if [[ "${1:-}" == volume && "${2:-}" == inspect ]]; then
  exit 1
fi
printf 'unexpected fake docker invocation\n' >&2
exit 97
MOCK_DOCKER
chmod 0755 "$mock_docker_dir/docker"
mock_backup_dir="$test_root/mock-backup-output"
mock_backup_output="$test_root/mock-backup.out"
if env -u CONFDOCK_SMOKE_RUN -u CONFDOCK_SMOKE_PROJECT \
  PATH="$mock_docker_dir:$PATH" \
  CONFDOCK_COMPOSE_FILE="$repo_root/deploy/docker/compose.yaml" \
  "$repo_root/scripts/backup-docker.sh" "$mock_backup_dir" >"$mock_backup_output" 2>&1; then
  printf '%s\n' 'missing-volume backup unexpectedly passed' >&2
  exit 1
fi
if ! grep -F 'data volume does not exist' "$mock_backup_output" >/dev/null \
  || grep -F 'Docker backup created:' "$mock_backup_output" >/dev/null \
  || [[ -e "$mock_backup_dir" ]]; then
  printf '%s\n' 'missing-volume backup left output behind' >&2
  exit 1
fi

if [[ "$guard_mode" == all || "$guard_mode" == cargo ]]; then
  command -v cargo >/dev/null || {
    printf '%s\n' 'cargo is required for the Cargo lockfile guard' >&2
    exit 1
  }
  mkdir -p "$test_root/cargo-app" "$test_root/cargo-dep/src"
  printf '%s\n' \
    '[package]' \
    'name = "lock-guard-dep"' \
    'version = "1.0.0"' \
    'edition = "2021"' >"$test_root/cargo-dep/Cargo.toml"
  printf '%s\n' 'pub fn value() {}' >"$test_root/cargo-dep/src/lib.rs"
  printf '%s\n' \
    '[package]' \
    'name = "lock-guard-app"' \
    'version = "1.0.0"' \
    'edition = "2021"' \
    '' \
    '[dependencies]' \
    'lock-guard-dep = { path = "../cargo-dep" }' >"$test_root/cargo-app/Cargo.toml"
  mkdir -p "$test_root/cargo-app/src"
  printf '%s\n' 'fn main() {}' >"$test_root/cargo-app/src/main.rs"

  cargo generate-lockfile --offline --manifest-path "$test_root/cargo-app/Cargo.toml" >/dev/null
  sed 's/version = "1.0.0"/version = "1.0.1"/' \
    "$test_root/cargo-dep/Cargo.toml" >"$test_root/cargo-dep/Cargo.toml.new"
  mv "$test_root/cargo-dep/Cargo.toml.new" "$test_root/cargo-dep/Cargo.toml"

  if cargo metadata --offline --locked \
    --manifest-path "$test_root/cargo-app/Cargo.toml" >"$test_root/metadata.out" 2>&1; then
    printf '%s\n' 'Cargo lockfile mismatch unexpectedly passed' >&2
    exit 1
  fi
fi

if [[ "$guard_mode" == all || "$guard_mode" == npm ]]; then
  command -v npm >/dev/null || {
    printf '%s\n' 'npm is required for the npm lockfile guard' >&2
    exit 1
  }
  mkdir -p "$test_root/npm-app/dep"
  printf '%s\n' '{"name":"lock-guard-dep","version":"1.0.0"}' \
    >"$test_root/npm-app/dep/package.json"
  printf '%s\n' \
    '{"name":"lock-guard-app","version":"1.0.0","private":true,"dependencies":{"lock-guard-dep":"file:dep"}}' \
    >"$test_root/npm-app/package.json"
  (
    cd "$test_root/npm-app"
    npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund >/dev/null
  )
  sed 's#file:dep#file:missing#' "$test_root/npm-app/package.json" \
    >"$test_root/npm-app/package.json.new"
  mv "$test_root/npm-app/package.json.new" "$test_root/npm-app/package.json"
  if (
    cd "$test_root/npm-app"
    npm ci --ignore-scripts --offline --no-audit --no-fund >"$test_root/npm-ci.out" 2>&1
  ); then
    printf '%s\n' 'npm lockfile mismatch unexpectedly passed' >&2
    exit 1
  fi
fi

printf 'docker build guard tests passed (%s)\n' "$guard_mode"
