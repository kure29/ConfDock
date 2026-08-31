import type {
  Diagnostic,
  DiagnosticSeverity,
  Result,
  SourceSpan,
  ValidationLevel,
  ValidationResult,
} from '../core/types'
import { err, ok } from '../core/types'
import { base64ToBytes, bytesToBase64 } from '../lib/bytes'
import type {
  ConfDockApi,
  CreateAccessTokenInput,
  PublishProjectInput,
  SaveRevisionInput,
  UpdateAccessTokenInput,
} from './ConfDockApi'
import { API_ERROR } from './types'
import type {
  AccessToken,
  AdminSession,
  ApiError,
  CreatedAccessToken,
  NewProject,
  Project,
  ProjectSummary,
  Revision,
  RevisionDiff,
  RevisionDiffDocument,
  RevisionDiffHunk,
  RevisionDiffLine,
  RevisionDiffLineEnding,
  RevisionDiffLineKind,
  RevisionListOptions,
  RevisionPage,
  RevisionSummary,
  PublishResult,
  SaveResult,
  ServiceInfo,
} from './types'

/**
 * The Axum client. `web/README.md` documents the same REST shape.
 *
 * Wire format: the management API is JSON throughout, with document bytes
 * base64-encoded in a `source` field. History lists are bounded pages and
 * intentionally omit source; `getRevision()` loads one selected immutable
 * entry when the administrator asks to inspect it. Only `GET /sub/:token` returns raw bytes directly,
 * because that is the endpoint proxy clients actually fetch.
 *
 * Auth is a session cookie set by `POST /api/session`, so every request goes out
 * with `credentials: 'same-origin'` and no token is ever put in a URL.
 */

interface Wire {
  session: { id: string; createdAt: string }
  projectSummary: Omit<ProjectSummary, 'byteLength'> & { byteLength: number }
  project: Omit<Project, 'source'> & { source: string }
  saveResult: { project: Wire['project']; validation: ValidationResult; unchanged: boolean }
  publishResult: { project: Wire['project']; unchanged: boolean }
  createdToken: { token: AccessToken; plaintext: string; url: string }
}

function decodeProject(wire: Wire['project']): Project {
  if (
    wire === null ||
    typeof wire !== 'object' ||
    typeof wire.source !== 'string' ||
    !isRevisionId(wire.currentRevisionId) ||
    !isRevisionId(wire.servedRevisionId) ||
    typeof wire.hasUnpublishedChanges !== 'boolean'
  ) {
    throw new Error('invalid project response')
  }
  const { source, ...rest } = wire
  const bytes = base64ToBytes(source)
  if (typeof rest.byteLength !== 'number' || rest.byteLength !== bytes.length) {
    throw new Error('project byte length mismatch')
  }
  if (wire.hasUnpublishedChanges !== (wire.currentRevisionId !== wire.servedRevisionId)) {
    throw new Error('invalid project pointers')
  }
  return {
    ...rest,
    source: bytes,
    hasUnpublishedChanges: wire.hasUnpublishedChanges,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isValidationLevel(value: unknown): value is ValidationLevel {
  return value === 'basic' || value === 'syntax' || value === 'static' || value === 'native'
}

function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === 'info' || value === 'warning' || value === 'error'
}

function decodeSpan(value: unknown): SourceSpan | null {
  if (value === null) return null
  if (!isRecord(value) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)) {
    throw new Error('invalid diagnostic span')
  }
  if ((value.start as number) < 0 || (value.end as number) < (value.start as number)) {
    throw new Error('invalid diagnostic span range')
  }
  return { start: value.start as number, end: value.end as number }
}

function decodeValidation(value: unknown): ValidationResult {
  if (!isRecord(value) || !isValidationLevel(value.level) || !Array.isArray(value.diagnostics)) {
    throw new Error('invalid validation result')
  }
  const diagnostics: Diagnostic[] = value.diagnostics.map((diagnostic) => {
    if (
      !isRecord(diagnostic) ||
      !isDiagnosticSeverity(diagnostic.severity) ||
      typeof diagnostic.code !== 'string' ||
      typeof diagnostic.message !== 'string'
    ) {
      throw new Error('invalid diagnostic')
    }
    return {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      span: decodeSpan(diagnostic.span),
    }
  })
  return { level: value.level, diagnostics }
}

