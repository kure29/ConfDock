# ADR-003: Source-Preserving Editing

## Decision

Retain source bytes and byte spans, and apply local replacements. Do not parse
to a universal AST and serialize the complete file.

## Spike result

The Slice 0.1 YAML fixture includes comments, blank lines, ordering, quote
styles, block scalar, anchor/alias/merge key, unknown duplicate keys, Unicode,
and a trailing newline. A conservative scanner patches only
`mixed-port: 7890` to `7893`.
`yaml-rust2` now performs strict, read-only YAML syntax and root/type checks.
Its serializer is deliberately not used: semantic parse/serialize interfaces
do not retain all comments and presentation details, so they cannot provide
this guarantee without a separate concrete-syntax layer. The project records
Source Spans with a conservative scanner and uses local patches, leaving
complex YAML to Raw Editor until a concrete-syntax implementation is
validated.

For JSON, `serde_json` is the strict syntax authority and validates replacement
literals. The custom scanner is responsible only for locating nested value
spans. Both use RFC 6901 JSON Pointers; duplicate paths are refused as
ambiguous. This division keeps indentation, key order, and unknown content
unchanged without trusting a hand-written scanner to accept the language.

For CONF targets, the shared tokenizer only exposes safe spans inside the
exact General/general section declared by each adapter. Other sections are
opaque. Duplicate sections or keys and uncertain inline-comment boundaries
are refused rather than guessed.
