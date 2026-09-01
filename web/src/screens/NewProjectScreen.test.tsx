import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewProjectScreen } from './NewProjectScreen'

const mocks = vi.hoisted(() => ({
  api: { createProject: vi.fn() },
  navigate: vi.fn(),
  toast: { notify: vi.fn() },
}))

vi.mock('../api', () => ({ api: mocks.api }))
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('../state/ToastContext', () => ({ useToast: () => mocks.toast }))

beforeEach(() => {
  mocks.api.createProject.mockReset()
  mocks.navigate.mockReset()
  mocks.toast.notify.mockReset()
})

describe('NewProjectScreen copy', () => {
  it('uses plain-language import and client instructions', () => {
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(<NewProjectScreen />)
    })

    const markup = JSON.stringify(renderer.toJSON())
    expect(markup).toContain('导入配置后，可以继续检查、编辑和保存。')
    expect(markup).toContain('配置内容')
    expect(markup).toContain('支持拖入文件、选择文件或直接粘贴配置内容。')
    expect(markup).toContain('或者直接粘贴配置内容')
    expect(markup).toContain('客户端')
    expect(markup).toContain('选择这份配置要使用的客户端。')
    expect(markup).not.toContain('保存的是你给的字节')
    expect(markup).not.toContain('适配器解析和校验')
    expect(markup).not.toContain('BOM')
    expect(markup).not.toContain('没有诊断信息')
    renderer.unmount()
  })
})
