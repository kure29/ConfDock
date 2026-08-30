# ADR-004: Hidden Revisions and Served Revision Pointer

## Decision

Reserve revision rows and project pointers now. Successful V1
validation-and-save sets both `current_revision_id` and `served_revision_id`
to the new revision. The initial V1 boundary did not expose Draft, Publish,
History, Diff, or Rollback controls; the read-only History and Diff scope
updates below do not change the pointer semantics.

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

## Scope update (Slice 3)

Authenticated administrators may request a bounded, read-only line Diff from
one revision to another revision in the same project. The UI currently offers
the selected revision → parent comparison only. Diff reads never create,
modify, delete, or repoint revisions, and successful saves continue to advance
`current_revision_id` and `served_revision_id` together. Draft, Publish,
Rollback, and native validator workflows remain outside this scope.
