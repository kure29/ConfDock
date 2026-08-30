import type { ConfigCore } from './ConfigCore'
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

interface WasmResult<T, E> {
  ok: boolean
  value?: T
  error?: E
}

interface WasmConfigCoreModule {
  default: () => Promise<unknown>
  WasmConfigCore: new () => WasmConfigCoreBinding
}

interface WasmConfigCoreBinding {
  targets(): unknown
  descriptor(id: string): unknown
  schema(id: string): unknown
  editCapabilities(id: string): unknown
  detect(source: Uint8Array): unknown
  validate(id: string, source: Uint8Array): unknown
  parse(id: string, source: Uint8Array): unknown
  applyEdit(id: string, source: Uint8Array, path: string, replacement: string): unknown
  documentInfo(source: Uint8Array): unknown
}

/**
 * Load the generated wasm-bindgen module and adapt its DTOs to ConfigCore.
 *
 * This is intentionally the only implementation of the TypeScript core seam:
 * no YAML/JSON/CONF parsing or target registry data lives here. If loading or
 * decoding fails, the error is thrown to the bootstrapper; callers must not
 * silently fall back to the old mock core.
 */
export async function createWasmCore(): Promise<ConfigCore> {
  const module = (await import('./wasm-generated/confdock_wasm.js')) as WasmConfigCoreModule
  await module.default()
  const binding = new module.WasmConfigCore()

  const read = <T>(value: unknown): T => value as T
  const result = <T, E>(value: unknown): Result<T, E> => {
    const dto = read<WasmResult<T, E>>(value)
    if (dto.ok) return { ok: true, value: dto.value as T }
    return { ok: false, error: dto.error as E }
  }

  return {
    targets: () => read<TargetDescriptor[]>(binding.targets()),
    descriptor: (id: TargetId) => read<TargetDescriptor | null>(binding.descriptor(id)),
    schema: (id: TargetId) => read<TargetSchema | null>(binding.schema(id)),
    editCapabilities: (id: TargetId) =>
      read<StructuredEditCapability[]>(binding.editCapabilities(id)),
    detect: (source: Uint8Array) => read<DetectionResult[]>(binding.detect(source)),
    validate: (id: TargetId, source: Uint8Array) =>
      read<ValidationResult>(binding.validate(id, source)),
    parse: (id: TargetId, source: Uint8Array) =>
      result<ParsedDocument, ParseError>(binding.parse(id, source)),
    applyEdit: (id: TargetId, source: Uint8Array, edit: StructuredEdit) => {
      const applied = result<Uint8Array | number[], EditError>(
        binding.applyEdit(id, source, edit.path, edit.replacement),
      )
      if (!applied.ok) return applied
      return { ok: true, value: toBytes(applied.value) }
    },
    documentInfo: (source: Uint8Array) => read<DocumentInfo>(binding.documentInfo(source)),
  }
}

function toBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? new Uint8Array(value) : Uint8Array.from(value)
}
