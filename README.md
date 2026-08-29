# ConfDock

ConfDock is a self-hosted platform for importing, editing, validating, saving,
and serving native proxy-client configuration files. It does not run proxy
traffic or replace a proxy core.

This repository currently contains Slice 0: a dependency-light Rust workspace
with source-preserving document primitives, isolated target adapters, layered
diagnostics, and local-editing fixtures for Mihomo, sing-box, Surge, Loon,
Quantumult X, and Shadowrocket.

## Development

The workspace is intentionally free of server/framework dependencies. Install a
stable Rust toolchain, then run:

```text
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

See [`docs/architecture.md`](docs/architecture.md) for the product boundary,
revision model, and the planned React/WASM/Axum/SQLite service architecture.
