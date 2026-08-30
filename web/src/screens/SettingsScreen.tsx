import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { ServiceInfo } from '../api'
import { core } from '../core'
import { describeScope, VALIDATION_LEVEL_COPY } from '../lib/copy'
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
 * Password, appearance, and what this build actually is.
 *
 * The capability table is rendered from the registry rather than written by
 * hand, so it cannot claim an ability the adapters do not have — and it updates
 * itself when the Rust side gains one.
 */
export function SettingsScreen({ theme, onThemeChange }: SettingsScreenProps) {
  const toast = useToast()
  const [service, setService] = useState<ServiceInfo | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void api.serviceInfo().then((info) => {
      if (live) setService(info)
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

        <Panel title="服务信息">
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
                  : '浏览器内的契约 mock —— 不是真正的解析器'}
              </dd>
            </div>
            <div className={styles.infoRow}>
              <dt className={styles.term}>后端</dt>
              <dd className={styles.value}>
                {service?.api === 'http'
                  ? 'Axum HTTP 服务'
                  : 'localStorage —— 数据只在这台浏览器里'}
              </dd>
            </div>
            <div className={styles.infoRow}>
              <dt className={styles.term}>订阅前缀</dt>
              <dd className={styles.mono}>{service?.subscriptionBase ?? '—'}</dd>
            </div>
          </dl>
        </Panel>

        <Panel
          title="已注册的客户端"
          description="直接读自 Target Registry：这张表不是手写的，能力变了它就跟着变。"
          flush
        >
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">客户端</th>
                  <th scope="col">后缀</th>
                  <th scope="col">最深校验</th>
                  <th scope="col">schema</th>
                  <th scope="col">可结构化编辑的范围</th>
                </tr>
              </thead>
              <tbody>
                {core.targets().map((descriptor) => {
                  const schema = core.schema(descriptor.id)
                  const capabilities = core.editCapabilities(descriptor.id)
                  return (
                    <tr key={descriptor.id}>
                      <th scope="row" className={styles.rowHead}>
                        {descriptor.displayName}
                      </th>
                      <td className={styles.mono}>
                        {descriptor.fileExtensions.map((ext) => `.${ext}`).join(' ')}
                      </td>
                      <td>
                        {VALIDATION_LEVEL_COPY[descriptor.capabilities.validationLevel].label}
                        {descriptor.capabilities.nativeValidation ? '' : '（无原生校验器）'}
                      </td>
                      <td>
                        {schema === null ? '不暴露' : `${schema.fields.length} 个字段`}
                      </td>
                      <td>
                        {capabilities.length === 0
                          ? '无'
                          : capabilities
                              .map((capability) => describeScope(capability.scope))
                              .join('；')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  )
}
