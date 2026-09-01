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
  const openerRef = useRef<HTMLElement | null>(null)
  /** Several dialogs are mounted at once (closed ones still render), so the
   * title id has to be unique per instance. */
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const modal = dialog
    if (open && !modal.open) {
      const active = typeof document === 'undefined' ? null : document.activeElement
      openerRef.current =
        typeof HTMLElement !== 'undefined' && active instanceof HTMLElement ? active : null
      modal.showModal()
      // Keep initial focus on the non-interactive container. This prevents
      // iOS from opening the keyboard when a dialog contains a form control.
      modal.focus({ preventScroll: true })
    }

    function closeAndRestoreFocus() {
      if (modal.open) modal.close()
      const opener = openerRef.current
      openerRef.current = null
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }

    if (!open) closeAndRestoreFocus()
    return () => {
      // A dialog can be removed by a parent (the nested delete confirmation
      // does this), so close it explicitly before unmounting and restore the
      // control that opened it.
      if (modal.open) closeAndRestoreFocus()
    }
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
    <dialog
      ref={ref}
      className={styles.dialog}
      onClick={onBackdropClick}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <h2 className={styles.title} id={titleId}>{title}</h2>
          {description !== undefined && <p className={styles.description}>{description}</p>}
        </header>
        <div className={styles.body}>{children}</div>
        {footer !== undefined && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </dialog>
  )
}
