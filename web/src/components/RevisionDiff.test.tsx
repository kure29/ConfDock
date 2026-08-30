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
        oldCount: 2,
        newStart: 1,
        newCount: 2,
        lines: [
          { kind: 'context', oldLineNo: 1, newLineNo: 1, text: '', lineEnding: 'lf' },
          { kind: 'delete', oldLineNo: 2, newLineNo: null, text: 'old  ', lineEnding: 'crlf' },
          { kind: 'insert', oldLineNo: null, newLineNo: 2, text: 'new  ', lineEnding: 'none' },
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
    expect(markup).toContain('CRLF')
    expect(markup).toContain('EOF')
    expect(markup).toContain('aria-label="旧行 2，CRLF"')
    expect(markup).toContain('aria-label="新行 2，EOF"')
  })

  it('renders an explicit identical state without hunk rows', () => {
    const markup = renderToStaticMarkup(
      <RevisionDiffView diff={diff({ identical: true, additions: 0, deletions: 0, hunks: [] })} />,
    )
    expect(markup).toContain('两个版本的原始字节完全一致')
    expect(markup).not.toContain('差异块 1')
  })

  it('renders metadata changes even when there are no line hunks', () => {
    const markup = renderToStaticMarkup(
      <RevisionDiffView diff={diff({ additions: 0, deletions: 0, hunks: [] })} />,
    )
    expect(markup).toContain('只有 BOM 或元数据不同')
    expect(markup).toContain('BOM')
  })
})
