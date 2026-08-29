# ADR-004: Hidden Revisions and Served Revision Pointer

## Decision

Reserve revision rows and project pointers now, without exposing Draft,
Publish, History, Diff, or Rollback UI in V1. Successful V1 validation-and-save
sets both `current_revision_id` and `served_revision_id` to the new revision.

## Consequences

A future Publish workflow only changes pointer advancement. Existing revision
storage, parent links, monotonic revision numbers, hashes, validation results,
and validator versions remain usable without a core migration.
