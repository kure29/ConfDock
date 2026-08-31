import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInfo, ServiceSettings } from '../api'
import { SettingsScreen } from './SettingsScreen'

const mocks = vi.hoisted(() => ({
  api: {
    serviceInfo: vi.fn(),
    settings: vi.fn(),
    updatePublicUrl: vi.fn(),
    changePassword: vi.fn(),
  },
  toast: { notify: vi.fn(), fail: vi.fn() },
}))

vi.mock('../api', () => ({ api: mocks.api }))
vi.mock('../state/ToastContext', () => ({ useToast: () => mocks.toast }))

const service: ServiceInfo = {
  version: '0.1.0',
  core: 'wasm',
  api: 'http',
  subscriptionBase: 'http://127.0.0.1:8787/sub',
}

function settings(publicUrl = 'http://127.0.0.1:8787'): ServiceSettings {
  return { publicUrl }
}

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function err(code: string, message: string) {
  return { ok: false as const, error: { code, message } }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.api.serviceInfo.mockReset()
  mocks.api.settings.mockReset()
  mocks.api.updatePublicUrl.mockReset()
  mocks.api.changePassword.mockReset()
  mocks.toast.notify.mockReset()
  mocks.toast.fail.mockReset()
  mocks.api.serviceInfo.mockResolvedValue(ok(service))
  mocks.api.settings.mockResolvedValue(ok(settings()))
})

describe('SettingsScreen public URL settings', () => {
  it('loads the public URL and removes the technical client registry table', async () => {
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<SettingsScreen theme="system" onThemeChange={() => {}} />)
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ id: 'public-url' }).props.value).toBe(
      'http://127.0.0.1:8787',
    )
    expect(JSON.stringify(renderer.toJSON())).not.toContain('已注册的客户端')
    expect(JSON.stringify(renderer.toJSON())).toContain('后端仍只监听 127.0.0.1')
    renderer.unmount()
  })

  it('trims and saves the public URL, then updates the service information', async () => {
    mocks.api.updatePublicUrl.mockResolvedValue(ok(settings('https://cd.example.test')))
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<SettingsScreen theme="system" onThemeChange={() => {}} />)
      await Promise.resolve()
    })
    const input = renderer.root.findByProps({ id: 'public-url' })
    await act(async () => input.props.onChange({ target: { value: '  https://cd.example.test  ' } }))
    const form = renderer.root
      .findAllByType('form')
      .find((candidate) => candidate.findAllByProps({ id: 'public-url' }).length > 0)
    expect(form).toBeDefined()
    await act(async () => form!.props.onSubmit({ preventDefault: vi.fn() }))
    expect(mocks.api.updatePublicUrl).toHaveBeenCalledWith('https://cd.example.test')
    expect(JSON.stringify(renderer.toJSON())).toContain('https://cd.example.test/sub')
    expect(mocks.toast.notify).toHaveBeenCalledWith('对外访问地址已更新')
    renderer.unmount()
  })

  it('shows a server validation error without changing the saved value', async () => {
    mocks.api.updatePublicUrl.mockResolvedValue(
      err('settings.invalid_public_url', '对外访问地址无效'),
    )
    let renderer!: ReturnType<typeof create>
    await act(async () => {
      renderer = create(<SettingsScreen theme="system" onThemeChange={() => {}} />)
      await Promise.resolve()
    })
    const form = renderer.root
      .findAllByType('form')
      .find((candidate) => candidate.findAllByProps({ id: 'public-url' }).length > 0)
    await act(async () => form!.props.onSubmit({ preventDefault: vi.fn() }))
    expect(JSON.stringify(renderer.toJSON())).toContain('对外访问地址无效')
    expect(mocks.toast.notify).not.toHaveBeenCalled()
    renderer.unmount()
  })
})
