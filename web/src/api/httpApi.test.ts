import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpApi } from './httpApi'

afterEach(() => vi.restoreAllMocks())

describe('HTTP API error boundary', () => {
  it('maps a missing current session to signed out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(createHttpApi().currentSession()).resolves.toEqual({ ok: true, value: null })
  })

  it('surfaces network failures instead of returning an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await createHttpApi().listProjects()
    expect(result).toEqual({
      ok: false,
      error: { code: 'network.unreachable', message: '无法连接到 ConfDock 服务' },
    })
  })

  it('keeps 401 observable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    const result = await createHttpApi().listProjects()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('auth.unauthorized')
      expect(result.error.message).toContain('重新登录')
    }
  })

  it('returns 401 from signOut so AuthContext can clear the local session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    const result = await createHttpApi().signOut()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('auth.unauthorized')
      expect(result.error.message).toContain('重新登录')
    }
  })

  it('distinguishes an explicit 404 project from transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const result = await createHttpApi().getProject('missing')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('project.not_found')
  })

  it('maps a conflict response to revision.conflict', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await createHttpApi().saveRevision({
      projectId: 'p1',
      source: new Uint8Array([1]),
      expectedRevisionId: 'rev_old',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('revision.conflict')
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      source: 'AQ==',
      expectedRevisionId: 'rev_old',
    })
  })

  it('preserves validation diagnostics from a 422 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            code: 'validation.failed',
            message: '配置校验未通过，未保存',
            validation: {
              level: 'syntax',
              diagnostics: [
                {
                  severity: 'error',
                  code: 'json.syntax',
                  message: 'invalid JSON',
                  span: null,
                },
              ],
            },
          },
          { status: 422 },
        ),
      ),
    )
    const result = await createHttpApi().saveRevision({
      projectId: 'p1',
      source: new Uint8Array([123]),
      expectedRevisionId: 'rev_1',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('validation.failed')
      expect(result.error.validation?.diagnostics[0]?.code).toBe('json.syntax')
    }
  })

  it('uses standard Base64 on create and decodes native bytes in the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: 'p1',
        name: 'Bytes',
        targetId: 'sing-box',
        fileName: 'config.json',
        updatedAt: '2026-08-30T00:00:00Z',
        byteLength: 4,
        lastValidation: { level: 'syntax', diagnostics: [] },
        source: '77u/AQ==',
        currentRevisionId: 'r1',
        servedRevisionId: 'r1',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await createHttpApi().createProject({
      name: 'Bytes',
      targetId: 'sing-box',
      fileName: 'config.json',
      source: new Uint8Array([0xef, 0xbb, 0xbf, 1]),
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(Array.from(result.value.source)).toEqual([0xef, 0xbb, 0xbf, 1])
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).source).toBe('77u/AQ==')
    expect(fetchMock.mock.calls[0]![1].credentials).toBe('same-origin')
  })

  it('keeps a structured 500 observable without treating it as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          { code: 'internal.error', message: '服务暂时无法完成请求', requestId: 'safe-id' },
          { status: 500 },
        ),
      ),
    )
    const result = await createHttpApi().listProjects()
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal.error', message: '服务暂时无法完成请求' },
    })
  })

  it('turns an empty successful response into a transport error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })))
    const result = await createHttpApi().listProjects()
    expect(result).toEqual({
      ok: false,
      error: { code: 'network.invalid_response', message: 'ConfDock 服务返回了无效响应' },
    })
  })

  it('does not throw when a successful project response contains invalid Base64', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 'p1',
          name: 'Broken',
          targetId: 'sing-box',
          fileName: 'config.json',
          updatedAt: '2026-08-30T00:00:00Z',
          byteLength: 1,
          lastValidation: { level: 'syntax', diagnostics: [] },
          source: 'not base64',
          currentRevisionId: 'r1',
          servedRevisionId: 'r1',
        }),
      ),
    )
    const result = await createHttpApi().getProject('p1')
    expect(result).toEqual({
      ok: false,
      error: { code: 'network.invalid_response', message: 'ConfDock 服务返回了无效响应' },
    })
  })

  it('does not report failed deletes or token revocations as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('', { status: 500 })),
    ))
    const api = createHttpApi()
    const deleted = await api.deleteProject('p1')
    const revoked = await api.revokeToken('p1', 't1')
    expect(deleted.ok).toBe(false)
    expect(revoked.ok).toBe(false)
    if (!deleted.ok) expect(deleted.error.code).not.toBe('auth.unauthorized')
  })
})
