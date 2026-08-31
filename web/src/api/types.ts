import type { TargetId, ValidationResult } from '../core/types'

/**
 * The wire shape of the Axum service described in `docs/architecture.md`.
 *
 * These types describe the *service*, not the config format — anything about
 * config semantics belongs in `core/`. Keeping the boundary separate lets the
 * HTTP transport evolve independently of the Rust WASM core.
 *
 * Field names mirror the `projects` / `config_revisions` / `access_tokens`
 * tables defined in architecture.md.
 */

// ---------------------------------------------------------------------------
// Session — single admin
// ---------------------------------------------------------------------------

/** There is exactly one admin. No roles, no members, no invitations. */
export interface AdminSession {
  /** Opaque; the cookie does the real work. Present so the UI can tell a
   * restored session from a fresh sign-in. */
  id: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  id: string
  name: string
  targetId: TargetId
  /** The original file name, kept so the served bytes can be offered under it. */
  fileName: string
  updatedAt: string
  byteLength: number
  /** Recorded at the last successful save. Never recomputed for the list — the
   * list must not imply a fresh check happened. */
  lastValidation: ValidationResult
  hasUnpublishedChanges: boolean
}

export interface Project extends ProjectSummary {
  /** Bytes of the current revision, including a saved draft not yet published. */
  source: Uint8Array
  /**
   * Current is the editable saved draft; served is what stable URLs return.
   */
  currentRevisionId: string
  servedRevisionId: string
}

export interface NewProject {
  name: string
  targetId: TargetId
  fileName: string
  source: Uint8Array
}

export interface SaveResult {
  project: Project
  /** The validation that gated the save. */
  validation: ValidationResult
  /** True when the bytes were identical and no revision was created. */
  unchanged: boolean
}

export interface PublishResult {
  project: Project
  unchanged: boolean
}

/** Read-only metadata for one immutable source revision. */
export interface RevisionSummary {
  id: string
  revisionNo: number
  parentRevisionId: string | null
  createdAt: string
  byteLength: number
  /** Lower-case SHA-256 of the exact native bytes. */
  contentHash: string
  validation: ValidationResult
  validatorVersion: string | null
  isCurrent: boolean
  isServed: boolean
}

/** A history entry with its original bytes, loaded on explicit selection. */
export interface Revision extends RevisionSummary {
  source: Uint8Array
}

/** A bounded page of revision metadata. `nextCursor` is null at the end. */
export interface RevisionPage {
  items: RevisionSummary[]
  nextCursor: string | null
}

export interface RevisionListOptions {
  /** Number of entries to request; the service defaults to 50 and caps it. */
  limit?: number
  /** Revision ID returned as the previous page's `nextCursor`. */
  cursor?: string
}

export type RevisionDiffLineEnding = 'none' | 'lf' | 'crlf' | 'mixed'
export type RevisionDiffLineKind = 'context' | 'delete' | 'insert'

/** Metadata for one side of a read-only diff.  Source bytes are never sent. */
export interface RevisionDiffDocument extends RevisionSummary {
  hasUtf8Bom: boolean
  lineEnding: RevisionDiffLineEnding
  trailingNewline: boolean
}

export interface RevisionDiffLine {
  kind: RevisionDiffLineKind
  oldLineNo: number | null
  newLineNo: number | null
  /** Text without its line-ending bytes. */
  text: string
  lineEnding: Exclude<RevisionDiffLineEnding, 'mixed'>
}

export interface RevisionDiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: RevisionDiffLine[]
}

export interface RevisionDiff {
  from: RevisionDiffDocument
  to: RevisionDiffDocument
  identical: boolean
  additions: number
  deletions: number
  hunks: RevisionDiffHunk[]
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

/**
 * What the server can still tell you about a token after it was created.
 *
 * Only a hash is stored (architecture.md §Security), so there is no way back to
 * the plaintext — including no way to rebuild the subscription URL. The UI has
 * to say that out loud instead of pretending the URL is retrievable.
 */
export interface AccessToken {
  id: string
  prefix: string
  suffix: string
  createdAt: string
  lastUsedAt: string | null
}

export interface CreatedAccessToken {
  token: AccessToken
  /** Returned exactly once, at creation. */
  plaintext: string
  /** The full subscription URL, likewise available only now. */
  url: string
}

// ---------------------------------------------------------------------------
// Service info
// ---------------------------------------------------------------------------

export interface ServiceInfo {
  version: string
  core: 'wasm'
  api: 'http'
  /** Prefix a subscription URL is built on, e.g. `http://127.0.0.1:8787/sub`. */
  subscriptionBase: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  /** Stable machine code, e.g. `auth.invalid_password`, `validation.failed`. */
  code: string
  message: string
  /** Present when a save was rejected by validation, so the editor can show the
   * diagnostics that blocked it. */
  validation?: ValidationResult
}

export const API_ERROR = {
  invalidPassword: 'auth.invalid_password',
  unauthorized: 'auth.unauthorized',
  notFound: 'project.not_found',
  validationFailed: 'validation.failed',
  unsupportedEncoding: 'encoding.unsupported',
  invalidName: 'project.invalid_name',
  revisionConflict: 'revision.conflict',
  publishConflict: 'publish.conflict',
  tokenNotFound: 'token.not_found',
  revisionNotFound: 'revision.not_found',
  revisionDiffTooLarge: 'revision.diff_too_large',
  invalidResponse: 'network.invalid_response',
} as const
