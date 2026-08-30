import type { ConfigCore } from './ConfigCore'
import { createWasmCore } from './wasmCore'

/**
 * The single instance every component imports.
 *
 * The binding is installed by `main.tsx` after asynchronous wasm startup. A
 * missing binding is a programming error; startup renders a dedicated error
 * screen rather than falling back to a second TypeScript core.
 */
export let core!: ConfigCore

export async function initializeCore(): Promise<void> {
  core = await createWasmCore()
}

export type { ConfigCore } from './ConfigCore'
export * from './types'
export { pathFromSegments, pathLabel, pathSegments, isValidPath } from './path'
