import { core } from '../core'
import type { TargetId } from '../core'
import { Badge } from '../ui/Badge'

/**
 * The client's display name, read from the Rust registry rather than from a
 * lookup table in the UI. If another adapter is registered in Rust, this
 * renders it without a React change.
 */
export function TargetBadge({ id }: { id: TargetId }) {
  const descriptor = core.descriptor(id)
  return <Badge tone="quiet">{descriptor?.displayName ?? id}</Badge>
}

/** Plain text version, for meta lines where a badge would be too heavy. */
export function targetName(id: TargetId): string {
  return core.descriptor(id)?.displayName ?? id
}