function decodeProjectSummary(value: unknown): ProjectSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.targetId !== 'string' ||
    typeof value.fileName !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    typeof value.hasUnpublishedChanges !== 'boolean'
  ) {
    throw new Error('invalid project summary')
  }
  return {
    id: value.id,
    name: value.name,
    targetId: value.targetId as ProjectSummary['targetId'],
    fileName: value.fileName,
    updatedAt: value.updatedAt,
    byteLength: value.byteLength as number,
    lastValidation: decodeValidation(value.lastValidation),
    hasUnpublishedChanges: value.hasUnpublishedChanges,
  }
}

function decodeRevisionSummary(value: unknown): RevisionSummary {
  if (
    !isRecord(value) ||
    !isRevisionId(value.id) ||
    !Number.isSafeInteger(value.revisionNo) ||
    (value.revisionNo as number) < 1 ||
    (value.parentRevisionId !== null && !isRevisionId(value.parentRevisionId)) ||
    typeof value.createdAt !== 'string' ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 0 ||
    typeof value.contentHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.contentHash) ||
    (value.validatorVersion !== null && typeof value.validatorVersion !== 'string') ||
    typeof value.isCurrent !== 'boolean' ||
    typeof value.isServed !== 'boolean'
  ) {
    throw new Error('invalid revision summary')
  }
  return {
    id: value.id,
    revisionNo: value.revisionNo as number,
    parentRevisionId: value.parentRevisionId as string | null,
    createdAt: value.createdAt,
    byteLength: value.byteLength as number,
    contentHash: value.contentHash,
    validation: decodeValidation(value.validation),
    validatorVersion: value.validatorVersion as string | null,
    isCurrent: value.isCurrent,
    isServed: value.isServed,
  }
}

function decodeRevision(value: unknown): Revision {
  if (!isRecord(value) || typeof value.source !== 'string') {
    throw new Error('invalid revision response')
  }
  const summary = decodeRevisionSummary(value)
  const source = base64ToBytes(value.source)
  if (source.length !== summary.byteLength) {
    throw new Error('revision byte length mismatch')
  }
  return { ...summary, source }
}

const MAX_REVISION_ID_BYTES = 128
const MAX_DIFF_INPUT_BYTES = 8 * 1024 * 1024
const MAX_DIFF_OUTPUT_LINES = 10_000

function isRevisionDiffLineEnding(value: unknown): value is RevisionDiffLineEnding {
  return value === 'none' || value === 'lf' || value === 'crlf' || value === 'mixed'
}

function isRevisionDiffLineKind(value: unknown): value is RevisionDiffLineKind {
  return value === 'context' || value === 'delete' || value === 'insert'
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRevisionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_REVISION_ID_BYTES &&
    ![...value].some((character) => character < ' ' || character === '\u007f')
  )
}

function decodeRevisionDiffDocument(
  value: unknown,
  expectedId: string,
): RevisionDiffDocument {
  if (
    !isRecord(value) ||
    'source' in value ||
    typeof value.hasUtf8Bom !== 'boolean' ||
    !isRevisionDiffLineEnding(value.lineEnding) ||
    typeof value.trailingNewline !== 'boolean'
  ) {
    throw new Error('invalid revision diff document')
  }
  const summary = decodeRevisionSummary(value)
  if (!isRevisionId(summary.id) || summary.id !== expectedId) {
    throw new Error('revision diff direction mismatch')
  }
  return {
    ...summary,
    hasUtf8Bom: value.hasUtf8Bom,
    lineEnding: value.lineEnding,
    trailingNewline: value.trailingNewline,
  }
}

function decodeDiffLine(value: unknown): RevisionDiffLine {
  if (
    !isRecord(value) ||
    !isRevisionDiffLineKind(value.kind) ||
    !isSafeNonNegativeInteger(value.oldLineNo === null ? 0 : value.oldLineNo) ||
    !isSafeNonNegativeInteger(value.newLineNo === null ? 0 : value.newLineNo) ||
    (value.oldLineNo !== null && !Number.isSafeInteger(value.oldLineNo)) ||
    (value.newLineNo !== null && !Number.isSafeInteger(value.newLineNo)) ||
    typeof value.text !== 'string' ||
    value.text.includes('\n') ||
    !isRevisionDiffLineEnding(value.lineEnding) ||
    value.lineEnding === 'mixed'
  ) {
    throw new Error('invalid revision diff line')
  }
  const oldLineNo = value.oldLineNo as number | null
  const newLineNo = value.newLineNo as number | null
  if (
    (oldLineNo !== null && oldLineNo < 1) ||
    (newLineNo !== null && newLineNo < 1) ||
    (value.kind === 'context' && (oldLineNo === null || newLineNo === null)) ||
    (value.kind === 'delete' && (oldLineNo === null || newLineNo !== null)) ||
    (value.kind === 'insert' && (oldLineNo !== null || newLineNo === null))
  ) {
    throw new Error('invalid revision diff line numbers')
  }
  return {
    kind: value.kind,
    oldLineNo,
    newLineNo,
    text: value.text,
    lineEnding: value.lineEnding,
  }
}

