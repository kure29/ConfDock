import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { ApiError, Project, ProjectSummary, PublishResult, SaveResult } from '../api'
import { core } from '../core'
import type {
  DocumentInfo,
  EditError,
  LineEnding,
  ParseError,
  ParsedDocument,
  Result,
  StructuredEdit,
  ValidationResult,
} from '../core'
import { err, ok } from '../core'
import { bytesEqual, decodeToEditor, encodeFromEditor } from '../lib/bytes'

/**
 * Editor state for one project.
 *
 * The native bytes are the source of truth (ADR-001). Text is a decoded view;
 * raw edits re-encode only uniform LF/CRLF documents, while structured edits
 * patch `workingBytes` directly. This keeps mixed-line-ending documents
 * byte-stable until a supported structured edit changes one span.
 */

export type ProjectStatus = 'loading' | 'missing' | 'error' | 'ready'

export interface ProjectEditor {
  status: ProjectStatus
  project: Project | null
  loadError: ApiError | null
  /** LF-normalized text held by the textarea. */
  text: string
  setText: (next: string) => void
  /** Encoding / line ending of the bytes currently in hand. */
  info: DocumentInfo
  /** Native bytes currently being edited. */
  workingBytes: Uint8Array
  bytes: Uint8Array
  dirty: boolean
  validation: ValidationResult
  /** True while `validation` still describes slightly older text. */
  validating: boolean
  parsed: Result<ParsedDocument, ParseError>
  applyEdit: (edit: StructuredEdit) => Result<void, EditError>
  saving: boolean
  save: () => Promise<Result<SaveResult, ApiError>>
  publishing: boolean
  publish: () => Promise<Result<PublishResult, ApiError>>
  rename: (name: string) => Promise<Result<ProjectSummary, ApiError>>
  remove: () => Promise<Result<void, ApiError>>
}

const EMPTY = new Uint8Array()

export function useProject(id: string): ProjectEditor {
  const [status, setStatus] = useState<ProjectStatus>('loading')
  const [project, setProject] = useState<Project | null>(null)
  const [workingBytes, setWorkingBytes] = useState<Uint8Array>(EMPTY)
  const [rawLineEndingPreference, setRawLineEndingPreference] = useState<Exclude<LineEnding, 'none'>>('lf')
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)
  const activeProjectIdRef = useRef(id)

  useEffect(() => {
    activeProjectIdRef.current = id
    publishingRef.current = false
    setPublishing(false)
    let live = true
    setStatus('loading')
    setProject(null)
    setWorkingBytes(EMPTY)
    setRawLineEndingPreference('lf')
    setLoadError(null)
    void api.getProject(id).then((result) => {
      if (!live) return
      if (!result.ok) {
        setLoadError(result.error)
        if (result.error.code === 'project.not_found') setStatus('missing')
        else setStatus('error')
        return
      }
      const loaded = result.value
      setLoadError(null)
      if (!loaded) {
        setStatus('missing')
        return
      }
      setProject(loaded)
      setWorkingBytes(new Uint8Array(loaded.source))
      const loadedLineEnding = core.documentInfo(loaded.source).lineEnding
      setRawLineEndingPreference(
        loadedLineEnding === 'crlf' ? 'crlf' : loadedLineEnding === 'mixed' ? 'mixed' : 'lf',
      )
      setStatus('ready')
    })
    return () => {
      live = false
    }
  }, [id])

  const info = useMemo<DocumentInfo>(() => core.documentInfo(workingBytes), [workingBytes])
  const decoded = useMemo(() => decodeToEditor(workingBytes), [workingBytes])
  const text = decoded.text

  const setText = useCallback(
    (next: string) => {
      if (rawLineEndingPreference === 'mixed') return
      try {
        setWorkingBytes(
          encodeFromEditor(next, { ...info, lineEnding: rawLineEndingPreference }, workingBytes),
        )
      } catch {
        // Mixed line endings are deliberately read-only in the raw editor.
      }
    },
    [info, rawLineEndingPreference, workingBytes],
  )

  const bytes = workingBytes

  const dirty = project !== null && !bytesEqual(bytes, project.source)

  // The check may lag a keystroke behind; `validating` says so rather than
  // showing a stale result as if it were current.
  const settled = useDeferredValue(bytes)
  const targetId = project?.targetId
  const validation = useMemo<ValidationResult>(
    () =>
      targetId === undefined
        ? { level: 'basic', diagnostics: [] }
        : core.validate(targetId, settled),
    [targetId, settled],
  )
  const parsed = useMemo<Result<ParsedDocument, ParseError>>(
    () =>
      targetId === undefined
        ? err<ParseError, ParsedDocument>({ diagnostics: [] })
        : core.parse(targetId, settled),
    [targetId, settled],
  )

  const applyEdit = useCallback(
    (edit: StructuredEdit): Result<void, EditError> => {
      if (!project) {
        return err<EditError, void>({ kind: 'parseFailed', detail: 'project not loaded' })
      }
      const result = core.applyEdit(project.targetId, workingBytes, edit)
      if (!result.ok) return err<EditError, void>(result.error)
      setWorkingBytes(new Uint8Array(result.value))
      return ok<void, EditError>(undefined)
    },
    [project, workingBytes],
  )

  const save = useCallback(async (): Promise<Result<SaveResult, ApiError>> => {
    if (!project) {
      return err<ApiError, SaveResult>({ code: 'project.not_found', message: '项目不存在' })
    }
    setSaving(true)
    try {
      const result = await api.saveRevision({
        projectId: project.id,
        source: workingBytes,
        expectedRevisionId: project.currentRevisionId,
      })
      if (result.ok) {
        setProject(result.value.project)
        setWorkingBytes(new Uint8Array(result.value.project.source))
      }
      return result
    } finally {
      setSaving(false)
    }
  }, [project, workingBytes])

  const publish = useCallback(async (): Promise<Result<PublishResult, ApiError>> => {
    if (!project) {
      return err<ApiError, PublishResult>({ code: 'project.not_found', message: '项目不存在' })
    }
    if (dirty) {
      return err<ApiError, PublishResult>({
        code: 'publish.dirty',
        message: '请先保存或撤销当前修改，再发布已保存的草稿',
      })
    }
    if (publishingRef.current) {
      return err<ApiError, PublishResult>({
        code: 'publish.busy',
        message: '正在发布，请稍候',
      })
    }
    publishingRef.current = true
    setPublishing(true)
    try {
      const result = await api.publishProject({
        projectId: project.id,
        expectedCurrentRevisionId: project.currentRevisionId,
        expectedServedRevisionId: project.servedRevisionId,
      })
      if (result.ok && activeProjectIdRef.current === project.id) {
        setProject(result.value.project)
      }
      return result
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }, [dirty, project])

  const rename = useCallback(
    async (name: string): Promise<Result<ProjectSummary, ApiError>> => {
      if (!project) {
        return err<ApiError, ProjectSummary>({ code: 'project.not_found', message: '项目不存在' })
      }
      const result = await api.renameProject(project.id, name)
      if (result.ok) setProject({ ...project, name: result.value.name })
      return result
    },
    [project],
  )

  const remove = useCallback(async () => {
    if (!project) return err<ApiError, void>({ code: 'project.not_found', message: '项目不存在' })
    return api.deleteProject(project.id)
  }, [project])

  return {
    status,
    project,
    loadError,
    text,
    setText,
    info,
    workingBytes: bytes,
    bytes: project ? bytes : EMPTY,
    dirty,
    validation,
    validating: settled !== bytes,
    parsed,
    applyEdit,
    saving,
    save,
    publishing,
    publish,
    rename,
    remove,
  }
}
