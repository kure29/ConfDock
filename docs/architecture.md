# ConfDock architecture (Slice 0.1)

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
read a database or depend on Axum, and the core is kept suitable for a future
WASM build.

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

* **Slice 0.1 (this repository):** hardened core contracts, strict read-only
  YAML/JSON validation, source-preserving patches, truthful capabilities,
  fixtures, validator boundary, and CI.
* **Slice 1:** persistence/revision service and authenticated API; keep the
  served pointer behavior defined above.
* **Slice 2:** WASM bindings and a minimal editor shell that consumes the Target
  Registry (no target conditionals scattered through React).
* **Later:** optional native validators, publish/revision UX, and individually
  scoped adapters or conversion tools.
