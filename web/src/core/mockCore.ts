import {
  applySpanPatch,
  baseOffset,
  bytesEqual,
  documentInfo as readDocumentInfo,
  documentText,
  encodeUtf8,
  utf8Length,
} from '../lib/bytes'
import type { ConfigCore } from './ConfigCore'
import { pathFromSegments, pathSegments } from './path'
import { TARGET_ENTRIES, targetEntry } from './registry'
import type {
  DetectionConfidence,
  DetectionResult,
  Diagnostic,
  DocumentInfo,
  EditError,
  EditErrorKind,
  ParseError,
  ParsedDocument,
  Result,
  SourceField,
  SourceSpan,
  StructuredEdit,
  StructuredEditCapability,
  TargetDescriptor,
  TargetId,
  TargetSchema,
  ValidationLevel,
  ValidationResult,
} from './types'
import { err, ok } from './types'

/**
 * A `ConfigCore` that stands in for the WASM build of `confdock-core`.
 *
 * What is a faithful port, line for line, from the Rust source:
 *
 * - `parse_ini_like` and `value_edit` (targets/common.rs) — the whole CONF
 *   family. Pure line scanning, so Surge / Loon / Quantumult X / Shadowrocket
 *   behave identically to Rust, including which keys are fields, which sections
 *   are opaque, and the exact order in which an edit is rejected.
 * - The JSON `Scanner` and `append_pointer` (targets/json.rs) — sing-box. A
 *   complete strict-JSON parser producing one `SourceField` per value with its
 *   RFC 6901 pointer, so duplicate keys become `ambiguousField` exactly as
 *   they do in Rust.
 * - `scan_mixed_port` (targets/mihomo.rs) — the line scanner that decides
 *   whether `/mixed-port` has a safely patchable decimal span.
 *
 * What is an approximation, because it needs a real YAML parser:
 *
 * - Mihomo's `mihomo.yaml_syntax`, `mihomo.document_count` and
 *   `mihomo.root_mapping`. This file substitutes narrow, conservative checks
 *   (tab indentation, `---` document markers, the shape of the first
 *   significant line). They never report a problem that is not one, but they
 *   miss YAML errors a real parser would catch.
 * - Mihomo's top-level `mixed-port` values come from the same line scan rather
 *   than from a YAML event stream, so a quoted key (`"mixed-port":`) is
 *   invisible to the mock where Rust would see it.
 *
 * The gap closes entirely when the WASM bindings land. Until then the UI must
 * not claim the browser has validated anything a real client would accept —
 * see the validation-level copy in `lib/copy.ts`.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function diagnostic(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  span: SourceSpan | null = null,
): Diagnostic {
  return { severity, code, message, span }
}

function error(code: string, message: string, span: SourceSpan | null = null): Diagnostic {
  return diagnostic('error', code, message, span)
}

function editError(kind: EditErrorKind, detail: string): EditError {
  return { kind, detail }
}

/** Mirrors `NativeDocument::encoding_diagnostic`. */
function encodingDiagnostic(info: DocumentInfo): Diagnostic | null {
  if (info.encoding !== 'unsupported') return null
  return error(
    'encoding.unsupported',
    'Only UTF-8 and UTF-8 with BOM are supported; the source was not changed.',
  )
}

/** Mirrors `common::validate_utf8_document`. */
function utf8Document(
  source: Uint8Array,
  displayName: string,
): Result<{ text: string; info: DocumentInfo }, ParseError> {
  const info = readDocumentInfo(source)
  const encoding = encodingDiagnostic(info)
  if (encoding) return err({ diagnostics: [encoding] })
  const text = documentText(source)
  if (text === null) {
    return err({
      diagnostics: [
        error('encoding.invalid_utf8', `${displayName} configuration is not valid UTF-8`),
      ],
    })
  }
  return ok({ text, info })
}

