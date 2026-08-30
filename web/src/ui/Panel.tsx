import type { ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './Panel.module.css'

interface PanelProps {
  title?: ReactNode
  /** One line under the title. Keep it to a fact, not a sales pitch. */
  description?: ReactNode
  /** Right side of the header. */
  actions?: ReactNode
  footer?: ReactNode
  /** Removes the body padding, for lists and editors that draw their own rows. */
  flush?: boolean
  className?: string
  children?: ReactNode
}

/** The only container in the system: 1px border, one radius, no shadow. */
export function Panel({
  title,
  description,
  actions,
  footer,
  flush = false,
  className,
  children,
}: PanelProps) {
  const hasHeader = title !== undefined || description !== undefined || actions !== undefined
  return (
    <section className={cx(styles.panel, className)}>
      {hasHeader && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title !== undefined && <h2 className={styles.title}>{title}</h2>}
            {description !== undefined && (
              <p className={styles.description}>{description}</p>
            )}
          </div>
          {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {children !== undefined && (
        <div className={cx(styles.body, flush && styles.flush)}>{children}</div>
      )}
      {footer !== undefined && <footer className={styles.footer}>{footer}</footer>}
    </section>
  )
}
