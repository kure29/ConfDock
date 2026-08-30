import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { cx } from '../lib/cx'
import { describedBy, Field, fieldStyles } from './Field'

interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  aside?: ReactNode
  mono?: boolean
}

/** For pasted config text and JSON literals. The full source editor is a
 * separate component — it needs a gutter and scroll sync. */
export function TextArea({
  id,
  label,
  hint,
  error,
  aside,
  mono = true,
  className,
  ...rest
}: TextAreaProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} aside={aside}>
      <textarea
        id={id}
        spellCheck={false}
        className={cx(
          fieldStyles.control,
          fieldStyles.textarea,
          mono && fieldStyles.mono,
          className,
        )}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Field>
  )
}
