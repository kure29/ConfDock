# ConfDock

> A self-hosted manager and stable subscription endpoint for native proxy-client configuration files.

[简体中文](README.md) · [Architecture](docs/architecture.md) · [Web development notes](web/README.md)

ConfDock lets you import, edit, validate, save, publish, and inspect the history of one proxy client's native configuration in a browser. Native bytes remain the source of truth: ConfDock does not run proxy traffic or silently convert and reserialize documents.

## What works today

- Byte-preserving editing keeps BOMs, line endings, comments, ordering, and unknown fields.
- Browser feedback is backed by authoritative Rust validation before persistence.
- Single-administrator authentication, SQLite persistence, immutable revisions, paginated history, and read-only revision diff.
- Save advances `currentRevisionId`; Publish advances `servedRevisionId`. Stable URLs return only the latest served revision, never an unpublished draft.
- Hosted addresses return their plaintext URL only once at creation, support a display name and expiry, and store only a token hash in SQLite.
- Structured editing changes only explicit source spans; unsafe content remains available through the Raw Editor.

## Supported clients

Mihomo, sing-box, Surge, Loon, Quantumult X, and Shadowrocket. Each Target keeps a raw editing path and displays the structured-editing and validation boundary actually implemented. Native Validator integrations are not implemented; Static/Syntax/Basic describe ConfDock's current layers, not official client validators.

## Architecture and data semantics

```text
React / Vite (5173 in development; served by Axum in the binary)
├── confdock-wasm → confdock-core  (instant validation and source-span edits)
└── same-origin /api requests
        ↓
Axum → confdock-core              (authoritative validation and transactions)
        ↓
SQLite / SQLx                     (admin, sessions, projects, revisions, tokens)
```

Native configuration bytes are the only Source of Truth. Revisions are immutable; history, diff, and hosted-address reads do not modify the editor. `expiresAt = null` means never expires. After expiry the server rejects subsequent subscription requests without deleting the Project, revisions, or token. An expired token may be extended or made permanent; a revoked token cannot be restored.

## Single-binary distribution

ConfDock provides a `confdock` binary embedding the React/Vite production assets, Rust WASM, SQLx migrations, and Axum routes. Runtime operation requires no Node.js, npm, Vite, `web/dist`, or external migration/WASM files; SQLite remains persistent data on disk.

Build locally with Node.js 22, stable Rust, and `wasm-bindgen-cli 0.2.127`:

```bash
./scripts/build-single-binary.sh
./scripts/smoke-single-binary.sh target/release/confdock
```

The smoke test starts from a temporary directory without source or `web/dist`, checks `/healthz`, SPA fallback, JS/CSS/WASM/PNG MIME types, HEAD, API/sub boundaries, traversal protection, and SIGTERM shutdown.
Run `workflow_dispatch` manually from GitHub Actions to build and upload the
`confdock-linux-x86_64` artifact (retained for 7 days). Pushes and pull
requests execute the same package, extraction, and smoke checks without
retaining an artifact.
The archive contains `confdock`, a root-level `config.toml`, and `SHA256SUMS`; it
does not contain a database, passwords, or source files.

Runtime configuration follows built-in defaults → `config.toml` → `CONFDOCK_*` environment variables → explicit CLI flags. The packaged archive includes [packaging/config.toml](packaging/config.toml); configuration files never contain passwords or tokens, and relative `data_dir` paths resolve relative to the configuration file.

```bash
./confdock --help
./confdock config check --config ./config.toml
./confdock admin init --config ./config.toml
./confdock --config ./config.toml
```

Starting directly from an interactive terminal prompts to initialize the fixed `admin` user on an empty database and then continues serving. For systemd and other non-interactive environments, run `admin init` first. `CONFDOCK_BOOTSTRAP_PASSWORD` remains available for controlled automation, but must not be written to `config.toml`.

Runtime environment variables (advanced compatibility entry point):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONFDOCK_LISTEN` | `127.0.0.1:8787` | API/Web listen address |
| `CONFDOCK_DATA_DIR` | `/var/lib/confdock` | Absolute data directory; uses `confdock.db` inside it |
| `CONFDOCK_DATABASE_URL` | `sqlite:///var/lib/confdock/confdock.db` | Choose this or `CONFDOCK_DATA_DIR`; existing URL configuration remains supported |
| `CONFDOCK_PUBLIC_URL` | `http://127.0.0.1:8787` | Public origin for stable URLs |
| `CONFDOCK_BOOTSTRAP_PASSWORD` | none | First administrator only |
| `CONFDOCK_COOKIE_SECURE` | `false` | Set `true` behind an HTTPS reverse proxy |
| `CONFDOCK_SESSION_TTL_SECONDS` | `604800` | Session lifetime, at most one year |
| `CONFDOCK_MAX_CONFIG_BYTES` | `8388608` | Decoded configuration limit, up to 64 MiB |
| `RUST_LOG` | `info` | Log filter |