/** `str::split_inclusive('\n')`: keeps the newline, yields nothing for "". */
function splitInclusive(text: string): string[] {
  if (text.length === 0) return []
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lines.push(text.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

interface SourceLine {
  /** Line content without its newline or trailing `\r`. */
  content: string
  /** Byte offset of the line's first byte, absolute (BOM included). */
  offset: number
  /** Byte length of the line *with* its newline — the scanner's step size. */
  byteLength: number
}

function sourceLines(text: string, start: number): SourceLine[] {
  const lines: SourceLine[] = []
  let offset = start
  for (const raw of splitInclusive(text)) {
    const withoutNewline = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    const content = withoutNewline.endsWith('\r')
      ? withoutNewline.slice(0, -1)
      : withoutNewline
    lines.push({ content, offset, byteLength: utf8Length(raw) })
    offset += utf8Length(raw)
  }
  return lines
}

function firstMessage(parseError: ParseError, fallback: string): string {
  return parseError.diagnostics[0]?.message ?? fallback
}

// ---------------------------------------------------------------------------
// Adapter shape, mirroring the `ConfigAdapter` trait
// ---------------------------------------------------------------------------

interface MockAdapter {
  detect(source: Uint8Array): DetectionResult
  parse(source: Uint8Array): Result<ParsedDocument, ParseError>
  validate(source: Uint8Array): ValidationResult
  applyEdit(source: Uint8Array, edit: StructuredEdit): Result<Uint8Array, EditError>
}

// ---------------------------------------------------------------------------
// CONF family — port of targets/common.rs
// ---------------------------------------------------------------------------

interface IniOptions {
  target: TargetId
  displayName: string
  editableSections: readonly string[]
  caseSensitiveSections: boolean
}

interface IniParsed {
  info: DocumentInfo
  fields: SourceField[]
  duplicateSections: Set<string>
}

/** Mirrors `common::matching_section`. Returns the *registered* spelling. */
function matchingSection(section: string, options: IniOptions): string | null {
  for (const candidate of options.editableSections) {
    const hit = options.caseSensitiveSections
      ? candidate === section
      : candidate.toLowerCase() === section.toLowerCase()
    if (hit) return candidate
  }
  return null
}

function normalizeSection(section: string, options: IniOptions): string {
  return options.caseSensitiveSections ? section : section.toLowerCase()
}

/** Mirrors `common::is_safe_key`: ASCII alphanumeric plus `_`, `-`, `.`. */
function isSafeKey(key: string): boolean {
  return key.length > 0 && /^[0-9A-Za-z_.-]+$/.test(key)
}

/** Mirrors `common::parse_ini_like`. */
function parseIniLike(
  source: Uint8Array,
  options: IniOptions,
): Result<IniParsed, ParseError> {
  const decoded = utf8Document(source, options.displayName)
  if (!decoded.ok) return decoded

  const { text, info } = decoded.value
  const fields: SourceField[] = []
  const seenSections = new Set<string>()
  const duplicateSections = new Set<string>()
  let section: string | null = null

  for (const line of sourceLines(text, baseOffset(info.encoding))) {
    const trimmed = line.content.trim()
    if (
      trimmed === '' ||
      trimmed.startsWith('#') ||
      trimmed.startsWith(';') ||
      trimmed.startsWith('//')
    ) {
      continue
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const rawSection = trimmed.slice(1, -1).trim()
      section = matchingSection(rawSection, options)
      if (section !== null) {
        const normalized = normalizeSection(section, options)
        if (seenSections.has(normalized)) duplicateSections.add(normalized)
        else seenSections.add(normalized)
      }
      continue
    }

    if (section === null) continue

    const equal = line.content.indexOf('=')
    if (equal < 0) continue

    const key = line.content.slice(0, equal).trim()
    if (!isSafeKey(key)) continue

    // Rust indexes `content` by bytes, so every offset below is a byte count.
    const afterEqual = line.content.slice(equal + 1)
    const leading = utf8Length(afterEqual) - utf8Length(afterEqual.trimStart())
    const valueStartRel = utf8Length(line.content.slice(0, equal)) + 1 + leading
    const value = afterEqual.trim()
    const valueStart = line.offset + valueStartRel
    fields.push({
      path: pathFromSegments([section, key]),
      valueSpan: { start: valueStart, end: valueStart + utf8Length(value) },
    })
  }

  return ok({ info, fields, duplicateSections })
}

/** Mirrors `common::value_edit`, including its rejection order. */
function iniValueEdit(
  source: Uint8Array,
  edit: StructuredEdit,
  options: IniOptions,
): Result<Uint8Array, EditError> {
  const segments = pathSegments(edit.path)
  if (segments.length !== 2) {
    return err(editError('unsupportedEdit', 'CONF edits require /Section/key'))
  }
  const rawSection = segments[0] as string
  const key = segments[1] as string

  const editableSection = matchingSection(rawSection, options)
  if (editableSection === null) {
    return err(
      editError(
        'unsupportedEdit',
        `section is opaque and cannot be patched safely: ${rawSection}`,
      ),
    )
  }

  const parsed = parseIniLike(source, options)
  if (!parsed.ok) {
    return err(
      editError('parseFailed', firstMessage(parsed.error, 'invalid text document')),
    )
  }

  const normalized = normalizeSection(editableSection, options)
  if (parsed.value.duplicateSections.has(normalized)) {
    return err(editError('ambiguousField', edit.path))
  }

  const canonicalPath = pathFromSegments([editableSection, key])
  const matches = parsed.value.fields.filter((field) => field.path === canonicalPath)
  if (matches.length === 0) return err(editError('fieldNotFound', edit.path))
  if (matches.length > 1) return err(editError('ambiguousField', edit.path))
  const field = matches[0] as SourceField

  const current = source.subarray(field.valueSpan.start, field.valueSpan.end)
  if (current.includes(0x23) || current.includes(0x3b)) {
    return err(
      editError('unsupportedEdit', 'inline comment boundary is not safe to infer'),
    )
  }
  if (
    edit.replacement.length === 0 ||
    edit.replacement.includes('\r') ||
    edit.replacement.includes('\n')
  ) {
    return err(
      editError(
        'unsafeValue',
        `value for ${edit.path} is not a safe single-line replacement`,
      ),
    )
  }

  const patched = applySpanPatch(source, field.valueSpan, encodeUtf8(edit.replacement))
  if (patched === null) {
    return err(editError('parseFailed', 'source span is outside the document'))
  }
  return ok(patched)
}

/** Mirrors `common::text_detection`. */
function textDetection(
  source: Uint8Array,
  target: TargetId,
  marker: string,
): DetectionResult {
  // Note: Rust checks the *whole* byte slice for UTF-8 validity here, BOM
  // included, so a BOM-prefixed document is still valid UTF-8 and reaches the
  // marker test.
  const text = documentText(source)
  let confidence: DetectionConfidence
  if (text === null) confidence = 'none'
  else if (text.includes(marker)) confidence = 'likely'
  else confidence = 'maybe'
  return { target, confidence, diagnostics: [] }
}

function createIniAdapter(options: IniOptions, marker: string): MockAdapter {
  return {
    detect: (source) => textDetection(source, options.target, marker),
    parse: (source) => {
      const parsed = parseIniLike(source, options)
      if (!parsed.ok) return parsed
      return ok({ info: parsed.value.info, fields: parsed.value.fields })
    },
    validate: (source) => {
      const parsed = parseIniLike(source, options)
      return {
        level: 'basic',
        diagnostics: parsed.ok ? [] : parsed.error.diagnostics,
      }
    },
    applyEdit: (source, edit) => iniValueEdit(source, edit, options),
  }
}

// ---------------------------------------------------------------------------
// sing-box — port of targets/json.rs
// ---------------------------------------------------------------------------

function appendPointer(path: string, segment: string): string {
  return `${path}/${segment.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

class JsonScanner {
  private cursor = 0
  readonly fields: SourceField[] = []

  constructor(
    private readonly bytes: Uint8Array,
    private readonly base: number,
  ) {}

  /** Absolute byte offset of the cursor, for diagnostic spans. */
  get position(): number {
    return this.base + this.cursor
  }

  skipWs(): void {
    while (this.cursor < this.bytes.length && isJsonWhitespace(this.byte())) {
      this.cursor += 1
    }
  }

  parseValue(path: string): void {
    this.skipWs()
    const start = this.cursor
    const byte = this.byte()
    if (byte === 0x7b) this.parseObject(path)
    else if (byte === 0x5b) this.parseArray(path)
    else if (byte === 0x22) this.parseString()
    else if (byte === 0x2d || (byte !== undefined && byte >= 0x30 && byte <= 0x39)) {
      this.parseNumber()
    } else if (byte === 0x74) this.consumeLiteral('true')
    else if (byte === 0x66) this.consumeLiteral('false')
    else if (byte === 0x6e) this.consumeLiteral('null')
    else if (byte === undefined) throw new JsonScanError('unexpected end of input')
    else throw new JsonScanError('unexpected value')

    if (path !== '') {
      this.fields.push({
        path,
        valueSpan: { start: this.base + start, end: this.base + this.cursor },
      })
    }
  }

  private parseObject(path: string): void {
    this.cursor += 1
    this.skipWs()
    if (this.consumeIf(0x7d)) return
    for (;;) {
      this.skipWs()
      if (this.byte() !== 0x22) throw new JsonScanError('object key must be a string')
      const key = this.parseStringValue()
      this.skipWs()
      if (!this.consumeIf(0x3a)) throw new JsonScanError("expected ':' after object key")
      this.parseValue(appendPointer(path, key))
      this.skipWs()
      if (this.consumeIf(0x7d)) return
      if (!this.consumeIf(0x2c)) throw new JsonScanError("expected ',' or '}' in object")
    }
  }

  private parseArray(path: string): void {
    this.cursor += 1
    this.skipWs()
    if (this.consumeIf(0x5d)) return
    let index = 0
    for (;;) {
      this.parseValue(appendPointer(path, String(index)))
      index += 1
      this.skipWs()
      if (this.consumeIf(0x5d)) return
      if (!this.consumeIf(0x2c)) throw new JsonScanError("expected ',' or ']' in array")
    }
  }

  private parseStringValue(): string {
    const start = this.cursor
    this.parseString()
    const raw = new TextDecoder().decode(this.bytes.subarray(start, this.cursor))
    try {
      return JSON.parse(raw) as string
    } catch {
      throw new JsonScanError('invalid JSON object key')
    }
  }

  private parseString(): void {
    if (!this.consumeIf(0x22)) throw new JsonScanError('expected string')
    while (this.cursor < this.bytes.length) {
      const byte = this.byte() as number
      if (byte === 0x22) {
        this.cursor += 1
        return
      }
      if (byte === 0x5c) {
        this.cursor += 1
        if (this.cursor >= this.bytes.length) {
          throw new JsonScanError('unterminated escape')
        }
        this.cursor += 1
        continue
      }
      if (byte < 0x20) throw new JsonScanError('control character in string')
      this.cursor += 1
    }
    throw new JsonScanError('unterminated string')
  }

  private parseNumber(): void {
    const start = this.cursor
    this.consumeIf(0x2d)
    if (this.consumeIf(0x30)) {
      if (isDigit(this.byte())) throw new JsonScanError('leading zero in number')
    } else if (this.consumeWhile(isDigit) === 0) {
      throw new JsonScanError('invalid number')
    }
    if (this.consumeIf(0x2e) && this.consumeWhile(isDigit) === 0) {
      throw new JsonScanError('invalid fraction')
    }
    const exponent = this.byte()
    if (exponent === 0x65 || exponent === 0x45) {
      this.cursor += 1
      this.consumeIf(0x2b)
      this.consumeIf(0x2d)
      if (this.consumeWhile(isDigit) === 0) throw new JsonScanError('invalid exponent')
    }
    if (this.cursor === start) throw new JsonScanError('invalid number')
  }

  private consumeLiteral(literal: string): void {
    const expected = encodeUtf8(literal)
    const actual = this.bytes.subarray(this.cursor, this.cursor + expected.length)
    if (!bytesEqual(actual, expected)) throw new JsonScanError('invalid literal')
    this.cursor += expected.length
  }

  private consumeIf(byte: number): boolean {
    if (this.byte() === byte) {
      this.cursor += 1
      return true
    }
    return false
  }

  private consumeWhile(predicate: (byte: number | undefined) => boolean): number {
    const start = this.cursor
    while (this.cursor < this.bytes.length && predicate(this.byte())) this.cursor += 1
    return this.cursor - start
  }

  private byte(): number | undefined {
    return this.bytes[this.cursor]
  }
}

class JsonScanError extends Error {}

function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39
}

function isJsonWhitespace(byte: number | undefined): boolean {
  // `u8::is_ascii_whitespace`: space, tab, LF, CR, form feed.
  return (
    byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c
  )
}

/** Mirrors `json::parse_json_document`. */
function parseJsonDocument(
  source: Uint8Array,
  displayName: string,
): Result<ParsedDocument, ParseError> {
  const info = readDocumentInfo(source)
  const encoding = encodingDiagnostic(info)
  if (encoding) return err({ diagnostics: [encoding] })

  const base = baseOffset(info.encoding)
  const body = source.subarray(base)
  const text = documentText(source)
  if (text === null) {
    return err({
      diagnostics: [error('json.syntax', `invalid ${displayName} JSON: not valid UTF-8`)],
    })
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unparseable'
    return err({
      diagnostics: [error('json.syntax', `invalid ${displayName} JSON: ${message}`)],
    })
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({
      diagnostics: [
        error(
          'json.root_object',
          `${displayName} configuration root must be a JSON object`,
          { start: base, end: source.length },
        ),
      ],
    })
  }

  const scanner = new JsonScanner(body, base)
  scanner.skipWs()
  try {
    scanner.parseValue('')
  } catch (cause) {
    const message = cause instanceof JsonScanError ? cause.message : 'unparseable'
    return err({
      diagnostics: [
        error('json.parse', `invalid ${displayName} JSON: ${message}`, {
          start: scanner.position,
          end: Math.min(scanner.position + 1, source.length),
        }),
      ],
    })
  }
  scanner.skipWs()
  if (scanner.position !== source.length) {
    return err({
      diagnostics: [
        error('json.trailing', 'unexpected bytes after the JSON document', {
          start: scanner.position,
          end: source.length,
        }),
      ],
    })
  }

  return ok({ info, fields: scanner.fields })
}

/** Mirrors `json::find_json_field`. */
function findJsonField(
  source: Uint8Array,
  path: string,
  displayName: string,
): Result<SourceSpan, EditError> {
  const parsed = parseJsonDocument(source, displayName)
  if (!parsed.ok) {
    return err(editError('parseFailed', firstMessage(parsed.error, 'invalid JSON')))
  }
  const matches = parsed.value.fields.filter((field) => field.path === path)
  if (matches.length === 0) return err(editError('fieldNotFound', path))
  if (matches.length > 1) return err(editError('ambiguousField', path))
  return ok((matches[0] as SourceField).valueSpan)
}

/** Mirrors `json::validate_json_literal`. */
export function isStrictJsonLiteral(literal: string): boolean {
  try {
    JSON.parse(literal)
    return true
  } catch {
    return false
  }
}

/** Mirrors `json::json_detection`. */
function jsonDetection(source: Uint8Array, target: TargetId): DetectionResult {
  const body = source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf
    ? source.subarray(3)
    : source
  let first: number | undefined
  for (const byte of body) {
    if (!isJsonWhitespace(byte)) {
      first = byte
      break
    }
  }
  return {
    target,
    confidence: first === 0x7b || first === 0x5b ? 'likely' : 'none',
    diagnostics: [],
  }
}

const SING_BOX: MockAdapter = {
  detect: (source) => jsonDetection(source, 'sing-box'),
  parse: (source) => parseJsonDocument(source, 'sing-box'),
  validate: (source) => {
    const parsed = parseJsonDocument(source, 'sing-box')
    if (parsed.ok) return { level: 'syntax', diagnostics: [] }
    const level: ValidationLevel = parsed.error.diagnostics.some((item) =>
      item.code.startsWith('encoding.'),
    )
      ? 'basic'
      : 'syntax'
    return { level, diagnostics: parsed.error.diagnostics }
  },
  applyEdit: (source, edit) => {
    const span = findJsonField(source, edit.path, 'sing-box')
    if (!span.ok) return span
    if (!isStrictJsonLiteral(edit.replacement)) {
      return err(editError('unsafeValue', 'replacement must be one strict JSON value'))
    }
    const patched = applySpanPatch(source, span.value, encodeUtf8(edit.replacement))
    if (patched === null) {
      return err(editError('parseFailed', 'source span is outside the document'))
    }
    return ok(patched)
  },
}

// ---------------------------------------------------------------------------
// Mihomo — port of targets/mihomo.rs
// ---------------------------------------------------------------------------

interface MixedPortOccurrence {
  /** Present only when the value is a safely patchable decimal run. */
  valueSpan: SourceSpan | null
  /** The whole trimmed value, quotes and tags included. */
  fullSpan: SourceSpan
}

type MixedPortValue = { kind: 'integer'; value: number } | { kind: 'other' }

/** Faithful port of `mihomo::scan_mixed_port`. */
function scanMixedPort(text: string, start: number): MixedPortOccurrence[] {
  const occurrences: MixedPortOccurrence[] = []
  const KEY = 'mixed-port:'
  for (const line of sourceLines(text, start)) {
    if (!line.content.startsWith(KEY)) continue
    const afterKey = line.content.slice(KEY.length)
    const leading = utf8Length(afterKey) - utf8Length(afterKey.trimStart())
    const valueStart = line.offset + KEY.length + leading
    const trimmed = afterKey.trimStart().trimEnd()
    const fullSpan = { start: valueStart, end: valueStart + utf8Length(trimmed) }

    let digits = 0
    while (digits < trimmed.length && isAsciiDigit(trimmed[digits] as string)) digits += 1
    const remainder = trimmed.slice(digits)
    const safelyTerminated =
      digits > 0 && (remainder.trim() === '' || remainder.trimStart().startsWith('#'))

    occurrences.push({
      valueSpan: safelyTerminated
        ? { start: valueStart, end: valueStart + digits }
        : null,
      fullSpan,
    })
  }
  return occurrences
}

function isAsciiDigit(character: string): boolean {
  return character >= '0' && character <= '9'
}

/**
 * Stands in for `inspect_top_level_mixed_ports`, which walks a YAML event
 * stream. Here the same line scan is reused: in well-formed YAML a top-level
 * key sits at column zero, which is exactly what `scan_mixed_port` matches.
 * A quoted top-level key would be missed — documented in web/README.md.
 */
function topLevelMixedPortValues(text: string): MixedPortValue[] {
  const values: MixedPortValue[] = []
  const KEY = 'mixed-port:'
  for (const line of sourceLines(text, 0)) {
    if (!line.content.startsWith(KEY)) continue
    values.push(classifyMixedPort(line.content.slice(KEY.length).trim()))
  }
  return values
}

/** Mirrors `mihomo::classify_mixed_port`. */
function classifyMixedPort(raw: string): MixedPortValue {
  let value = raw

  // An alias node is never a scalar.
  if (value.startsWith('*')) return { kind: 'other' }

  // An anchor sits before the scalar and does not change its style.
  if (value.startsWith('&')) {
    const separator = value.search(/\s/)
    if (separator < 0) return { kind: 'other' }
    value = value.slice(separator).trim()
  }

  // Explicit tag: only `!!int` yields an integer, and only via decimal parse.
  if (value.startsWith('!')) {
    const separator = value.search(/\s/)
    if (separator < 0) return { kind: 'other' }
    const tag = value.slice(0, separator)
    const rest = stripPlainComment(value.slice(separator).trim())
    if (tag !== '!!int') return { kind: 'other' }
    const parsed = decimalInteger(rest)
    return parsed === null ? { kind: 'other' } : { kind: 'integer', value: parsed }
  }

  // Quoted scalars are not `TScalarStyle::Plain`.
  if (value.startsWith('"') || value.startsWith("'")) return { kind: 'other' }
  // Block scalars and flow collections are not plain scalars either.
  if (value.startsWith('|') || value.startsWith('>')) return { kind: 'other' }
  if (value.startsWith('{') || value.startsWith('[')) return { kind: 'other' }

  const scalar = stripPlainComment(value)
  if (scalar === '') return { kind: 'other' }
  const parsed = yamlInteger(scalar)
  return parsed === null ? { kind: 'other' } : { kind: 'integer', value: parsed }
}

/** A YAML plain scalar ends at ` #`. */
function stripPlainComment(value: string): string {
  const comment = value.search(/\s#/)
  return (comment < 0 ? value : value.slice(0, comment)).trim()
}

/** Mirrors the integer branch of `yaml_rust2`'s `Yaml::from_str`. */
function yamlInteger(value: string): number | null {
  if (value.startsWith('0x')) return radixInteger(value.slice(2), 16)
  if (value.startsWith('0o')) return radixInteger(value.slice(2), 8)
  if (value.startsWith('+')) return decimalInteger(value.slice(1))
  return decimalInteger(value)
}

function decimalInteger(value: string): number | null {
  if (!/^[+-]?\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function radixInteger(value: string, radix: number): number | null {
  const pattern = radix === 16 ? /^[0-9a-fA-F]+$/ : /^[0-7]+$/
  if (!pattern.test(value)) return null
  const parsed = Number.parseInt(value, radix)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Conservative substitute for the three YAML failures `parse_yaml_root` can
 * report. Each check only fires on something that is unambiguously invalid, so
 * the mock never invents an error; it does miss errors a real parser catches.
 */
function yamlStructureDiagnostics(
  text: string,
  byteLength: number,
  start: number,
): Diagnostic | null {
  const lines = sourceLines(text, start)

  // A tab can never be YAML indentation.
  for (const line of lines) {
    const indent = line.content.length - line.content.trimStart().length
    if (line.content.slice(0, indent).includes('\t')) {
      return error(
        'mihomo.yaml_syntax',
        'invalid Mihomo YAML: tab characters cannot be used for indentation',
        { start: line.offset, end: line.offset + line.byteLength },
      )
    }
  }

  const significant = lines.filter((line) => {
    const trimmed = line.content.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })

  const markers = significant.filter((line) => line.content.trimEnd() === '---')
  const documents =
    markers.length === 0
      ? 1
      : significant[0]?.content.trimEnd() === '---'
        ? markers.length
        : markers.length + 1
  if (documents !== 1) {
    return error(
      'mihomo.document_count',
      'Mihomo configuration must contain exactly one YAML document',
    )
  }

  const root = significant.find((line) => line.content.trimEnd() !== '---')
  if (root === undefined) {
    return error('mihomo.root_mapping', 'Mihomo configuration root must be a YAML mapping', {
      start: 0,
      end: byteLength,
    })
  }
  const rootContent = root.content.trim()
  const looksLikeMapping =
    rootContent.startsWith('{') ||
    /^(?:"[^"]*"|'[^']*'|[^"'\s][^:]*)\s*:(?:\s|$)/.test(rootContent)
  if (!looksLikeMapping) {
    return error('mihomo.root_mapping', 'Mihomo configuration root must be a YAML mapping', {
      start: 0,
      end: byteLength,
    })
  }

  return null
}

interface MihomoRoot {
  text: string
  info: DocumentInfo
  mixedPortValues: MixedPortValue[]
}

/** Mirrors `mihomo::parse_yaml_root`. */
function parseYamlRoot(source: Uint8Array): Result<MihomoRoot, ParseError> {
  const decoded = utf8Document(source, 'Mihomo')
  if (!decoded.ok) return decoded
  const { text, info } = decoded.value

  const structural = yamlStructureDiagnostics(text, source.length, baseOffset(info.encoding))
  if (structural) return err({ diagnostics: [structural] })

  return ok({ text, info, mixedPortValues: topLevelMixedPortValues(text) })
}

const MIHOMO: MockAdapter = {
  detect: (source) => {
    const text = documentText(source)
    let confidence: DetectionConfidence = 'none'
    if (text !== null) {
      const hit = sourceLines(text, 0).some(
        (line) =>
          line.content.startsWith('mixed-port:') ||
          line.content.startsWith('proxy-groups:'),
      )
      confidence = hit ? 'likely' : 'maybe'
    }
    return { target: 'mihomo', confidence, diagnostics: [] }
  },

  parse: (source) => {
    const root = parseYamlRoot(source)
    if (!root.ok) return root
    const { text, info } = root.value
    const fields: SourceField[] = []
    for (const occurrence of scanMixedPort(text, baseOffset(info.encoding))) {
      if (occurrence.valueSpan) {
        fields.push({ path: '/mixed-port', valueSpan: occurrence.valueSpan })
      }
    }
    return ok({ info, fields })
  },

  validate: (source) => {
    const root = parseYamlRoot(source)
    if (!root.ok) {
      const level: ValidationLevel = root.error.diagnostics.some((item) =>
        item.code.startsWith('encoding.'),
      )
        ? 'basic'
        : 'syntax'
      return { level, diagnostics: root.error.diagnostics }
    }

    const { text, info, mixedPortValues } = root.value
    const occurrences = scanMixedPort(text, baseOffset(info.encoding))
    const diagnostics: Diagnostic[] = []

    if (mixedPortValues.length > 1) {
      const span = occurrences[1]?.fullSpan ?? occurrences[0]?.fullSpan ?? null
      diagnostics.push(
        error(
          'mihomo.mixed_port_duplicate',
          'mixed-port occurs more than once and is ambiguous',
          span,
        ),
      )
    }

    const first = mixedPortValues[0]
    if (first !== undefined) {
      const span = occurrences[0]?.fullSpan ?? null
      if (first.kind === 'integer') {
        if (first.value < 1 || first.value > 65535) {
          diagnostics.push(
            error('mihomo.mixed_port_range', 'mixed-port must be between 1 and 65535', span),
          )
        }
      } else {
        diagnostics.push(
          error('mihomo.mixed_port_type', 'mixed-port must be an integer', span),
        )
      }
    }

    return { level: 'static', diagnostics }
  },

  applyEdit: (source, edit) => {
    if (edit.path !== '/mixed-port') {
      return err(
        editError(
          'unsupportedEdit',
          'Mihomo structured edits currently support only /mixed-port',
        ),
      )
    }
    const root = parseYamlRoot(source)
    if (!root.ok) {
      return err(editError('parseFailed', firstMessage(root.error, 'invalid YAML document')))
    }
    const { text, info, mixedPortValues } = root.value
    const occurrences = scanMixedPort(text, baseOffset(info.encoding))
    if (mixedPortValues.length > 1 || occurrences.length > 1) {
      return err(editError('ambiguousField', edit.path))
    }
    const occurrence = occurrences[0]
    if (occurrence === undefined) return err(editError('fieldNotFound', edit.path))
    if (occurrence.valueSpan === null) {
      return err(
        editError(
          'unsupportedEdit',
          'mixed-port value is not a safely identifiable decimal scalar',
        ),
      )
    }

    // `replacement.parse::<u16>()`: optional `+`, digits only, <= 65535.
    if (!/^\+?\d+$/.test(edit.replacement)) {
      return err(editError('unsafeValue', 'mixed-port must be a decimal integer'))
    }
    const value = Number(edit.replacement)
    if (value > 65535) {
      return err(editError('unsafeValue', 'mixed-port must be a decimal integer'))
    }
    if (value === 0) {
      return err(editError('unsafeValue', 'mixed-port must be between 1 and 65535'))
    }

    const patched = applySpanPatch(source, occurrence.valueSpan, encodeUtf8(edit.replacement))
    if (patched === null) {
      return err(editError('parseFailed', 'source span is outside the document'))
    }
    return ok(patched)
  },
}

// ---------------------------------------------------------------------------
// Adapter table, mirroring `TargetRegistry::builtin()`
// ---------------------------------------------------------------------------

function iniAdapter(target: TargetId, displayName: string, section: string): MockAdapter {
  return createIniAdapter(
    {
      target,
      displayName,
      editableSections: [section],
      caseSensitiveSections: true,
    },
    `[${section}]`,
  )
}

const ADAPTERS: Record<TargetId, MockAdapter> = {
  mihomo: MIHOMO,
  'sing-box': SING_BOX,
  surge: iniAdapter('surge', 'Surge', 'General'),
  loon: iniAdapter('loon', 'Loon', 'General'),
  'quantumult-x': iniAdapter('quantumult-x', 'Quantumult X', 'general'),
  shadowrocket: iniAdapter('shadowrocket', 'Shadowrocket', 'General'),
}

// ---------------------------------------------------------------------------
// ConfigCore implementation
// ---------------------------------------------------------------------------

export function createMockCore(): ConfigCore {
  return {
    targets(): TargetDescriptor[] {
      return TARGET_ENTRIES.map((entry) => entry.descriptor)
    },

    descriptor(id: TargetId): TargetDescriptor | null {
      return targetEntry(id)?.descriptor ?? null
    },

    schema(id: TargetId): TargetSchema | null {
      return targetEntry(id)?.schema ?? null
    },

    editCapabilities(id: TargetId): StructuredEditCapability[] {
      return targetEntry(id)?.editCapabilities.slice() ?? []
    },

    detect(source: Uint8Array): DetectionResult[] {
      return TARGET_ENTRIES.map((entry) =>
        ADAPTERS[entry.descriptor.id].detect(source),
      )
    },

    validate(id: TargetId, source: Uint8Array): ValidationResult {
      return ADAPTERS[id].validate(source)
    },

    parse(id: TargetId, source: Uint8Array): Result<ParsedDocument, ParseError> {
      return ADAPTERS[id].parse(source)
    },

    applyEdit(
      id: TargetId,
      source: Uint8Array,
      edit: StructuredEdit,
    ): Result<Uint8Array, EditError> {
      return ADAPTERS[id].applyEdit(source, edit)
    },

    documentInfo(source: Uint8Array): DocumentInfo {
      return readDocumentInfo(source)
    },
  }
}
