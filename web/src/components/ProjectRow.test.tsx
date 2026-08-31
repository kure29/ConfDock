import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '../api'
import { ProjectRow } from './ProjectRow'

const project: ProjectSummary = {
  id: 'p1',
  name: 'Draft',
  targetId: 'sing-box',
  fileName: 'config.json',
  updatedAt: '2026-08-30T00:00:00Z',
  byteLength: 12,
  lastValidation: { level: 'syntax', diagnostics: [] },
  hasUnpublishedChanges: true,
}

describe('ProjectRow', () => {
  it('shows an unpublished badge when current and served pointers differ', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ProjectRow project={project} />
      </MemoryRouter>,
    )
    expect(markup).toContain('未发布')
  })

  it('does not show an unpublished badge when pointers match', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ProjectRow project={{ ...project, hasUnpublishedChanges: false }} />
      </MemoryRouter>,
    )
    expect(markup).not.toContain('未发布')
  })
})
