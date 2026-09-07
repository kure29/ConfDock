# ConfDock

> Manage native configuration, publish a stable subscription endpoint.

[简体中文](README.md) · [Documentation](https://kure29.github.io/ConfDock/) · [Architecture](docs/development/architecture.md) · [Backup and restore](docs/operations/backup-and-restore.md) · [Web development notes](web/README.md)

ConfDock is a self-hosted configuration manager for native proxy-client files. Import, edit, validate, save, and publish one client document in a browser, then create a stable subscription URL for the published revision. Native bytes remain the source of truth: ConfDock does not run proxy traffic, measure nodes, manage client processes, or convert between formats.

## What works today

- Byte-preserving edits keep BOMs, line endings, comments, ordering, and unknown fields. Structured edits are local Source Span patches.
- Immutable Revisions provide history metadata, read-only details, and bounded diffs.
- Save advances only `currentRevisionId`; Publish advances `servedRevisionId`. Stable URLs never expose an unpublished draft.
- Single-administrator SQLite persistence and high-entropy Hosted Address tokens. Plaintext is returned once at creation; SQLite stores only a hash.

## Supported clients

Mihomo, sing-box, Surge, Loon, Quantumult X, and Shadowrocket. Current validation levels are Basic, Syntax, and Static; Native Validator integration is not implemented. Every Target displays ConfDock's complete plain-text name. No third-party logos, images, emoji, abbreviated badges, or CSS client marks are shipped.

## Data semantics

A Project maps to one Target and one Native Config. Revisions store the original SQLite BLOB; history, diff, and Hosted Address reads never mutate the editor.

- `currentRevisionId` is the saved draft shown in management; `servedRevisionId` is what a Stable URL returns.
- Save creates a new Current Revision; Publish only moves Served Revision and never auto-publishes or rotates a token.
- `expires_at = null` means a Hosted Address never expires; a revoked address cannot be restored, but may be purged after confirmation.

## Quick start

ConfDock 1.0.0 uses a SHA-256-verified Docker Quick Start Bundle and defaults to
`ghcr.io/kure29/confdock:1.0.0`, so users do not compile source on the server.
This Release Readiness change does not itself create a tag, Release, or GHCR
image. After the first manual release, an administrator must still set the
GitHub Package visibility to Public before anonymous pulls work.

Only Linux x86-64 is supported. Start with the
[Docker five-minute guide](docs/deployment/docker-quick-start.md), then read the
[complete Docker operations guide](docs/deployment/docker.md). The
[single-binary deployment](docs/deployment/binary.md) remains supported.

## Status and boundaries

- Production is an independent Rust single binary embedding React/Vite assets, WASM, SQLx migrations, and Axum routes. Node.js and the docs site are not runtime dependencies.
- V1 distribution infrastructure targets Linux x86-64 only. A manually approved workflow builds the binary, Docker Bundle, GHCR amd64 image, SBOM, and checksums; ordinary PRs only run a read-only release dry-run. ARM64 is not claimed as verified.
- Stable URLs return only the Served Revision; Save never auto-publishes. The public origin is persisted in `instance_settings.id=1` and does not change the listener.
- Back up only after stopping the service, including the complete data directory, SQLite WAL/SHM sidecars, and the actual configuration directory.

The public origin is persisted in the database singleton; editing `config.toml` does not replace an initialized value. Update it from the authenticated Settings screen.

## Documentation and development

The complete, user-oriented documentation lives in the [VitePress site](https://kure29.github.io/ConfDock/) and remains readable from the repository:

- [Getting started and core concepts](docs/guide/getting-started.md)
- [Binary, configuration, systemd, and reverse proxy](docs/deployment/binary.md)
- [Docker deployment, backup, upgrade, and troubleshooting](docs/deployment/docker.md)
- [Backup, restore, upgrade, and troubleshooting](docs/operations/backup-and-restore.md)
- [CLI, API, and security boundaries](docs/reference/cli.md)
- [Architecture, ADRs, and local development](docs/development/architecture.md)

The Web-specific engineering notes remain in [`web/README.md`](web/README.md). Common checks:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm run docs:build --prefix docs
```

ConfDock is licensed under [Apache License 2.0](LICENSE). Distributions include
the generated [third-party notices](THIRD_PARTY_NOTICES.md); development-scope
notes remain in [THIRD_PARTY_LICENSE_INVENTORY.md](THIRD_PARTY_LICENSE_INVENTORY.md).
The full documentation is currently maintained in Simplified Chinese.
