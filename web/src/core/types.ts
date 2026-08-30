/* TypeScript mirror of the `confdock-core` public contracts.
 *
 * Every type here corresponds one-to-one to a Rust type in
 * `crates/confdock-core/src/`. Keep the shapes aligned: when the WASM bindings
 * land in Slice 2 they will serialize into exactly these structures, and the
 * mock in `mockCore.ts` will be deleted without touching a single component.
 *
 * Rust enums become discriminated unions so components can exhaustively match
 * without knowing which target they are looking at. That is what
 * `docs/architecture.md` means by "no target conditionals scattered through
 * React".
 */

// ---------------------------------------------------------------------------
// targets/mod.rs
// ---------------------------------------------------------------------------

/** Mirrors the `TargetId` constants. There is no runtime target that is not in
 * this union, so an unhandled id is a type error rather than a blank screen. */
export type TargetId =
  | 'mihomo'
  | 'sing-box'
  | 'surge'
  | 'loon'
  | 'quantumult-x'
  | 'shadowrocket'

export type DetectionConfidence = 'none' | 'maybe' | 'likely'

export interface DetectionResult {
  target: TargetId
  confidence: DetectionConfidence
  diagnostics: Diagnostic[]
}

export interface AdapterCapabilities {
  rawEdit: boolean
  validationLevel: ValidationLevel
  nativeValidation: boolean
  /** Sections the adapter recognizes. Advisory: being listed does not make a
   * section structurally editable — that is `StructuredEditScope`. */
  sections: string[]
}

export type StructuredEditScope =
  | { kind: 'exactPaths'; paths: string[] }
  | { kind: 'existingJsonPointerValues' }
  | { kind: 'existingSectionKeys'; sections: string[]; caseSensitive: boolean }

export type StructuredEditOperation = 'replaceExistingValue'

export interface StructuredEditCapability {
  scope: StructuredEditScope
  operations: StructuredEditOperation[]
  valueTypes: SchemaValueType[]
  /** Verbatim from the adapter. Surfaced to the user unchanged so the UI can
   * never overstate what the core will actually do. */
  safetyNotes: string
}

export interface TargetDescriptor {
  id: TargetId
  displayName: string
  fileExtensions: string[]
  capabilities: AdapterCapabilities
}

export interface ParseError {
  diagnostics: Diagnostic[]
}

// ---------------------------------------------------------------------------
// diagnostics.rs
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'info' | 'warning' | 'error'

/**
 * Validation is layered. A failure reports the *deepest layer actually
 * reached*, so `basic` is not a synonym for "passed" — see `docs/architecture.md`.
 */
export type ValidationLevel = 'basic' | 'syntax' | 'static' | 'native'

/** Ascending, matching Rust's `Ord` derive on `ValidationLevel`. */
export const VALIDATION_LEVEL_ORDER: readonly ValidationLevel[] = [
  'basic',
  'syntax',
  'static',
  'native',
]

/**
 * Byte offsets into the native source — **not** JavaScript string indexes.
 * Convert with `lib/bytes.ts` before touching a textarea selection.
 */
export interface SourceSpan {
  start: number
  end: number
}

export interface Diagnostic {
  severity: DiagnosticSeverity
  /** Stable machine code, e.g. `mihomo.mixed_port_range`. Always shown. */
  code: string
  message: string
  span: SourceSpan | null
}

export interface ValidationResult {
  level: ValidationLevel
  diagnostics: Diagnostic[]
}

export function isValid(result: ValidationResult): boolean {
  return !result.diagnostics.some((d) => d.severity === 'error')
}

// ---------------------------------------------------------------------------
// document.rs
// ---------------------------------------------------------------------------

export type SourceEncoding = 'utf8' | 'utf8-bom' | 'unsupported'

export type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none'

export interface DocumentInfo {
  encoding: SourceEncoding
  lineEnding: LineEnding
  hasTrailingNewline: boolean
  byteLength: number
}

export interface SourceField {
  /** RFC 6901 JSON Pointer. */
  path: string
  /** Span of the complete value, excluding surrounding whitespace. */
  valueSpan: SourceSpan
}

export interface ParsedDocument {
  info: DocumentInfo
  fields: SourceField[]
}

// ---------------------------------------------------------------------------
// schema.rs
// ---------------------------------------------------------------------------

export type SchemaValueType =
  | 'string'
  | 'integer'
  | 'boolean'
  | 'number'
  | 'object'
  | 'array'
  | 'null'
  | 'any'

export interface SchemaField {
  path: string
  valueType: SchemaValueType
  description: string
}

export interface TargetSchema {
  fields: SchemaField[]
}

// ---------------------------------------------------------------------------
// patch.rs
// ---------------------------------------------------------------------------

export interface StructuredEdit {
  path: string
  /** Inserted verbatim after the adapter validates it. */
  replacement: string
}

export type EditErrorKind =
  | 'unsupportedEncoding'
  | 'parseFailed'
  | 'fieldNotFound'
  | 'ambiguousField'
  | 'unsafeValue'
  | 'unsupportedEdit'

export interface EditError {
  kind: EditErrorKind
  /** The adapter's own message, in English. `lib/copy.ts` renders the Chinese
   * explanation from `kind`; this string is shown as supporting detail. */
  detail: string
}

// ---------------------------------------------------------------------------
// Result, mirroring Rust's `Result<T, E>`
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value }
}

export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error }
}
