import { useEffect, useState } from 'react'
import type { EditError, Result, SchemaValueType } from '../core'
import { EDIT_ERROR_COPY, VALUE_TYPE_COPY } from '../lib/copy'
import { TextField } from '../ui/TextField'
import styles from './StructuredFieldRow.module.css'

interface StructuredFieldRowProps {
  /** RFC 6901 pointer, shown as the label because it is the real identity of
   * the field — a prettified name would hide which bytes get replaced. */
  path: string
  valueType: SchemaValueType
  /** The adapter's own description, when the schema provides one. */
  description?: string
  /** Current value, read straight out of the source span. */
  value: string
  /** Runs `core.applyEdit`. Returns the adapter's error unchanged. */
  onCommit: (next: string) => Result<void, EditError>
}

/**
 * One editable value.
 *
 * Committing writes through `core.applyEdit`, which replaces exactly one span in
 * the existing bytes. Nothing is re-serialized, so a commit here cannot reorder
 * keys, drop comments or normalize quotes elsewhere in the file.
 *
 * A rejected commit leaves the draft in the box: the user's typing is theirs,
 * and the error explains what the adapter refused to do.
 */
export function StructuredFieldRow({
  path,
  valueType,
  description,
  value,
  onCommit,
}: StructuredFieldRowProps) {
  const [draft, setDraft] = useState(value)
  const [error, setError] = useState<EditError | null>(null)

  useEffect(() => {
    setDraft(value)
    setError(null)
  }, [value])

  function commit() {
    if (draft === value) {
      setError(null)
      return
    }
    const result = onCommit(draft)
    setError(result.ok ? null : result.error)
  }

  const copy = error === null ? null : EDIT_ERROR_COPY[error.kind]

  return (
    <div className={styles.row}>
      <TextField
        id={`field-${path}`}
        label={<span className={styles.path}>{path}</span>}
        aside={VALUE_TYPE_COPY[valueType]}
        mono
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        hint={description}
        error={
          copy === null ? undefined : (
            <span className={styles.error}>
              <span>
                {copy.title}。{copy.hint}
              </span>
              <span className={styles.detail}>{error?.detail}</span>
            </span>
          )
        }
      />
    </div>
  )
}