function decodeDiffHunk(value: unknown): RevisionDiffHunk {
  if (
    !isRecord(value) ||
    !isSafeNonNegativeInteger(value.oldStart) ||
    !isSafeNonNegativeInteger(value.oldCount) ||
    !isSafeNonNegativeInteger(value.newStart) ||
    !isSafeNonNegativeInteger(value.newCount) ||
    !Array.isArray(value.lines) ||
    value.lines.length === 0 ||
    value.lines.length > MAX_DIFF_OUTPUT_LINES
  ) {
    throw new Error('invalid revision diff hunk')
  }
  const oldStart = value.oldStart as number
  const oldCount = value.oldCount as number
  const newStart = value.newStart as number
  const newCount = value.newCount as number
  if (oldStart < 1 || newStart < 1) {
    throw new Error('invalid revision diff hunk range')
  }
  const lines = value.lines.map(decodeDiffLine)
  let expectedOld = oldStart
  let expectedNew = newStart
  let consumedOld = 0
  let consumedNew = 0
  let changed = false
  for (const line of lines) {
    if (line.kind === 'context') {
      if (line.oldLineNo !== expectedOld || line.newLineNo !== expectedNew) {
        throw new Error('invalid context line range')
      }
      expectedOld += 1
      expectedNew += 1
      consumedOld += 1
      consumedNew += 1
    } else if (line.kind === 'delete') {
      if (line.oldLineNo !== expectedOld) throw new Error('invalid delete line range')
      expectedOld += 1
      consumedOld += 1
      changed = true
    } else {
      if (line.newLineNo !== expectedNew) throw new Error('invalid insert line range')
      expectedNew += 1
      consumedNew += 1
      changed = true
    }
  }
  if (!changed || consumedOld !== oldCount || consumedNew !== newCount) {
    throw new Error('hunk count does not match lines')
  }
  return { oldStart, oldCount, newStart, newCount, lines }
}

function decodeRevisionDiff(
  value: unknown,
  fromRevisionId: string,
  toRevisionId: string,
): RevisionDiff {
  if (
    !isRecord(value) ||
    'source' in value ||
    typeof value.identical !== 'boolean' ||
    !isSafeNonNegativeInteger(value.additions) ||
    !isSafeNonNegativeInteger(value.deletions) ||
    !Array.isArray(value.hunks)
  ) {
    throw new Error('invalid revision diff')
  }
  const from = decodeRevisionDiffDocument(value.from, fromRevisionId)
  const to = decodeRevisionDiffDocument(value.to, toRevisionId)
  if (
    from.byteLength > MAX_DIFF_INPUT_BYTES ||
    to.byteLength > MAX_DIFF_INPUT_BYTES ||
    from.byteLength + to.byteLength > MAX_DIFF_INPUT_BYTES
  ) {
    throw new Error('revision diff input is too large')
  }
  const additions = value.additions as number
  const deletions = value.deletions as number
  if (additions > MAX_DIFF_OUTPUT_LINES || deletions > MAX_DIFF_OUTPUT_LINES) {
    throw new Error('revision diff output is too large')
  }
  if (value.hunks.length > MAX_DIFF_OUTPUT_LINES) {
    throw new Error('revision diff output is too large')
  }
  const hunks = value.hunks.map(decodeDiffHunk)
  const outputLines = hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
  if (outputLines > MAX_DIFF_OUTPUT_LINES) throw new Error('revision diff output is too large')
  const actualAdditions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'insert').length,
    0,
  )
  const actualDeletions = hunks.reduce(
    (total, hunk) => total + hunk.lines.filter((line) => line.kind === 'delete').length,
    0,
  )
  if (actualAdditions !== additions || actualDeletions !== deletions) {
    throw new Error('revision diff counts do not match lines')
  }
  let previousOldEnd = 1
  let previousNewEnd = 1
  for (const hunk of hunks) {
    const oldEnd = hunk.oldStart + hunk.oldCount
    const newEnd = hunk.newStart + hunk.newCount
    if (!Number.isSafeInteger(oldEnd) || !Number.isSafeInteger(newEnd)) {
      throw new Error('revision diff hunk range overflow')
    }
    if (hunk.oldStart < previousOldEnd || hunk.newStart < previousNewEnd) {
      throw new Error('overlapping revision diff hunks')
    }
    previousOldEnd = oldEnd
    previousNewEnd = newEnd
  }
  const sameByteMetadata =
    from.contentHash === to.contentHash &&
    from.byteLength === to.byteLength &&
    from.hasUtf8Bom === to.hasUtf8Bom &&
    from.lineEnding === to.lineEnding &&
    from.trailingNewline === to.trailingNewline
  if (from.id === to.id && !sameByteMetadata) {
    throw new Error('same revision has contradictory byte metadata')
  }
  const sameIdentity = from.id === to.id || from.contentHash === to.contentHash
  if (sameIdentity !== value.identical) {
    throw new Error('invalid identical revision diff contract')
  }
  if (
    value.identical &&
    (!sameByteMetadata || additions !== 0 || deletions !== 0 || hunks.length !== 0)
  ) {
    throw new Error('identical revision diff contains changes')
  }
  return { from, to, identical: value.identical, additions, deletions, hunks }
}

