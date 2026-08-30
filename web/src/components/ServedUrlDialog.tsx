import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { AccessToken, CreatedAccessToken } from '../api'
import { TOKEN_ONCE_WARNING, TOKEN_STORAGE_NOTICE } from '../lib/copy'
import { absoluteDateTime, relativeTime } from '../lib/time'
import { Button } from '../ui/Button'
import { CopyField } from '../ui/CopyField'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { useToast } from '../state/ToastContext'
import styles from './ServedUrlDialog.module.css'

interface ServedUrlDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
}

/**
 * The subscription URL, and the honest consequences of storing only a hash.
 *
 * Because the server keeps just a hash of the token (architecture.md §Security),
 * it cannot rebuild the URL later — so the full URL exists exactly once, right
 * after generation. Afterwards the list can only show a prefix and a suffix.
 * This dialog says that instead of implying the URL can be looked up again.
 */
export function ServedUrlDialog({ open, onClose, projectId }: ServedUrlDialogProps) {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  const reload = useCallback(async () => {
    const result = await api.listTokens(projectId)
    if (result.ok) {
      setTokens(result.value)
      setError(null)
    } else {
      setTokens(null)
      setError(result.error.message)
    }
  }, [projectId])

  useEffect(() => {
    if (!open) {
      // The full URL is deliberately ephemeral. Do not keep it in component
      // state after the dialog closes; the server cannot recreate it either.
      setCreated(null)
      return
    }
    setCreated(null)
    void reload()
  }, [open, reload])

  async function generate() {
    setBusy(true)
    try {
      const result = await api.createToken(projectId)
      if (result.ok) {
        setCreated(result.value)
        await reload()
      } else {
        toast.fail(result.error.message)
      }
    } finally {
      setBusy(false)
    }
  }

  async function revoke(tokenId: string) {
    setBusy(true)
    try {
      const result = await api.revokeToken(projectId, tokenId)
      if (!result.ok) {
        toast.fail(result.error.message)
        return
      }
      // If the token we just revoked is the one on screen, its plaintext is
      // now worthless — take it off the screen too.
      setCreated((current) => (current?.token.id === tokenId ? null : current))
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="托管地址"
      description="客户端用这个地址拉取最近一次发布的配置内容。"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void generate()}>
            生成新地址
          </Button>
        </>
      }
    >
      {created !== null && (
        <div className={styles.created}>
          <p className={styles.createdTitle}>新地址已生成</p>
          <CopyField value={created.url} wrap label="复制地址" />
          <p className={styles.warning}>{TOKEN_ONCE_WARNING}</p>
          <p className={styles.note}>{TOKEN_STORAGE_NOTICE}</p>
        </div>
      )}

      {error !== null ? (
        <p className={styles.loading} role="alert">{error}</p>
      ) : tokens === null ? (
        <p className={styles.loading}>正在读取…</p>
      ) : tokens.length === 0 ? (
        <EmptyState
          title="还没有托管地址"
          body={<p>生成一个之后，客户端就能通过它订阅这份配置。</p>}
        />
      ) : (
        <ul className={styles.list}>
          {tokens.map((token) => (
            <li key={token.id} className={styles.item}>
              <div className={styles.itemText}>
                <span className={styles.token}>
                  {token.prefix}…{token.suffix}
                </span>
                <span className={styles.itemMeta}>
                  创建于 {absoluteDateTime(token.createdAt)} ·{' '}
                  {token.lastUsedAt === null
                    ? '还没有被使用过'
                    : `最近使用 ${relativeTime(token.lastUsedAt)}`}
                </span>
              </div>
              <Button variant="ghost" disabled={busy} onClick={() => void revoke(token.id)}>
                撤销
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
