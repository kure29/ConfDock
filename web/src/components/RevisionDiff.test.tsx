import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RevisionDiff } from '../api'
import { RevisionDiff as RevisionDiffView } from './RevisionDiff'

function document(id: string, revisionNo: number): RevisionDiff['from'] {
  return {
    id,
    revisionNo,
    parentRevisionId: revisionNo > 1 ? `r${revisionNo - 1}` : null,
    createdAt: '2026-08-30T00:00:00Z',
    byteLength: 8,
    contentHash: revisionNo === 1 ? 'a'.repeat(64) : 'b'.repeat(64),
    validation: { level: 'syntax', diagnostics: [] },
    validatorVersion: null,
    isCurrent: revisionNo === 2,
    isServed: revisionNo === 2,
    hasUtf8Bom: revisionNo === 1,
    lineEnding: revisionNo === 1 ? 'crlf' : 'mixed',
    trailingNewline: revisionNo === 1,
  }
}

function diff(overrides: Partial<RevisionDiff> = {}): RevisionDiff {
  return {
    from: document('r1', 1),
    to: document('r2', 2),
    identical: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 3,
        newStart: 1,
        newCount: 3,
        lines: [
          { kind: 'context', oldLineNo: 1, newLineNo: 1, text: 'same', lineEnding: 'lf' },
          { kind: 'delete', oldLineNo: 2, newLineNo: null, text: 'old  ', lineEnding: 'crlf' },
          { kind: 'insert', oldLineNo: null, newLineNo: 2, text: 'new  ', lineEnding: 'none' },
          { kind: 'context', oldLineNo: 3, newLineNo: 3, text: '', lineEnding: 'lf' },
        ],
      },
    ],
    ...overrides,
  }
}

describe('RevisionDiff view', () => {
  it('renders direction, counts, dual line numbers, whitespace, and line endings', () => {
    const markup = renderToStaticMarkup(<RevisionDiffView diff={diff()} />)
    expect(markup).toContain('版本 1')
    expect(markup).toContain('版本 2')
    expect(markup).toContain('+1 新增行')
    expect(markup).toContain('−1 删除行')
    expect(markup).toContain('old  ')
    expect(markup).toContain('Windows 换行')
    expect(markup).toContain('EOF')
    expect(markup).toContain('上下文行，旧行 1，新行 1，标准换行：')
    expect(markup).toContain('删除行，旧行 2，Windows 换行：')
    expect(markup).toContain('新增行，新行 2，EOF：')
    expect(markup).toContain('>same</span>')
    expect(markup).toContain('>old  </span>')
    expect(markup).toContain('>new  </span>')
    expect(markup).toContain('空行')
    const lineTags = markup.match(/<li[^>]*>/g) ?? []
    expect(lineTags).toHaveLength(4)
    expect(lineTags.every((tag) => !tag.includes('aria-label'))).toBe(true)
  })

  it('renders an explicit identical state without hunk rows', () => {
    const markup = renderToStaticMarkup(
      <RevisionDiffView diff={diff({ identical: true, additions: 0, deletions: 0, hunks: [] })} />,
    )
    expect(markup).toContain('两个版本的配置内容完全一致')
    expect(markup).not.toContain('差异块 1')
  })

  it('renders metadata changes even when there are no line hunks', () => {
    const markup = renderToStaticMarkup(
      <RevisionDiffView diff={diff({ additions: 0, deletions: 0, hunks: [] })} />,
    )
    expect(markup).toContain('只有文件标记或其他文件信息不同')
    expect(markup).toContain('文件标记')
  })
})
