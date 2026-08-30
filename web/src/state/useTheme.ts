import { useCallback, useEffect, useState } from 'react'

/**
 * Appearance preference.
 *
 * `system` is the default and the recommended setting: `tokens.css` already has
 * a `prefers-color-scheme` block, so `system` works by removing the override
 * attribute rather than by computing a colour scheme in JS.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'confdock.theme'

function readStored(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Private mode / storage disabled: fall back to following the system.
  }
  return 'system'
}

function apply(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', preference)
}

export function useTheme(): {
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
} {
  const [preference, setState] = useState<ThemePreference>(readStored)

  useEffect(() => {
    apply(preference)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not worth surfacing: the preference still applies for this session.
    }
  }, [])

  return { preference, setPreference }
}

export const THEME_LABEL: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}
