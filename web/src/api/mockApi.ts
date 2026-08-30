import { core } from '../core'
import { isValid } from '../core/types'
import type { Result, ValidationResult } from '../core/types'
import {
  base64ToBytes,
  bytesEqual,
  bytesToBase64,
  encodeUtf8,
} from '../lib/bytes'
import { nowIso } from '../lib/time'
import type { ConfDockApi } from './ConfDockApi'
import { SEED_PROJECTS } from './seed'
import { API_ERROR } from './types'
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
import { err, ok } from '../core/types'

/**
 * A `ConfDockApi` backed by `localStorage`.
 *
 * It exists so the whole interface can be walked before the Axum service is
 * written: saving really persists, tokens really disappear from view after they
 * are shown once, and validation really gates a save.
 *
 * Two things it is NOT, and which the UI states plainly rather than implying
 * otherwise:
 *
 * - **It does not authenticate.** There is no server, so any password is
 *   accepted until one is set through 设置. The login screen says so.
 * - **It is not multi-device.** Everything lives in this browser profile.
 *
 * Token handling does mirror the real constraint from architecture.md: only a
 * SHA-256 hash is kept, so neither the plaintext nor the subscription URL can
 * be recovered after the dialog closes.
 */

const STORAGE_KEY = 'confdock.mock.v1'
const READ_DELAY = 80
const WRITE_DELAY = 180

interface StoredToken {
  id: string
  prefix: string
  suffix: string
  /** SHA-256 of the plaintext, hex. The plaintext is never stored. */
  hash: string
  createdAt: string
  lastUsedAt: string | null
}

interface StoredProject {
  id: string
  name: string
  targetId: ProjectSummary['targetId']
  fileName: string
  createdAt: string
  updatedAt: string
  sourceBase64: string
  lastValidation: ValidationResult
  currentRevisionId: string
  servedRevisionId: string
  revisionCount: number
  tokens: StoredToken[]
}

