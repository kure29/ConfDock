import type { ConfDockApi } from './ConfDockApi'
import { createMockApi } from './mockApi'

/**
 * The single instance every screen imports.
 *
 * Slice 1 swaps the right-hand side:
 *
 *     import { createHttpApi } from './httpApi'
 *     export const api: ConfDockApi = createHttpApi()
 *
 * `mockApi.ts` and `seed.ts` are deleted at that point; `httpApi.ts` already
 * implements the same interface, and no screen changes.
 */
export const api: ConfDockApi = createMockApi(`${window.location.origin}/sub`)

export type { ConfDockApi, SaveRevisionInput } from './ConfDockApi'
export * from './types'
export { resetMockStore } from './mockApi'
