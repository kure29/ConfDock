import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { core } from '../core'
import { TargetPicker } from './TargetPicker'

describe('TargetPicker cards', () => {
  it('renders a project-owned icon and accessible text for every registry target', () => {
    const markup = renderToStaticMarkup(<TargetPicker value={null} onChange={() => {}} />)
    const descriptors = core.targets()
    expect(descriptors).toHaveLength(6)
    expect((markup.match(/data-target-icon=/g) ?? []).length).toBe(descriptors.length)
    for (const descriptor of descriptors) expect(markup).toContain(descriptor.displayName)
    expect(markup).not.toContain('最深校验')
    expect(markup).not.toContain('.yaml')
    expect(markup).not.toContain('.yml')
    expect(markup).not.toContain('.json')
    expect(markup).not.toContain('.conf')
  })
})
