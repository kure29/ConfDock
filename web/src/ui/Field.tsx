import type { ReactNode } from 'react'
import styles from './Field.module.css'

interface FieldProps {
  id: string
  label: ReactNode
  /** Neutral guidance, shown under the control. */
  hint?: ReactNode
  /** Replaces the hint and marks the control invalid. */
  error?: ReactNode
  /** Right-aligned in the label row: a unit, a byte count, a pointer. */
  aside?: ReactNode
  children: ReactNode
}

/**
 * Label + control + one line of guidance.
 *
 * Every form control wraps in this, so the label-to-control relationship, the
 * hint spacing and the error treatment are decided once.
 */
export function Field({ id, label, hint, error, aside, children }: FieldProps) {
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {aside !== undefined && <span className={styles.aside}>{aside}</span>}
      </div>
      {children}
      {error !== undefined ? (
        <p className={styles.error} id={`${id}-error`}>
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p className={styles.hint} id={`${id}-hint`}>
            {hint}
          </p>
        )
      )}
    </div>
  )
}

/** Which element describes the control, matching the ids `Field` renders. */
export function describedBy(
  id: string,
  hint: unknown,
  error: unknown,
): string | undefined {
  if (error !== undefined) return `${id}-error`
  if (hint !== undefined) return `${id}-hint`
  return undefined
}

/** Shared so TextField / TextArea / Select cannot drift apart visually. */
export { styles as fieldStyles }
