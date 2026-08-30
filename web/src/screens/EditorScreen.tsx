import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { core } from '../core'
import type { SourceSpan } from '../core'
import {
  CapabilityNotice,
  DiagnosticList,
  ServedUrlDialog,
  SourceEditor,
  StructuredFieldList,
  TargetBadge,
  ValidationLevelBadge,
  diagnosticMarkers,
} from '../components'
import type { RevealRequest } from '../components'
import {
  SAVE_ACTION,
  SAVE_SUCCESS,
  SERVED_POINTER_NOTICE,
  VALIDATION_LEVEL_CAVEAT,
  VALIDATION_LEVEL_COPY,
} from '../lib/copy'
import { useProject } from '../state/useProject'
import { useToast } from '../state/ToastContext'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Panel } from '../ui/Panel'
import { TabPanel, Tabs } from '../ui/Tabs'
import type { TabItem } from '../ui/Tabs'
import page from './page.module.css'
import styles from './EditorScreen.module.css'

type EditorTab = 'raw' | 'fields' | 'check'

/**
 * The editor. Three views of one document, defaulting to the raw bytes.
 *
 * Raw comes first because the bytes are the source of truth (ADR-001): the
 * fields view is a convenience over the same bytes, not a separate model, and it
 * can only reach what `editCapabilities()` actually promises.
 *
 * There is one write action. Saving validates and advances both
 * `current_revision_id` and `served_revision_id` together (ADR-004), so there is
 * no draft state to reason about and no publish button to forget to press.
 */
export function EditorScreen() {
  const { id = '' } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const editor = useProject(id)

  const [tab, setTab] = useState<EditorTab>('raw')
  const [reveal, setReveal] = useState<RevealRequest | null>(null)
  const [urlOpen, setUrlOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const nonce = useRef(0)

  const { project, text, info, bytes, dirty, validation, validating, saving } = editor

  useEffect(() => {
    if (project) setNameDraft(project.name)
  }, [project])

  /** The browser's own guard is the only one that can stop a tab close. */
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const markers = useMemo(
    () => diagnosticMarkers(validation.diagnostics, text, info),
    [validation, text, info],
  )

  const problems = validation.diagnostics.filter(
    (diagnostic) => diagnostic.severity !== 'info',
  ).length

  async function save() {
    const result = await editor.save()
    if (result.ok) {
      toast.notify(result.value.unchanged ? '内容没有变化，未创建新版本' : SAVE_SUCCESS)
      return
    }
    toast.fail(result.error.message)
    if (result.error.validation !== undefined) setTab('check')
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return
      event.preventDefault()
      if (!saving) void save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `save` closes over the current bytes; re-bind whenever they change.
  }, [bytes, saving])

  function onReveal(span: SourceSpan) {
    nonce.current += 1
    setTab('raw')
    setReveal({ span, nonce: nonce.current })
  }

  async function commitName() {
    if (!project || nameDraft.trim() === '' || nameDraft.trim() === project.name) {
      setNameDraft(project?.name ?? '')
      return
    }
    const result = await editor.rename(nameDraft.trim())
    if (!result.ok) {
      toast.fail(result.error.message)
      setNameDraft(project.name)
    }
  }

  if (editor.status === 'loading') {
    return <p className={page.quiet}>正在读取…</p>
  }

  if (editor.status === 'missing' || project === null) {
    return (
      <>
        <Link to="/" className={page.back}>
          ← 配置
        </Link>
        <Panel title="找不到这个配置" description="它可能已经被删除了。" />
      </>
    )
  }

  const levelCopy = VALIDATION_LEVEL_COPY[validation.level]
  const capabilities = core.editCapabilities(project.targetId)

  const tabs: readonly TabItem<EditorTab>[] = [
    { id: 'raw', label: '原始' },
    { id: 'fields', label: '字段' },
    {
      id: 'check',
      label: '检查',
      badge: problems > 0 ? problems : undefined,
    },
  ]

  return (
    <>
      <div className={styles.bar}>
        <Link to="/" className={styles.back} aria-label="返回配置列表">
          ←
        </Link>
        <input
          className={styles.name}
          value={nameDraft}
          aria-label="配置名称"
          onChange={(event) => setNameDraft(event.target.value)}
          onBlur={() => void commitName()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setNameDraft(project.name)
          }}
        />
        <TargetBadge id={project.targetId} />
        <span className={styles.file}>{project.fileName}</span>
        {dirty && <span className={styles.dirty} title="有未保存的改动" />}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => setUrlOpen(true)}>
            托管地址
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {SAVE_ACTION}
          </Button>
        </div>
      </div>

      <Tabs label="编辑视图" items={tabs} active={tab} onChange={setTab} />

      <div className={styles.panel}>
        {tab === 'raw' && (
          <TabPanel id="raw">
            <SourceEditor
              text={text}
              onChange={editor.setText}
              info={info}
              markers={markers}
              reveal={reveal}
            />
          </TabPanel>
        )}

        {tab === 'fields' && (
          <TabPanel id="fields">
            <Panel flush footer={<CapabilityNotice capabilities={capabilities} />}>
              <StructuredFieldList
                targetId={project.targetId}
                source={bytes}
                parsed={editor.parsed}
                onEdit={(path, replacement) => editor.applyEdit({ path, replacement })}
                onOpenRaw={() => setTab('raw')}
              />
            </Panel>
          </TabPanel>
        )}

        {tab === 'check' && (
          <TabPanel id="check">
            <Panel
              title={`本次检查到达「${levelCopy.label}」层`}
              description={
                <>
                  {levelCopy.detail}
                  <br />
                  {VALIDATION_LEVEL_CAVEAT}
                </>
              }
              actions={
                <>
                  {validating && <span className={styles.validating}>正在重新检查…</span>}
                  <ValidationLevelBadge result={validation} />
                </>
              }
              flush={validation.diagnostics.length > 0}
            >
              {validation.diagnostics.length === 0 ? (
                <p className={page.quiet}>没有诊断信息。</p>
              ) : (
                <DiagnosticList
                  diagnostics={validation.diagnostics}
                  text={text}
                  info={info}
                  onReveal={onReveal}
                />
              )}
            </Panel>
          </TabPanel>
        )}
      </div>

      <p className={styles.notice}>{SERVED_POINTER_NOTICE}</p>

      <div className={styles.danger}>
        <p className={styles.dangerText}>删除后，托管地址会立刻失效，内容也无法恢复。</p>
        <Button variant="danger" onClick={() => setDeleteOpen(true)}>
          删除这个配置
        </Button>
      </div>

      <ServedUrlDialog open={urlOpen} onClose={() => setUrlOpen(false)} projectId={project.id} />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`删除「${project.name}」`}
        description="这份配置的所有版本和托管地址都会被删除，无法恢复。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                void editor.remove().then(() => {
                  toast.notify('已删除')
                  void navigate('/')
                })
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className={styles.confirm}>确认要删除吗？</p>
      </Dialog>
    </>
  )
}
