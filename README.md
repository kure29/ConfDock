# ConfDock

ConfDock is a self-hosted manager for native proxy-client configuration files.
The browser edits and checks native bytes through the Rust WASM core; an Axum
service authenticates one administrator, validates every write again with
`confdock-core`, stores immutable revisions in SQLite, and serves stable URLs.

Supported targets are Mihomo, sing-box, Surge, Loon, Quantumult X, and
Shadowrocket. ConfDock does not run proxy traffic, reserialize documents, or
convert one client format into another.

## Architecture

```text
React / Vite :5173
├── confdock-wasm → confdock-core (instant browser checks)
└── same-origin /api requests
       ↓
Axum :8787 → confdock-core (authoritative save check)
       ↓
SQLite / SQLx (admins, sessions, projects, revisions, access tokens)
```

`confdock-core` remains independent of HTTP, Axum, SQLx, and SQLite. The
service uses explicit HTTP DTO mappings instead of adding transport-oriented
serialization to core types.

## Development startup

Install stable Rust, the `wasm32-unknown-unknown` target, wasm-bindgen CLI
0.2.127, and Node.js 22. On the first service start, choose a bootstrap password
of 8–1024 bytes:

```bash
CONFDOCK_BOOTSTRAP_PASSWORD='local-development-password' \
CONFDOCK_DATABASE_URL='sqlite://data/confdock-dev.db' \
cargo run -p confdock-service --bin confdock
```

In another terminal:

```bash
npm ci --prefix web
npm run dev --prefix web
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` and `/sub` to
`http://127.0.0.1:8787`, so the session cookie remains same-origin. Migrations
run automatically, and the database parent directory is created safely when it
does not exist.

The bootstrap password is required only when the database has no administrator.
Later starts never overwrite the stored Argon2id password. Change it through
the Settings screen or `POST /api/admin/password`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONFDOCK_LISTEN` | `127.0.0.1:8787` | API listen address; loopback by default |
| `CONFDOCK_DATABASE_URL` | `sqlite://data/confdock.db` | SQLite database URL |
| `CONFDOCK_PUBLIC_URL` | `http://127.0.0.1:8787` | Stable URL origin/base |
| `CONFDOCK_BOOTSTRAP_PASSWORD` | none | First-run administrator password only |
| `CONFDOCK_SESSION_TTL_SECONDS` | `604800` | Session lifetime (maximum `31536000` seconds) |
| `CONFDOCK_COOKIE_SECURE` | `false` | Add `Secure` to the session cookie |
| `CONFDOCK_MAX_CONFIG_BYTES` | `8388608` | Maximum decoded configuration size (maximum `67108864` bytes) |
| `RUST_LOG` | `info` | Rust log filter |

Copy `.env.example` as a reference, but do not commit a real `.env`, password,
token, or database.

## Persistence and security

- Passwords use Argon2id with a random salt; password plaintext is never stored.
- Session and stable tokens contain 32 CSPRNG bytes. Cookies/creation responses
  receive plaintext, while SQLite stores only SHA-256 hashes.
- The session cookie is `HttpOnly`, `SameSite=Strict`, `Path=/api`, has no
  `Domain`, and is `Secure` when configured for HTTPS.
- Management and subscription responses send `Cache-Control: no-store`; the
  browser HTTP client also opts out of its response cache.
- The SQLite database file and existing `-wal` / `-shm` sidecars are restricted
  to owner-only `0600` permissions on Unix. Symlinked or non-regular database
  files are rejected at startup.
- Session lifetimes are limited to one year and decoded configuration bytes to
  64 MiB to bound request and in-process work.
- Project creation and saves validate native bytes again in `confdock-core`.
- Revisions are immutable BLOB rows with a SHA-256 content hash. A successful
  save advances `current_revision_id` and `served_revision_id` together; the
  authenticated History view can inspect older revisions without changing
  either pointer.
- `expectedRevisionId` is checked inside a write transaction; concurrent saves
  cannot silently overwrite one another.
- `/sub/:token` returns the served BLOB byte-for-byte with no Base64,
  reserialization, or appended newline. Full subscription URIs are not logged.
- Stable token plaintext and its complete URL are returned only once.

SQLite uses foreign keys, WAL, and a busy timeout. To back up the database,
stop writes first or use SQLite's online backup facilities; copying only the
main file while WAL writes are active is unsafe.

When binding beyond loopback, put the service behind HTTPS and set
`CONFDOCK_COOKIE_SECURE=true`; the service does not provide TLS termination or
network-level rate limiting by itself.

## Verification

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

npm ci --prefix web
npm run wasm:build --prefix web
npm run typecheck --prefix web
npm run test --prefix web
npm run build --prefix web
npm audit --prefix web
npm audit --prefix web --omit=dev
```

See [`docs/architecture.md`](docs/architecture.md) and
[`web/README.md`](web/README.md) for service and UI boundary details.

## Not implemented yet

Diff, Publish, Rollback, and Snapshot UI are intentionally deferred. Native
validators, additional adapters, embedded Web assets, Docker, HTTPS automation,
and multi-administrator accounts are also outside this slice.
