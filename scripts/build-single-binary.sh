#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for command_name in node npm cargo rustc; do
  command -v "$command_name" >/dev/null || {
    printf 'required command missing: %s\n' "$command_name" >&2
    exit 1
  }
done

wasm_bindgen_bin="$(command -v wasm-bindgen || true)"
if [[ -z "$wasm_bindgen_bin" ]]; then
  cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
  wasm_bindgen_bin="$cargo_home/bin/wasm-bindgen"
fi
test -x "$wasm_bindgen_bin" || {
  printf 'required command missing: wasm-bindgen (install version 0.2.127)\n' >&2
  exit 1
}

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 22 ]]; then
  printf 'Node.js 22 or newer is required (found %s)\n' "$(node --version)" >&2
  exit 1
fi

wasm_bindgen_version="$($wasm_bindgen_bin --version | awk '{print $2}')"
if [[ "$wasm_bindgen_version" != "0.2.127" ]]; then
  printf 'wasm-bindgen 0.2.127 is required (found %s)\n' "$wasm_bindgen_version" >&2
  exit 1
fi

printf 'Node.js: %s\n' "$(node --version)"
printf 'Rustc: %s\n' "$(rustc --version)"
printf 'Cargo: %s\n' "$(cargo --version)"
printf 'wasm-bindgen: %s\n' "$wasm_bindgen_version"

# Vite normally empties this directory, but make that contract explicit so an
# interrupted or hand-copied build can never leave stale assets for rust-embed.
rm -rf -- web/dist
npm ci --prefix web
npm run wasm:build --prefix web
npm run build --prefix web
test -f web/dist/index.html
if find web/dist -type f \( -name '*.map' -o -name '* 2.*' \) -print -quit | grep -q .; then
  printf 'web/dist contains stale or source-map output\n' >&2
  exit 1
fi

binary="target/release/confdock"
temporary_unembedded="$(mktemp -t confdock-unembedded.XXXXXX)"
trap 'rm -f "$temporary_unembedded"' EXIT

cargo build -p confdock-service --release
cp "$binary" "$temporary_unembedded"
cargo build -p confdock-service --release --features embedded-web

web_dist_bytes="$(find web/dist -type f -print0 | xargs -0 wc -c | tail -1 | awk '{print $1}')"
wasm_bytes="$(find web/dist -type f -name '*.wasm' -print0 | xargs -0 wc -c | tail -1 | awk '{print $1}')"
unembedded_bytes="$(wc -c < "$temporary_unembedded" | tr -d ' ')"
embedded_bytes="$(wc -c < "$binary" | tr -d ' ')"

printf 'web dist bytes: %s\n' "$web_dist_bytes"
printf 'WASM bytes: %s\n' "$wasm_bytes"
printf 'backend release bytes (without embedded web): %s\n' "$unembedded_bytes"
printf 'single binary bytes (embedded web): %s\n' "$embedded_bytes"
printf 'single binary: %s\n' "$repo_root/$binary"
file "$binary"
