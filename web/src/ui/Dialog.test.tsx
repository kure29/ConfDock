import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from './Dialog'

interface DialogNode {
  open: boolean
  showModal: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

function dialogNode(): DialogNode {
  const node = {
    open: false,
    showModal: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
  node.showModal.mockImplementation(() => {
    node.open = true
  })
  node.close.mockImplementation(() => {
    node.open = false
  })
  return node
}

let renderer: ReturnType<typeof create> | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

describe('Dialog initial focus', () => {
  it('focuses the dialog container without focusing the title or first control', async () => {
    const node = dialogNode()
    const inputNode = { focus: vi.fn() }
    await act(async () => {
      renderer = create(
        <Dialog open onClose={() => {}} title="托管地址">
          <input aria-label="地址名称" />
        </Dialog>,
        {
          createNodeMock: (element) => {
            if (element.type === 'dialog') return node
            if (element.type === 'input') return inputNode
            return null
          },
        },
      )
      await Promise.resolve()
    })

    expect(node.showModal).toHaveBeenCalledTimes(1)
    expect(node.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(inputNode.focus).not.toHaveBeenCalled()
    expect(renderer!.root.findByType('dialog').props.tabIndex).toBe(-1)
    expect(renderer!.root.findByType('h2').props.tabIndex).toBeUndefined()
  })

  it('closes through the native dialog and keeps cancel/backdrop handlers', async () => {
    const node = dialogNode()
    const onClose = vi.fn()
    await act(async () => {
      renderer = create(
        <Dialog open onClose={onClose} title="确认">
          <p>不可恢复</p>
        </Dialog>,
        { createNodeMock: (element) => (element.type === 'dialog' ? node : null) },
      )
      await Promise.resolve()
    })

    const cancelCall = node.addEventListener.mock.calls.find(([type]) => type === 'cancel')
    expect(cancelCall).toBeDefined()
    await act(async () => {
      cancelCall![1]({ preventDefault: vi.fn() })
    })
    expect(onClose).toHaveBeenCalledTimes(1)

    const dialog = renderer!.root.findByType('dialog')
    await act(async () => dialog.props.onClick({ target: node }))
    expect(onClose).toHaveBeenCalledTimes(2)

    await act(async () => {
      renderer!.update(
        <Dialog open={false} onClose={onClose} title="确认">
          <p>不可恢复</p>
        </Dialog>,
      )
      await Promise.resolve()
    })
    expect(node.close).toHaveBeenCalledTimes(1)
  })
})
