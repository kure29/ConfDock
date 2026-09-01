import { act, create } from 'react-test-renderer'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentInfo } from '../core'
import { SourceEditor } from './SourceEditor'

const info: DocumentInfo = {
  encoding: 'utf8',
  lineEnding: 'lf',
  hasTrailingNewline: false,
  byteLength: 0,
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function nodeMocks() {
  let textareaNode: {
    scrollTop: number
    scrollLeft: number
    clientHeight: number
    focus: () => void
    setSelectionRange: () => void
  } | null = null
  let gutterNode: { scrollTop: number; scrollLeft: number } | null = null

  return {
    get textarea() {
      return textareaNode
    },
    get gutter() {
      return gutterNode
    },
    createNodeMock(element: ReactElement) {
      const props = element.props as Record<string, unknown>
      if (element.type === 'textarea') {
        textareaNode = {
          scrollTop: 0,
          scrollLeft: 0,
          clientHeight: 420,
          focus: vi.fn(),
          setSelectionRange: vi.fn(),
        }
        return textareaNode
      }
      if (element.type === 'div' && props['aria-hidden'] === 'true') {
        gutterNode = { scrollTop: 0, scrollLeft: 0 }
        return gutterNode
      }
      return {}
    },
  }
}

function lineNumberCount(renderer: ReturnType<typeof create>): number {
  const gutter = renderer.root.findByProps({ 'aria-hidden': 'true' })
  return gutter.findAllByType('div').filter((node) => node.props.style?.height === 21).length
}

function editor(
  text: string,
  onChange: (value: string) => void = vi.fn(),
  key?: string,
) {
  return (
    <SourceEditor
      key={key}
      text={text}
      onChange={onChange}
      bytes={bytes(text)}
      info={{ ...info, byteLength: bytes(text).byteLength }}
    />
  )
}

describe('SourceEditor line gutter', () => {
  it('keeps vertical scrolling in sync without moving the gutter horizontally', () => {
    const mocks = nodeMocks()
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(editor('one\ntwo\nthree'), { createNodeMock: mocks.createNodeMock })
    })

    const textarea = renderer.root.findByType('textarea')
    mocks.textarea!.scrollTop = 315
    mocks.textarea!.scrollLeft = 80
    act(() => textarea.props.onScroll())
    expect(mocks.gutter?.scrollTop).toBe(315)
    expect(mocks.gutter?.scrollLeft).toBe(0)

    mocks.textarea!.scrollTop = 0
    act(() => textarea.props.onScroll())
    expect(mocks.gutter?.scrollTop).toBe(0)
    renderer.unmount()
  })

  it('updates line numbers for added, removed, CRLF, Unicode and trailing lines', () => {
    const mocks = nodeMocks()
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(editor('第一行\r\n第二行'), { createNodeMock: mocks.createNodeMock })
    })
    expect(lineNumberCount(renderer)).toBe(2)

    act(() => {
      renderer.update(editor('第一行\n第二行\n第三行\n'))
    })
    expect(lineNumberCount(renderer)).toBe(4)

    act(() => {
      renderer.update(editor('🙂\n最后一行'))
    })
    expect(lineNumberCount(renderer)).toBe(2)
    renderer.unmount()
  })

  it('starts a switched document at the top without retaining the old scroll position', () => {
    const mocks = nodeMocks()
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(editor('one\ntwo\nthree', vi.fn(), 'first'), {
        createNodeMock: mocks.createNodeMock,
      })
    })
    mocks.textarea!.scrollTop = 500
    act(() => renderer.root.findByType('textarea').props.onScroll())
    expect(mocks.gutter?.scrollTop).toBe(500)

    act(() => {
      renderer.update(editor('new document\nsecond line', vi.fn(), 'second'))
    })
    expect(mocks.textarea?.scrollTop).toBe(0)
    expect(mocks.gutter?.scrollTop).toBe(0)
    renderer.unmount()
  })

  it('keeps the gutter outside the accessibility tree', () => {
    const mocks = nodeMocks()
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(editor('one'), { createNodeMock: mocks.createNodeMock })
    })
    expect(renderer.root.findByProps({ 'aria-hidden': 'true' })).toBeDefined()
    renderer.unmount()
  })
})
