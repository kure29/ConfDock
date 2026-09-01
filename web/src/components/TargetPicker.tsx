import { core } from '../core'
import type { DetectionResult, TargetId } from '../core'
import { CONFIDENCE_COPY, DETECTION_NOTICE } from '../lib/copy'
import { cx } from '../lib/cx'
import { Badge } from '../ui/Badge'
import styles from './TargetPicker.module.css'

interface TargetPickerProps {
  value: TargetId | null
  onChange: (id: TargetId) => void
  /** Advisory hints from `core.detect`. Never used to change `value`. */
  detections?: readonly DetectionResult[]
}

/**
 * Every target returned by the Rust registry, in registry order.
 *
 * Detection is shown as a hint and nothing more: `docs/development/architecture.md` is
 * explicit that `detect` is advisory and a user-selected target always wins, so
 * this component never auto-selects and never disables a row.
 */
export function TargetPicker({ value, onChange, detections = [] }: TargetPickerProps) {
  const byTarget = new Map(detections.map((result) => [result.target, result]))

  return (
    <div className={styles.picker}>
      <ul className={styles.list} role="radiogroup" aria-label="客户端">
        {core.targets().map((descriptor) => {
          const detection = byTarget.get(descriptor.id)
          const selected = value === descriptor.id
          return (
            <li key={descriptor.id}>
              <label className={cx(styles.row, selected && styles.selected)}>
                <input
                  type="radio"
                  name="target"
                  className={styles.radio}
                  value={descriptor.id}
                  checked={selected}
                  onChange={() => onChange(descriptor.id)}
                />
                <span className={styles.text}>
                  <span className={styles.name}>{descriptor.displayName}</span>
                  {detection !== undefined && detection.confidence !== 'none' && (
                    <span className={styles.compatibility}>检测到此格式</span>
                  )}
                </span>
                {detection !== undefined && detection.confidence !== 'none' && (
                  <Badge tone={detection.confidence === 'likely' ? 'accent' : 'neutral'}>
                    检测到 · {CONFIDENCE_COPY[detection.confidence]}
                  </Badge>
                )}
              </label>
            </li>
          )
        })}
      </ul>
      <p className={styles.notice}>{DETECTION_NOTICE}</p>
    </div>
  )
}
