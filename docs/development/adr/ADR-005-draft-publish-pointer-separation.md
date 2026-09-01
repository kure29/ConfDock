# ADR-005: Separate Draft and Publish Revision Pointers

## Status

Accepted in Slice 4.

## Context

ConfDock stores immutable configuration revisions and exposes a stable
subscription URL. Earlier Slice 2/3 behavior advanced `current_revision_id` and
`served_revision_id` together whenever a save succeeded. That made every edit
immediately visible to subscribers and left no safe review step.

## Decision

Projects keep two independent pointers:

- `current_revision_id` is the saved draft used by authenticated management
  Project and List responses.
- `served_revision_id` is the published revision returned by `/sub/:token`.

Save validates bytes and, when they changed, creates one immutable revision and
advances only `current_revision_id`. `has_unpublished_changes` is derived from
pointer inequality; no extra database flag is stored.

`POST /api/projects/:id/publish` runs in a `BEGIN IMMEDIATE` transaction. The
request supplies both expected pointer IDs. A stale current pointer returns
`revision.conflict`; a stale served pointer while a draft is pending returns
`publish.conflict`. A successful publish updates only `served_revision_id` and
does not create revisions, mutate BLOBs, change hashes or parents, or rotate
tokens. If both pointers already match, Publish is idempotent and returns
`unchanged: true`.

## Consequences

The editor presents Save as “检查并保存草稿” and exposes Publish only when a
saved draft is pending. Publish is disabled while local edits are dirty. Stable
URLs continue returning the old served bytes until Publish succeeds. Revision
history and Diff remain read-only and show the two pointer markers independently.

ADR-004's statement that Save advances both pointers together is superseded by
this decision; ADR-004 remains as historical context for the coupled-pointer
implementation.

Rollback, token repointing, and native validators remain future work.
