# ADR-004: Hidden Revisions and Served Revision Pointer

## Decision

Reserve revision rows and project pointers now, without exposing Draft,
Publish, History, Diff, or Rollback UI in V1. Successful V1 validation-and-save
sets both `current_revision_id` and `served_revision_id` to the new revision.

## Consequences

A future Publish workflow only changes pointer advancement. Existing revision
storage, parent links, monotonic revision numbers, hashes, validation results,
and validator versions remain usable without a core migration.

## Scope update (Slice 2)

The original V1 boundary has been narrowed rather than removed: authenticated
administrators may now read revision metadata and explicitly inspect one
immutable revision's original bytes. This is a read-only History view. It does
not expose Draft, Publish, Diff, or Rollback, and it never moves either project
pointer; successful saves still advance `current_revision_id` and
`served_revision_id` together.
