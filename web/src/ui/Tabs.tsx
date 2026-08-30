import { useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cx } from '../lib/cx'
import styles from './Tabs.module.css'

export interface TabItem<T extends string> {
  id: T
  label: ReactNode
  /** A count or a status dot. Kept out of the label so the label stays a noun. */
  badge?: ReactNode
}

interface TabsProps<T extends string> {
  /** Accessible name for the tab list, e.g. "编辑视图". */
  label: string
  items: readonly TabItem<T>[]
  active: T
  onChange: (id: T) => void
}

/**
 * Underline tabs with arrow-key navigation (automatic activation).
 *
 * The caller renders the panel and pairs it with `tabPanelId` / `tabId` so the
 * `aria-controls` / `aria-labelledby` relationship holds.
 */
export function Tabs<T extends string>({ label, items, active, onChange }: TabsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>())

  function move(offset: number) {
    const index = items.findIndex((item) => item.id === active)
    if (index < 0) return
    const next = items[(index + offset + items.length) % items.length]
    if (next === undefined) return
    onChange(next.id)
    buttons.current.get(next.id)?.focus()
  }

  function jump(to: 'first' | 'last') {
    const next = to === 'first' ? items[0] : items[items.length - 1]
    if (next === undefined) return
    onChange(next.id)
    buttons.current.get(next.id)?.focus()
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault()
        move(1)
        break
      case 'ArrowLeft':
        event.preventDefault()
        move(-1)
        break
      case 'Home':
        event.preventDefault()
        jump('first')
        break
      case 'End':
        event.preventDefault()
        jump('last')
        break
      default:
        break
    }
  }

  return (
    <div className={styles.tabs} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.id === active
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(item.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(item.id)}
            tabIndex={selected ? 0 : -1}
            className={cx(styles.tab, selected && styles.selected)}
            onClick={() => onChange(item.id)}
            ref={(element) => {
              if (element) buttons.current.set(item.id, element)
              else buttons.current.delete(item.id)
            }}
          >
            {item.label}
            {item.badge !== undefined && <span className={styles.badge}>{item.badge}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function tabId(id: string): string {
  return `tab-${id}`
}

export function tabPanelId(id: string): string {
  return `tabpanel-${id}`
}

/** The panel half of the pair. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={tabPanelId(id)} aria-labelledby={tabId(id)} tabIndex={-1}>
      {children}
    </div>
  )
}