function decodeRevisionPage(value: unknown, requestCursor?: string): RevisionPage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('invalid revision page')
  }
  if (value.nextCursor !== null && typeof value.nextCursor !== 'string') {
    throw new Error('invalid revision cursor')
  }
  if (
    typeof value.nextCursor === 'string' &&
    (value.nextCursor.length === 0 || value.nextCursor.length > 128)
  ) {
    throw new Error('invalid revision cursor')
  }
  const items = value.items.map(decodeRevisionSummary)
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error('duplicate revision')
    ids.add(item.id)
  }
  if (
    typeof value.nextCursor === 'string' &&
    value.nextCursor !== items[items.length - 1]?.id
  ) {
    throw new Error('cursor does not point at the last item')
  }
  if (typeof value.nextCursor === 'string' && value.nextCursor === requestCursor) {
    throw new Error('cursor repeats the request cursor')
  }
  const currentCount = items.filter((revision) => revision.isCurrent).length
  const servedCount = items.filter((revision) => revision.isServed).length
  if (currentCount > 1 || servedCount > 1) {
    throw new Error('invalid revision pointers')
  }
  if (items.length === 0 && value.nextCursor !== null) {
    throw new Error('empty revision page has a cursor')
  }
  return {
    items,
    nextCursor: value.nextCursor as string | null,
  }
}

function invalidResponse(): ApiError {
  return { code: API_ERROR.invalidResponse, message: 'ConfDock 服务返回了无效响应' }
}

function decodeIsoTimestamp(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('invalid token timestamp')
  }
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) throw new Error('timestamp must include timezone')
  return value
}

function decodeAccessToken(value: unknown): AccessToken {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.displayName !== 'string' ||
    value.displayName.trim() === '' ||
    typeof value.prefix !== 'string' ||
    typeof value.suffix !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('invalid access token')
  }
  return {
    id: value.id,
    displayName: value.displayName,
    prefix: value.prefix,
    suffix: value.suffix,
    createdAt: decodeIsoTimestamp(value.createdAt, false)!,
    lastUsedAt: decodeIsoTimestamp(value.lastUsedAt, true),
    expiresAt: decodeIsoTimestamp(value.expiresAt, true),
    revokedAt: decodeIsoTimestamp(value.revokedAt, true),
  }
}

function decodeCreatedAccessToken(value: unknown): CreatedAccessToken {
  if (!isRecord(value) || typeof value.plaintext !== 'string' || typeof value.url !== 'string') {
    throw new Error('invalid created token')
  }
  return {
    token: decodeAccessToken(value.token),
    plaintext: value.plaintext,
    url: value.url,
  }
}

function decodeProjectResult(wire: Wire['project']): Result<Project, ApiError> {
  try {
    return ok(decodeProject(wire))
  } catch {
    // A successful HTTP status does not make malformed JSON or Base64 safe to
    // consume. Keep the transport boundary total so screens never crash while
    // trying to render a broken server response.
    return err(invalidResponse())
  }
}

