import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginScreen } from './LoginScreen'

const mocks = vi.hoisted(() => ({
  api: { serviceInfo: vi.fn() },
  auth: { signIn: vi.fn(), error: null },
}))

vi.mock('../api', () => ({ api: mocks.api }))
vi.mock('../state/AuthContext', () => ({ useAuth: () => mocks.auth }))

function ok<T>(value: T) {
  return { ok: true as const, value }
}

function err(code: string, message: string) {
  return { ok: false as const, error: { code, message } }
}

const session = { id: 'session-1', createdAt: '2026-09-01T00:00:00Z' }

let renderer: ReturnType<typeof create> | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mocks.api.serviceInfo.mockReset()
  mocks.auth.signIn.mockReset()
  mocks.auth.error = null
  mocks.api.serviceInfo.mockResolvedValue(ok({}))
})

async function render(inputNode: { blur: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }) {
  await act(async () => {
    renderer = create(<LoginScreen />, {
      createNodeMock: (element) => (element.type === 'input' ? inputNode : null),
    })
    await Promise.resolve()
  })
}

describe('LoginScreen mobile focus behavior', () => {
  it('does not autofocus the password field', async () => {
    await render({ blur: vi.fn(), focus: vi.fn() })
    const input = renderer!.root.findByProps({ id: 'password' })

    expect(input.props.autoFocus).toBeUndefined()
  })

  it('blurs the password field after successful sign-in', async () => {
    const inputNode = { blur: vi.fn(), focus: vi.fn() }
    mocks.auth.signIn.mockResolvedValue(ok(session))
    await render(inputNode)

    await act(async () => {
      renderer!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
    })

    expect(inputNode.blur).toHaveBeenCalledTimes(1)
  })

  it('keeps the password and shows a server error after a failed sign-in', async () => {
    mocks.auth.signIn.mockResolvedValue(err('auth.invalid', '密码错误'))
    await render({ blur: vi.fn(), focus: vi.fn() })
    const input = renderer!.root.findByProps({ id: 'password' })
    await act(async () => input.props.onChange({ target: { value: 'still-secret' } }))

    await act(async () => {
      renderer!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
    })

    expect(renderer!.root.findByProps({ id: 'password' }).props.value).toBe('still-secret')
    expect(JSON.stringify(renderer!.toJSON())).toContain('密码错误')
  })

  it('turns a rejected sign-in into a safe visible error', async () => {
    mocks.auth.signIn.mockRejectedValue(new Error('private transport details'))
    await render({ blur: vi.fn(), focus: vi.fn() })

    await act(async () => {
      renderer!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
    })

    expect(JSON.stringify(renderer!.toJSON())).toContain('无法登录，请稍后重试')
    expect(JSON.stringify(renderer!.toJSON())).not.toContain('private transport details')
  })
})
