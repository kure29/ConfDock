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
    expect(fetchMock.mock.calls[0]![1].cache).toBe('no-store')
  })

  it('decodes ordered revision history metadata without loading source bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          {
            id: 'r2',
            revisionNo: 2,
            parentRevisionId: 'r1',
            createdAt: '2026-08-30T00:00:01Z',
            byteLength: 4,
            contentHash: 'a'.repeat(64),
            validation: { level: 'syntax', diagnostics: [] },
            validatorVersion: null,
            isCurrent: true,
            isServed: true,
          },
        ],
        nextCursor: null,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await createHttpApi().listRevisions('project/1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.items[0]?.id).toBe('r2')
      expect(result.value.items[0]?.parentRevisionId).toBe('r1')
      expect(result.value.nextCursor).toBe(null)
    }
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/project%2F1/revisions')
  })

  it('encodes a bounded revision page cursor and limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          {
            id: 'revision/3',
            revisionNo: 3,
            parentRevisionId: 'revision/4',
            createdAt: '2026-08-29T00:00:00Z',
            byteLength: 2,
            contentHash: 'c'.repeat(64),
            validation: { level: 'basic', diagnostics: [] },
            validatorVersion: null,
            isCurrent: false,
            isServed: false,
          },
        ],
        nextCursor: 'revision/3',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const result = await createHttpApi().listRevisions('p1', {
      limit: 25,
      cursor: 'revision/2',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.nextCursor).toBe('revision/3')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/projects/p1/revisions?limit=25&cursor=revision%2F2',
    )
  })

  it('loads one revision source and rejects a byte-length mismatch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 'r1',
          revisionNo: 1,
          parentRevisionId: null,
          createdAt: '2026-08-30T00:00:00Z',
          byteLength: 3,
          contentHash: 'b'.repeat(64),
          validation: { level: 'syntax', diagnostics: [] },
          validatorVersion: null,
          isCurrent: false,
          isServed: false,
          source: 'e30=',
        }),
      ),
    )
    const result = await createHttpApi().getRevision('p1', 'r1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('network.invalid_response')
  })

  it('decodes a valid revision detail as native bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 'r1',
          revisionNo: 1,
          parentRevisionId: null,
          createdAt: '2026-08-30T00:00:00Z',
          byteLength: 3,
          contentHash: 'b'.repeat(64),
          validation: { level: 'syntax', diagnostics: [] },
          validatorVersion: null,
          isCurrent: true,
          isServed: true,
          source: 'e30A',
        }),
      ),
    )
    const result = await createHttpApi().getRevision('p1', 'r1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(Array.from(result.value.source)).toEqual([0x7b, 0x7d, 0x00])
  })

  it('rejects malformed revision lists at the HTTP boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ items: [{ id: 'broken' }], nextCursor: null })),
    )
    const result = await createHttpApi().listRevisions('p1')
    expect(result).toEqual({
      ok: false,
      error: { code: 'network.invalid_response', message: 'ConfDock 服务返回了无效响应' },
    })
  })

  it('rejects a page cursor that does not identify its last item', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          items: [
            {
              id: 'r1',
              revisionNo: 1,
              parentRevisionId: null,
              createdAt: '2026-08-30T00:00:00Z',
              byteLength: 2,
              contentHash: 'd'.repeat(64),
              validation: { level: 'basic', diagnostics: [] },
              validatorVersion: null,
              isCurrent: false,
              isServed: false,
            },
          ],
          nextCursor: 'r0',
        }),
      ),
    )
    const result = await createHttpApi().listRevisions('p1', { cursor: 'r2' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('network.invalid_response')
  })

  it('maps a missing revision to a stable revision.not_found error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    const result = await createHttpApi().getRevision('p1', 'missing')
    expect(result).toEqual({
      ok: false,
      error: { code: 'revision.not_found', message: '版本不存在' },
    })
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
