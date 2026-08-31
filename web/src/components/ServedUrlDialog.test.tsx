import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessToken, CreatedAccessToken } from '../api'
import { ServedUrlDialog } from './ServedUrlDialog'

const mocks = vi.hoisted(() => ({
  api: {
    listTokens: vi.fn(),
    createToken: vi.fn(),
    updateToken: vi.fn(),
    revokeToken: vi.fn(),
  },
  toast: { notify: vi.fn(), fail: vi.fn() },
}))

vi.mock('../api', () => ({ api: mocks.api }))
vi.mock('../state/ToastContext', () => ({ useToast: () => mocks.toast }))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function token(overrides: Partial<AccessToken> = {}): AccessToken {
  return {
    id: 't1',
    displayName: 'iPhone Surge',
    prefix: 'abc123',
    suffix: 'xyz789',
    createdAt: '2026-08-31T00:00:00Z',
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  }
}

function created(value: AccessToken = token()): CreatedAccessToken {
  return { token: value, plaintext: 'secret-token', url: 'https://example.test/sub/secret-token' }
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function err(code: string, message: string) {
  return { ok: false as const, error: { code, message } }
}

let renderer: ReturnType<typeof create> | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(),
  })
  mocks.api.listTokens.mockReset()
  mocks.api.createToken.mockReset()
  mocks.api.updateToken.mockReset()
  mocks.api.revokeToken.mockReset()
  mocks.toast.notify.mockReset()
  mocks.toast.fail.mockReset()
  mocks.api.listTokens.mockResolvedValue(ok([]))
})

