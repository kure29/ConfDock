import type { Result } from '../core/types'
import type {
  AccessToken,
  AdminSession,
  ApiError,
  CreatedAccessToken,
  NewProject,
  Project,
  ProjectSummary,
  SaveResult,
  ServiceInfo,
} from './types'

/**
 * The seam between the React shell and the Axum service.
 *
 * Everything is async — unlike `ConfigCore`, this really is a network boundary.
 * Methods that can fail for a reason the user must see return
 * `Result<T, ApiError>`; methods that can only fail catastrophically reject.
 *
 * `mockApi.ts` implements this against `localStorage` today; `httpApi.ts`
 * implements it against the REST shape documented in `web/README.md`.
 */
export interface ConfDockApi {
  // -- session ------------------------------------------------------------
  /** Restore an existing session on boot. `null` means "show the login". */
  currentSession(): Promise<AdminSession | null>
  signIn(password: string): Promise<Result<AdminSession, ApiError>>
  signOut(): Promise<void>
  changePassword(
    currentPassword: string,
    nextPassword: string,
  ): Promise<Result<void, ApiError>>

  // -- projects -----------------------------------------------------------
  listProjects(): Promise<ProjectSummary[]>
  getProject(id: string): Promise<Project | null>
  createProject(input: NewProject): Promise<Result<Project, ApiError>>
  /**
   * Validate, then store — one action, no separate publish (ADR-004). On
   * success `current_revision_id` and `served_revision_id` both advance.
   * Rejected saves come back with `error.validation` so the editor can show
   * exactly what blocked them.
   */
  saveRevision(id: string, source: Uint8Array): Promise<Result<SaveResult, ApiError>>
  renameProject(id: string, name: string): Promise<Result<ProjectSummary, ApiError>>
  deleteProject(id: string): Promise<void>

  // -- access tokens ------------------------------------------------------
  listTokens(projectId: string): Promise<AccessToken[]>
  /** The only moment the plaintext and the full URL exist. */
  createToken(projectId: string): Promise<Result<CreatedAccessToken, ApiError>>
  revokeToken(projectId: string, tokenId: string): Promise<void>

  // -- service ------------------------------------------------------------
  serviceInfo(): Promise<ServiceInfo>
}
