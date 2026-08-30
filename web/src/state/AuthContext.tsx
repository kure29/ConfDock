import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import type { AdminSession, ApiError } from '../api'
import type { Result } from '../core'

/**
 * Single-admin session state.
 *
 * There is one account, no roles and no members, so this holds a session or it
 * holds nothing. `status: 'loading'` exists only for the boot round-trip that
 * asks whether a session is already active — without it the login screen would
 * flash on every refresh.
 */

type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

interface AuthApi {
  status: AuthStatus
  session: AdminSession | null
  signIn: (password: string) => Promise<Result<AdminSession, ApiError>>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthApi | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [session, setSession] = useState<AdminSession | null>(null)

  useEffect(() => {
    let live = true
    void api.currentSession().then((restored) => {
      if (!live) return
      setSession(restored)
      setStatus(restored ? 'signedIn' : 'signedOut')
    })
    return () => {
      live = false
    }
  }, [])

  const signIn = useCallback(async (password: string) => {
    const result = await api.signIn(password)
    if (result.ok) {
      setSession(result.value)
      setStatus('signedIn')
    }
    return result
  }, [])

  const signOut = useCallback(async () => {
    await api.signOut()
    setSession(null)
    setStatus('signedOut')
  }, [])

  const value = useMemo<AuthApi>(
    () => ({ status, session, signIn, signOut }),
    [status, session, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthApi {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return value
}
