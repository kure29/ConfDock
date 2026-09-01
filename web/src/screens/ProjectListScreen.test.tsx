import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSummary } from '../api'
import { ProjectListScreen } from './ProjectListScreen'

const mocks = vi.hoisted(() => ({
  api: { listProjects: vi.fn() },
  navigate: vi.fn(),
}))

vi.mock('../api', () => ({ api: mocks.api }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('../components', () => ({
  ProjectRow: ({ project }: { project: ProjectSummary }) => <li>{project.name}</li>,
}))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const project: ProjectSummary = {
  id: 'p1',
  name: 'Demo',
  targetId: 'sing-box',
  fileName: 'config.json',
  updatedAt: '2026-08-31T00:00:00Z',
  byteLength: 2,
  lastValidation: { level: 'syntax', diagnostics: [] },
  hasUnpublishedChanges: false,
}

beforeEach(() => {
  mocks.api.listProjects.mockReset()
  mocks.navigate.mockReset()
})

async function renderWith(projects: ProjectSummary[]) {
  const response = deferred<{ ok: true; value: ProjectSummary[] }>()
  mocks.api.listProjects.mockReturnValueOnce(response.promise)
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(<ProjectListScreen />)
  })
  await act(async () => {
    response.resolve({ ok: true, value: projects })
    await response.promise
  })
  return renderer
}

describe('ProjectListScreen import entry points', () => {
  it('shows one import button in the empty state', async () => {
    const renderer = await renderWith([])
    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('管理已导入的客户端配置。')
    expect(markup).not.toContain('校验分层')
    expect(markup).not.toContain('最深一层')
    expect(markup).toContain('导入一份配置即可开始。')
    const buttons = renderer.root.findAllByType('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.props.children).toBe('导入配置')
    await act(async () => buttons[0]?.props.onClick())
    expect(mocks.navigate).toHaveBeenCalledWith('/new')
    renderer.unmount()
  })

  it('shows only the top import button when projects exist', async () => {
    const renderer = await renderWith([project])
    const buttons = renderer.root.findAllByType('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.props.children).toBe('导入配置')
    await act(async () => buttons[0]?.props.onClick())
    expect(mocks.navigate).toHaveBeenCalledWith('/new')
    renderer.unmount()
  })
})
