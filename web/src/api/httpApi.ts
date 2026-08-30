import type { Result, ValidationResult } from '../core/types'
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
  SaveResult,
  ServiceInfo,
} from './types'

/**
 * The Axum client. Not wired up yet — Slice 1 builds the service this talks to.
 *
 * It is written now, and kept next to `mockApi.ts`, so the REST contract is a
 * concrete artifact rather than a paragraph of prose that drifts. `web/README.md`
 * documents the same shape.
 *
 * Wire format: the management API is JSON throughout, with document bytes
 * base64-encoded in a `source` field. Only `GET /sub/:token` returns raw bytes,
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
  const { source, ...rest } = wire
  return { ...rest, source: base64ToBytes(source) }
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
      if (result.ok) return ok(decodeProject(result.value))
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
      return result.ok ? ok(decodeProject(result.value)) : result
    },

    async saveRevision({ projectId, source, expectedRevisionId }: SaveRevisionInput): Promise<Result<SaveResult, ApiError>> {
      const result = await request<Wire['saveResult']>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/revisions`,
        { source: bytesToBase64(source), expectedRevisionId },
      )
      if (!result.ok) return result
      return ok({
        project: decodeProject(result.value.project),
        validation: result.value.validation,
        unchanged: result.value.unchanged,
      })
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
