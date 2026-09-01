import { act, create } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiError, Project, ProjectSummary, PublishResult, SaveResult } from '../api'
import type { Result } from '../core'
import { EditorScreen } from '../screens/EditorScreen'
import { useProject } from './useProject'
import type { ProjectEditor } from './useProject'

const mocks = vi.hoisted(() => ({
  route: { id: 'p1' },
  toast: { notify: vi.fn(), fail: vi.fn() },
  api: {
    getProject: vi.fn(),
    saveRevision: vi.fn(),
    publishProject: vi.fn(),
    renameProject: vi.fn(),
  },
  core: {
    descriptor: (id: string) => ({ displayName: `Registry ${id}` }),
    documentInfo: (source: Uint8Array) => ({
      encoding: 'utf8' as const,
      lineEnding: 'lf' as const,
      hasTrailingNewline: source.length > 0 && source[source.length - 1] === 10,
      byteLength: source.byteLength,
    }),
    validate: () => ({ level: 'basic' as const, diagnostics: [] }),
    parse: () => ({ ok: true as const, value: { info: undefined, fields: [] } }),
    applyEdit: () => ({ ok: true as const, value: new Uint8Array() }),
    editCapabilities: () => ({
      rawEdit: true,
      validationLevel: 'basic' as const,
      nativeValidation: false,
      sections: [],
    }),
  },
}))

