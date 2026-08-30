import type { TargetId, ValidationResult } from '../core/types'

/**
 * The shape of the Axum service planned in `docs/architecture.md`.
 *
 * These types describe the *service*, not the config format — anything about
 * config semantics belongs in `core/`. The split matters because Slice 1
 * replaces `mockApi.ts` with `httpApi.ts` and Slice 2 replaces `mockCore.ts`
 * with a WASM core, independently.
 *
 * Field names mirror the `projects` / `config_revisions` / `access_tokens`
 * tables in architecture.md.
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
}

export interface Project extends ProjectSummary {
  /** Bytes of the served revision. The single source of truth (ADR-001). */
  source: Uint8Array
  /**
   * Both pointers exist in the schema and advance together on save (ADR-004).
   * They are exposed here to keep the model honest, not because V1 shows a
   * history UI — it deliberately does not.
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
  /** Which implementation is actually behind the seams right now. The settings
   * screen shows this so nobody mistakes the mock for the real service. */
  core: 'mock' | 'wasm'
  api: 'mock' | 'http'
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
} as const
