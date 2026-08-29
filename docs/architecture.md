# ConfDock architecture (Slice 0)

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
static validation, structured edit policy, fixtures, and tests. Shared code is
limited to diagnostics, span patching, a conservative line tokenizer, and a
JSON scanner. Unknown fields/sections remain opaque and are never discarded.

`detect` is advisory only; a user-selected Target always wins. Adapters do not
read a database or depend on Axum, and the core is kept suitable for a future
WASM build.

Slice 0 capability matrix:

| Target | Raw | Schema | Structured edit | Level | Native validator |
| --- | --- | --- | --- | --- | --- |
| Mihomo | yes | yes | `mixed-port` safe patch | Static | no |
| sing-box | yes | yes | nested JSON literal patch | Static | no |
| Surge | yes | yes | conservative `key = value` | Static | no |
| Loon | yes | no | conservative `key = value` | Static | no |
| Quantumult X | yes | no | conservative `key = value` | Static | no |
| Shadowrocket | yes | no | conservative `key = value` | Static | no |

Complex or unconfirmed syntax is intentionally left as opaque text and can be
edited through Raw Editor.

## Source-preserving editing

The parser records byte `SourceSpan`s for fields. A structured edit validates
the requested value, then replaces only that span. No adapter pretty-prints or
re-serializes a whole file. If a field is missing, duplicated, ambiguous, or
the syntax is not safely understood, the adapter returns an explicit
`EditError` and the caller should use Raw Editor.

The Mihomo YAML spike intentionally uses a conservative span scanner rather
than a parse/serialize library. We evaluated the Rust `serde_yaml` and
`yaml-rust2` approaches: both are useful semantic parsers, but their normal
serialization APIs do not expose the complete comment/trivia and presentation
tree needed for a byte-preserving rewrite. They therefore cannot be the
source-preserving editor here. The scanner can safely
patch a simple top-level scalar (`mixed-port`) while preserving all other
bytes. Complex YAML remains available through Raw Editor.

sing-box uses a small JSON scanner to locate nested value spans and validates a
replacement as one JSON literal. It never pretty-prints, so indentation, key
order, unknown fields, and surrounding whitespace remain unchanged.

Surge, Loon, Quantumult X, and Shadowrocket use independent adapters over a
line-preserving tokenizer. Their syntax is not treated as one generic INI
format; only conservative `key = value` edits are enabled. Unconfirmed or
complex rule/script semantics remain opaque.

## Validation levels

Validation is layered: parse, then target-specific schema/static checks, then
an optional native validator. The public `ValidationLevel` values are
`ParseOnly`, `Static`, and `Native`. Slice 0 reports `Static` for adapters that
perform conservative syntax checks and never claims native validation for the
six built-in clients.

The `confdock-validator` crate defines a native-validator process boundary for
future Mihomo support. A process implementation must pin the binary/version,
use a temporary directory, enforce a timeout and resource limits, run as a
non-root user, bound stdout/stderr, map output to diagnostics, and never log
full source bytes. Slice 0 does not download or execute Mihomo.

## Future service architecture

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

The core remains independent of the server. A future database should include:

* `admins`
* `sessions`
* `projects`
* `config_revisions`
* `access_tokens`

`projects` reserves `current_revision_id` and `served_revision_id`.
`config_revisions` reserves `parent_revision_id`, `revision_no`,
`source_bytes`, `content_hash`, `validation_level`, `validation_result`, and
`validator_version`. In V1, successful “validate and save” advances both
project pointers to the new revision. A later Publish workflow can advance
only `served_revision_id` without changing the data model.

Stable URLs use high-entropy random tokens. Only a hash of an access token is
stored in the database. Proxy passwords, UUIDs, and subscription URLs are
sensitive: never put full configs or tokens in ordinary logs or error
messages. Management APIs require single-admin authentication.

## Slice plan

* **Slice 0 (this repository):** core types, adapters, source-preserving patch
  spike, fixtures, validator boundary, and architecture decisions.
* **Slice 1:** persistence/revision service and authenticated API; keep the
  served pointer behavior defined above.
* **Slice 2:** WASM bindings and a minimal editor shell that consumes the Target
  Registry (no target conditionals scattered through React).
* **Later:** optional native validators, publish/revision UX, and individually
  scoped adapters or conversion tools.
