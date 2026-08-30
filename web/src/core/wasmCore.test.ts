import { describe, expect, it } from 'vitest'
import { core } from './index'
import { encodeUtf8 } from '../lib/bytes'

const ids = ['mihomo', 'sing-box', 'surge', 'loon', 'quantumult-x', 'shadowrocket'] as const

function bytes(text: string): Uint8Array {
  return encodeUtf8(text)
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

describe('Rust WASM ConfigCore boundary', () => {
  it('exposes the six built-in targets and their authoritative capabilities', () => {
    const descriptors = core.targets()
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(ids)
    expect(descriptors.map((descriptor) => descriptor.displayName)).toEqual([
      'Mihomo',
      'sing-box',
      'Surge',
      'Loon',
      'Quantumult X',
      'Shadowrocket',
    ])
    expect(descriptors.every((descriptor) => descriptor.capabilities.rawEdit)).toBe(true)
    expect(descriptors.every((descriptor) => !descriptor.capabilities.nativeValidation)).toBe(true)
    expect(descriptors.map((descriptor) => descriptor.capabilities.validationLevel)).toEqual([
      'static',
      'syntax',
      'basic',
      'basic',
      'basic',
      'basic',
    ])

    expect(core.schema('mihomo')?.fields.map((field) => field.path)).toEqual(['/mixed-port'])
    expect(core.schema('sing-box')?.fields.map((field) => field.path)).toEqual(['/log/level'])
    expect(core.schema('surge')).toBeNull()
    expect(core.editCapabilities('mihomo')[0]?.scope).toEqual({
      kind: 'exactPaths',
      paths: ['/mixed-port'],
    })
    expect(core.editCapabilities('sing-box')[0]?.scope).toEqual({
      kind: 'existingJsonPointerValues',
    })
    expect(core.editCapabilities('quantumult-x')[0]?.scope).toEqual({
      kind: 'existingSectionKeys',
      sections: ['general'],
      caseSensitive: true,
    })
  })

  it('returns native document metadata for BOM, Unicode, LF, CRLF, mixed and no-newline input', () => {
    expect(core.documentInfo(bytes('备注: 家庭网络\n'))).toMatchObject({
      encoding: 'utf8',
      lineEnding: 'lf',
      hasTrailingNewline: true,
    })
    expect(core.documentInfo(bytes('one\r\ntwo\r\n'))).toMatchObject({
      encoding: 'utf8',
      lineEnding: 'crlf',
      hasTrailingNewline: true,
    })
    expect(core.documentInfo(bytes('one\r\ntwo\n'))?.lineEnding).toBe('mixed')
    expect(core.documentInfo(bytes('single line'))?.lineEnding).toBe('none')
    expect(core.documentInfo(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('x\n')]))).toMatchObject({
      encoding: 'utf8-bom',
      lineEnding: 'lf',
    })
  })

  it('maps validation, parsing and UTF-8 byte spans from the Rust core', () => {
    const mihomo = bytes('备注: 家庭网络\nmixed-port: 7890\n')
    const valid = core.validate('mihomo', mihomo)
    expect(valid).toEqual({ level: 'static', diagnostics: [] })

    const parsed = core.parse('mihomo', mihomo)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value.info.byteLength).toBe(mihomo.length)
      const field = parsed.value.fields.find((item) => item.path === '/mixed-port')
      expect(field).toBeDefined()
      expect(field && text(mihomo.slice(field.valueSpan.start, field.valueSpan.end))).toBe('7890')
      expect(field?.valueSpan.start).toBeGreaterThan('备注: 家庭网络\n'.length)
    }

    const invalid = core.validate('mihomo', bytes('mixed-port: 70000\n'))
    expect(invalid.level).toBe('static')
    expect(invalid.diagnostics[0]).toMatchObject({
      code: 'mihomo.mixed_port_range',
      severity: 'error',
      span: { start: 12, end: 17 },
    })

    const json = core.parse('sing-box', bytes('{"log":{"level":"info"}}'))
    expect(json.ok).toBe(true)
    expect(core.validate('sing-box', bytes('{"log":'))).toMatchObject({
      level: 'syntax',
      diagnostics: [{ code: 'json.syntax', severity: 'error' }],
    })
  })

  it('applies byte-preserving structured edits and reports controlled errors', () => {
    const mihomo = bytes('mixed-port: 7890\n备注: 家庭网络\n')
    const mihomoEdit = core.applyEdit('mihomo', mihomo, {
      path: '/mixed-port',
      replacement: '9090',
    })
    expect(mihomoEdit.ok).toBe(true)
    if (mihomoEdit.ok) expect(text(mihomoEdit.value)).toBe('mixed-port: 9090\n备注: 家庭网络\n')

    const json = bytes('{\n  "log": { "level": "info" },\n  "keep": 1\n}\n')
    const jsonEdit = core.applyEdit('sing-box', json, {
      path: '/log/level',
      replacement: '"debug"',
    })
    expect(jsonEdit.ok).toBe(true)
    if (jsonEdit.ok) {
      expect(text(jsonEdit.value)).toBe('{\n  "log": { "level": "debug" },\n  "keep": 1\n}\n')
    }

    const conf = bytes('[General]\nfoo = bar\n# keep\n[Proxy]\nserver = untouched\n')
    const confEdit = core.applyEdit('surge', conf, {
      path: '/General/foo',
      replacement: 'baz',
    })
    expect(confEdit.ok).toBe(true)
    if (confEdit.ok) expect(text(confEdit.value)).toBe('[General]\nfoo = baz\n# keep\n[Proxy]\nserver = untouched\n')

    const unsafe = core.applyEdit('sing-box', json, {
      path: '/log/level',
      replacement: 'debug',
    })
    expect(unsafe).toEqual({
      ok: false,
      error: { kind: 'unsafeValue', detail: 'replacement must be one strict JSON value' },
    })

    const unknown = core.applyEdit('not-a-target' as never, json, {
      path: '/log/level',
      replacement: '"debug"',
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.kind).toBe('unsupportedEdit')
    const invalidPath = core.applyEdit('sing-box', json, {
      path: '/log/~invalid' as string,
      replacement: '"debug"',
    })
    expect(invalidPath.ok).toBe(false)
    if (!invalidPath.ok) expect(invalidPath.error.kind).toBe('unsupportedEdit')
    expect(core.descriptor('not-a-target' as never)).toBeNull()
  })
})
