import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './Badge.module.css'

export type BadgeTone = 'quiet' | 'neutral' | 'accent' | 'warn' | 'bad'

interface BadgeProps {
  tone?: BadgeTone
  /** Diagnostic codes and pointers read better in the mono face. */
  mono?: boolean
  title?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', mono = false, title, children }: BadgeProps) {
  return (
    <span className={cx(styles.badge, styles[tone], mono && styles.mono)} title={title}>
      {children}
    </span>
  )
}
