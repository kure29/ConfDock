import type { ValidationResult } from '../core'
import { VALIDATION_LEVEL_CAVEAT, VALIDATION_LEVEL_COPY } from '../lib/copy'
import { Badge } from '../ui/Badge'
import type { BadgeTone } from '../ui/Badge'

/**
 * The validation level, never a check mark.
 *
 * A level says how deep the checking got, not that the document is good. The
 * previous prototype painted `Basic` green with a ✓, which claimed a Surge file
 * had been verified when in truth nothing had parsed it. So: the badge always
 * shows the level's own name, the worst severity present decides the tone, and
 * the tooltip carries the definition plus the caveat.
 */
export function ValidationLevelBadge({ result }: { result: ValidationResult }) {
  const copy = VALIDATION_LEVEL_COPY[result.level]
  const hasError = result.diagnostics.some((d) => d.severity === 'error')
  const hasWarning = result.diagnostics.some((d) => d.severity === 'warning')

  let tone: BadgeTone
  if (hasError) tone = 'bad'
  else if (hasWarning) tone = 'warn'
  else if (copy.depth >= 3) tone = 'accent'
  else if (copy.depth === 2) tone = 'neutral'
  else tone = 'quiet'

  const prefix = hasError ? '✕ ' : hasWarning ? '⚠ ' : ''

  return (
    <Badge tone={tone} title={`${copy.detail}\n${VALIDATION_LEVEL_CAVEAT}`}>
      {prefix}
      {copy.label}
    </Badge>
  )
}
