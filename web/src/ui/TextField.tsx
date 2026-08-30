import type { InputHTMLAttributes, ReactNode } from 'react'
import { cx } from '../lib/cx'
import { describedBy, Field, fieldStyles } from './Field'

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  aside?: ReactNode
  /** Config values, ports and pointers are code — render them in the mono face. */
  mono?: boolean
}

export function TextField({
  id,
  label,
  hint,
  error,
  aside,
  mono = false,
  className,
  ...rest
}: TextFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} aside={aside}>
      <input
        id={id}
        className={cx(fieldStyles.control, mono && fieldStyles.mono, className)}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...rest}
      />
    </Field>
  )
}
