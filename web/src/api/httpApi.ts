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
import type { ConfDockApi, SaveRevisionInput } from './ConfDockApi'
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
  RevisionSummary,
  SaveResult,
  ServiceInfo,
} from './types'

/**
 * The Axum client. `web/README.md` documents the same REST shape.
 *
 * Wire format: the management API is JSON throughout, with document bytes
 * base64-encoded in a `source` field. History lists intentionally omit source;
 * `getRevision()` loads one selected immutable entry when the administrator
 * asks to inspect it. Only `GET /sub/:token` returns raw bytes directly,
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
  createdToken: { token: AccessToken; plaintext: string; url: string }
}

function decodeProject(wire: Wire['project']): Project {
  if (wire === null || typeof wire !== 'object' || typeof wire.source !== 'string') {
    throw new Error('invalid project response')
  }
  const { source, ...rest } = wire
  return { ...rest, source: base64ToBytes(source) }
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

function decodeRevisionSummary(value: unknown): RevisionSummary {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.revisionNo) ||
    (value.revisionNo as number) < 1 ||
    (value.parentRevisionId !== null && typeof value.parentRevisionId !== 'string') ||
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

function invalidResponse(): ApiError {
  return { code: API_ERROR.invalidResponse, message: 'ConfDock 服务返回了无效响应' }
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
      return request<ProjectSummary[]>('GET', '/api/projects')
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
      const project = decodeProjectResult(result.value.project)
      if (!project.ok) return project
      return ok({
        project: project.value,
        validation: result.value.validation,
        unchanged: result.value.unchanged,
      })
    },

    async listRevisions(projectId: string): Promise<Result<RevisionSummary[], ApiError>> {
      const result = await request<unknown>(
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/revisions`,
      )
      if (!result.ok) {
        if (result.error.code === 'http.404') {
          return err({ code: API_ERROR.notFound, message: '配置不存在' })
        }
        return result
      }
      try {
        if (!Array.isArray(result.value)) throw new Error('invalid revision list')
        const revisions = result.value.map(decodeRevisionSummary)
        if (
          revisions.length === 0 ||
          revisions.filter((revision) => revision.isCurrent).length !== 1 ||
          revisions.filter((revision) => revision.isServed).length !== 1
        ) {
          throw new Error('invalid revision pointers')
        }
        return ok(revisions)
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
      return request<AccessToken[]>('GET', `/api/projects/${encodeURIComponent(projectId)}/tokens`)
    },

    async createToken(projectId: string): Promise<Result<CreatedAccessToken, ApiError>> {
      return request<CreatedAccessToken>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/tokens`,
      )
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
