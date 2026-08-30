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
  error: ApiError | null
  signIn: (password: string) => Promise<Result<AdminSession, ApiError>>
  signOut: () => Promise<Result<void, ApiError>>
}

const AuthContext = createContext<AuthApi | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [session, setSession] = useState<AdminSession | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    let live = true
    void api.currentSession().then((result) => {
      if (!live) return
      if (!result.ok) {
        setError(result.error)
        setSession(null)
        setStatus('signedOut')
        return
      }
      setError(null)
      setSession(result.value)
      setStatus(result.value ? 'signedIn' : 'signedOut')
    })
    return () => {
      live = false
    }
  }, [])

  const signIn = useCallback(async (password: string) => {
    const result = await api.signIn(password)
    if (result.ok) {
      setError(null)
      setSession(result.value)
      setStatus('signedIn')
    }
    else setError(result.error)
    return result
  }, [])

  const signOut = useCallback(async () => {
    const result = await api.signOut()
    if (!result.ok) {
      setError(result.error)
      return result
    }
    setSession(null)
    setStatus('signedOut')
    setError(null)
    return result
  }, [])

  const value = useMemo<AuthApi>(
    () => ({ status, session, error, signIn, signOut }),
    [status, session, error, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthApi {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return value
}
