import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { ApiError, Project, ProjectSummary, SaveResult } from '../api'
import { core } from '../core'
import type {
  DocumentInfo,
  EditError,
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
 * The native bytes are the source of truth (ADR-001), so this hook keeps a
 * single piece of authored state — the editor text — and *derives* the bytes,
 * the dirty flag, the validation and the parse from it. There is no parallel
 * structured model to fall out of sync; the fields view edits the same bytes
 * through `core.applyEdit`.
 */

export type ProjectStatus = 'loading' | 'missing' | 'ready'

export interface ProjectEditor {
  status: ProjectStatus
  project: Project | null
  /** LF-normalized text held by the textarea. */
  text: string
  setText: (next: string) => void
  /** Encoding / line ending of the bytes currently in hand. */
  info: DocumentInfo
  /** `text` re-encoded with the original BOM and line-ending style. */
  bytes: Uint8Array
  dirty: boolean
  validation: ValidationResult
  /** True while `validation` still describes slightly older text. */
  validating: boolean
  parsed: Result<ParsedDocument, ParseError>
  applyEdit: (edit: StructuredEdit) => Result<void, EditError>
  saving: boolean
  save: () => Promise<Result<SaveResult, ApiError>>
  rename: (name: string) => Promise<Result<ProjectSummary, ApiError>>
  remove: () => Promise<void>
}

const EMPTY = new Uint8Array()

const EMPTY_INFO: DocumentInfo = {
  encoding: 'utf8',
  lineEnding: 'none',
  hasTrailingNewline: false,
  byteLength: 0,
}

export function useProject(id: string): ProjectEditor {
  const [status, setStatus] = useState<ProjectStatus>('loading')
  const [project, setProject] = useState<Project | null>(null)
  const [text, setText] = useState('')
  const [info, setInfo] = useState<DocumentInfo>(EMPTY_INFO)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    setStatus('loading')
    void api.getProject(id).then((loaded) => {
      if (!live) return
      if (!loaded) {
        setStatus('missing')
        return
      }
      const decoded = decodeToEditor(loaded.source)
      setProject(loaded)
      setText(decoded.text)
      setInfo(decoded.info)
      setStatus('ready')
    })
    return () => {
      live = false
    }
  }, [id])

  const bytes = useMemo(() => encodeFromEditor(text, info), [text, info])

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
      const result = core.applyEdit(project.targetId, bytes, edit)
      if (!result.ok) return err<EditError, void>(result.error)
      // Re-derive both text and metadata from the patched bytes so the header
      // can never describe an encoding the bytes no longer have.
      const decoded = decodeToEditor(result.value)
      setText(decoded.text)
      setInfo(decoded.info)
      return ok<void, EditError>(undefined)
    },
    [project, bytes],
  )

  const save = useCallback(async (): Promise<Result<SaveResult, ApiError>> => {
    if (!project) {
      return err<ApiError, SaveResult>({ code: 'project.not_found', message: '项目不存在' })
    }
    setSaving(true)
    try {
      const result = await api.saveRevision(project.id, bytes)
      if (result.ok) {
        setProject(result.value.project)
        const decoded = decodeToEditor(result.value.project.source)
        setInfo(decoded.info)
      }
      return result
    } finally {
      setSaving(false)
    }
  }, [project, bytes])

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
    if (project) await api.deleteProject(project.id)
  }, [project])

  return {
    status,
    project,
    text,
    setText,
    info,
    bytes: project ? bytes : EMPTY,
    dirty,
    validation,
    validating: settled !== bytes,
    parsed,
    applyEdit,
    saving,
    save,
    rename,
    remove,
  }
}
