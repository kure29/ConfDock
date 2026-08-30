import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  /** One sentence stating what is not here. No illustrations, no exclamation. */
  title: ReactNode
  /** Why it is empty, or what the constraint is. This is where honest
   * capability limits get explained rather than hidden. */
  body?: ReactNode
  action?: ReactNode
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      <p className={styles.title}>{title}</p>
      {body !== undefined && <div className={styles.body}>{body}</div>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  )
}