describe('ServedUrlDialog hosted address controls', () => {
  it('defaults to a named never-expiring address and sends one create request', async () => {
    const createRequest = deferred<ReturnType<typeof ok<CreatedAccessToken>>>()
    mocks.api.createToken.mockReturnValueOnce(createRequest.promise)
    await act(async () => {
      renderer = create(
        <ServedUrlDialog open onClose={() => {}} projectId="p1" projectName="家庭网络" />,
      )
    })
    const buttons = renderer!.root.findAllByType('button')
    const generate = buttons.find((button) => button.props.children === '生成新地址')
    expect(generate).toBeDefined()
    const name = renderer!.root.findByProps({ id: 'hosted-address-name' })
    expect(name.props.value).toBe('家庭网络')
    await act(async () => {
      generate!.props.onClick()
      generate!.props.onClick()
    })
    expect(mocks.api.createToken).toHaveBeenCalledTimes(1)
    expect(mocks.api.createToken).toHaveBeenCalledWith('p1', {
      displayName: '家庭网络',
      expiresAt: null,
    })
    await act(async () => {
      createRequest.resolve(ok(created()))
      await createRequest.promise
    })
    expect(renderer!.root.findByProps({ id: 'hosted-address-name' }).props.value).toBe('家庭网络')
  })

  it('renders expiry and revoked states, and updates a token without changing its identity', async () => {
    const expiring = token({
      id: 't-expiring',
      displayName: '临时分享',
      expiresAt: '2026-09-01T00:00:00Z',
    })
    const permanent = token({ id: 't-permanent', displayName: '家里 Mihomo' })
    const revoked = token({ id: 't-revoked', displayName: '旧地址', revokedAt: '2026-08-30T00:00:00Z' })
    mocks.api.listTokens.mockResolvedValue(ok([expiring, permanent, revoked]))
    mocks.api.updateToken.mockResolvedValue(ok({ ...expiring, displayName: '新的临时分享' }))
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={() => {}} projectId="p1" />)
    })
    expect(renderer!.root.findAllByType('button').map((button) => button.props.children)).toContain('编辑')
    expect(renderer!.root.findAllByType('button')).toHaveLength(6)
    const text = renderer!.toJSON()
    expect(JSON.stringify(text)).toContain('永久有效')
    expect(JSON.stringify(text)).toContain('已撤销')

    const edit = renderer!.root.findAllByType('button').find((button) => button.props.children === '编辑')
    await act(async () => edit!.props.onClick())
    const editName = renderer!.root.findByProps({ id: 'hosted-address-name-t-expiring' })
    await act(async () => {
      editName.props.onChange({ target: { value: '新的临时分享' } })
    })
    const save = renderer!
      .root
      .findAllByType('button')
      .find((button) => button.props.children === '保存')
    await act(async () => save!.props.onClick())
    expect(mocks.api.updateToken).toHaveBeenCalledWith('p1', 't-expiring', {
      displayName: '新的临时分享',
      expiresAt: '2026-09-01T00:00:00.000Z',
      expectedDisplayName: '临时分享',
      expectedExpiresAt: '2026-09-01T00:00:00Z',
    })
  })

  it('rejects an explicitly cleared address name instead of restoring the project name', async () => {
    await act(async () => {
      renderer = create(
        <ServedUrlDialog open onClose={() => {}} projectId="p1" projectName="家庭网络" />,
      )
    })
    const name = renderer!.root.findByProps({ id: 'hosted-address-name' })
    await act(async () => name.props.onChange({ target: { value: '   ' } }))
    const generate = renderer!
      .root
      .findAllByType('button')
      .find((button) => button.props.children === '生成新地址')
    await act(async () => generate!.props.onClick())
    expect(mocks.api.createToken).not.toHaveBeenCalled()
    expect(mocks.toast.fail).toHaveBeenCalledWith('地址名称必须为 1 到 64 个字符')
  })

  it('rejects a past custom expiry before sending a request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'))
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={() => {}} projectId="p1" />)
    })
    const expiry = renderer!.root.findByProps({ id: 'hosted-address-expiry' })
    await act(async () => expiry.props.onChange({ target: { value: 'custom' } }))
    const custom = renderer!.root.findByProps({ id: 'hosted-address-custom-expiry' })
    await act(async () => custom.props.onChange({ target: { value: '2026-08-30T00:00' } }))
    const generate = renderer!
      .root
      .findAllByType('button')
      .find((button) => button.props.children === '生成新地址')
    await act(async () => generate!.props.onClick())
    expect(mocks.api.createToken).not.toHaveBeenCalled()
    expect(mocks.toast.fail).toHaveBeenCalledWith('有效期必须晚于当前时间')
  })

  it('keeps the newest same-project list when an older reload finishes last', async () => {
    const firstList = deferred<ReturnType<typeof ok<AccessToken[]>>>()
    mocks.api.listTokens
      .mockReturnValueOnce(firstList.promise)
      .mockResolvedValueOnce(ok([token({ id: 't-new', displayName: '新地址' })]))
    mocks.api.createToken.mockResolvedValue(ok(created(token({ id: 't-new' }))))
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={() => {}} projectId="p1" />)
    })
    const generate = renderer!
      .root
      .findAllByType('button')
      .find((button) => button.props.children === '生成新地址')
    await act(async () => {
      generate!.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('新地址')
    await act(async () => {
      firstList.resolve(ok([token({ id: 't-old', displayName: '旧列表' })]))
      await firstList.promise
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('新地址')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('旧列表')
  })

  it('blocks user close while creating and ignores an externally closed request result', async () => {
    const onClose = vi.fn()
    const createRequest = deferred<ReturnType<typeof err>>()
    mocks.api.createToken.mockReturnValueOnce(createRequest.promise)
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={onClose} projectId="p1" />)
    })
    const buttons = renderer!.root.findAllByType('button')
    const generate = buttons.find((button) => button.props.children === '生成新地址')
    const close = buttons.find((button) => button.props.children === '关闭')
    await act(async () => generate!.props.onClick())
    await act(async () => close!.props.onClick())
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => {
      renderer!.update(<ServedUrlDialog open={false} onClose={onClose} projectId="p1" />)
    })
    await act(async () => {
      createRequest.resolve(err('network.unreachable', 'offline'))
      await createRequest.promise
    })
    expect(mocks.toast.fail).not.toHaveBeenCalled()
    expect(mocks.api.listTokens).toHaveBeenCalledTimes(1)
  })

  it('refreshes status at the expiry boundary and clears its timer when closed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'))
    mocks.api.listTokens.mockResolvedValue(
      ok([
        token({ id: 'soon', displayName: '即将过期', expiresAt: '2026-08-31T00:00:01Z' }),
        token({ id: 'later', displayName: '稍后过期', expiresAt: '2026-08-31T00:00:10Z' }),
      ]),
    )
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={() => {}} projectId="p1" />)
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('即将到期')
    await act(async () => {
      vi.advanceTimersByTime(1_001)
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('已过期')
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await act(async () => {
      renderer!.update(<ServedUrlDialog open={false} onClose={() => {}} projectId="p1" />)
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reloads current metadata after a stale token update conflict', async () => {
    const original = token({ displayName: '原名称' })
    const current = token({ displayName: '其他页面的新名称' })
    mocks.api.listTokens.mockResolvedValueOnce(ok([original])).mockResolvedValueOnce(ok([current]))
    mocks.api.updateToken.mockResolvedValue(
      err('token.conflict', '托管地址已被其他页面更新，请重新加载后再编辑'),
    )
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={() => {}} projectId="p1" />)
    })
    const edit = renderer!
      .root
      .findAllByType('button')
      .find((button) => button.props.children === '编辑')
    await act(async () => edit!.props.onClick())
    const editName = renderer!.root.findByProps({ id: 'hosted-address-name-t1' })
    await act(async () => editName.props.onChange({ target: { value: '我的修改' } }))
    const save = renderer!
      .root
      .findAllByType('button')
      .find((button) => button.props.children === '保存')
    await act(async () => {
      save!.props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.api.updateToken).toHaveBeenCalledWith('p1', 't1', {
      displayName: '我的修改',
      expiresAt: null,
      expectedDisplayName: '原名称',
      expectedExpiresAt: null,
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('其他页面的新名称')
    expect(mocks.toast.fail).toHaveBeenCalledWith(
      '托管地址已被其他页面更新，请重新加载后再编辑',
    )
  })

  it('ignores an old project response after switching project IDs', async () => {
    const first = deferred<ReturnType<typeof ok<AccessToken[]>>>()
    const second = deferred<ReturnType<typeof ok<AccessToken[]>>>()
    mocks.api.listTokens.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await act(async () => {
      renderer = create(<ServedUrlDialog open onClose={() => {}} projectId="p1" />)
    })
    await act(async () => {
      renderer!.update(<ServedUrlDialog open onClose={() => {}} projectId="p2" />)
    })
    await act(async () => {
      second.resolve(ok([token({ id: 't2', displayName: '新项目地址' })]))
      await second.promise
    })
    await act(async () => {
      first.resolve(ok([token({ id: 't1', displayName: '旧项目地址' })]))
      await first.promise
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('新项目地址')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('旧项目地址')
  })

  it('keeps the loaded token list when the current project name changes', async () => {
    mocks.api.listTokens.mockResolvedValue(ok([token({ displayName: '现有地址' })]))
    await act(async () => {
      renderer = create(
        <ServedUrlDialog open onClose={() => {}} projectId="p1" projectName="旧名称" />,
      )
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('现有地址')
    await act(async () => {
      renderer!.update(
        <ServedUrlDialog open onClose={() => {}} projectId="p1" projectName="新名称" />,
      )
    })
    expect(JSON.stringify(renderer!.toJSON())).toContain('现有地址')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('正在读取')
  })
})
