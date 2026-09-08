// @vitest-environment jsdom

import { redo, undo } from '@codemirror/commands'
import { Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DocumentInfo, TargetId } from '../core'
import { SourceEditor } from './SourceEditor'

const mounted: Array<{ container: HTMLDivElement; root: Root }> = []

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => DOMRect.fromRect()
  }
})

afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount())
    item.container.remove()
  }
})

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function infoFor(text: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    encoding: 'utf8',
    lineEnding: text.includes('\n') ? 'lf' : 'none',
    hasTrailingNewline: text.endsWith('\n'),
    byteLength: bytes(text).byteLength,
    ...overrides,
  }
}

function editorElement(
  text: string,
  onChange = vi.fn(),
  targetId: TargetId = 'mihomo',
  key = 'document',
  overrides: Partial<DocumentInfo> = {},
) {
  return (
    <SourceEditor
      key={key}
      text={text}
      onChange={onChange}
      targetId={targetId}
      bytes={bytes(text)}
      info={infoFor(text, overrides)}
    />
  )
}

function renderEditor(element: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => root.render(element))
  return { container, root }
}

function findView(container: HTMLElement): EditorView {
  const editor = container.querySelector<HTMLElement>('.cm-editor')
  const view = editor && EditorView.findFromDOM(editor)
  if (view === null) throw new Error('CodeMirror view not mounted')
  return view
}

describe('SourceEditor CodeMirror integration', () => {
  it('does not change or focus a document on first mount', () => {
    const onChange = vi.fn()
    const { container } = renderEditor(editorElement('备注: 家庭网络  \n', onChange))
    const view = findView(container)

    expect(view.state.doc.toString()).toBe('备注: 家庭网络  \n')
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(view.contentDOM)
    expect(view.dom.dataset.highlightLanguage).toBe('yaml')
  })

  it('renders YAML numeric and boolean scalar categories in the viewport', () => {
    const source = 'mixed-port: 7890\nenabled: true\n'
    const { container } = renderEditor(editorElement(source))

    expect(container.querySelector('.cd-syntax-number')?.textContent).toBe('7890')
    expect(container.querySelector('.cd-syntax-boolean')?.textContent).toBe('true')
  })

  it('returns exact user transactions and supports undo and redo', () => {
    const onChange = vi.fn()
    const { container } = renderEditor(editorElement('first\n', onChange, 'sing-box'))
    const view = findView(container)
    const inserted = '第二行  \nhttps://example.com/a:b?q=1#片段'

    act(() => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: inserted },
        annotations: Transaction.userEvent.of('input.paste'),
      })
    })
    expect(onChange).toHaveBeenLastCalledWith(`first\n${inserted}`)

    act(() => {
      expect(undo(view)).toBe(true)
    })
    expect(view.state.doc.toString()).toBe('first\n')
    act(() => {
      expect(redo(view)).toBe(true)
    })
    expect(view.state.doc.toString()).toBe(`first\n${inserted}`)
  })

  it('starts a switched Project or Revision with isolated content, history, and scroll', () => {
    const onChange = vi.fn()
    const { container, root } = renderEditor(
      editorElement('old\ndocument\n', onChange, 'mihomo', 'old'),
    )
    const oldView = findView(container)
    oldView.scrollDOM.scrollTop = 320
    act(() => oldView.dispatch({ changes: { from: 0, to: 3, insert: 'changed' } }))
    onChange.mockClear()

    act(() => {
      root.render(editorElement('new\nview', onChange, 'surge', 'new'))
    })
    const newView = findView(container)
    expect(newView).not.toBe(oldView)
    expect(newView.state.doc.toString()).toBe('new\nview')
    expect(newView.scrollDOM.scrollTop).toBe(0)
    expect(undo(newView)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(newView.dom.dataset.highlightLanguage).toBe('ini')
  })

  it('does not emit a change when a tab unmounts and remounts the same document', () => {
    const source = 'mixed-port: 7890\n# 中文注释  \n'
    const onChange = vi.fn()
    const { container, root } = renderEditor(editorElement(source, onChange))
    expect(findView(container).state.doc.toString()).toBe(source)

    act(() => root.render(null))
    act(() => root.render(editorElement(source, onChange)))

    expect(findView(container).state.doc.toString()).toBe(source)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('uses one scroll container with fixed neutral gutters', () => {
    const { container } = renderEditor(editorElement('one\ntwo\nthree\n'))
    const view = findView(container)
    const gutters = container.querySelector<HTMLElement>('.cm-gutters')
    const content = container.querySelector<HTMLElement>('.cm-content')

    expect(gutters).not.toBeNull()
    expect(content).not.toBeNull()
    expect(gutters?.parentElement).toBe(view.scrollDOM)
    expect(content?.parentElement).toBe(view.scrollDOM)
    expect(getComputedStyle(gutters!).position).toBe('sticky')
    view.scrollDOM.scrollTop = 120
    view.scrollDOM.scrollLeft = 80
    expect(view.scrollDOM.scrollTop).toBe(120)
    expect(view.scrollDOM.scrollLeft).toBe(80)
  })

  it('provides an accessible textbox and hides line numbers from assistive technology', () => {
    const { container } = renderEditor(editorElement('[General]\nloglevel = notify\n', vi.fn(), 'loon'))
    const view = findView(container)
    const gutters = container.querySelector<HTMLElement>('.cm-gutters')

    expect(view.contentDOM.getAttribute('role')).toBe('textbox')
    expect(view.contentDOM.getAttribute('aria-label')).toBe('配置源码')
    expect(view.contentDOM.getAttribute('aria-multiline')).toBe('true')
    expect(gutters?.getAttribute('aria-hidden')).toBe('true')
  })

  it('labels revision source as read-only and does not expose an editable surface', () => {
    const source = '{"log":{"level":"info"}}\n'
    const { container } = renderEditor(
      <SourceEditor
        text={source}
        onChange={vi.fn()}
        targetId="sing-box"
        bytes={bytes(source)}
        info={infoFor(source)}
        readOnly
      />,
    )
    const view = findView(container)

    expect(view.contentDOM.getAttribute('aria-label')).toBe('历史版本源码（只读）')
    expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true')
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
  })

  it('renders a large configuration through the viewport rather than duplicating the document', () => {
    const source = Array.from({ length: 5_000 }, (_, index) => `key-${index} = value-${index}`).join('\n')
    const { container } = renderEditor(editorElement(source, vi.fn(), 'shadowrocket'))
    const view = findView(container)

    expect(view.state.doc.lines).toBe(5_000)
    expect(container.querySelectorAll('.cm-line').length).toBeLessThan(5_000)
    expect(container.textContent?.length ?? 0).toBeLessThan(source.length)
  })
})