export function createHttpApi(baseUrl = ''): ConfDockApi {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Result<T, ApiError>> {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      return err({ code: 'network.unreachable', message: '无法连接到 ConfDock 服务' })
    }

    if (response.status === 204) return ok(undefined as T)

    let payload: unknown = null
    let text: string
    try {
      text = await response.text()
    } catch {
      return err({ code: 'network.unreachable', message: '无法读取 ConfDock 服务响应' })
    }
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }

    if (!response.ok) {
      const problem = payload as Partial<ApiError> | null
      return err({
        code:
          problem?.code ??
          (response.status === 409
            ? API_ERROR.revisionConflict
            : response.status === 401
              ? API_ERROR.unauthorized
              : `http.${response.status}`),
        message:
          problem?.message ??
          (response.status === 401 ? '登录已失效，请重新登录' : `服务返回 ${response.status}`),
        ...(problem?.validation ? { validation: problem.validation } : {}),
      })
    }
    if (payload === null) return err(invalidResponse())
    return ok(payload as T)
  }

  return {
    async currentSession(): Promise<Result<AdminSession | null, ApiError>> {
      const result = await request<Wire['session']>('GET', '/api/session')
      if (result.ok) return ok(result.value)
      if (result.error.code === 'http.404') return ok(null)
      return result
    },

    async signIn(password: string): Promise<Result<AdminSession, ApiError>> {
      return request<AdminSession>('POST', '/api/session', { password })
    },

    async signOut(): Promise<Result<void, ApiError>> {
      return request<void>('DELETE', '/api/session')
    },

    async changePassword(
      currentPassword: string,
      nextPassword: string,
    ): Promise<Result<void, ApiError>> {
      return request<void>('POST', '/api/admin/password', {
        currentPassword,
        nextPassword,
      })
    },

    async listProjects(): Promise<Result<ProjectSummary[], ApiError>> {
      const result = await request<unknown>('GET', '/api/projects')
      if (!result.ok) return result
      try {
        if (!Array.isArray(result.value)) throw new Error('invalid project list')
        return ok(result.value.map(decodeProjectSummary))
      } catch {
        return err(invalidResponse())
      }
    },

    async getProject(id: string): Promise<Result<Project, ApiError>> {
      const result = await request<Wire['project']>(
        'GET',
        `/api/projects/${encodeURIComponent(id)}`,
      )
      if (result.ok) return decodeProjectResult(result.value)
      if (result.error.code === 'http.404') {
        return err({ code: API_ERROR.notFound, message: '配置不存在' })
      }
      return result
    },

    async createProject(input: NewProject): Promise<Result<Project, ApiError>> {
      const result = await request<Wire['project']>('POST', '/api/projects', {
        name: input.name,
        targetId: input.targetId,
        fileName: input.fileName,
        source: bytesToBase64(input.source),
      })
      return result.ok ? decodeProjectResult(result.value) : result
    },

    async saveRevision({ projectId, source, expectedRevisionId }: SaveRevisionInput): Promise<Result<SaveResult, ApiError>> {
      const result = await request<Wire['saveResult']>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/revisions`,
        { source: bytesToBase64(source), expectedRevisionId },
      )
      if (!result.ok) return result
      try {
        if (!isRecord(result.value) || typeof result.value.unchanged !== 'boolean') {
          throw new Error('invalid save response')
        }
        const project = decodeProjectResult(result.value.project as Wire['project'])
        if (!project.ok) return project
        return ok({
          project: project.value,
          validation: decodeValidation(result.value.validation),
          unchanged: result.value.unchanged,
        })
      } catch {
        return err(invalidResponse())
      }
    },

    async publishProject({
      projectId,
      expectedCurrentRevisionId,
      expectedServedRevisionId,
    }: PublishProjectInput): Promise<Result<PublishResult, ApiError>> {
      const result = await request<Wire['publishResult']>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/publish`,
        { expectedCurrentRevisionId, expectedServedRevisionId },
      )
      if (!result.ok) {
        if (result.error.code === 'http.404') {
          return err({ code: API_ERROR.notFound, message: '配置不存在' })
        }
        return result
      }
      try {
        if (!isRecord(result.value) || typeof result.value.unchanged !== 'boolean') {
          throw new Error('invalid publish response')
        }
        const project = decodeProjectResult(result.value.project as Wire['project'])
        if (!project.ok) return project
        if (
          project.value.currentRevisionId !== expectedCurrentRevisionId ||
          project.value.servedRevisionId !== project.value.currentRevisionId ||
          project.value.hasUnpublishedChanges !== false
        ) {
          return err(invalidResponse())
        }
        return ok({ project: project.value, unchanged: result.value.unchanged })
      } catch {
        return err(invalidResponse())
      }
    },

    async listRevisions(
      projectId: string,
      options?: RevisionListOptions,
    ): Promise<Result<RevisionPage, ApiError>> {
      const params = new URLSearchParams()
      if (options?.limit !== undefined) params.set('limit', String(options.limit))
      if (options?.cursor !== undefined) params.set('cursor', options.cursor)
      const query = params.toString()
      const result = await request<unknown>(
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/revisions${query ? `?${query}` : ''}`,
      )
      if (!result.ok) {
        if (result.error.code === 'http.404') {
          return err({ code: API_ERROR.notFound, message: '配置不存在' })
        }
        return result
      }
      try {
        return ok(decodeRevisionPage(result.value, options?.cursor))
      } catch {
        return err(invalidResponse())
      }
    },

    async getRevision(
      projectId: string,
      revisionId: string,
    ): Promise<Result<Revision, ApiError>> {
      const result = await request<unknown>(
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}`,
      )
      if (!result.ok) {
        if (result.error.code === 'http.404') {
          return err({ code: API_ERROR.revisionNotFound, message: '版本不存在' })
        }
        return result
      }
      try {
        return ok(decodeRevision(result.value))
      } catch {
        return err(invalidResponse())
      }
    },

    async getRevisionDiff(
      projectId: string,
      fromRevisionId: string,
      toRevisionId: string,
    ): Promise<Result<RevisionDiff, ApiError>> {
      const params = new URLSearchParams()
      params.set('fromRevisionId', fromRevisionId)
      params.set('toRevisionId', toRevisionId)
      const result = await request<unknown>(
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/revisions/diff?${params.toString()}`,
      )
      if (!result.ok) {
        if (result.error.code === 'http.404') {
          return err({ code: API_ERROR.revisionNotFound, message: '版本不存在' })
        }
        if (result.error.code === 'http.413') {
          return err({
            code: API_ERROR.revisionDiffTooLarge,
            message: '差异过大，暂时无法在浏览器中显示',
          })
        }
        return result
      }
      try {
        return ok(decodeRevisionDiff(result.value, fromRevisionId, toRevisionId))
      } catch {
        return err(invalidResponse())
      }
    },

    async renameProject(
      id: string,
      name: string,
    ): Promise<Result<ProjectSummary, ApiError>> {
      return request<ProjectSummary>('PATCH', `/api/projects/${encodeURIComponent(id)}`, {
        name,
      })
    },

    async deleteProject(id: string): Promise<Result<void, ApiError>> {
      return request<void>('DELETE', `/api/projects/${encodeURIComponent(id)}`)
    },

    async listTokens(projectId: string): Promise<Result<AccessToken[], ApiError>> {
      const result = await request<unknown>(
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/tokens`,
      )
      if (!result.ok) return result
      try {
        if (!Array.isArray(result.value)) throw new Error('invalid token list')
        return ok(result.value.map(decodeAccessToken))
      } catch {
        return err(invalidResponse())
      }
    },

    async createToken(
      projectId: string,
      input?: CreateAccessTokenInput,
    ): Promise<Result<CreatedAccessToken, ApiError>> {
      const result = await request<unknown>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/tokens`,
        input,
      )
      if (!result.ok) return result
      try {
        return ok(decodeCreatedAccessToken(result.value))
      } catch {
        return err(invalidResponse())
      }
    },

    async updateToken(
      projectId: string,
      tokenId: string,
      input: UpdateAccessTokenInput,
    ): Promise<Result<AccessToken, ApiError>> {
      const result = await request<unknown>(
        'PATCH',
        `/api/projects/${encodeURIComponent(projectId)}/tokens/${encodeURIComponent(tokenId)}`,
        input,
      )
      if (!result.ok) return result
      try {
        return ok(decodeAccessToken(result.value))
      } catch {
        return err(invalidResponse())
      }
    },

    async revokeToken(projectId: string, tokenId: string): Promise<Result<void, ApiError>> {
      return request<void>(
        'DELETE',
        `/api/projects/${encodeURIComponent(projectId)}/tokens/${encodeURIComponent(tokenId)}`,
      )
    },

    async serviceInfo(): Promise<Result<ServiceInfo, ApiError>> {
      return request<ServiceInfo>('GET', '/api/service')
    },
  }
}

/** Re-exported so callers can compare a returned code without importing types. */
export { API_ERROR }