vi.mock('../api', () => ({ api: mocks.api }))
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children?: ReactNode }) => children ?? null,
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: mocks.route.id }),
}))
vi.mock('./ToastContext', () => ({ useToast: () => mocks.toast }))
vi.mock('../components', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => children ?? null
  return {
    CapabilityNotice: Passthrough,
    DiagnosticList: Passthrough,
    RevisionHistory: Passthrough,
    ServedUrlDialog: () => null,
    SourceEditor: Passthrough,
    StructuredFieldList: Passthrough,
    TargetBadge: () => null,
    ValidationLevelBadge: () => null,
    diagnosticMarkers: () => [],
  }
})
vi.mock('../core', () => ({
  core: mocks.core,
  ok: (value: unknown) => ({ ok: true as const, value }),
  err: (error: unknown) => ({ ok: false as const, error }),
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function result<T>(value: T): Result<T, ApiError> {
  return { ok: true, value }
}

function failure<T = never>(code: ApiError['code']): Result<T, ApiError> {
  return { ok: false, error: { code, message: code } }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function project(
  id: string,
  overrides: Partial<Project> = {},
): Project {
  const source = overrides.source ?? bytes('base\n')
  return {
    id,
    name: 'Original name',
    targetId: 'sing-box',
    fileName: 'config.json',
    updatedAt: '2026-08-31T00:00:00Z',
    lastValidation: { level: 'basic', diagnostics: [] },
    hasUnpublishedChanges: false,
    source,
    currentRevisionId: 'r1',
    servedRevisionId: 'r1',
    ...overrides,
    byteLength: source.byteLength,
  }
}

function summary(value: Project, name: string): ProjectSummary {
  return {
    id: value.id,
    name,
    targetId: value.targetId,
    fileName: value.fileName,
    updatedAt: '2026-08-31T01:00:00Z',
    byteLength: value.byteLength,
    lastValidation: value.lastValidation,
    hasUnpublishedChanges: value.hasUnpublishedChanges,
  }
}

let currentEditor: ProjectEditor | undefined

function HookHarness({ id, children }: { id: string; children?: ReactNode }) {
  currentEditor = useProject(id)
  return children ?? null
}

async function mount(id: string, value: Project) {
  const load = deferred<Result<Project, ApiError>>()
  mocks.api.getProject.mockImplementationOnce(() => load.promise)
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(<HookHarness id={id} />)
  })
  await act(async () => {
    load.resolve(result(value))
    await load.promise
  })
  expect(currentEditor?.project?.id).toBe(id)
  return renderer
}

async function resolve<T>(request: Deferred<T>, value: T) {
  await act(async () => {
    request.resolve(value)
    await request.promise
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  currentEditor = undefined
  mocks.route.id = 'p1'
  mocks.toast.notify.mockReset()
  mocks.toast.fail.mockReset()
  mocks.api.getProject.mockReset()
  mocks.api.saveRevision.mockReset()
  mocks.api.publishProject.mockReset()
  mocks.api.renameProject.mockReset()
})

describe('useProject rename and write交错', () => {
  it('keeps saved pointers and bytes when Rename returns after Save', async () => {
    const initial = project('p1')
    const saved = project('p1', {
      source: bytes('saved\n'),
      currentRevisionId: 'r2',
      updatedAt: '2026-08-31T02:00:00Z',
    })
    const renderer = await mount('p1', initial)
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    const save = deferred<Result<SaveResult, ApiError>>()
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)
    mocks.api.saveRevision.mockReturnValueOnce(save.promise)

    let renameCall!: Promise<unknown>
    await act(async () => {
      renameCall = currentEditor!.rename('Renamed')
      void currentEditor!.save()
    })
    await resolve(save, result({ project: saved, validation: saved.lastValidation, unchanged: false }))
    await resolve(rename, result(summary(initial, 'Renamed')))
    await act(async () => {
      await renameCall
    })

    expect(currentEditor?.project).toMatchObject({
      id: 'p1',
      name: 'Renamed',
      currentRevisionId: 'r2',
    })
    expect(currentEditor?.workingBytes).toEqual(bytes('saved\n'))
    renderer.unmount()
  })

  it('keeps a successful Rename name when Save returns last', async () => {
    const initial = project('p1')
    const saved = project('p1', { source: bytes('saved\n'), currentRevisionId: 'r2' })
    const renderer = await mount('p1', initial)
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    const save = deferred<Result<SaveResult, ApiError>>()
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)
    mocks.api.saveRevision.mockReturnValueOnce(save.promise)

    await act(async () => {
      void currentEditor!.rename('Renamed')
      void currentEditor!.save()
    })
    await resolve(rename, result(summary(initial, 'Renamed')))
    await resolve(save, result({ project: saved, validation: saved.lastValidation, unchanged: false }))

    expect(currentEditor?.project).toMatchObject({ name: 'Renamed', currentRevisionId: 'r2' })
    renderer.unmount()
  })

  it('keeps published pointers when Rename returns after Publish', async () => {
    const initial = project('p1', {
      currentRevisionId: 'r2',
      servedRevisionId: 'r1',
      hasUnpublishedChanges: true,
    })
    const published = project('p1', {
      currentRevisionId: 'r2',
      servedRevisionId: 'r2',
      hasUnpublishedChanges: false,
    })
    const renderer = await mount('p1', initial)
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    const publish = deferred<Result<PublishResult, ApiError>>()
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)
    mocks.api.publishProject.mockReturnValueOnce(publish.promise)

    await act(async () => {
      void currentEditor!.rename('Renamed')
      void currentEditor!.publish()
    })
    await resolve(publish, result({ project: published, unchanged: false }))
    await resolve(rename, result(summary(initial, 'Renamed')))

    expect(currentEditor?.project).toMatchObject({
      name: 'Renamed',
      currentRevisionId: 'r2',
      servedRevisionId: 'r2',
      hasUnpublishedChanges: false,
    })
    renderer.unmount()
  })

  it('keeps a successful Rename name when Publish returns last', async () => {
    const initial = project('p1', {
      currentRevisionId: 'r2',
      servedRevisionId: 'r1',
      hasUnpublishedChanges: true,
    })
    const published = project('p1', {
      currentRevisionId: 'r2',
      servedRevisionId: 'r2',
      hasUnpublishedChanges: false,
    })
    const renderer = await mount('p1', initial)
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    const publish = deferred<Result<PublishResult, ApiError>>()
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)
    mocks.api.publishProject.mockReturnValueOnce(publish.promise)

    await act(async () => {
      void currentEditor!.rename('Renamed')
      void currentEditor!.publish()
    })
    await resolve(rename, result(summary(initial, 'Renamed')))
    await resolve(publish, result({ project: published, unchanged: false }))

    expect(currentEditor?.project).toMatchObject({ name: 'Renamed', servedRevisionId: 'r2' })
    renderer.unmount()
  })

  it('does not let a stale Rename response affect a switched Project', async () => {
    const first = project('p1')
    const second = project('p2', { name: 'Second project' })
    const renderer = await mount('p1', first)
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    const loadSecond = deferred<Result<Project, ApiError>>()
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)
    mocks.api.getProject.mockImplementationOnce(() => loadSecond.promise)

    await act(async () => {
      void currentEditor!.rename('Old project name')
      renderer.update(<HookHarness id="p2" />)
    })
    await resolve(loadSecond, result(second))
    await resolve(rename, result(summary(first, 'Old project name')))

    expect(currentEditor?.project).toMatchObject({ id: 'p2', name: 'Second project' })
    expect(currentEditor?.workingBytes).toEqual(second.source)
    renderer.unmount()
  })

  it('keeps the new Project intact when a stale Rename fails', async () => {
    const first = project('p1')
    const second = project('p2', { name: 'Second project', source: bytes('second\n') })
    const renderer = await mount('p1', first)
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    const loadSecond = deferred<Result<Project, ApiError>>()
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)
    mocks.api.getProject.mockImplementationOnce(() => loadSecond.promise)

    let renameCall!: Promise<unknown>
    await act(async () => {
      renameCall = currentEditor!.rename('Old project name')
      renderer.update(<HookHarness id="p2" />)
    })
    await resolve(loadSecond, result(second))
    await resolve(rename, failure('network.error'))
    await act(async () => {
      await renameCall
    })

    expect(currentEditor?.project).toMatchObject({ id: 'p2', name: 'Second project' })
    expect(currentEditor?.workingBytes).toEqual(bytes('second\n'))
    renderer.unmount()
  })

  it('preserves local edits made while Publish is in flight', async () => {
    const initial = project('p1', {
      currentRevisionId: 'r2',
      servedRevisionId: 'r1',
      hasUnpublishedChanges: true,
    })
    const published = project('p1', {
      currentRevisionId: 'r2',
      servedRevisionId: 'r2',
      hasUnpublishedChanges: false,
    })
    const renderer = await mount('p1', initial)
    const publish = deferred<Result<PublishResult, ApiError>>()
    mocks.api.publishProject.mockReturnValueOnce(publish.promise)

    await act(async () => {
      void currentEditor!.publish()
      currentEditor!.setText('local edit\n')
    })
    await resolve(publish, result({ project: published, unchanged: false }))

    expect(currentEditor?.workingBytes).toEqual(bytes('local edit\n'))
    expect(currentEditor?.dirty).toBe(true)
    expect(currentEditor?.project).toMatchObject({ servedRevisionId: 'r2', hasUnpublishedChanges: false })
    renderer.unmount()
  })

  it('does not restore an old name draft after a failed Rename and Project switch', async () => {
    const first = project('p1')
    const second = project('p2', { name: 'Second project', source: bytes('second\n') })
    const firstLoad = deferred<Result<Project, ApiError>>()
    const secondLoad = deferred<Result<Project, ApiError>>()
    const rename = deferred<Result<ProjectSummary, ApiError>>()
    mocks.api.getProject.mockImplementationOnce(() => firstLoad.promise)
    mocks.api.renameProject.mockReturnValueOnce(rename.promise)

    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<EditorScreen />)
    })
    await resolve(firstLoad, result(first))

    const nameInput = () => renderer.root.findByProps({ 'aria-label': '配置名称' })
    await act(async () => {
      nameInput().props.onChange({ target: { value: 'Old project name' } })
      nameInput().props.onBlur()
      mocks.route.id = 'p2'
      mocks.api.getProject.mockImplementationOnce(() => secondLoad.promise)
      renderer.update(<EditorScreen />)
    })
    await resolve(secondLoad, result(second))
    await resolve(rename, failure('network.error'))

    expect(nameInput().props.value).toBe('Second project')
    renderer.unmount()
  })

  it('renders the current target as the registry display name without a target badge', async () => {
    const renderer = await (async () => {
      const load = deferred<Result<Project, ApiError>>()
      mocks.api.getProject.mockImplementationOnce(() => load.promise)
      let resultRenderer!: ReturnType<typeof create>
      await act(async () => {
        resultRenderer = create(<EditorScreen />)
      })
      await resolve(load, result(project('p1', { targetId: 'sing-box' })))
      return resultRenderer
    })()

    const spanText = renderer.root
      .findAllByType('span')
      .map((node) => node.props.children)
      .filter((children): children is string => typeof children === 'string')
    expect(spanText).toContain('Registry sing-box')
    expect(spanText).not.toContain('SB')
    renderer.unmount()
  })
})