Setting both data-location variables fails explicitly, avoiding an unpredictable current-directory database. Startup creates the data directory, runs migrations, and on Unix restricts the SQLite file and WAL/SHM sidecars as far as the host permits.

## Local development

```bash
npm ci --prefix web
npm run dev --prefix web

CONFDOCK_BOOTSTRAP_PASSWORD='local-development-password' \
CONFDOCK_DATABASE_URL='sqlite://data/confdock-dev.db' \
cargo run -p confdock-service --bin confdock
```

Vite proxies `/api` and `/sub` to the Rust service during development. The production binary serves `/`, assets, `/api/**`, `/sub/**`, and `/healthz` from Axum.

## Linux Deployment

Examples target Linux x86-64 with glibc, with systemd as the current native service-management target: [deploy/systemd/confdock.service](deploy/systemd/confdock.service), [the environment sample](deploy/systemd/confdock.env.example), and [the systemd notes](deploy/systemd/README.md). Debian 13 has been verified on hardware; this does not claim every distribution or ARM64 support. Recommended topology:

```text
Internet → Nginx/Caddy HTTPS → 127.0.0.1:8787 → confdock → SQLite
```

Keep the backend on loopback and do not expose the internal port through the firewall. HTTPS is required for public use; set `CONFDOCK_PUBLIC_URL` to the real origin (or update the same value from the authenticated Settings screen) and `CONFDOCK_COOKIE_SECURE=true`. WebSockets are not required. Use the distribution's generic Nginx/Caddy reverse-proxy configuration. The menu installer, Docker installation, and backup/restore are reserved for later slices. Before upgrades, stop the service and back up SQLite (do not copy only the main file while WAL writes are active), replace `/usr/local/bin/confdock`, and start it again. Migrations run at startup; do not downgrade an older binary and continue writing a database after a newer schema migration. Treat the data directory and hosted URLs as sensitive credentials.

## API overview

Management endpoints require a session; subscriptions use an unguessable stable token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Check service and basic SQLite availability |
| `POST` / `DELETE` | `/api/session` | Sign in / sign out |
| `GET` / `POST` | `/api/projects` | List / create projects |
| `GET` / `PATCH` / `DELETE` | `/api/projects/:id` | Get, rename, or delete |
| `POST` | `/api/projects/:id/revisions` | Validate and Save a revision |
| `POST` | `/api/projects/:id/publish` | Publish a saved draft |
| `GET` | `/api/projects/:id/revisions` | Paginated revision metadata |
| `GET` | `/api/projects/:id/revisions/:revisionId` | Read one revision on demand |
| `GET` / `POST` | `/api/projects/:id/tokens` | List / create hosted addresses |
| `PATCH` / `DELETE` | `/api/projects/:id/tokens/:tokenId` | Update name/expiry / revoke |
| `POST` | `/api/projects/:id/tokens/:tokenId/purge` | Permanently delete a revoked hosted address |
| `GET` / `PATCH` | `/api/settings` | Read / update the public URL |
| `GET` | `/sub/:token` | Return served revision bytes |

Management and subscription responses use conservative `Cache-Control: no-store`; hashed static assets may be cached immutably while `index.html` is revalidated. Invalid, unknown, revoked, and expired tokens receive the same safe public response without reason leakage.

## Limits and security boundaries

- One administrator and one-machine SQLite; no clustering, object storage, or automatic backup service.
- No proxy runtime, client-process management, node measurements, or cross-format conversion.
- No Rollback, token rotation, automatic Publish, revision deletion, or Native Validator.
- No Docker, ARM64, Windows/macOS installer, formal Release, Tag, or automatic Deploy.
- Cargo package metadata declares Apache-2.0; redistributors must also comply with dependency licenses. Client names and icons belong to their respective rights holders and are used only to identify supported Targets; they do not imply certification, partnership, or endorsement by ConfDock.

## Verification

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p confdock-service --features embedded-web --test embedded_web
npm ci --prefix web
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm audit --prefix web
npm audit --prefix web --omit=dev
./scripts/build-single-binary.sh
./scripts/smoke-single-binary.sh target/release/confdock
```

Issues and pull requests are welcome. New adapters should include Rust fixtures, capability-matrix updates, icon-source records, and regression tests while preserving native-byte round trips.
