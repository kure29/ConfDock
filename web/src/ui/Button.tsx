import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './Button.module.css'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  /** Replaces the label with a spinner and disables interaction. */
  loading?: boolean
  children: ReactNode
}

export function Button({
  variant = 'secondary',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(styles.button, styles[variant], className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : children}
    </button>
  )
}
