# ConfDock architecture (Slice 4)

## Product boundary

ConfDock is a self-hosted configuration management and stable-URL serving
platform. It imports, edits, validates, saves, and serves a client's **native
configuration**. It does not run proxy traffic, manage Mihomo runtime state,
measure nodes, or act as a Sub-Store replacement.

A Project owns exactly one target client and one native document (for example,
`家庭网络 → Mihomo → config.yaml`). V1 does not compile one universal model into
multiple client formats. Cross-client conversion, if ever added, is a separate
feature with separate safety guarantees.

## Single source of truth

The native source bytes are the only source of truth. Raw editing, structured
editing, and a future schema editor are views over the same bytes. We do not
persist a parallel GUI state, compiler state, or universal intent IR.

`NativeDocument` records the original bytes, encoding, line-ending style, and
trailing-newline state. A document that was not changed must round-trip
byte-for-byte.

## Target Adapter isolation

`ConfigAdapter` is the seam between the core and each client. The built-in
registry currently exposes Mihomo, sing-box, Surge, Loon, Quantumult X, and
Shadowrocket. Every adapter owns its descriptor, parser, detection hint,
validation, structured edit policy, fixtures, and tests. Shared code is limited
to diagnostics, RFC 6901 paths, span patching, a conservative line tokenizer,
and a JSON source-span scanner. Unknown fields/sections remain opaque and are
never discarded.

`detect` is advisory only; a user-selected Target always wins. Adapters do not
read a database or depend on Axum. The `confdock-wasm` crate now exposes this
registry to the React shell through hand-written DTOs; the core itself remains
free of `wasm-bindgen`, browser, and transport dependencies.

Slice 0.1 capability matrix:

| Target | Raw | Schema exposed by adapter | Structured edit scope | Level | Native validator |
| --- | --- | --- | --- | --- | --- |
| Mihomo | yes | `/mixed-port`: integer 1–65535 | Replace existing, unambiguous `/mixed-port` decimal scalar | Static | no |
| sing-box | yes | `/log/level`: string | Replace any existing, unambiguous JSON Pointer value with one strict JSON value | Syntax | no |
| Surge | yes | none | Unique existing key in case-sensitive `/General` only | Basic | no |
| Loon | yes | none | Unique existing key in case-sensitive `/General` only | Basic | no |
| Quantumult X | yes | none | Unique existing key in case-sensitive `/general` only | Basic | no |
| Shadowrocket | yes | none | Unique existing key in case-sensitive `/General` only | Basic | no |

Complex or unconfirmed syntax is intentionally left as opaque text and can be
edited through Raw Editor. `ConfigAdapter::schema()` is the schema capability:
there is no separately maintained schema boolean. Likewise,
`structured_edit_capabilities()` reports scope, operations, value types, and
safety constraints instead of claiming blanket structured-edit support. The
integration test `capability_contracts_match_real_schema_and_validation`
constrains the matrix's schema and validation claims against the registry.

## Source-preserving editing

The parser records byte `SourceSpan`s for fields. A structured edit validates
the requested value, then replaces only that span. No adapter pretty-prints or
re-serializes a whole file. If a field is missing, duplicated, ambiguous, or
the syntax is not safely understood, the adapter returns an explicit
`EditError` and the caller should use Raw Editor.

Mihomo uses `yaml-rust2` as a strict, read-only parser for YAML syntax, a
single-mapping root requirement, and static `mixed-port` type/range checks. It
does not use the library's serializer. A separate conservative source scanner
locates only a simple top-level decimal `/mixed-port` span and preserves its
line-ending comment, block scalars, anchors, aliases, formatting, and every
other byte. Duplicate or unsafe spans are refused. Complex YAML remains
available through Raw Editor.

sing-box uses `serde_json` for strict syntax and object-root validation. A
separate scanner only locates source spans; it is not the syntax authority.
Paths are RFC 6901 JSON Pointers, so `/`, `~`, dots, escaped keys, and array
indexes are unambiguous. A replacement must itself be exactly one strict JSON
value. Duplicate paths are ambiguous and refused. The adapter never
pretty-prints, so indentation, key order, unknown fields, and surrounding
whitespace remain unchanged.

