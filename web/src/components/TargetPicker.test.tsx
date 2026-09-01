import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { core } from '../core'
import { TargetPicker } from './TargetPicker'

describe('TargetPicker cards', () => {
  it('renders original neutral text markers and names for every target', () => {
    const markup = renderToStaticMarkup(<TargetPicker value={null} onChange={() => {}} />)
    const descriptors = core.targets()
    const markers = {
      mihomo: 'M',
      'sing-box': 'SB',
      surge: 'SG',
      loon: 'L',
      'quantumult-x': 'QX',
      shadowrocket: 'SR',
    } as const
    expect(descriptors).toHaveLength(6)
    expect((markup.match(/data-target-marker=/g) ?? []).length).toBe(descriptors.length)
    expect((markup.match(/aria-hidden="true"/g) ?? []).length).toBe(descriptors.length)
    expect(markup).not.toContain('<img')
    expect(markup).not.toContain('<svg')
    expect(markup).not.toMatch(/https?:\/\//)
    for (const descriptor of descriptors) {
      expect(markup).toContain(descriptor.displayName)
      expect(markup).toContain(`data-target-marker="${descriptor.id}"`)
      expect(markup).toContain(`>${markers[descriptor.id]}</span>`)
    }
    expect(markup).not.toContain('最深校验')
    expect(markup).not.toContain('.yaml')
    expect(markup).not.toContain('.yml')
    expect(markup).not.toContain('.json')
    expect(markup).not.toContain('.conf')
  })
})
