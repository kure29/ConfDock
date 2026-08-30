import type { DocumentInfo, LineEnding, SourceEncoding, SourceSpan } from '../core/types'

/**
 * Byte-level helpers.
 *
 * Two facts drive this whole file:
 *
 * 1. `SourceSpan` holds **UTF-8 byte offsets**. JavaScript strings are UTF-16.
 *    `fixtures/mihomo/config.yaml` contains `unicode-note: "家庭网络"` and
 *    `fixtures/surge/config.conf` contains `comment = "保留引号"`, so using a
 *    byte offset directly as a string index silently points at the wrong
 *    character. Everything that crosses that boundary goes through here.
 *
 * 2. A `<textarea>` normalizes its value's newlines to LF, and drops nothing
 *    else. To honour ADR-001's "an unchanged document round-trips
 *    byte-for-byte", the original BOM and line-ending style are recorded when
 *    the document is decoded and re-applied when it is encoded.
 */

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })
const lossyDecoder = new TextDecoder('utf-8')

export const BOM = Uint8Array.of(0xef, 0xbb, 0xbf)

export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/** Mirrors `NativeDocument::as_str`, which strips the BOM before decoding. */
export function stripBom(bytes: Uint8Array): Uint8Array {
  return hasBom(bytes) ? bytes.subarray(3) : bytes
}

/** Byte offset of the document body. Spans are absolute, so BOM-prefixed
 * documents start at 3. Mirrors the `base_offset` in the Rust scanners. */
export function baseOffset(encoding: SourceEncoding): number {
  return encoding === 'utf8-bom' ? 3 : 0
}

/** Mirrors `document::detect_encoding`. */
export function detectEncoding(bytes: Uint8Array): SourceEncoding {
  if (hasBom(bytes)) {
    return isValidUtf8(bytes.subarray(3)) ? 'utf8-bom' : 'unsupported'
  }
  return isValidUtf8(bytes) ? 'utf8' : 'unsupported'
}

/** Mirrors `document::detect_line_ending`, including its `Mixed` case. */
export function detectLineEnding(bytes: Uint8Array): LineEnding {
  let lf = 0
  let crlf = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue
    if (index > 0 && bytes[index - 1] === 0x0d) crlf += 1
    else lf += 1
  }
  if (lf === 0 && crlf === 0) return 'none'
  if (lf === 0) return 'crlf'
  if (crlf === 0) return 'lf'
  return 'mixed'
}

export function documentInfo(bytes: Uint8Array): DocumentInfo {
  return {
    encoding: detectEncoding(bytes),
    lineEnding: detectLineEnding(bytes),
    hasTrailingNewline: bytes.length > 0 && bytes[bytes.length - 1] === 0x0a,
    byteLength: bytes.length,
  }
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    strictDecoder.decode(bytes)
    return true
  } catch {
    return false
  }
}

/** BOM-stripped text, or `null` when the bytes are not valid UTF-8. Mirrors
 * `NativeDocument::as_str`. */
export function documentText(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(stripBom(bytes))
  } catch {
    return null
  }
}

export function decodeLossy(bytes: Uint8Array): string {
  return lossyDecoder.decode(stripBom(bytes))
}

export function encodeUtf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function utf8Length(text: string): number {
  return encoder.encode(text).length
}

// ---------------------------------------------------------------------------
// Editor text <-> native bytes
// ---------------------------------------------------------------------------

/**
 * Decode native bytes into the text an editor can hold, plus the metadata
 * needed to encode it back. Newlines are normalized to LF because a textarea
 * would do it anyway; `info.lineEnding` remembers the original style.
 */
export function decodeToEditor(bytes: Uint8Array): {
  text: string
  info: DocumentInfo
} {
  const info = documentInfo(bytes)
  const raw = documentText(bytes) ?? decodeLossy(bytes)
  return { text: raw.replace(/\r\n/g, '\n'), info }
}

/**
 * Re-apply the original BOM and line-ending style.
 *
 * Lossless for pure-LF and pure-CRLF documents, which is what makes an
 * untouched save byte-identical. A `mixed` document cannot survive a textarea
 * round-trip; it is normalized to LF and the editor warns about it rather than
 * corrupting bytes silently.
 */
export function encodeFromEditor(text: string, info: DocumentInfo): Uint8Array {
  const body = info.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
  const encoded = encodeUtf8(body)
  return info.encoding === 'utf8-bom' ? concatBytes(BOM, encoded) : encoded
}

/**
 * Map a `SourceSpan` (absolute UTF-8 byte offsets into the *native* bytes) onto
 * a character range in the LF-normalized editor text.
 *
 * One walk handles all three offsets at once: the BOM prefix, `\n` costing two
 * bytes when the document is CRLF, and multi-byte characters.
 */
export function spanToEditorRange(
  text: string,
  info: DocumentInfo,
  span: SourceSpan,
): { start: number; end: number } {
  const crlf = info.lineEnding === 'crlf'
  let bytes = baseOffset(info.encoding)
  let index = 0
  let start: number | null = null
  let end: number | null = null

  for (;;) {
    if (start === null && bytes >= span.start) start = index
    if (start !== null && bytes >= span.end) {
      end = index
      break
    }
    if (index >= text.length) break
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    bytes += codePoint === 0x0a && crlf ? 2 : utf8Width(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }

  const resolvedStart = start ?? text.length
  return { start: resolvedStart, end: Math.max(end ?? text.length, resolvedStart) }
}

function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  if (codePoint < 0x10000) return 3
  return 4
}

/** UTF-8 byte offset within a decoded string -> UTF-16 index. Used by the
 * mock core's ports of the Rust line scanners, which count bytes. */
export function byteOffsetToCharIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0
  let bytes = 0
  let index = 0
  while (index < text.length) {
    if (bytes >= byteOffset) return index
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    bytes += utf8Width(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }
  return text.length
}

export function charIndexToByteOffset(text: string, charIndex: number): number {
  let bytes = 0
  let index = 0
  while (index < text.length && index < charIndex) {
    const codePoint = text.codePointAt(index)
    if (codePoint === undefined) break
    bytes += utf8Width(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Raw byte utilities
// ---------------------------------------------------------------------------

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Mirrors `patch::apply_span_patch`. */
export function applySpanPatch(
  source: Uint8Array,
  span: SourceSpan,
  replacement: Uint8Array,
): Uint8Array | null {
  if (span.start > span.end || span.end > source.length) return null
  return concatBytes(
    source.subarray(0, span.start),
    replacement,
    source.subarray(span.end),
  )
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

export function sliceText(source: Uint8Array, span: SourceSpan): string {
  return decodeLossy(source.subarray(span.start, span.end))
}

// ---------------------------------------------------------------------------
// Persistence (the mock API stores bytes in localStorage, which is text-only)
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** Short, stable content fingerprint. Stands in for the core's `content_hash`
 * so the UI can tell "changed" from "same bytes" without a crypto dependency. */
export function contentFingerprint(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] as number
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
