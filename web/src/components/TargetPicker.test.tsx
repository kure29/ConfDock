import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { core } from '../core'
import type { TargetId } from '../core'
import { TargetPicker } from './TargetPicker'

describe('TargetPicker', () => {
  it('renders registry names as plain, accessible text without icon or badge elements', () => {
    const selected = 'surge' satisfies TargetId
    const markup = renderToStaticMarkup(<TargetPicker value={selected} onChange={() => {}} />)
    const descriptors = core.targets()

    expect(descriptors).toHaveLength(6)
    expect((markup.match(/type="radio"/g) ?? []).length).toBe(descriptors.length)
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('<svg')
    expect(markup).not.toContain('data-target-marker')
    expect(markup).not.toContain('aria-hidden="true"')
    expect(markup).not.toMatch(/>M<\/span>|>SB<\/span>|>SG<\/span>|>L<\/span>|>QX<\/span>|>SR<\/span>/)

    for (const descriptor of descriptors) {
      expect(markup).toContain(descriptor.displayName)
      expect(markup).toContain(`value="${descriptor.id}"`)
    }
    expect(markup).toContain('checked=""')
  })

  it('keeps each registry target selectable and returns its original id', () => {
    const onChange = vi.fn<(id: TargetId) => void>()
    let renderer!: ReturnType<typeof create>
    act(() => {
      renderer = create(<TargetPicker value={null} onChange={onChange} />)
    })
    const radios = renderer.root.findAllByType('input')
    const descriptors = core.targets()

    expect(radios).toHaveLength(descriptors.length)
    for (const radio of radios) {
      act(() => radio.props.onChange())
    }

    expect(onChange.mock.calls.map(([id]) => id)).toEqual(descriptors.map(({ id }) => id))
    renderer.unmount()
  })
})
