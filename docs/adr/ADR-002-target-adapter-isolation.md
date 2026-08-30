# ADR-002: Target Adapter Isolation

## Decision

Each client is an independent `ConfigAdapter` with its own descriptor, parser,
capabilities, validators, edit policy, fixtures, and tests. Shared utilities
are deliberately narrow (diagnostics, spans, tokenizer helpers).

Schema support is derived from `ConfigAdapter::schema()`, not a duplicated
boolean. Structured-edit support is reported as explicit path/section scope,
replacement operations, value types, and safety notes. Raw editing does not
imply broad structured editing.

## Consequences

Adding Surge behavior does not modify Mihomo parsing. A registry exposes
capabilities to future frontends, avoiding scattered `target === ...` checks.
Duplicate target IDs are rejected during registration rather than resolved by
registration order.
