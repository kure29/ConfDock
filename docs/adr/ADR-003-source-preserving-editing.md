# ADR-003: Source-Preserving Editing

## Decision

Retain source bytes and byte spans, and apply local replacements. Do not parse
to a universal AST and serialize the complete file.

## Spike result

The Slice 0 YAML fixture includes comments, blank lines, ordering, quote styles,
block scalar, anchor/alias/merge key, unknown content, Unicode, and a trailing
newline. A conservative scanner patches only `mixed-port: 7890` to `7893`.
We evaluated `serde_yaml` and `yaml-rust2`; their semantic parse/serialize
interfaces do not retain all comments and presentation details, so they cannot
provide this guarantee without a separate concrete-syntax layer. The project
therefore records Source Spans and uses local patches, leaving complex YAML to
Raw Editor until a concrete-syntax implementation is validated.

The JSON scanner applies the same strategy to nested values and validates a
replacement literal without changing indentation or key order.