Surge, Loon, Quantumult X, and Shadowrocket use independent adapters over a
line-preserving tokenizer. The shared code recognizes lines and only collects
safe key/value spans from sections explicitly allowed by each adapter. In Slice
0.1 that means case-sensitive `General` for Surge, Loon, and Shadowrocket, and
case-sensitive `general` for Quantumult X. Rule, Script, Rewrite, Proxy, and
all unconfirmed sections remain opaque even when a line contains `=`.
Duplicate editable sections or keys, uncertain inline-comment boundaries,
empty or multiline replacements, and absent fields are refused.

## Validation levels

Validation is layered. The public `ValidationLevel` values are:

* `Basic`: encoding and only conservative structure/heuristic checks;
* `Syntax`: a real format parser accepted the document and required root;
* `Static`: target-specific schema or semantic checks also ran;
* `Native`: a pinned client-native validator actually ran.

Mihomo reports `Static` after YAML and `mixed-port` checks; sing-box reports
`Syntax`; the four CONF targets report `Basic`. A failure reports the deepest
layer that was actually reached, so an encoding failure can remain `Basic` and
a YAML/JSON parser failure can remain `Syntax`.

The `confdock-validator` crate defines a native-validator process boundary for
future Mihomo support. A process implementation must pin the binary/version,
use a temporary directory, enforce a timeout and resource limits, run as a
non-root user, bound stdout/stderr, map output to diagnostics, and never log
full source bytes. `NativeValidationResult` has one diagnostic collection,
`result.diagnostics`, plus an explicit `Completed` or `Unavailable` status.
Unavailable execution adds `native.unavailable`, retains the non-native level,
and has no validator version; only completed execution raises the level to
`Native` and records a version. Slice 0.1 does not download or execute Mihomo.

## Registry integrity

`TargetRegistry::register()` returns a result and rejects duplicate `TargetId`
values. Tests cover both duplicate registration and uniqueness of the built-in
registry.

## WASM boundary

`crates/confdock-wasm` owns the browser boundary. `WasmConfigCore` holds one
`TargetRegistry::builtin()` and exposes target descriptors, schemas, detection,
validation, parsing, structured edits, and document metadata. Inputs and patch
outputs cross the boundary as byte arrays; `serde-wasm-bindgen` serializes only
stable DTOs that mirror the TypeScript wire shapes. Mapping is explicit and
exhaustive, so Rust Core types do not need browser-oriented serde derives.

The web app initializes this module before rendering React. A load or decode
failure shows a startup error and never falls back to a second TypeScript
parser. The Web API seam uses `createHttpApi()`; no localStorage-backed API or
duplicate configuration parser remains. `npm run wasm:build
--prefix web` uses the pinned `wasm-bindgen-cli` version and writes generated
glue under `web/src/core/wasm-generated/` (ignored except for its declaration
file). CI generates these artifacts before typecheck, tests, and Vite build.

## Service architecture

```text
React + TypeScript + Vite
        ↓
Rust WASM Config Core
        ↓
Rust Axum API
        ↓
SQLite + SQLx
        ↓
Revision Storage / Stable URL
```

`crates/confdock-service` is the Axum/SQLx boundary and produces the `confdock`
binary. It directly calls `confdock-core` for every project creation and save;
it never calls the WASM crate and never reimplements a YAML, JSON, or CONF
parser. Browser validation is immediate feedback only, while server validation
is authoritative for persistence.

HTTP DTOs are defined inside the service and map core diagnostics explicitly.
Core types do not gain transport-oriented serde derives. Configuration bytes
cross the management JSON boundary as standard Base64 and are stored as SQLite
BLOBs. The public subscription endpoint is the only route that returns raw
configuration bytes.

SQLite migrations run automatically at startup and create:

* `admins`: exactly one Argon2id password hash;
* `sessions`: random-token SHA-256 hashes and expiry/last-seen timestamps;
* `projects`: target, display metadata, validation snapshot, and two revision
  pointers;
