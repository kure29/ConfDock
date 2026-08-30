import { describe, expect, it } from 'vitest'
import {
  applySpanPatch,
  bytesEqual,
  decodeToEditor,
  encodeFromEditor,
  encodeUtf8,
  documentInfo,
  spanToEditorRange,
} from './bytes'
import { core } from '../core'

describe('native byte views', () => {
  it.each([
    ['LF', 'alpha: 1\nbeta: 2\n'],
    ['CRLF', 'alpha: 1\r\nbeta: 2\r\n'],
    ['no trailing newline', 'alpha: 1\nbeta: 2'],
  ])('%s round-trips unchanged', (_label, source) => {
    const bytes = encodeUtf8(source)
    const decoded = decodeToEditor(bytes)
    expect(bytesEqual(encodeFromEditor(decoded.text, decoded.info), bytes)).toBe(true)
  })

  it('preserves BOM and Unicode', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encodeUtf8('备注: 家庭网络\r\n')])
    const decoded = decodeToEditor(bytes)
    expect(decoded.text).toBe('备注: 家庭网络\n')
    expect(bytesEqual(encodeFromEditor(decoded.text, decoded.info), bytes)).toBe(true)
  })

  it('retains a CRLF raw-edit preference across a temporary single line', () => {
    const original = encodeUtf8('first\r\nsecond\r\n')
    const info = documentInfo(original)
    const singleLine = encodeFromEditor('single line', { ...info, lineEnding: 'crlf' })
    expect(new TextDecoder().decode(singleLine)).toBe('single line')
    const withNewline = encodeFromEditor('single line\nthird', {
      ...documentInfo(singleLine),
      lineEnding: 'crlf',
    })
    expect(new TextDecoder().decode(withNewline)).toBe('single line\r\nthird')
  })

  it('keeps mixed line endings untouched and refuses lossy text encoding', () => {
    const bytes = encodeUtf8('first\r\nsecond\nthird\r\n')
    const decoded = decodeToEditor(bytes)
    expect(decoded.info.lineEnding).toBe('mixed')
    expect(() => encodeFromEditor(decoded.text, decoded.info)).toThrow()
    expect(bytesEqual(encodeFromEditor(decoded.text, decoded.info, bytes), bytes)).toBe(true)
  })

  it('patches only the requested span in a mixed document', () => {
    const bytes = encodeUtf8('first: 1\r\n第二: 2\nthird: 3\r\n')
    const text = decodeToEditor(bytes).text
    const valueStart = encodeUtf8('first: ').length
    const valueEnd = valueStart + 1
    const patched = applySpanPatch(bytes, { start: valueStart, end: valueEnd }, encodeUtf8('9'))
    expect(patched).not.toBeNull()
    expect(new TextDecoder().decode(patched!)).toBe('first: 9\r\n第二: 2\nthird: 3\r\n')
    expect(text).toContain('第二: 2')
  })

  it('uses the core span patch for a mixed structured edit', () => {
    const bytes = encodeUtf8('mixed-port: 7890\r\n备注: 家庭网络\nother: true\r\n')
    const result = core.applyEdit('mihomo', bytes, { path: '/mixed-port', replacement: '9090' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(new TextDecoder().decode(result.value)).toBe(
      'mixed-port: 9090\r\n备注: 家庭网络\nother: true\r\n',
    )
  })

  it('maps BOM, Unicode and mixed native spans to editor UTF-16 ranges', () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...encodeUtf8('前缀\r\n目标: 值\n结尾'),
    ])
    const decoded = decodeToEditor(bytes)
    const targetStart = bytes.indexOf(encodeUtf8('目标')[0]!)
    const marker = encodeUtf8('目标: 值')
    const markerStart = bytes.findIndex((_, index) =>
      marker.every((value, offset) => bytes[index + offset] === value),
    )
    const range = spanToEditorRange(bytes, {
      start: markerStart,
      end: markerStart + marker.length,
    })
    expect(decoded.text.slice(range.start, range.end)).toBe('目标: 值')
    expect(targetStart).toBeGreaterThan(3)
  })

  it('reports accurate metadata for trailing newline', () => {
    expect(documentInfo(encodeUtf8('x\n')).hasTrailingNewline).toBe(true)
    expect(documentInfo(encodeUtf8('x')).hasTrailingNewline).toBe(false)
  })
})
