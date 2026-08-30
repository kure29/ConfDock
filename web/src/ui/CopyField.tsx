import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './CopyField.module.css'

interface CopyFieldProps {
  /** The exact text that lands on the clipboard. */
  value: string
  label?: string
  /** Wrap a long value over several lines instead of scrolling it sideways. */
  wrap?: boolean
}

/**
 * A read-only mono value plus a copy button.
 *
 * The value lives in a real read-only form control rather than a styled
 * `<div>`, so select-all and the browser's own copy affordances still work when
 * the Clipboard API is unavailable (no permission, or a non-secure context).
 */
export function CopyField({ value, label = '复制', wrap = false }: CopyFieldProps) {
  const [copied, setCopied] = useState(false)
  const control = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const timer = useRef(0)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Select the text so the user can copy it by hand rather than being stuck.
      control.current?.focus()
      control.current?.select()
      return
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className={styles.field}>
      {wrap ? (
        <textarea
          ref={control as React.RefObject<HTMLTextAreaElement>}
          className={cx(styles.value, styles.wrapped)}
          value={value}
          readOnly
          spellCheck={false}
          rows={2}
        />
      ) : (
        <input
          ref={control as React.RefObject<HTMLInputElement>}
          className={styles.value}
          value={value}
          readOnly
          spellCheck={false}
        />
      )}
      <button type="button" className={styles.button} onClick={copy} aria-live="polite">
        {copied ? '已复制' : label}
      </button>
    </div>
  )
}