* `config_revisions`: immutable native BLOBs, SHA-256 content hashes,
  validation snapshots, parent IDs, and project-local revision numbers;
* `access_tokens`: random-token SHA-256 hashes, display-only prefix/suffix,
  usage timestamps, and revocation state.
* `instance_settings`: the singleton public URL used to build hosted address
  links and reported by the service-info endpoint.

Foreign keys, WAL, and a busy timeout are enabled on every SQLite connection.
On Unix, the database file and existing WAL/SHM sidecars are kept as regular,
non-symlink files with owner-only `0600` permissions. Startup rejects an unsafe
existing database path. Service configuration caps session lifetime at one year
and decoded configuration bytes at 64 MiB.
Deleting a project cascades to its revisions and access tokens. Revision rows
cannot be updated. To back up a live database, stop writes or use SQLite's
online backup facilities instead of copying only the main file while WAL is
active.

The authenticated `/api/settings` endpoint reads and updates the singleton
public URL. It accepts only an `http://` or `https://` origin (host plus an
optional port, with no credentials, path, query, or fragment). The listener
continues to bind to its configured local address; this setting only controls
the origin embedded in newly created hosted links and returned by
`/api/service`.

### Project and revision transaction

Project creation validates all inputs and bytes before opening a write
transaction, then inserts the project, Revision No. 1, and both valid pointers
atomically. Validation failure writes nothing.

A save validates bytes first, then enters `BEGIN IMMEDIATE`, re-reads
`current_revision_id`, and compares it with `expectedRevisionId`. A mismatch is
HTTP 409 and changes nothing. Identical bytes update only the validation
snapshot and return `unchanged: true`. New bytes create the next immutable
revision, point its parent at the former current revision, and advance current
and advances current only; served remains on the last published revision. This
locking order means two writers with the same expected revision cannot both
succeed. Publish is a separate transaction described below.

### Read-only revision history

Slice 2 exposes immutable revision metadata through the authenticated
`GET /api/projects/:id/revisions` endpoint, newest first. The endpoint returns a
bounded page (`50` by default, `100` maximum) with `items` and an optional
`nextCursor`; the cursor is the ID of the last item and is scoped to the same
project. Each item contains the revision number, parent ID, creation time,
exact-byte length and SHA-256, validation snapshot, validator version, and
explicit `isCurrent`/`isServed` flags. Source BLOBs are deliberately omitted so
a history refresh does not copy every configuration into memory or across the
wire. The detail endpoint `GET /api/projects/:id/revisions/:revisionId` returns
one selected revision's original bytes as Base64 plus the same metadata. Both
operations are read-only: selecting or inspecting history never changes
pointers, creates a revision, or publishes anything. The UI now offers a
read-only comparison from the selected revision to its parent; Rollback remains
unavailable, while Publish is exposed only by the editor for a saved draft.

### Read-only revision diff

Slice 3 adds the authenticated `GET
/api/projects/:id/revisions/diff?fromRevisionId=…&toRevisionId=…` endpoint.
The two IDs must belong to the same project. A missing or cross-project
revision is always `404 revision.not_found`, and the explicit static `diff`
route is registered before the revision-detail route. Both immutable rows are
read in one read-only SQLite transaction. The transaction is committed before
the CPU-heavy line diff runs in a controlled Tokio blocking task, so a SQLite
connection is never held by the diff algorithm.

The service uses the `similar` Myers algorithm over records containing the
original line text and its actual terminator. It does not normalize bytes,
line endings, or configuration syntax. LF and CRLF therefore remain
observable, as do mixed endings, an unterminated final line, empty files,
Unicode, and UTF-8 BOM presence. Diff metadata includes the exact byte length,
SHA-256, BOM, line-ending style, trailing-newline state, and both live pointer
flags. The source BLOB is never Base64-encoded into the diff response.

