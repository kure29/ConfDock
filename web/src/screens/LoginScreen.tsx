import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import { useAuth } from '../state/AuthContext'
import { Button } from '../ui/Button'
import { TextField } from '../ui/TextField'
import styles from './LoginScreen.module.css'

/**
 * One password field. There is one administrator, so there is no user name, no
 * "remember me", no sign-up and no password reset flow to speak of.
 */
export function LoginScreen() {
  const { signIn, error: sessionError } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const live = useRef(true)

  useEffect(
    () => {
      // StrictMode mounts effects twice in development; re-arm the guard on
      // each real effect setup so the first probe cleanup cannot disable it.
      live.current = true
      return () => {
        live.current = false
        passwordInput.current?.blur()
      }
    },
    [],
  )

  useEffect(() => {
    let live = true
    void api.serviceInfo().then((result) => {
      if (!live) return
      setServiceError(result.ok ? null : result.error.message)
    })
    return () => {
      live = false
    }
  }, [])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    // Blur before awaiting the session request. AuthProvider unmounts this
    // screen on success, so doing it synchronously is race-safe and closes
    // the iOS keyboard for the transition to the next screen.
    passwordInput.current?.blur()
    try {
      const result = await signIn(password)
      if (!result.ok && live.current) {
        setError(result.error.message)
      }
    } catch {
      if (live.current) setError('无法登录，请稍后重试')
    } finally {
      if (live.current) setBusy(false)
    }
  }

  return (
    <main className={styles.screen}>
      <form className={styles.card} onSubmit={(event) => void onSubmit(event)}>
        <div className={styles.heading}>
          <h1 className={styles.brand}>ConfDock</h1>
          <p className={styles.subtitle}>原生配置管理与稳定分发</p>
        </div>

        <TextField
          id="password"
          label="管理员密码"
          type="password"
          autoComplete="current-password"
          ref={passwordInput}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={(error ?? sessionError?.message) ?? undefined}
        />

        <Button type="submit" variant="primary" loading={busy}>
          进入
        </Button>

        {serviceError !== null && <p className={styles.serviceError}>{serviceError}</p>}
      </form>
    </main>
  )
}
