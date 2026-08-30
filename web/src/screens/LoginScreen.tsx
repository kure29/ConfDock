import { useEffect, useState } from 'react'
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
    setBusy(true)
    setError(null)
    try {
      const result = await signIn(password)
      if (!result.ok) setError(result.error.message)
    } finally {
      setBusy(false)
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
          autoFocus
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
