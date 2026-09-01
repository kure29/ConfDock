#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for command_name in node npm rustup; do
  command -v "$command_name" >/dev/null || {
    printf 'required command missing: %s\n' "$command_name" >&2
    exit 1
  }
done

# A standalone Cargo/rustc cannot enforce RUSTUP_TOOLCHAIN. Always resolve and
# use the repository's exact Rust toolchain through rustup.
if ! rustup_cargo_bin="$(rustup which --toolchain 1.88.0 cargo 2>/dev/null)" \
  || ! rustup_rustc_bin="$(rustup which --toolchain 1.88.0 rustc 2>/dev/null)"; then
  printf 'Rust 1.88.0 is required; install it with rustup before building\n' >&2
  exit 1
fi
test -x "$rustup_cargo_bin"
test -x "$rustup_rustc_bin"
pinned_toolchain_bin="$(dirname "$rustup_rustc_bin")"
export PATH="$pinned_toolchain_bin:$PATH"

rustc_version="$($rustup_rustc_bin --version)"
cargo_version="$($rustup_cargo_bin --version)"
case "$rustc_version" in
  "rustc 1.88.0 ("*) ;;
  *) printf 'Rust 1.88.0 is required (found %s)\n' "$rustc_version" >&2; exit 1 ;;
esac
case "$cargo_version" in
  "cargo 1.88.0 ("*) ;;
  *) printf 'Cargo 1.88.0 is required (found %s)\n' "$cargo_version" >&2; exit 1 ;;
esac

wasm_bindgen_bin="$(command -v wasm-bindgen || true)"
if [[ -z "$wasm_bindgen_bin" ]]; then
  cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
  wasm_bindgen_bin="$cargo_home/bin/wasm-bindgen"
fi
test -x "$wasm_bindgen_bin" || {
  printf 'required command missing: wasm-bindgen (install version 0.2.127)\n' >&2
  exit 1
}
wasm_bindgen_version="$($wasm_bindgen_bin --version | awk '{print $2}')"
if [[ "$wasm_bindgen_version" != "0.2.127" ]]; then
  printf 'wasm-bindgen 0.2.127 is required (found %s)\n' "$wasm_bindgen_version" >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" -lt 22 ]]; then
  printf 'Node.js 22 or newer is required (found %s)\n' "$(node --version)" >&2
  exit 1
fi

printf 'Node.js: %s\n' "$(node --version)"
printf 'Rustc: %s\n' "$rustc_version"
printf 'Cargo: %s\n' "$cargo_version"
printf 'wasm-bindgen: %s\n' "$wasm_bindgen_version"

build_root="${CONFDOCK_BUILD_ROOT:-$repo_root/target/confdock-rust-1.88.0}"
wasm_target_dir="${CONFDOCK_WASM_TARGET_DIR:-$build_root/wasm}"
native_target_dir="${CONFDOCK_NATIVE_TARGET_DIR:-$build_root/native}"
native_binary="$native_target_dir/release/confdock"
compat_binary="${CONFDOCK_OUTPUT_BINARY:-$repo_root/target/release/confdock}"

# Vite normally empties this directory, but make that contract explicit so an
# interrupted or hand-copied build can never leave stale assets for rust-embed.
rm -rf -- web/dist
npm ci --prefix web
CONFDOCK_WASM_TARGET_DIR="$wasm_target_dir" \
  CONFDOCK_WASM_BINDGEN="$wasm_bindgen_bin" npm run wasm:build --prefix web
npm run build --prefix web
test -f web/dist/index.html
if find web/dist -type f \( -name '*.map' -o -name '* 2.*' \) -print -quit | grep -q .; then
  printf 'web/dist contains stale or source-map output\n' >&2
  exit 1
fi

temporary_unembedded="$(mktemp -t confdock-unembedded.XXXXXX)"
compat_temp=""
cleanup() {
  rm -f -- "$temporary_unembedded"
  if [[ -n "$compat_temp" ]]; then
    rm -f -- "$compat_temp"
  fi
}
trap cleanup EXIT

CARGO_TARGET_DIR="$native_target_dir" RUSTUP_TOOLCHAIN=1.88.0 RUSTC="$rustup_rustc_bin" \
  "$rustup_cargo_bin" build -p confdock-service --release
cp "$native_binary" "$temporary_unembedded"
CARGO_TARGET_DIR="$native_target_dir" RUSTUP_TOOLCHAIN=1.88.0 RUSTC="$rustup_rustc_bin" \
  "$rustup_cargo_bin" build -p confdock-service --release --features embedded-web

# Keep the historical output path only as an explicit copy of the just-built,
# toolchain-isolated binary. Packaging and smoke tests should use native_binary.
mkdir -p "$(dirname "$compat_binary")"
compat_temp="$(mktemp "${compat_binary}.XXXXXX")"
install -m 755 "$native_binary" "$compat_temp"
mv -f -- "$compat_temp" "$compat_binary"
compat_temp=""

web_dist_bytes="$(find web/dist -type f -print0 | xargs -0 wc -c | tail -1 | awk '{print $1}')"
wasm_bytes="$(find web/dist -type f -name '*.wasm' -print0 | xargs -0 wc -c | tail -1 | awk '{print $1}')"
unembedded_bytes="$(wc -c < "$temporary_unembedded" | tr -d ' ')"
embedded_bytes="$(wc -c < "$native_binary" | tr -d ' ')"

printf 'web dist bytes: %s\n' "$web_dist_bytes"
printf 'WASM bytes: %s\n' "$wasm_bytes"
printf 'backend release bytes (without embedded web): %s\n' "$unembedded_bytes"
printf 'single binary bytes (embedded web): %s\n' "$embedded_bytes"
printf 'single binary: %s\n' "$native_binary"
printf 'compatibility copy: %s\n' "$compat_binary"
file "$native_binary"
