import type {
  DetectionResult,
  DocumentInfo,
  EditError,
  ParseError,
  ParsedDocument,
  Result,
  StructuredEdit,
  StructuredEditCapability,
  TargetDescriptor,
  TargetId,
  TargetSchema,
  ValidationResult,
} from './types'

/**
 * The seam between the React shell and the Rust core.
 *
 * `wasmCore.ts` implements this interface by adapting the generated
 * wasm-bindgen bindings. Nothing above this file depends on the transport or
 * on a target-specific parser.
 *
 * Everything is synchronous after the WASM module initializes in-process, not a
 * network call. Byte arrays cross the boundary, never
 * strings — the source bytes are the source of truth and decoding them is a
 * view concern (see ADR-001).
 */
export interface ConfigCore {
  /** Every registered adapter, in registry order. The UI must not maintain its
   * own list of clients. */
  targets(): TargetDescriptor[]

  descriptor(id: TargetId): TargetDescriptor | null

  /** `null` means the adapter exposes no schema at all — which is the honest
   * state for Surge / Loon / Quantumult X / Shadowrocket today. */
  schema(id: TargetId): TargetSchema | null

  /** What a structured edit is actually allowed to do. Render this; do not
   * infer capability from the target id. */
  editCapabilities(id: TargetId): StructuredEditCapability[]

  /** Advisory only. A user-selected target always wins (architecture.md L35). */
  detect(source: Uint8Array): DetectionResult[]

  validate(id: TargetId, source: Uint8Array): ValidationResult

  parse(id: TargetId, source: Uint8Array): Result<ParsedDocument, ParseError>

  /** Replaces exactly one value span and returns the new bytes. Never
   * re-serializes the document. */
  applyEdit(
    id: TargetId,
    source: Uint8Array,
    edit: StructuredEdit,
  ): Result<Uint8Array, EditError>

  /** Encoding / line-ending metadata, independent of any target. */
  documentInfo(source: Uint8Array): DocumentInfo
}
