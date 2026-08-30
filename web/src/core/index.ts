import type { ConfigCore } from './ConfigCore'
import { createMockCore } from './mockCore'

/**
 * The single instance every component imports.
 *
 * Slice 2 replaces the right-hand side with the WASM-backed implementation:
 *
 *     import { createWasmCore } from './wasmCore'
 *     export const core: ConfigCore = await createWasmCore()
 *
 * `registry.ts` and `mockCore.ts` are deleted at that point. Nothing else in
 * `src/` changes, which is the whole reason this seam exists.
 */
export const core: ConfigCore = createMockCore()

export type { ConfigCore } from './ConfigCore'
export * from './types'
export { pathFromSegments, pathLabel, pathSegments, isValidPath } from './path'
export { editableSections, targetDescriptors, targetEntry } from './registry'
export { isStrictJsonLiteral } from './mockCore'
