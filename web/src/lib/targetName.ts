import { core } from '../core'
import type { TargetId } from '../core'

/** Resolve the user-facing target name from the authoritative Rust registry. */
export function targetName(id: TargetId): string {
  return core.descriptor(id)?.displayName ?? id
}
