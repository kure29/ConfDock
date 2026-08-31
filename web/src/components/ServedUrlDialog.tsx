import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AccessToken, CreatedAccessToken } from '../api'
import {
  TOKEN_EXPIRY_NOTICE,
  TOKEN_ONCE_WARNING,
  TOKEN_STORAGE_NOTICE,
} from '../lib/copy'
import {
  expiryFromPreset,
  hostedExpiryStatus,
  HOSTED_EXPIRY_OPTIONS,
  localDateTimeValue,
  tokenName,
  type HostedExpiryPreset,
} from '../lib/token'
import { absoluteDateTime, relativeTime } from '../lib/time'
import { Button } from '../ui/Button'
import { CopyField } from '../ui/CopyField'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Select } from '../ui/Select'
import { TextField } from '../ui/TextField'
import { useToast } from '../state/ToastContext'
import styles from './ServedUrlDialog.module.css'

interface ServedUrlDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
  projectName?: string
}

const DEFAULT_NAME = '未命名地址'
const MAX_TIMER_DELAY = 2_147_000_000

interface BusyToken {
  id: number
  generation: number
}

function expiryForEdit(token: AccessToken): { preset: HostedExpiryPreset; custom: string } {
  return token.expiresAt === null
    ? { preset: 'never', custom: '' }
    : { preset: 'custom', custom: localDateTimeValue(token.expiresAt) }
}

