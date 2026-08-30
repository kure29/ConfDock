import { cx } from '../lib/cx'
import styles from './Toast.module.css'

export type ToastTone = 'neutral' | 'bad'

export interface ToastMessage {
  id: string
  tone: ToastTone
  text: string
  /** A second line, e.g. an adapter's own English message. */
  detail?: string
}

interface ToastRegionProps {
  toasts: readonly ToastMessage[]
  onDismiss: (id: string) => void
}

/**
 * Bottom-centre live region. Presentational only — `state/ToastContext` owns
 * the queue and the timers.
 *
 * `aria-live="polite"` rather than `assertive`: a save confirmation should not
 * interrupt whatever a screen reader is in the middle of.
 */
export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  return (
    <div className={styles.region} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cx(styles.toast, styles[toast.tone])}>
          <div className={styles.content}>
            <p className={styles.text}>{toast.text}</p>
            {toast.detail !== undefined && <p className={styles.detail}>{toast.detail}</p>}
          </div>
          <button
            type="button"
            className={styles.dismiss}
            onClick={() => onDismiss(toast.id)}
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
