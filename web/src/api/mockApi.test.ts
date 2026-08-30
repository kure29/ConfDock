import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from './mockApi'
import { encodeUtf8 } from '../lib/bytes'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe('mock revision boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('setTimeout', ((callback: () => void) => {
      callback()
      return 0
    }) as typeof setTimeout)
  })

  it('rejects stale expectedRevisionId without changing stored bytes', async () => {
    const api = createMockApi('https://example.invalid/sub')
    const listed = await api.listProjects()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const first = await api.getProject(listed.value[0]!.id)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const original = new Uint8Array(first.value.source)

    const saved = await api.saveRevision({
      projectId: first.value.id,
      source: encodeUtf8('mixed-port: 7890\n'),
      expectedRevisionId: first.value.currentRevisionId,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const stale = await api.saveRevision({
      projectId: first.value.id,
      source: encodeUtf8('mixed-port: 9999\n'),
      expectedRevisionId: first.value.currentRevisionId,
    })
    expect(stale).toEqual({
      ok: false,
      error: {
        code: 'revision.conflict',
        message: '配置已被其他页面更新，请重新加载后再保存',
      },
    })

    const current = await api.getProject(first.value.id)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    expect(new TextDecoder().decode(current.value.source)).toBe(
      new TextDecoder().decode(saved.value.project.source),
    )
    expect(new TextDecoder().decode(current.value.source)).not.toBe(
      new TextDecoder().decode(original),
    )
    expect(current.value.currentRevisionId).toBe(saved.value.project.currentRevisionId)
  })
})
