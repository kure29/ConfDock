import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Revision, RevisionDiff, RevisionPage, RevisionSummary } from '../api'
import {
  applyRevisionPage,
  beginRevisionPageRequest,
  createRevisionPaginationState,
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

function page(items: RevisionSummary[], nextCursor: string | null): RevisionPage {
  return { items, nextCursor }
}

function revisionDiff(): RevisionDiff {
  return {
    from: { ...summary('r1', 1), hasUtf8Bom: false, lineEnding: 'lf', trailingNewline: true },
    to: { ...summary('r2', 2, true), hasUtf8Bom: false, lineEnding: 'lf', trailingNewline: true },
    identical: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: 'context', oldLineNo: 1, newLineNo: 1, text: 'old', lineEnding: 'lf' },
          { kind: 'insert', oldLineNo: null, newLineNo: 2, text: 'new', lineEnding: 'none' },
        ],
      },
    ],
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
    expect(markup).not.toContain('· ·')
    expect(markup.match(/<span aria-hidden="true">·<\/span>/g)).toHaveLength(2)

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

  it('offers parent comparison and keeps the initial revision explicitly non-comparable', () => {
    const withParent = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({ selectedId: 'r2', detail: { ...summary('r2', 2, true), source: new Uint8Array([1]) } })}
      />,
    )
    expect(withParent).toContain('与上一版本比较')

    const initial = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({
          revisions: [summary('r1', 1)],
          selectedId: 'r1',
          detail: { ...summary('r1', 1), source: new Uint8Array([1]) },
        })}
      />,
    )
    expect(initial).not.toContain('与上一版本比较')
    expect(initial).toContain('这是初始版本，没有上一版本可比较')
  })

  it('renders diff loading, success, identical, and retryable error states', () => {
    const loading = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({
          selectedId: 'r2',
          detail: { ...summary('r2', 2, true), source: new Uint8Array([1]) },
          diffVisible: true,
          diffLoading: true,
        })}
      />,
    )
    expect(loading).toContain('role="status"')
    expect(loading).toContain('正在读取版本差异')

    const success = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({
          selectedId: 'r2',
          detail: { ...summary('r2', 2, true), source: new Uint8Array([1]) },
          diffVisible: true,
          diff: revisionDiff(),
        })}
      />,
    )
    expect(success).toContain('差异块 1')
    expect(success).toContain('版本 1')

    const identical = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({
          selectedId: 'r2',
          detail: { ...summary('r2', 2, true), source: new Uint8Array([1]) },
          diffVisible: true,
          diff: { ...revisionDiff(), identical: true, additions: 0, deletions: 0, hunks: [] },
        })}
      />,
    )
    expect(identical).toContain('两个版本的原始字节完全一致')

    const failed = renderToStaticMarkup(
      <RevisionHistoryView
        {...viewProps({
          selectedId: 'r2',
          detail: { ...summary('r2', 2, true), source: new Uint8Array([1]) },
          diffVisible: true,
          diffError: '差异读取失败',
        })}
      />,
    )
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('重试差异读取')
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

describe('revision pagination state transitions', () => {
  it('rejects a response that repeats its request cursor and keeps loaded items', () => {
    const first = applyRevisionPage(
      createRevisionPaginationState(),
      null,
      page([summary('A', 2, true)], 'A'),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const started = beginRevisionPageRequest(first.state, 'A')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const blocked = applyRevisionPage(started.state, 'A', page([summary('A', 2, true)], 'A'))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.reason).toBe('same_cursor')
      expect(blocked.state.nextCursor).toBe(null)
      expect(blocked.state.revisions.map((revision) => revision.id)).toEqual(['A'])
    }
  })

  it('rejects an A to B to A cycle before another page can be requested', () => {
    const first = applyRevisionPage(
      createRevisionPaginationState(),
      null,
      page([summary('A', 3, true)], 'A'),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstRequest = beginRevisionPageRequest(first.state, 'A')
    expect(firstRequest.ok).toBe(true)
    if (!firstRequest.ok) return
    const second = applyRevisionPage(firstRequest.state, 'A', page([summary('B', 2)], 'B'))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const secondRequest = beginRevisionPageRequest(second.state, 'B')
    expect(secondRequest.ok).toBe(true)
    if (!secondRequest.ok) return

    const blocked = applyRevisionPage(secondRequest.state, 'B', page([summary('A', 1)], 'A'))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.reason).toBe('cursor_cycle')
      expect(blocked.state.nextCursor).toBe(null)
      expect(blocked.state.revisions.map((revision) => revision.id)).toEqual(['A', 'B'])
    }
    const repeatedRequest = beginRevisionPageRequest(blocked.state, 'A')
    expect(repeatedRequest.ok).toBe(false)
    if (!repeatedRequest.ok) expect(repeatedRequest.reason).toBe('cursor_unavailable')
  })

  it('does not start a second request for an already reserved cursor', () => {
    const initial = applyRevisionPage(
      createRevisionPaginationState(),
      null,
      page([summary('A', 2, true)], 'A'),
    )
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const firstRequest = beginRevisionPageRequest(initial.state, 'A')
    expect(firstRequest.ok).toBe(true)
    if (!firstRequest.ok) return
    const duplicateRequest = beginRevisionPageRequest(firstRequest.state, 'A')
    expect(duplicateRequest.ok).toBe(false)
    if (!duplicateRequest.ok) expect(duplicateRequest.reason).toBe('cursor_repeated')
  })

  it('completes normal A to B to null pagination', () => {
    const initial = applyRevisionPage(
      createRevisionPaginationState(),
      null,
      page([summary('A', 3, true)], 'A'),
    )
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const firstRequest = beginRevisionPageRequest(initial.state, 'A')
    expect(firstRequest.ok).toBe(true)
    if (!firstRequest.ok) return
    const second = applyRevisionPage(firstRequest.state, 'A', page([summary('B', 2)], 'B'))
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const secondRequest = beginRevisionPageRequest(second.state, 'B')
    expect(secondRequest.ok).toBe(true)
    if (!secondRequest.ok) return
    const complete = applyRevisionPage(secondRequest.state, 'B', page([summary('C', 1)], null))
    expect(complete.ok).toBe(true)
    if (complete.ok) {
      expect(complete.state.nextCursor).toBe(null)
      expect(complete.state.revisions.map((revision) => revision.id)).toEqual(['A', 'B', 'C'])
    }
  })

  it('resets the cursor set for a new project or full retry cycle', () => {
    const initial = applyRevisionPage(
      createRevisionPaginationState(),
      null,
      page([summary('A', 2, true)], 'A'),
    )
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    const request = beginRevisionPageRequest(initial.state, 'A')
    expect(request.ok).toBe(true)
    if (!request.ok) return
    const next = applyRevisionPage(request.state, 'A', page([summary('B', 1)], 'B'))
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.state.seenCursors).toEqual(new Set(['A', 'B']))

    const reset = createRevisionPaginationState()
    expect(reset.revisions).toEqual([])
    expect(reset.nextCursor).toBe(null)
    expect(reset.seenCursors).toEqual(new Set())
    expect(reset.requestedCursors).toEqual(new Set())
  })
})
