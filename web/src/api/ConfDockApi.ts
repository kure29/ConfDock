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
  RevisionDiff,
  RevisionListOptions,
  RevisionPage,
  SaveResult,
  PublishResult,
  ServiceInfo,
  ServiceSettings,
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
  /** Validate, then store a draft revision. */
  saveRevision(input: SaveRevisionInput): Promise<Result<SaveResult, ApiError>>
  publishProject(input: PublishProjectInput): Promise<Result<PublishResult, ApiError>>
  /** List one bounded page of immutable revision metadata, newest first. */
  listRevisions(
    projectId: string,
    options?: RevisionListOptions,
  ): Promise<Result<RevisionPage, ApiError>>
  /** Load one immutable revision's original bytes for read-only inspection. */
  getRevision(projectId: string, revisionId: string): Promise<Result<Revision, ApiError>>
  /** Return a bounded, read-only line diff in the explicit from → to order. */
  getRevisionDiff(
    projectId: string,
    fromRevisionId: string,
    toRevisionId: string,
  ): Promise<Result<RevisionDiff, ApiError>>
  renameProject(id: string, name: string): Promise<Result<ProjectSummary, ApiError>>
  deleteProject(id: string): Promise<Result<void, ApiError>>

  // -- access tokens ------------------------------------------------------
  listTokens(projectId: string): Promise<Result<AccessToken[], ApiError>>
  /** The only moment the plaintext and the full URL exist. */
  createToken(
    projectId: string,
    input?: CreateAccessTokenInput,
  ): Promise<Result<CreatedAccessToken, ApiError>>
  updateToken(
    projectId: string,
    tokenId: string,
    input: UpdateAccessTokenInput,
  ): Promise<Result<AccessToken, ApiError>>
  revokeToken(projectId: string, tokenId: string): Promise<Result<void, ApiError>>
  deleteRevokedToken(projectId: string, tokenId: string): Promise<Result<void, ApiError>>

  // -- service ------------------------------------------------------------
  serviceInfo(): Promise<Result<ServiceInfo, ApiError>>
  settings(): Promise<Result<ServiceSettings, ApiError>>
  updatePublicUrl(publicUrl: string): Promise<Result<ServiceSettings, ApiError>>
}

export interface PublishProjectInput {
  projectId: string
  expectedCurrentRevisionId: string
  expectedServedRevisionId: string
}

export interface SaveRevisionInput {
  projectId: string
  source: Uint8Array
  expectedRevisionId: string
}

export interface CreateAccessTokenInput {
  displayName: string
  expiresAt: string | null
}

export interface UpdateAccessTokenInput {
  displayName: string
  expiresAt: string | null
  expectedDisplayName: string
  expectedExpiresAt: string | null
}
