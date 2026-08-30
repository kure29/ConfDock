import type { Result } from '../core/types'
import type {
  AccessToken,
  AdminSession,
  ApiError,
  CreatedAccessToken,
  NewProject,
  Project,
  ProjectSummary,
  Revision,
  RevisionSummary,
  SaveResult,
  ServiceInfo,
} from './types'

/**
 * The seam between the React shell and the Axum service.
 *
 * Everything is async — unlike `ConfigCore`, this really is a network boundary.
 * Every management operation that can fail for a reason the user must see
 * returns `Result<T, ApiError>`; no network or authorization error is converted
 * into an empty collection or `null`.
 *
 * `httpApi.ts` implements it against the Axum REST boundary documented in
 * `web/README.md`.
 */
export interface ConfDockApi {
  // -- session ------------------------------------------------------------
  /** Restore an existing session on boot. `null` means "show the login". */
  currentSession(): Promise<Result<AdminSession | null, ApiError>>
  signIn(password: string): Promise<Result<AdminSession, ApiError>>
  signOut(): Promise<Result<void, ApiError>>
  changePassword(
    currentPassword: string,
    nextPassword: string,
  ): Promise<Result<void, ApiError>>

  // -- projects -----------------------------------------------------------
  listProjects(): Promise<Result<ProjectSummary[], ApiError>>
  getProject(id: string): Promise<Result<Project, ApiError>>
  createProject(input: NewProject): Promise<Result<Project, ApiError>>
  /**
   * Validate, then store — one action, no separate publish (ADR-004). On
   * success `current_revision_id` and `served_revision_id` both advance.
   * Rejected saves come back with `error.validation` so the editor can show
   * exactly what blocked them.
   */
  saveRevision(input: SaveRevisionInput): Promise<Result<SaveResult, ApiError>>
  /** List immutable revision metadata, newest first; source bytes are omitted. */
  listRevisions(projectId: string): Promise<Result<RevisionSummary[], ApiError>>
  /** Load one immutable revision's original bytes for read-only inspection. */
  getRevision(projectId: string, revisionId: string): Promise<Result<Revision, ApiError>>
  renameProject(id: string, name: string): Promise<Result<ProjectSummary, ApiError>>
  deleteProject(id: string): Promise<Result<void, ApiError>>

  // -- access tokens ------------------------------------------------------
  listTokens(projectId: string): Promise<Result<AccessToken[], ApiError>>
  /** The only moment the plaintext and the full URL exist. */
  createToken(projectId: string): Promise<Result<CreatedAccessToken, ApiError>>
  revokeToken(projectId: string, tokenId: string): Promise<Result<void, ApiError>>

  // -- service ------------------------------------------------------------
  serviceInfo(): Promise<Result<ServiceInfo, ApiError>>
}

export interface SaveRevisionInput {
  projectId: string
  source: Uint8Array
  expectedRevisionId: string
}
