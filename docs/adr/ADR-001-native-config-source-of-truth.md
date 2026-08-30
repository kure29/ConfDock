# ADR-001: Native Config as Source of Truth

## Decision

Store and edit the original native configuration bytes. GUI state, schema state,
and compiler state are derived views, never parallel authoritative models.

## Context

Proxy-client formats contain comments, unknown extensions, duplicate keys,
ordering, quoting, and client-specific syntax that a generic model cannot
round-trip safely.

## Consequences

Raw and structured editors share one source. Every structured change must be a
small, span-based patch; unsafe changes return an error and use Raw Editor.
Fields, schemas, and edit requests identify the same locations with RFC 6901
`ConfigPath` values, avoiding ambiguous dotted paths.
