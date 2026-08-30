import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { ServiceInfo } from '../api'
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
  const [service, setService] = useState<ServiceInfo | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void api.serviceInfo().then((result) => {
      if (!live) return
      if (result.ok) setService(result.value)
      else setServiceError(result.error.message)
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
          <p className={styles.subtitle}>自建的代理配置托管</p>
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

        {service?.api === 'mock' && (
          // Said out loud rather than hidden: a login box that accepts anything
          // while looking like a real one is the least honest screen possible.
          <p className={styles.mock}>
            当前运行在本地演示数据上，还没有接后端服务。在「设置」里设过密码之前，
            任意密码都能进入，数据只存在这台浏览器的 localStorage 里。
          </p>
        )}
        {serviceError !== null && <p className={styles.mock}>{serviceError}</p>}
      </form>
    </main>
  )
}
