import { useEffect, useId, useRef } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import styles from './Dialog.module.css'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  footer?: ReactNode
  children: ReactNode
}

/**
 * Built on the native `<dialog>` element.
 *
 * That choice buys the focus trap, the inert background, Esc-to-close and the
 * top layer for free — all the parts a hand-rolled modal usually gets wrong,
 * and the reason this app needs no dialog dependency.
 */
export function Dialog({ open, onClose, title, description, footer, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  /** Several dialogs are mounted at once (closed ones still render), so the
   * title id has to be unique per instance. */
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  /** Esc and the form's implicit close both fire `cancel`/`close`. */
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const handleCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    dialog.addEventListener('cancel', handleCancel)
    return () => dialog.removeEventListener('cancel', handleCancel)
  }, [onClose])

  /** The backdrop is part of the dialog box, so a click landing on the element
   * itself (not its content) means "outside". */
  function onBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === ref.current) onClose()
  }

  return (
    <dialog ref={ref} className={styles.dialog} onClick={onBackdropClick} aria-labelledby={titleId}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <h2 className={styles.title} id={titleId}>
            {title}
          </h2>
          {description !== undefined && <p className={styles.description}>{description}</p>}
        </header>
        <div className={styles.body}>{children}</div>
        {footer !== undefined && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </dialog>
  )
}
