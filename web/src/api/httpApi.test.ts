import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpApi } from './httpApi'

afterEach(() => vi.restoreAllMocks())

describe('HTTP API error boundary', () => {
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
