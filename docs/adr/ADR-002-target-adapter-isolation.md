# ADR-002: Target Adapter Isolation

## Decision

Each client is an independent `ConfigAdapter` with its own descriptor, parser,
capabilities, validators, edit policy, fixtures, and tests. Shared utilities
are deliberately narrow (diagnostics, spans, tokenizer helpers).

## Consequences

Adding Surge behavior does not modify Mihomo parsing. A registry exposes
capabilities to future frontends, avoiding scattered `target === ...` checks.
