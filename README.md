# ConfDock

ConfDock is a self-hosted platform for importing, editing, validating, saving,
and serving native proxy-client configuration files. It does not run proxy
traffic or replace a proxy core.

This repository currently contains Slice 0.1: a dependency-light Rust
workspace with source-preserving document primitives, isolated target
adapters, layered validation, explicit schema/edit capabilities, and fixtures
for Mihomo, sing-box, Surge, Loon, Quantumult X, and Shadowrocket.

The native bytes remain the source of truth. Structured edits use RFC 6901
JSON Pointers and replace only a safely identified source span; they never
serialize an entire configuration.

## Current capabilities

| Target | Schema | Structured edit scope | Validation |
| --- | --- | --- | --- |
| Mihomo | `/mixed-port` | Replace an existing, unambiguous top-level decimal `/mixed-port` | Static |
| sing-box | `/log/level` | Replace any existing, unambiguous JSON Pointer value with one strict JSON value | Syntax |
| Surge | none | Replace a unique existing key in case-sensitive `/General` | Basic |
| Loon | none | Replace a unique existing key in case-sensitive `/General` | Basic |
| Quantumult X | none | Replace a unique existing key in case-sensitive `/general` | Basic |
| Shadowrocket | none | Replace a unique existing key in case-sensitive `/General` | Basic |

All six targets support raw editing. None currently runs a native validator.
The CONF adapters refuse edits in complex or unconfirmed sections and reject
ambiguous keys, duplicate editable sections, multiline replacements, and
values whose inline-comment boundary cannot be inferred safely. The capability
contract is covered by integration tests so this table cannot silently drift
from schema availability and validation levels.

## Development

The workspace is intentionally free of server/framework dependencies. There is
no declared MSRV yet; local development and CI use the current stable Rust
toolchain. Install stable Rust, then run:

```text
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

See [`docs/architecture.md`](docs/architecture.md) for the product boundary,
revision model, and the planned React/WASM/Axum/SQLite service architecture.