interface Store {
  version: 1
  /** `null` until the admin sets one through 设置. */
  passwordFingerprint: string | null
  sessionId: string | null
  projects: StoredProject[]
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${hex}`
}

async function sha256Hex(value: string): Promise<string> {
  // Create a concrete ArrayBuffer rather than passing a Uint8Array whose
  // generic buffer may be SharedArrayBuffer under newer TypeScript DOM types.
  const bytes = encodeUtf8(value)
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function seedStore(): Store {
  const createdAt = nowIso()
  const projects = SEED_PROJECTS.map((seed, index) => {
    const source = encodeUtf8(seed.source)
    const revisionId = randomId('rev')
    // Stagger the timestamps so the list shows a plausible spread of relative
    // times instead of three identical "刚刚".
    const updatedAt = new Date(
      Date.parse(createdAt) - index * 2 * 60 * 60 * 1000,
    ).toISOString()
    return {
      id: randomId('prj'),
      name: seed.name,
      targetId: seed.targetId,
      fileName: seed.fileName,
      createdAt: updatedAt,
      updatedAt,
      sourceBase64: bytesToBase64(source),
      lastValidation: core.validate(seed.targetId, source),
      currentRevisionId: revisionId,
      servedRevisionId: revisionId,
      revisionCount: 1,
      tokens: [],
    } satisfies StoredProject
  })
  return { version: 1, passwordFingerprint: null, sessionId: null, projects }
}

function readStore(): Store {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    const store = seedStore()
    writeStore(store)
    return store
  }
  try {
    const parsed = JSON.parse(raw) as Store
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) throw new Error('shape')
    return parsed
  } catch {
    // A malformed store is not worth recovering in a mock; reseed rather than
    // leaving the app wedged.
    const store = seedStore()
    writeStore(store)
    return store
  }
}

function writeStore(store: Store): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toSummary(stored: StoredProject): ProjectSummary {
  return {
    id: stored.id,
    name: stored.name,
    targetId: stored.targetId,
    fileName: stored.fileName,
    updatedAt: stored.updatedAt,
    byteLength: base64ToBytes(stored.sourceBase64).length,
    lastValidation: stored.lastValidation,
  }
}

function toProject(stored: StoredProject): Project {
  return {
    ...toSummary(stored),
    source: base64ToBytes(stored.sourceBase64),
    currentRevisionId: stored.currentRevisionId,
    servedRevisionId: stored.servedRevisionId,
  }
}

function toToken(stored: StoredToken): AccessToken {
  return {
    id: stored.id,
    prefix: stored.prefix,
    suffix: stored.suffix,
    createdAt: stored.createdAt,
    lastUsedAt: stored.lastUsedAt,
  }
}

function apiError(code: string, message: string): ApiError {
  return { code, message }
}

function validateName(name: string): Result<string, ApiError> {
  const trimmed = name.trim()
  if (trimmed === '') {
    return err(apiError(API_ERROR.invalidName, '名称不能为空'))
  }
  if (trimmed.length > 60) {
    return err(apiError(API_ERROR.invalidName, '名称最多 60 个字符'))
  }
  return ok(trimmed)
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createMockApi(subscriptionBase: string): ConfDockApi {
  function findProject(store: Store, id: string): StoredProject | undefined {
    return store.projects.find((project) => project.id === id)
  }

  return {
    async currentSession(): Promise<AdminSession | null> {
      await delay(READ_DELAY)
      const store = readStore()
      if (store.sessionId === null) return null
      return { id: store.sessionId, createdAt: nowIso() }
    },

    async signIn(password: string): Promise<Result<AdminSession, ApiError>> {
      await delay(WRITE_DELAY)
      const store = readStore()
      if (store.passwordFingerprint !== null) {
        const fingerprint = await sha256Hex(password)
        if (fingerprint !== store.passwordFingerprint) {
          return err(apiError(API_ERROR.invalidPassword, '密码不正确'))
        }
      }
      const session: AdminSession = { id: randomId('ses'), createdAt: nowIso() }
      store.sessionId = session.id
      writeStore(store)
      return ok(session)
    },

    async signOut(): Promise<void> {
      await delay(READ_DELAY)
      const store = readStore()
      store.sessionId = null
      writeStore(store)
    },

    async changePassword(
      currentPassword: string,
      nextPassword: string,
    ): Promise<Result<void, ApiError>> {
      await delay(WRITE_DELAY)
      const store = readStore()
      if (store.passwordFingerprint !== null) {
        const fingerprint = await sha256Hex(currentPassword)
        if (fingerprint !== store.passwordFingerprint) {
          return err(apiError(API_ERROR.invalidPassword, '当前密码不正确'))
        }
      }
      if (nextPassword.length < 8) {
        return err(apiError(API_ERROR.invalidPassword, '新密码至少 8 个字符'))
      }
      store.passwordFingerprint = await sha256Hex(nextPassword)
      writeStore(store)
      return ok(undefined)
    },

    async listProjects(): Promise<ProjectSummary[]> {
      await delay(READ_DELAY)
      return readStore()
        .projects.map(toSummary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    async getProject(id: string): Promise<Project | null> {
      await delay(READ_DELAY)
      const stored = findProject(readStore(), id)
      return stored === undefined ? null : toProject(stored)
    },

    async createProject(input: NewProject): Promise<Result<Project, ApiError>> {
      await delay(WRITE_DELAY)
      const name = validateName(input.name)
      if (!name.ok) return name

      const validation = core.validate(input.targetId, input.source)
      if (!isValid(validation)) {
        return err({
          code: API_ERROR.validationFailed,
          message: '校验未通过，未创建配置',
          validation,
        })
      }

      const store = readStore()
      const revisionId = randomId('rev')
      const timestamp = nowIso()
      const stored: StoredProject = {
        id: randomId('prj'),
        name: name.value,
        targetId: input.targetId,
        fileName: input.fileName,
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceBase64: bytesToBase64(input.source),
        lastValidation: validation,
        currentRevisionId: revisionId,
        servedRevisionId: revisionId,
        revisionCount: 1,
        tokens: [],
      }
      store.projects.push(stored)
      writeStore(store)
      return ok(toProject(stored))
    },

    async saveRevision(
      id: string,
      source: Uint8Array,
    ): Promise<Result<SaveResult, ApiError>> {
      await delay(WRITE_DELAY)
      const store = readStore()
      const stored = findProject(store, id)
      if (stored === undefined) {
        return err(apiError(API_ERROR.notFound, '配置不存在'))
      }

      const validation = core.validate(stored.targetId, source)
      if (!isValid(validation)) {
        return err({
          code: API_ERROR.validationFailed,
          message: '校验未通过，未保存',
          validation,
        })
      }

      if (bytesEqual(base64ToBytes(stored.sourceBase64), source)) {
        // Identical bytes: record the validation but do not manufacture a
        // revision. ADR-004's pointers only move when content actually does.
        stored.lastValidation = validation
        writeStore(store)
        return ok({ project: toProject(stored), validation, unchanged: true })
      }

      // One action advances both pointers — there is no publish step (ADR-004).
      const revisionId = randomId('rev')
      stored.sourceBase64 = bytesToBase64(source)
      stored.lastValidation = validation
      stored.currentRevisionId = revisionId
      stored.servedRevisionId = revisionId
      stored.revisionCount += 1
      stored.updatedAt = nowIso()
      writeStore(store)
      return ok({ project: toProject(stored), validation, unchanged: false })
    },

    async renameProject(
      id: string,
      name: string,
    ): Promise<Result<ProjectSummary, ApiError>> {
      await delay(WRITE_DELAY)
      const validated = validateName(name)
      if (!validated.ok) return validated
      const store = readStore()
      const stored = findProject(store, id)
      if (stored === undefined) {
        return err(apiError(API_ERROR.notFound, '配置不存在'))
      }
      stored.name = validated.value
      stored.updatedAt = nowIso()
      writeStore(store)
      return ok(toSummary(stored))
    },

    async deleteProject(id: string): Promise<void> {
      await delay(WRITE_DELAY)
      const store = readStore()
      store.projects = store.projects.filter((project) => project.id !== id)
      writeStore(store)
    },

    async listTokens(projectId: string): Promise<AccessToken[]> {
      await delay(READ_DELAY)
      const stored = findProject(readStore(), projectId)
      return stored === undefined ? [] : stored.tokens.map(toToken)
    },

    async createToken(projectId: string): Promise<Result<CreatedAccessToken, ApiError>> {
      await delay(WRITE_DELAY)
      const store = readStore()
      const stored = findProject(store, projectId)
      if (stored === undefined) {
        return err(apiError(API_ERROR.notFound, '配置不存在'))
      }

      // 32 random bytes, base64url — the "high-entropy random token" the
      // architecture doc calls for.
      const raw = new Uint8Array(32)
      crypto.getRandomValues(raw)
      const plaintext = bytesToBase64(raw)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')

      const token: StoredToken = {
        id: randomId('tok'),
        prefix: plaintext.slice(0, 4),
        suffix: plaintext.slice(-4),
        hash: await sha256Hex(plaintext),
        createdAt: nowIso(),
        lastUsedAt: null,
      }
      stored.tokens.push(token)
      writeStore(store)

      return ok({
        token: toToken(token),
        plaintext,
        url: `${subscriptionBase}/${plaintext}`,
      })
    },

    async revokeToken(projectId: string, tokenId: string): Promise<void> {
      await delay(WRITE_DELAY)
      const store = readStore()
      const stored = findProject(store, projectId)
      if (stored === undefined) return
      stored.tokens = stored.tokens.filter((token) => token.id !== tokenId)
      writeStore(store)
    },

    async serviceInfo(): Promise<ServiceInfo> {
      await delay(READ_DELAY)
      return {
        version: '0.1.0-dev',
        core: 'mock',
        api: 'mock',
        subscriptionBase,
      }
    },
  }
}

/** Wipes the mock store. Exposed for the 设置 screen so a demo can be reset. */
export function resetMockStore(): void {
  localStorage.removeItem(STORAGE_KEY)
}
