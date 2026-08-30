import type { ConfDockApi } from './ConfDockApi'
import { createHttpApi } from './httpApi'

/**
 * The single HTTP service instance every screen imports. Vite proxies `/api`
 * and `/sub` to the local Axum process, preserving same-origin cookie rules.
 */
export const api: ConfDockApi = createHttpApi()

export type { ConfDockApi, SaveRevisionInput } from './ConfDockApi'
export * from './types'
