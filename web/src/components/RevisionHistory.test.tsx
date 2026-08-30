import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Revision, RevisionSummary } from '../api'
import {
  RevisionHistory,
  RevisionHistoryView,
  isRevisionRequestCurrent,
  mergeRevisionItems,
} from './RevisionHistory'

function summary(id: string, revisionNo: number, current = false): RevisionSummary {
  return {
    id,
    revisionNo,
    parentRevisionId: revisionNo > 1 ? `r${revisionNo - 1}` : null,
    createdAt: '2026-08-30T00:00:00Z',
    byteLength: 3,
    contentHash: 'a'.repeat(64),
    validation: { level: 'syntax', diagnostics: [] },
    validatorVersion: null,
    isCurrent: current,
    isServed: current,
  }
}

function viewProps(overrides: Partial<Parameters<typeof RevisionHistoryView>[0]> = {}) {
  return {
    revisions: [summary('r2', 2, true), summary('r1', 1)],
    selectedId: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    nextCursor: null,
    loadingMore: false,
    loadMoreError: null,
    onSelect: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides,
  }
}

describe('RevisionHistory view states', () => {
  it('starts with an accessible loading status before the first page arrives', () => {
    const markup = renderToStaticMarkup(<RevisionHistory projectId="p1" refreshKey={0} />)
    expect(markup).toContain('role="status"')
    expect(markup).toContain('正在读取版本历史')
  })

  it('renders a bounded-page control and preserves selected-row semantics', () => {
    const markup = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ nextCursor: 'r1', selectedId: 'r2' })}
      />,
    )
    expect(markup).toContain('加载更早版本')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('aria-labelledby="revision-list-heading"')

    const loadingMarkup = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ nextCursor: 'r1', loadingMore: true })}
      />,
    )
    expect(loadingMarkup).toContain('aria-label="正在加载更早版本…"')
  })

  it('keeps a load-more failure actionable without discarding the current list', () => {
    const markup = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ loadMoreError: '网络暂时不可用', nextCursor: 'r1' })}
      />,
    )
    expect(markup).toContain('网络暂时不可用')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('重试')
    expect(markup).toContain('版本 2')
  })

  it('exposes detail loading and retry states as live, actionable content', () => {
    const loading = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ selectedId: 'r2', detailLoading: true })}
      />,
    )
    expect(loading).toContain('role="status"')
    expect(loading).toContain('正在读取这个版本')

    const failed = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ selectedId: 'r2', detailError: '版本读取失败' })}
      />,
    )
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('版本读取失败')
    expect(failed).toContain('重试')
  })

  it('renders selected source bytes as a read-only editor', () => {
    const selected: Revision = {
      ...summary('r2', 2, true),
      source: new Uint8Array([0x7b, 0x7d, 0x0a]),
    }
    const markup = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ selectedId: 'r2', detail: selected })}
      />,
    )
    expect(markup).toContain('aria-label="历史版本源码（只读）"')
    expect(markup).toContain('readOnly=""')
  })
})

describe('revision page merging', () => {
  it('deduplicates repeated cursor pages while preserving server order', () => {
    const merged = mergeRevisionItems(
      [summary('r3', 3, true), summary('r2', 2)],
      [summary('r2', 2), summary('r1', 1), summary('r1', 1)],
    )
    expect(merged.map((revision) => revision.id)).toEqual(['r3', 'r2', 'r1'])
  })

  it('ignores responses owned by an older request serial', () => {
    expect(isRevisionRequestCurrent(4, 4)).toBe(true)
    expect(isRevisionRequestCurrent(5, 4)).toBe(false)
  })
})
