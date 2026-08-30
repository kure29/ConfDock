import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ToastRegion } from '../ui/Toast'
import type { ToastMessage, ToastTone } from '../ui/Toast'

/**
 * Owns the toast queue and its timers. `ui/Toast` stays presentational.
 *
 * Errors do not auto-dismiss: a failed save is something the user has to read,
 * and a message that vanishes is the same as a message that never appeared.
 */

interface ToastApi {
  /** Neutral confirmation. Auto-dismisses. */
  notify: (text: string, detail?: string) => void
  /** Stays until dismissed. `detail` is for the adapter's own English message. */
  fail: (text: string, detail?: string) => void
  dismiss: (id: string) => void
}

const NOTIFY_MS = 3200

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([])
  const timers = useRef(new Map<string, number>())
  const seq = useRef(0)

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
    },
    [],
  )

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (tone: ToastTone, text: string, detail?: string) => {
      seq.current += 1
      const id = `toast-${seq.current}`
      const toast: ToastMessage = detail === undefined ? { id, tone, text } : { id, tone, text, detail }
      // One at a time: stacked toasts in a single-user tool are just noise.
      setToasts([toast])
      for (const timer of timers.current.values()) window.clearTimeout(timer)
      timers.current.clear()
      if (tone === 'neutral') {
        timers.current.set(
          id,
          window.setTimeout(() => dismiss(id), NOTIFY_MS),
        )
      }
    },
    [dismiss],
  )

  const value = useMemo<ToastApi>(
    () => ({
      notify: (text, detail) => push('neutral', text, detail),
      fail: (text, detail) => push('bad', text, detail),
      dismiss,
    }),
    [push, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast 必须在 ToastProvider 内使用')
  return value
}
