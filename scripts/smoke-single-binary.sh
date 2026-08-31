#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s /path/to/confdock\n' "$0" >&2
  exit 2
fi

binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
test -x "$binary"
config_file="$(dirname "$binary")/config.toml"
if [[ ! -f "$config_file" ]]; then
  config_file="$(cd "$(dirname "$0")/.." && pwd)/packaging/config.toml"
fi
test -f "$config_file"

"$binary" --help >/dev/null
"$binary" --version >/dev/null
"$binary" config check --config "$config_file" >/dev/null

runtime_dir="$(mktemp -d -t confdock-smoke.XXXXXX)"
data_dir="$runtime_dir/data"
mkdir -p "$data_dir"
runtime_binary="$runtime_dir/confdock"
install -m 755 "$binary" "$runtime_binary"
binary="$runtime_binary"
port="${CONFDOCK_SMOKE_PORT:-18878}"
base_url="http://127.0.0.1:${port}"
log_file="$runtime_dir/server.log"
pid=""

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$runtime_dir"
}
trap cleanup EXIT

(
  cd "$runtime_dir"
  CONFDOCK_LISTEN="127.0.0.1:${port}" \
  CONFDOCK_DATABASE_URL="sqlite://${data_dir}/confdock.db" \
  CONFDOCK_PUBLIC_URL="$base_url" \
  CONFDOCK_BOOTSTRAP_PASSWORD="smoke-test-password-only" \
  RUST_LOG=info \
  exec "$binary"
) >"$log_file" 2>&1 &
pid=$!

ready=0
for _ in $(seq 1 80); do
  if curl -fsS "$base_url/healthz" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$log_file" >&2
    exit 1
  fi
  sleep 0.1
done
test "$ready" -eq 1

curl -fsS "$base_url/" -o "$runtime_dir/index.html"
grep -F '<div id="root"></div>' "$runtime_dir/index.html" >/dev/null
script_path="$(sed -n 's/.*src="\(\/assets\/[^"?]*\.js\)".*/\1/p' "$runtime_dir/index.html" | head -1)"
style_path="$(sed -n 's/.*href="\(\/assets\/[^"?]*\.css\)".*/\1/p' "$runtime_dir/index.html" | head -1)"
test -n "$script_path"
test -n "$style_path"

assert_content_type() {
  local path="$1"
  local expected="$2"
  local content_type
  content_type="$(curl -fsS -D - -o /dev/null "$base_url$path" | awk -F': ' 'tolower($1)=="content-type" {print $2}' | tr -d '\r' | tail -1)"
  test "$content_type" = "$expected"
}

assert_content_type "$script_path" "application/javascript; charset=utf-8"
assert_content_type "$style_path" "text/css; charset=utf-8"
curl -fsS "$base_url$script_path" -o "$runtime_dir/app.js"
test -s "$runtime_dir/app.js"
curl -fsS "$base_url$style_path" -o "$runtime_dir/app.css"
test -s "$runtime_dir/app.css"
wasm_module="$(grep -oE 'confdock_wasm-[A-Za-z0-9_.-]+\.js' "$runtime_dir/app.js" | head -1)"
test -n "$wasm_module"
curl -fsS "$base_url/assets/$wasm_module" -o "$runtime_dir/wasm.js"
wasm_name="$(grep -oE 'confdock_wasm_bg-[A-Za-z0-9_.-]+\.wasm' "$runtime_dir/wasm.js" | head -1)"
test -n "$wasm_name"
assert_content_type "/assets/$wasm_name" "application/wasm"
assert_content_type "/client-icons/mihomo.png" "image/png"

head_bytes="$(curl -fsS --head -o /dev/null -w '%{size_download}' "$base_url$script_path")"
test "$head_bytes" = "0"
test "$(curl -fsS -o "$runtime_dir/spa.html" -w '%{http_code}' "$base_url/p/smoke")" = "200"
grep -F '<div id="root"></div>' "$runtime_dir/spa.html" >/dev/null

for path in /api/not-found /sub/not-found /assets/missing.js /assets/missing.css /assets/missing.wasm /client-icons/missing.png /client-icons/missing.webp; do
  status="$(curl -sS -o "$runtime_dir/missing.body" -w '%{http_code}' "$base_url$path")"
  test "$status" = "404"
  ! grep -F '<div id="root"></div>' "$runtime_dir/missing.body" >/dev/null
done

for method in POST PUT PATCH DELETE; do
  status="$(curl -sS -X "$method" -o "$runtime_dir/method.body" -w '%{http_code}' "$base_url/unknown/client-route")"
  test "$status" = "404"
done

status="$(curl --path-as-is -sS -o "$runtime_dir/traversal.body" -w '%{http_code}' "$base_url/assets/%2e%2e/Cargo.toml")"
test "$status" = "404"

kill -TERM "$pid"
wait "$pid"
pid=""

if command -v sha256sum >/dev/null; then
  digest="$(sha256sum "$binary" | awk '{print $1}')"
else
  digest="$(shasum -a 256 "$binary" | awk '{print $1}')"
fi
printf 'single-binary smoke test passed\n'
printf 'binary=%s\n' "$binary"
printf 'bytes=%s\n' "$(wc -c < "$binary" | tr -d ' ')"
printf 'sha256=%s\n' "$digest"