/** Manage stable subscription URLs without ever reconstructing plaintext tokens. */
export function ServedUrlDialog({ open, onClose, projectId, projectName }: ServedUrlDialogProps) {
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)
  const [displayName, setDisplayName] = useState(projectName ?? DEFAULT_NAME)
  const [expiryPreset, setExpiryPreset] = useState<HostedExpiryPreset>('never')
  const [customExpiry, setCustomExpiry] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editPreset, setEditPreset] = useState<HostedExpiryPreset>('never')
  const [editCustomExpiry, setEditCustomExpiry] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<AccessToken | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusNow, setStatusNow] = useState(() => Date.now())
  const toast = useToast()
  const generationRef = useRef(0)
  const projectRef = useRef(projectId)
  const openRef = useRef(open)
  const busyTokenRef = useRef<BusyToken | null>(null)
  const busySequenceRef = useRef(0)
  const listRequestRef = useRef(0)
  const editExpectedRef = useRef<{
    tokenId: string
    displayName: string
    expiresAt: string | null
  } | null>(null)

  if (projectRef.current !== projectId) {
    projectRef.current = projectId
    generationRef.current += 1
  }
  if (openRef.current !== open) {
    openRef.current = open
    generationRef.current += 1
  }
  const isCurrent = useCallback(
    (requestedProjectId: string, requestedGeneration: number) =>
      openRef.current &&
      projectRef.current === requestedProjectId &&
      generationRef.current === requestedGeneration,
    [],
  )

  const beginBusy = useCallback((): BusyToken | null => {
    if (!openRef.current || busyTokenRef.current !== null) return null
    busySequenceRef.current += 1
    const token = { id: busySequenceRef.current, generation: generationRef.current }
    busyTokenRef.current = token
    setBusy(true)
    return token
  }, [])

  const finishBusy = useCallback((token: BusyToken) => {
    if (
      busyTokenRef.current !== token ||
      !openRef.current ||
      generationRef.current !== token.generation
    ) {
      return
    }
    busyTokenRef.current = null
    setBusy(false)
  }, [])

  const reload = useCallback(async () => {
    const requestedProjectId = projectId
    const requestedGeneration = generationRef.current
    listRequestRef.current += 1
    const requestSerial = listRequestRef.current
    const result = await api.listTokens(requestedProjectId)
    if (
      isCurrent(requestedProjectId, requestedGeneration) &&
      listRequestRef.current === requestSerial
    ) {
      if (result.ok) {
        setTokens(result.value)
        setError(null)
        setStatusNow(Date.now())
      } else {
        setTokens(null)
        setError(result.error.message)
      }
    }
    return result
  }, [isCurrent, projectId])

  useEffect(() => {
    generationRef.current += 1
    projectRef.current = projectId
    listRequestRef.current += 1
    busyTokenRef.current = null
    editExpectedRef.current = null
    setBusy(false)
    setTokens(null)
    setCreated(null)
    setError(null)
    setEditingId(null)
    setDeleteTarget(null)
    setDisplayName(tokenName(projectName ?? '', DEFAULT_NAME))
    setExpiryPreset('never')
    setCustomExpiry('')
  }, [projectId])

  useEffect(() => {
    if (!open) {
      listRequestRef.current += 1
      busyTokenRef.current = null
      editExpectedRef.current = null
      setBusy(false)
      setCreated(null)
      setEditingId(null)
      setDeleteTarget(null)
      return
    }
    setTokens(null)
    setError(null)
    setCreated(null)
    setStatusNow(Date.now())
    void reload()
  }, [open, reload])

  useEffect(
    () => () => {
      generationRef.current += 1
      listRequestRef.current += 1
      openRef.current = false
      busyTokenRef.current = null
      editExpectedRef.current = null
    },
    [],
  )

  useEffect(() => {
    if (!open || tokens === null) return
    const now = Date.now()
    const nextExpiry = tokens.reduce<number | null>((next, token) => {
      if (token.revokedAt !== null || token.expiresAt === null) return next
      const expiresAt = Date.parse(token.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return next
      const upcomingAt = expiresAt - 24 * 60 * 60 * 1000
      const transition = upcomingAt > now ? upcomingAt : expiresAt
      return next === null || transition < next ? transition : next
    }, null)
    if (nextExpiry === null) return
    const delay = Math.min(Math.max(0, nextExpiry - now) + 1, MAX_TIMER_DELAY)
    const timer = globalThis.setTimeout(() => setStatusNow(Date.now()), delay)
    return () => globalThis.clearTimeout(timer)
  }, [open, statusNow, tokens])

  function expiryPayload(preset: HostedExpiryPreset, custom: string): string | null {
    return expiryFromPreset(preset, custom)
  }

  function expiryError(preset: HostedExpiryPreset, expiresAt: string | null): string | null {
    if (preset === 'custom' && expiresAt === null) return '请输入有效的本地日期和时间'
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
      return '有效期必须晚于当前时间'
    }
    return null
  }

  async function generate() {
    const busyToken = beginBusy()
    if (busyToken === null) return
    const requestedProjectId = projectId
    const requestedGeneration = generationRef.current
    const name = displayName.trim()
    const expiresAt = expiryPayload(expiryPreset, customExpiry)
    if (name.length === 0 || Array.from(name).length > 64) {
      toast.fail('地址名称必须为 1 到 64 个字符')
      finishBusy(busyToken)
      return
    }
    const expiryMessage = expiryError(expiryPreset, expiresAt)
    if (expiryMessage !== null) {
      toast.fail(expiryMessage)
      finishBusy(busyToken)
      return
    }
    try {
      const result = await api.createToken(requestedProjectId, { displayName: name, expiresAt })
      if (isCurrent(requestedProjectId, requestedGeneration)) {
        if (result.ok) {
          setCreated(result.value)
          await reload()
        } else {
          toast.fail(result.error.message)
        }
      }
    } finally {
      finishBusy(busyToken)
    }
  }

  function beginEdit(token: AccessToken) {
    const expiry = expiryForEdit(token)
    editExpectedRef.current = {
      tokenId: token.id,
      displayName: token.displayName,
      expiresAt: token.expiresAt,
    }
    setEditingId(token.id)
    setEditName(token.displayName)
    setEditPreset(expiry.preset)
    setEditCustomExpiry(expiry.custom)
  }

  async function saveEdit(tokenId: string) {
    const busyToken = beginBusy()
    if (busyToken === null) return
    const requestedProjectId = projectId
    const requestedGeneration = generationRef.current
    const expected = editExpectedRef.current
    if (expected === null || expected.tokenId !== tokenId) {
      finishBusy(busyToken)
      return
    }
    const name = editName.trim()
    const expiresAt = expiryPayload(editPreset, editCustomExpiry)
    if (name.length === 0 || Array.from(name).length > 64) {
      toast.fail('地址名称必须为 1 到 64 个字符')
      finishBusy(busyToken)
      return
    }
    const expiryMessage = expiryError(editPreset, expiresAt)
    if (expiryMessage !== null) {
      toast.fail(expiryMessage)
      finishBusy(busyToken)
      return
    }
    try {
      const result = await api.updateToken(requestedProjectId, tokenId, {
        displayName: name,
        expiresAt,
        expectedDisplayName: expected.displayName,
        expectedExpiresAt: expected.expiresAt,
      })
      if (isCurrent(requestedProjectId, requestedGeneration) && result.ok) {
        setTokens((current) =>
          current?.map((token) => (token.id === tokenId ? result.value : token)) ?? current,
        )
        setStatusNow(Date.now())
        editExpectedRef.current = null
        setEditingId(null)
      } else if (isCurrent(requestedProjectId, requestedGeneration) && !result.ok) {
        toast.fail(result.error.message)
        if (result.error.code === 'token.conflict') {
          editExpectedRef.current = null
          setEditingId(null)
          await reload()
        }
      }
    } finally {
      finishBusy(busyToken)
    }
  }

  async function revoke(tokenId: string) {
    const busyToken = beginBusy()
    if (busyToken === null) return
    const requestedProjectId = projectId
    const requestedGeneration = generationRef.current
    try {
      const result = await api.revokeToken(requestedProjectId, tokenId)
      if (isCurrent(requestedProjectId, requestedGeneration)) {
        if (!result.ok) {
          toast.fail(result.error.message)
        } else {
          setCreated((current) => (current?.token.id === tokenId ? null : current))
          await reload()
        }
      }
    } finally {
      finishBusy(busyToken)
    }
  }

  async function purge(tokenId: string) {
    const busyToken = beginBusy()
    if (busyToken === null) return
    const requestedProjectId = projectId
    const requestedGeneration = generationRef.current
    try {
      const result = await api.deleteRevokedToken(requestedProjectId, tokenId)
      if (isCurrent(requestedProjectId, requestedGeneration)) {
        if (!result.ok) {
          toast.fail(result.error.message)
        } else {
          setDeleteTarget(null)
          setCreated((current) => (current?.token.id === tokenId ? null : current))
          await reload()
        }
      }
    } finally {
      finishBusy(busyToken)
    }
  }

  function closeDialog() {
    if (busyTokenRef.current !== null) return
    onClose()
  }

  return (
    <>
      <Dialog
      open={open}
      onClose={closeDialog}
      title="托管地址"
      description="客户端用这个地址拉取最近一次发布的配置内容。"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={closeDialog}>
            关闭
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void generate()}>
            生成新地址
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <TextField
          id="hosted-address-name"
          label="地址名称"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          hint="最多 64 个 Unicode 字符"
        />
        <Select
          id="hosted-address-expiry"
          label="有效期"
          value={expiryPreset}
          onChange={(event) => setExpiryPreset(event.target.value as HostedExpiryPreset)}
          options={HOSTED_EXPIRY_OPTIONS}
        />
        {expiryPreset === 'custom' && (
          <TextField
            id="hosted-address-custom-expiry"
            label="自定义时间（本地时区）"
            type="datetime-local"
            value={customExpiry}
            onChange={(event) => setCustomExpiry(event.target.value)}
          />
        )}
        <p className={styles.notice}>{TOKEN_EXPIRY_NOTICE}</p>
      </div>

      {created !== null && (
        <div className={styles.created}>
          <p className={styles.createdTitle}>新地址已生成：{created.token.displayName}</p>
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
          {tokens.map((token) => {
            const revoked = token.revokedAt !== null
            const editing = editingId === token.id
            return (
              <li key={token.id} className={styles.item}>
                {editing ? (
                  <div className={styles.editForm}>
                    <TextField
                      id={`hosted-address-name-${token.id}`}
                      label="地址名称"
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                    />
                    <Select
                      id={`hosted-address-expiry-${token.id}`}
                      label="有效期"
                      value={editPreset}
                      onChange={(event) => setEditPreset(event.target.value as HostedExpiryPreset)}
                      options={HOSTED_EXPIRY_OPTIONS}
                    />
                    {editPreset === 'custom' && (
                      <TextField
                        id={`hosted-address-custom-expiry-${token.id}`}
                        label="自定义时间（本地时区）"
                        type="datetime-local"
                        value={editCustomExpiry}
                        onChange={(event) => setEditCustomExpiry(event.target.value)}
                      />
                    )}
                    <div className={styles.editActions}>
                      <Button variant="primary" loading={busy} onClick={() => void saveEdit(token.id)}>
                        保存
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          editExpectedRef.current = null
                          setEditingId(null)
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.itemText}>
                      <strong className={styles.displayName}>{token.displayName}</strong>
                      <span className={styles.token}>
                        {token.prefix}…{token.suffix}
                      </span>
                      <span className={styles.itemMeta}>
                        {hostedExpiryStatus(token.expiresAt, token.revokedAt, statusNow)} · 创建于{' '}
                        {absoluteDateTime(token.createdAt)} ·{' '}
                        {token.lastUsedAt === null
                          ? '还没有被使用过'
                          : `最近使用 ${relativeTime(token.lastUsedAt)}`}
                      </span>
                    </div>
                    {!revoked && (
                      <Button variant="ghost" disabled={busy} onClick={() => beginEdit(token)}>
                        编辑
                      </Button>
                    )}
                    {!revoked && (
                      <Button variant="ghost" disabled={busy} onClick={() => void revoke(token.id)}>
                        撤销
                      </Button>
                    )}
                    {revoked && (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => setDeleteTarget(token)}
                      >
                        删除
                      </Button>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
      </Dialog>

      {deleteTarget !== null && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setDeleteTarget(null)
          }}
          title="永久删除托管地址"
          description="删除后，这条托管地址的记录将无法恢复。"
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setDeleteTarget(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() => {
                  void purge(deleteTarget.id)
                }}
              >
                永久删除
              </Button>
            </>
          }
        >
          <p>
            确定要删除「{deleteTarget.displayName}」吗？撤销记录和相关元数据都会被移除。
          </p>
        </Dialog>
      )}
    </>
  )
}
