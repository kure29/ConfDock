import type { Result, ValidationResult } from '../core/types'
import { err, ok } from '../core/types'
import { base64ToBytes, bytesToBase64 } from '../lib/bytes'
import type { ConfDockApi } from './ConfDockApi'
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
    const text = await response.text()
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
        code: problem?.code ?? `http.${response.status}`,
        message: problem?.message ?? `服务返回 ${response.status}`,
        ...(problem?.validation ? { validation: problem.validation } : {}),
      })
    }
    return ok(payload as T)
  }

  /** For endpoints whose failure is not actionable — a rejected promise there
   * would only produce an unhandled error, so they resolve to a fallback. */
  async function requestOr<T>(method: string, path: string, fallback: T): Promise<T> {
    const result = await request<T>(method, path)
    return result.ok ? result.value : fallback
  }

  return {
    async currentSession(): Promise<AdminSession | null> {
      const result = await request<Wire['session']>('GET', '/api/session')
      return result.ok ? result.value : null
    },

    async signIn(password: string): Promise<Result<AdminSession, ApiError>> {
      return request<AdminSession>('POST', '/api/session', { password })
    },

    async signOut(): Promise<void> {
      await request<void>('DELETE', '/api/session')
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

    async listProjects(): Promise<ProjectSummary[]> {
      return requestOr<ProjectSummary[]>('GET', '/api/projects', [])
    },

    async getProject(id: string): Promise<Project | null> {
      const result = await request<Wire['project']>(
        'GET',
        `/api/projects/${encodeURIComponent(id)}`,
      )
      return result.ok ? decodeProject(result.value) : null
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

    async saveRevision(
      id: string,
      source: Uint8Array,
    ): Promise<Result<SaveResult, ApiError>> {
      const result = await request<Wire['saveResult']>(
        'POST',
        `/api/projects/${encodeURIComponent(id)}/revisions`,
        { source: bytesToBase64(source) },
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

    async deleteProject(id: string): Promise<void> {
      await request<void>('DELETE', `/api/projects/${encodeURIComponent(id)}`)
    },

    async listTokens(projectId: string): Promise<AccessToken[]> {
      return requestOr<AccessToken[]>(
        'GET',
        `/api/projects/${encodeURIComponent(projectId)}/tokens`,
        [],
      )
    },

    async createToken(projectId: string): Promise<Result<CreatedAccessToken, ApiError>> {
      return request<CreatedAccessToken>(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/tokens`,
      )
    },

    async revokeToken(projectId: string, tokenId: string): Promise<void> {
      await request<void>(
        'DELETE',
        `/api/projects/${encodeURIComponent(projectId)}/tokens/${encodeURIComponent(tokenId)}`,
      )
    },

    async serviceInfo(): Promise<ServiceInfo> {
      return requestOr<ServiceInfo>('GET', '/api/service', {
        version: 'unknown',
        core: 'wasm',
        api: 'http',
        subscriptionBase: `${window.location.origin}/sub`,
      })
    },
  }
}

/** Re-exported so callers can compare a returned code without importing types. */
export { API_ERROR }
