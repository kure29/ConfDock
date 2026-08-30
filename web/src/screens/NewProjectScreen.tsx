import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { core, isValid } from '../core'
import type { TargetId, ValidationResult } from '../core'
import {
  DiagnosticList,
  ImportPanel,
  TargetPicker,
  ValidationLevelBadge,
  importBytes,
} from '../components'
import type { ImportSource } from '../components'
import { decodeToEditor } from '../lib/bytes'
import { SAVE_BLOCKED, VALIDATION_LEVEL_COPY } from '../lib/copy'
import { useToast } from '../state/ToastContext'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { TextField } from '../ui/TextField'
import page from './page.module.css'
import styles from './NewProjectScreen.module.css'

/**
 * Import a native config and register it as a project.
 *
 * Three steps in one screen, in the order the decisions actually happen: the
 * bytes, the client they are for, then the name. Detection runs on the bytes and
 * is shown in the picker as a hint — it never selects for you, because
 * `docs/architecture.md` is explicit that a user-chosen target wins.
 */
export function NewProjectScreen() {
  const navigate = useNavigate()
  const toast = useToast()
  const [source, setSource] = useState<ImportSource | null>(null)
  const [targetId, setTargetId] = useState<TargetId | null>(null)
  const [name, setName] = useState('')
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [rejected, setRejected] = useState<ValidationResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const bytes = useMemo(() => (source === null ? null : importBytes(source)), [source])
  const detections = useMemo(() => (bytes === null ? [] : core.detect(bytes)), [bytes])
  const decoded = useMemo(() => (bytes === null ? null : decodeToEditor(bytes)), [bytes])
  const validation = useMemo(
    () => (bytes === null || targetId === null ? null : core.validate(targetId, bytes)),
    [bytes, targetId],
  )

  const descriptor = targetId === null ? null : core.descriptor(targetId)
  const suggestedFileName =
    source?.kind === 'file'
      ? source.name
      : descriptor === null
        ? ''
        : `config.${descriptor.fileExtensions[0] ?? 'conf'}`
  const suggestedName =
    source?.kind === 'file' ? source.name.replace(/\.[^.]+$/, '') : (descriptor?.displayName ?? '')

  const effectiveName = name.trim() === '' ? suggestedName : name.trim()
  const effectiveFileName = fileName.trim() === '' ? suggestedFileName : fileName.trim()

  const blocked = validation !== null && !isValid(validation)
  const ready =
    bytes !== null &&
    targetId !== null &&
    effectiveName !== '' &&
    effectiveFileName !== '' &&
    !blocked

  async function submit() {
    if (bytes === null || targetId === null) return
    setBusy(true)
    setRejected(null)
    setFailure(null)
    try {
      const result = await api.createProject({
        name: effectiveName,
        targetId,
        fileName: effectiveFileName,
        source: bytes,
      })
      if (result.ok) {
        toast.notify('已创建')
        void navigate(`/p/${result.value.id}`)
        return
      }
      if (result.error.validation !== undefined) setRejected(result.error.validation)
      setFailure(result.error.message)
    } finally {
      setBusy(false)
    }
  }

  const shown = rejected ?? validation
  const levelCopy = shown === null ? null : VALIDATION_LEVEL_COPY[shown.level]

  return (
    <>
      <div className={page.header}>
        <div className={page.heading}>
          <h1 className={page.title}>导入配置</h1>
          <p className={page.lead}>保存的是你给的字节；ConfDock 不会替你重排格式。</p>
        </div>
      </div>

      <div className={page.stack}>
        <Panel title="① 配置内容" description="拖入文件可以完整保留 BOM 与行尾。">
          <ImportPanel value={source} onChange={setSource} />
        </Panel>

        <Panel title="② 客户端" description="决定用哪个适配器解析和校验这份文档。">
          <TargetPicker value={targetId} onChange={setTargetId} detections={detections} />
        </Panel>

        <Panel title="③ 名称">
          <div className={styles.names}>
            <TextField
              id="project-name"
              label="配置名称"
              value={name}
              placeholder={suggestedName}
              onChange={(event) => setName(event.target.value)}
              hint={
                suggestedName === '' ? undefined : `留空就用「${suggestedName}」`
              }
            />
            <TextField
              id="project-file"
              label="文件名"
              mono
              value={fileName}
              placeholder={suggestedFileName}
              onChange={(event) => setFileName(event.target.value)}
              hint={
                suggestedFileName === ''
                  ? '客户端拉取时看到的文件名'
                  : `留空就用「${suggestedFileName}」`
              }
            />
          </div>
        </Panel>

        {shown !== null && levelCopy !== null && (
          <Panel
            title="检查"
            description={levelCopy.detail}
            actions={<ValidationLevelBadge result={shown} />}
            flush={shown.diagnostics.length > 0}
          >
            {shown.diagnostics.length === 0 ? (
              <p className={page.quiet}>没有诊断信息。</p>
            ) : (
              decoded !== null && (
                <DiagnosticList
                  diagnostics={shown.diagnostics}
                  bytes={bytes!}
                />
              )
            )}
          </Panel>
        )}

        <div className={styles.footer}>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            创建
          </Button>
          {blocked && <span className={styles.blocked}>{SAVE_BLOCKED}</span>}
          {failure !== null && !blocked && <span className={styles.blocked}>{failure}</span>}
          <Button variant="ghost" onClick={() => void navigate('/')}>
            取消
          </Button>
        </div>
      </div>
    </>
  )
}
