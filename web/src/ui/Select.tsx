import type { ReactNode, SelectHTMLAttributes } from 'react'
import { cx } from '../lib/cx'
import { describedBy, Field, fieldStyles } from './Field'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string
  label: ReactNode
  options: readonly SelectOption[]
  hint?: ReactNode
  error?: ReactNode
  aside?: ReactNode
}

export function Select({
  id,
  label,
  options,
  hint,
  error,
  aside,
  className,
  ...rest
}: SelectProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} aside={aside}>
      <span className={fieldStyles.selectWrap}>
        <select
          id={id}
          className={cx(fieldStyles.control, fieldStyles.select, className)}
          aria-invalid={error !== undefined || undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <span className={fieldStyles.caret} aria-hidden="true" />
      </span>
    </Field>
  )
}
