import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { ServiceInfo } from '../api'
import { THEME_LABEL } from '../state/useTheme'
import type { ThemePreference } from '../state/useTheme'
import { useToast } from '../state/ToastContext'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { TextField } from '../ui/TextField'
import page from './page.module.css'
import styles from './SettingsScreen.module.css'

interface SettingsScreenProps {
  theme: ThemePreference
  onThemeChange: (next: ThemePreference) => void
}

/**
 * Password, appearance, and the address clients should use to reach this
 * instance.
 */
export function SettingsScreen({ theme, onThemeChange }: SettingsScreenProps) {
  const toast = useToast()
  const [service, setService] = useState<ServiceInfo | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [publicUrl, setPublicUrl] = useState('')
  const [publicUrlError, setPublicUrlError] = useState<string | null>(null)
  const [publicUrlLoading, setPublicUrlLoading] = useState(true)
  const [publicUrlBusy, setPublicUrlBusy] = useState(false)

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

  useEffect(() => {
    let live = true
    void api
      .settings()
      .then((result) => {
        if (!live) return
        if (result.ok) {
          setPublicUrl(result.value.publicUrl)
          setPublicUrlError(null)
        } else {
          setPublicUrlError(result.error.message)
        }
      })
      .catch(() => {
        if (live) setPublicUrlError('无法读取对外访问地址')
      })
      .finally(() => {
        if (live) setPublicUrlLoading(false)
      })
    return () => {
      live = false
    }
  }, [])

  async function changePassword(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (next.length < 8) {
      setError('新密码至少 8 个字符')
      return
    }
    if (next !== again) {
      setError('两次输入的新密码不一致')
      return
    }
    setBusy(true)
    try {
      const result = await api.changePassword(current, next)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setCurrent('')
      setNext('')
      setAgain('')
      toast.notify('密码已更新')
    } finally {
      setBusy(false)
    }
  }

  async function savePublicUrl(event: FormEvent) {
    event.preventDefault()
    setPublicUrlError(null)
    const value = publicUrl.trim()
    if (value.length === 0) {
      setPublicUrlError('请输入对外访问地址')
      return
    }
    setPublicUrlBusy(true)
    try {
      const result = await api.updatePublicUrl(value)
      if (!result.ok) {
        setPublicUrlError(result.error.message)
        return
      }
      setPublicUrl(result.value.publicUrl)
      setService((current) =>
        current === null
          ? current
          : { ...current, subscriptionBase: `${result.value.publicUrl}/sub` },
      )
      toast.notify('对外访问地址已更新')
    } finally {
      setPublicUrlBusy(false)
    }
  }

  return (
    <>
      <div className={page.header}>
        <div className={page.heading}>
          <h1 className={page.title}>设置</h1>
        </div>
      </div>

      <div className={page.stack}>
        <Panel title="管理员密码" description="只有一个管理员账号，没有成员和角色。">
          <form className={styles.form} onSubmit={(event) => void changePassword(event)}>
            <TextField
              id="current-password"
              label="当前密码"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
            <div className={styles.pair}>
              <TextField
                id="next-password"
                label="新密码"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                hint="至少 8 个字符"
              />
              <TextField
                id="again-password"
                label="再输一次"
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(event) => setAgain(event.target.value)}
                error={error ?? undefined}
              />
            </div>
            <div>
              <Button type="submit" variant="primary" loading={busy}>
                更新密码
              </Button>
            </div>
          </form>
        </Panel>

        <Panel title="外观">
          <Select
            id="theme"
            label="主题"
            value={theme}
            onChange={(event) => onThemeChange(event.target.value as ThemePreference)}
            options={[
              { value: 'system', label: THEME_LABEL.system },
              { value: 'light', label: THEME_LABEL.light },
              { value: 'dark', label: THEME_LABEL.dark },
            ]}
            hint="默认跟随系统。"
          />
        </Panel>

        <Panel
          title="对外访问地址"
          description="这是反向代理对外提供服务的地址；ConfDock 后端仍只监听 127.0.0.1。"
        >
          <form className={styles.form} onSubmit={(event) => void savePublicUrl(event)}>
            <TextField
              id="public-url"
              label="访问地址"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://cd.maibi.de"
              value={publicUrl}
              disabled={publicUrlLoading || publicUrlBusy}
              onChange={(event) => setPublicUrl(event.target.value)}
              error={publicUrlError ?? undefined}
              hint="支持 http:// 或 https://，可包含端口，不能填写路径。"
              mono
            />
            <div>
              <Button
                type="submit"
                variant="primary"
                loading={publicUrlBusy}
                disabled={publicUrlLoading}
              >
                保存地址
              </Button>
            </div>
          </form>
        </Panel>

        <Panel title="服务信息">
          {serviceError !== null && <p className={page.quiet}>{serviceError}</p>}
          <dl className={styles.info}>
            <div className={styles.infoRow}>
              <dt className={styles.term}>版本</dt>
              <dd className={styles.value}>{service?.version ?? '—'}</dd>
            </div>
            <div className={styles.infoRow}>
              <dt className={styles.term}>配置内核</dt>
              <dd className={styles.value}>
                {service?.core === 'wasm'
                  ? 'confdock-core（WASM）'
                  : '未连接 Rust WASM Core'}
              </dd>
            </div>
            <div className={styles.infoRow}>
              <dt className={styles.term}>后端</dt>
              <dd className={styles.value}>{service ? 'Axum HTTP 服务' : '—'}</dd>
            </div>
            <div className={styles.infoRow}>
              <dt className={styles.term}>订阅前缀</dt>
              <dd className={styles.mono}>{service?.subscriptionBase ?? '—'}</dd>
            </div>
          </dl>
        </Panel>
      </div>
    </>
  )
}