Diff resource limits are deliberately below the 64 MiB configuration limit:
the two inputs together may use at most 8 MiB and 200,000 logical lines, and
the returned hunks may contain at most 10,000 rows. Exceeding a limit returns
`413 revision.diff_too_large`; the service never silently truncates a result.
Comparing the same revision or the same content hash returns an empty,
`identical` result without running Myers.

### Administrator and session security

On the first start only, `CONFDOCK_BOOTSTRAP_PASSWORD` is mandatory and must be
8–1024 bytes. It is never trimmed. The password is stored as an Argon2id PHC
string using a random salt, 19 MiB memory, two iterations, and one lane. Later
starts never overwrite the database password from the environment. A password
change keeps the current session and revokes every other session.

Session plaintext is a URL-safe, unpadded encoding of 32 CSPRNG bytes; only its
SHA-256 hash is stored. The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/api`,
has no `Domain`, and gains `Secure` when `CONFDOCK_COOKIE_SECURE=true`. Expired
sessions are unusable and cleaned at startup or authentication time. Failed
logins receive the same `auth.invalid_password` response and increasing short
backoff. At most two Argon2 operations run concurrently per service process.

Management and subscription responses carry `Cache-Control: no-store`,
including authentication and error responses, so credentials and configuration
metadata are not retained by browser or intermediary caches. Deployments that
listen beyond loopback still require HTTPS and `CONFDOCK_COOKIE_SECURE=true`;
TLS termination, IP rate limiting, and request filtering remain the proxy's
responsibility.

### Stable URL security

Stable URLs use high-entropy random tokens. Only a hash of an access token is
stored in the database; prefix and suffix exist only for UI identification.
Plaintext and the full URL appear once in the creation response. Revoked,
unknown, malformed, or project-deleted tokens all return the same 404.

`GET /sub/:token` hashes the token, reads `served_revision_id`, and returns the
original BLOB byte-for-byte with `application/octet-stream`, `no-store`, and
`nosniff`. It never decodes Base64, reserializes, or appends a newline. The file
name is header-sanitized. No request layer logs the complete `/sub/:token` URI,
token prefix/suffix/hash, configuration contents, password, or session token.
Internal errors expose only a safe request ID.

### Draft and Publish pointers

Each project keeps two immutable revision pointers. `current_revision_id` is the
saved draft shown by authenticated management Project/List reads; `served_revision_id`
is the revision returned by stable subscription URLs. A successful Save creates a
revision only when bytes change, advances `current_revision_id`, and leaves
`served_revision_id` untouched. Responses expose `has_unpublished_changes` when
the pointers differ.

`POST /api/projects/:id/publish` accepts both expected pointer IDs. Inside a
`BEGIN IMMEDIATE` transaction it rejects a stale current pointer with
`revision.conflict`, and a stale served pointer with `publish.conflict` while a
draft is pending. Publishing only updates `served_revision_id`; it does not
create a revision, rewrite BLOBs, or rotate tokens. Repeating Publish after the
pointers already match is an idempotent success with `unchanged: true`.

## Slice plan

* **Slice 0.1:** hardened core contracts, strict read-only
  YAML/JSON validation, source-preserving patches, truthful capabilities,
  fixtures, validator boundary, and CI.
* **WASM web boundary:** `confdock-wasm` and the React shell consume
  the Rust registry and preserve native bytes; no duplicate parser or registry
  exists in TypeScript.
* **Slice 1:** single-admin Axum service, SQLite persistence,
  immutable revisions, concurrency protection, stable URLs, and the real Web
  HTTP seam.
* **Slice 2:** read-only revision history metadata/detail API and editor
  inspection UI, while current and served pointers remain coupled.
* **Slice 3:** bounded, read-only parent revision Diff in the Rust Service and
  the history detail view. The UI compares only the selected revision with its
  parent; `current_revision_id` and `served_revision_id` remain coupled.
* **Slice 4:** Draft/Publish pointer separation. Management Project reads current
  bytes, `has_unpublished_changes` reports pointer divergence, and Publish moves
  only `served_revision_id` transactionally with optimistic pointer checks.
* **Later:** Rollback, optional native validators, embedded Web assets,
  Docker, and individually scoped adapters or conversion tools.
