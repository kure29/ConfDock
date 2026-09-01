import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { core } from '../core'
import { TargetPicker } from './TargetPicker'

describe('TargetPicker cards', () => {
  it('renders local raster icons and a neutral Mihomo marker for every target', () => {
    const markup = renderToStaticMarkup(<TargetPicker value={null} onChange={() => {}} />)
    const descriptors = core.targets()
    expect(descriptors).toHaveLength(6)
    expect((markup.match(/data-target-icon=/g) ?? []).length).toBe(descriptors.length - 1)
    expect((markup.match(/<img /g) ?? []).length).toBe(descriptors.length - 1)
    expect(markup).toContain('data-target-letter="mihomo"')
    expect(markup).toContain('>M</span>')
    expect(markup).not.toContain('data-target-icon="mihomo"')
    expect(markup).not.toContain('<svg')
    expect(markup).not.toMatch(/https?:\/\//)
    for (const descriptor of descriptors) {
      expect(markup).toContain(descriptor.displayName)
      if (descriptor.id !== 'mihomo') {
        const icon = `${descriptor.id === 'sing-box' ? 'sing-box' : descriptor.id}.png`
        expect(markup).toContain(`/client-icons/${icon}`)
      }
    }
    expect(markup).not.toContain('最深校验')
    expect(markup).not.toContain('.yaml')
    expect(markup).not.toContain('.yml')
    expect(markup).not.toContain('.json')
    expect(markup).not.toContain('.conf')
  })
})
