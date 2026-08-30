import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Revision, RevisionDiff, RevisionPage, RevisionSummary } from '../api'
import { decodeToEditor } from '../lib/bytes'
import {
  REVISION_BYTES_LABEL,
  REVISION_CREATED_LABEL,
  REVISION_CURRENT_LABEL,
  REVISION_DETAIL_LABEL,
  REVISION_DIFF_COMPARE,
  REVISION_DIFF_INITIAL,
  REVISION_DIFF_LOADING,
  REVISION_DIFF_RETRY,
  REVISION_DIFF_SHOW_SOURCE,
  REVISION_DIFF_VIEW_MODE,
  REVISION_HASH_LABEL,
  REVISION_HISTORY_DESCRIPTION,
  REVISION_HISTORY_DETAIL_LOADING,
  REVISION_HISTORY_EMPTY,
  REVISION_HISTORY_LOAD_MORE,
  REVISION_HISTORY_LOADING,
  REVISION_HISTORY_LOADING_MORE,
  REVISION_HISTORY_PAGINATION_ERROR,
  REVISION_HISTORY_RETRY,
  REVISION_HISTORY_SELECT,
  REVISION_LIST_LABEL,
  REVISION_NO_PARENT,
  REVISION_NUMBER_PREFIX,
  REVISION_PARENT_LABEL,
  REVISION_SERVED_LABEL,
  REVISION_HISTORY_SOURCE_NOTICE,
  REVISION_SOURCE_TITLE_SUFFIX,
  REVISION_VALIDATOR_VERSION_LABEL,
  VALIDATION_LEVEL_COPY,
  formatBytes,
} from '../lib/copy'
import { relativeTime, absoluteDateTime } from '../lib/time'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { SourceEditor } from './SourceEditor'
import { RevisionDiff as RevisionDiffPanel } from './RevisionDiff'
import { ValidationLevelBadge } from './ValidationLevelBadge'
import styles from './RevisionHistory.module.css'

const REVISION_PAGE_SIZE = 50

interface RevisionHistoryProps {
  projectId: string
  /** Increment after a save so unchanged saves refresh validation metadata too. */
  refreshKey: number
}

export interface RevisionHistoryViewProps {
  revisions: RevisionSummary[]
  selectedId: string | null
  detail: Revision | null
  detailLoading: boolean
  detailError: string | null
  nextCursor: string | null
  loadingMore: boolean
  loadMoreError: string | null
  diff?: RevisionDiff | null
  diffLoading?: boolean
  diffError?: string | null
  diffVisible?: boolean
  onSelect: (revisionId: string) => void
  onLoadMore: () => void
  onCompare?: () => void
  onRetryDiff?: () => void
  onShowSource?: () => void
}

/**
 * Merge one server page while defending the UI from a repeated cursor or a
 * duplicate item. The server's immutable IDs are the de-duplication key.
 */
export function mergeRevisionItems(
  current: readonly RevisionSummary[],
  incoming: readonly RevisionSummary[],
): RevisionSummary[] {
  const seen = new Set(current.map((revision) => revision.id))
  const additions: RevisionSummary[] = []
  for (const revision of incoming) {
    if (seen.has(revision.id)) continue
    seen.add(revision.id)
    additions.push(revision)
  }
  return additions.length === 0 ? [...current] : [...current, ...additions]
}

export interface RevisionPaginationState {
  revisions: RevisionSummary[]
  nextCursor: string | null
  /** Every non-null cursor returned by an accepted page in this cycle. */
  seenCursors: ReadonlySet<string>
  /** Cursors whose requests have already started in this cycle. */
  requestedCursors: ReadonlySet<string>
}

export type RevisionPaginationTransition =
  | { ok: true; state: RevisionPaginationState }
  | {
      ok: false
      reason: 'same_cursor' | 'cursor_cycle'
      state: RevisionPaginationState
    }

export type RevisionRequestTransition =
  | { ok: true; state: RevisionPaginationState }
  | {
      ok: false
      reason: 'cursor_repeated' | 'cursor_unavailable'
      state: RevisionPaginationState
    }

export function createRevisionPaginationState(): RevisionPaginationState {
  return {
    revisions: [],
    nextCursor: null,
    seenCursors: new Set<string>(),
    requestedCursors: new Set<string>(),
  }
}

/** Reserve a continuation cursor before starting its request. */
export function beginRevisionPageRequest(
  state: RevisionPaginationState,
  cursor: string,
): RevisionRequestTransition {
  if (state.nextCursor !== cursor) {
    return { ok: false, reason: 'cursor_unavailable', state }
  }
  if (state.requestedCursors.has(cursor)) {
    return { ok: false, reason: 'cursor_repeated', state }
  }
  const requestedCursors = new Set(state.requestedCursors)
  requestedCursors.add(cursor)
  return { ok: true, state: { ...state, requestedCursors } }
}

/** Allow a failed transport request to be retried without erasing history. */
export function releaseRevisionPageRequest(
  state: RevisionPaginationState,
  cursor: string,
): RevisionPaginationState {
  const requestedCursors = new Set(state.requestedCursors)
  requestedCursors.delete(cursor)
  return { ...state, requestedCursors }
}

/**
 * Apply one page to the immutable history state. A repeated response cursor
 * terminates continuation while preserving every item already loaded.
 */
export function applyRevisionPage(
  state: RevisionPaginationState,
  requestCursor: string | null,
  page: RevisionPage,
): RevisionPaginationTransition {
  const seenCursors = new Set(state.seenCursors)
  const requestedCursors = new Set(state.requestedCursors)
  if (requestCursor !== null) requestedCursors.add(requestCursor)

  if (page.nextCursor !== null && page.nextCursor === requestCursor) {
    seenCursors.add(page.nextCursor)
    return {
      ok: false,
      reason: 'same_cursor',
      state: {
        ...state,
        nextCursor: null,
        seenCursors,
        requestedCursors,
      },
    }
  }
  if (page.nextCursor !== null && seenCursors.has(page.nextCursor)) {
    return {
      ok: false,
      reason: 'cursor_cycle',
      state: {
        ...state,
        nextCursor: null,
        seenCursors,
        requestedCursors,
      },
    }
  }
  if (page.nextCursor !== null) seenCursors.add(page.nextCursor)
  return {
    ok: true,
    state: {
      revisions: mergeRevisionItems(state.revisions, page.items),
      nextCursor: page.nextCursor,
      seenCursors,
      requestedCursors,
    },
  }
}

/** Ignore an async response once a newer request has taken ownership. */
export function isRevisionRequestCurrent(activeSerial: number, requestSerial: number): boolean {
  return activeSerial === requestSerial
}

/**
 * A read-only timeline for immutable revisions. The list is intentionally
 * metadata-only; source bytes are fetched after the administrator selects one
 * entry, keeping the common history request small and predictable.
 */
export function RevisionHistory({
  projectId,
  refreshKey,
}: RevisionHistoryProps) {
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<Revision | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const [diff, setDiff] = useState<RevisionDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffVisible, setDiffVisible] = useState(false)
  const listSerial = useRef(0)
  const detailSerial = useRef(0)
  const diffSerial = useRef(0)
  const diffRequestKey = useRef<string | null>(null)
  const paginationRef = useRef<RevisionPaginationState>(createRevisionPaginationState())
  const loadingMoreRef = useRef(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const serial = listSerial.current + 1
    listSerial.current = serial
    detailSerial.current += 1
    diffSerial.current += 1
    diffRequestKey.current = null
    paginationRef.current = createRevisionPaginationState()
    loadingMoreRef.current = false
    setRevisions(null)
    setListError(null)
    setNextCursor(null)
    setLoadingMore(false)
    setLoadMoreError(null)
    setSelectedId(null)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    setDiff(null)
    setDiffLoading(false)
    setDiffError(null)
    setDiffVisible(false)
    let live = true
    void (async () => {
      const result = await api.listRevisions(projectId, { limit: REVISION_PAGE_SIZE })
      if (!live || !isRevisionRequestCurrent(listSerial.current, serial)) return
      if (result.ok) {
        const transition = applyRevisionPage(
          createRevisionPaginationState(),
          null,
          result.value,
        )
        if (!transition.ok) {
          setRevisions(null)
          setListError(REVISION_HISTORY_PAGINATION_ERROR)
          return
        }
        paginationRef.current = transition.state
        setRevisions(transition.state.revisions)
        setNextCursor(transition.state.nextCursor)
        setListError(null)
        setLoadMoreError(null)
        setSelectedId(null)
        setDetail(null)
        setDetailError(null)
      } else {
        setRevisions(null)
        setListError(result.error.message)
      }
    })()
    return () => {
      live = false
    }
  }, [projectId, refreshKey, retry])

  const select = useCallback(async (revisionId: string) => {
    const serial = detailSerial.current + 1
    detailSerial.current = serial
    diffSerial.current += 1
    diffRequestKey.current = null
    setSelectedId(revisionId)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    setDiff(null)
    setDiffLoading(false)
    setDiffError(null)
    setDiffVisible(false)
    const result = await api.getRevision(projectId, revisionId)
    if (!isRevisionRequestCurrent(detailSerial.current, serial)) return
    setDetailLoading(false)
    if (result.ok) setDetail(result.value)
    else setDetailError(result.error.message)
  }, [projectId])

  const compare = useCallback(async () => {
    const selected = revisions?.find((revision) => revision.id === selectedId)
    if (selected === undefined || selected.parentRevisionId === null) return
    const key = `${selected.parentRevisionId}\u0000${selected.id}`
    if (diffRequestKey.current === key) {
      setDiffVisible(true)
      return
    }
    if (
      diff !== null &&
      diff.from.id === selected.parentRevisionId &&
      diff.to.id === selected.id
    ) {
      setDiffVisible(true)
      return
    }
    const serial = diffSerial.current + 1
    diffSerial.current = serial
    diffRequestKey.current = key
    setDiffVisible(true)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    const result = await api.getRevisionDiff(projectId, selected.parentRevisionId, selected.id)
    if (serial !== diffSerial.current || diffRequestKey.current !== key) return
    diffRequestKey.current = null
    setDiffLoading(false)
    if (result.ok) setDiff(result.value)
    else setDiffError(result.error.message)
  }, [diff, projectId, revisions, selectedId])

  const showSource = useCallback(() => {
    setDiffVisible(false)
  }, [])

  const loadMore = useCallback(async () => {
    const cursor = paginationRef.current.nextCursor
    if (cursor === null || loadingMoreRef.current) return
    const started = beginRevisionPageRequest(paginationRef.current, cursor)
    if (!started.ok) {
      paginationRef.current = {
        ...started.state,
        nextCursor: null,
      }
      setNextCursor(null)
      setLoadMoreError(REVISION_HISTORY_PAGINATION_ERROR)
      return
    }
    paginationRef.current = started.state
    loadingMoreRef.current = true
    const serial = listSerial.current + 1
    listSerial.current = serial
    setLoadingMore(true)
    setLoadMoreError(null)
    const result = await api.listRevisions(projectId, {
      cursor,
      limit: REVISION_PAGE_SIZE,
    })
    if (!isRevisionRequestCurrent(listSerial.current, serial)) return
    loadingMoreRef.current = false
    setLoadingMore(false)
    if (!result.ok) {
      if (result.error.code === 'network.invalid_response') {
        paginationRef.current = {
          ...paginationRef.current,
          nextCursor: null,
        }
        setNextCursor(null)
        setLoadMoreError(REVISION_HISTORY_PAGINATION_ERROR)
        return
      }
      paginationRef.current = releaseRevisionPageRequest(paginationRef.current, cursor)
      setLoadMoreError(result.error.message)
      return
    }
    const transition = applyRevisionPage(paginationRef.current, cursor, result.value)
    if (!transition.ok) {
      paginationRef.current = transition.state
      setRevisions(transition.state.revisions)
      setNextCursor(null)
      setLoadMoreError(REVISION_HISTORY_PAGINATION_ERROR)
      return
    }
    paginationRef.current = transition.state
    setRevisions(transition.state.revisions)
    setNextCursor(transition.state.nextCursor)
    setLoadMoreError(null)
  }, [projectId])

  if (listError !== null) {
    return (
      <div className={styles.messageBlock} role="alert">
        <p className={styles.message}>{listError}</p>
        <Button variant="ghost" onClick={() => setRetry((value) => value + 1)}>
          {REVISION_HISTORY_RETRY}
        </Button>
      </div>
    )
  }
  if (revisions === null) {
    return <p className={styles.message} role="status">{REVISION_HISTORY_LOADING}</p>
  }
  if (revisions.length === 0) {
    return <p className={styles.message}>{REVISION_HISTORY_EMPTY}</p>
  }

  return (
    <RevisionHistoryView
      revisions={revisions}
      selectedId={selectedId}
      detail={detail}
      detailLoading={detailLoading}
      detailError={detailError}
      diff={diff}
      diffLoading={diffLoading}
      diffError={diffError}
      diffVisible={diffVisible}
      nextCursor={nextCursor}
      loadingMore={loadingMore}
      loadMoreError={loadMoreError}
      onSelect={(revisionId) => void select(revisionId)}
      onLoadMore={() => void loadMore()}
      onCompare={() => void compare()}
      onRetryDiff={() => void compare()}
      onShowSource={showSource}
    />
  )
}

/**
 * Presentational history surface. Keeping this separate makes loading, retry,
 * pagination, and read-only states directly renderable in tests without
 * requiring a browser DOM or coupling them to the HTTP client.
 */
export function RevisionHistoryView({
  revisions,
  selectedId,
  detail,
  detailLoading,
  detailError,
  diff = null,
  diffLoading = false,
  diffError = null,
  diffVisible = false,
  nextCursor,
  loadingMore,
  loadMoreError,
  onSelect,
  onLoadMore,
  onCompare = () => undefined,
  onRetryDiff = () => undefined,
  onShowSource = () => undefined,
}: RevisionHistoryViewProps) {
  return (
    <div className={styles.history}>
      <p className={styles.description}>{REVISION_HISTORY_DESCRIPTION}</p>
      <div className={styles.layout}>
        <section className={styles.listSection} aria-labelledby="revision-list-heading">
          <h3 id="revision-list-heading" className={styles.sectionLabel}>{REVISION_LIST_LABEL}</h3>
          <ol className={styles.list}>
            {revisions.map((revision) => {
              // The server's snapshot is authoritative. Local project pointers
              // can be stale when another tab saves while this view is open.
              const isCurrent = revision.isCurrent
              const isServed = revision.isServed
              const selected = revision.id === selectedId
              return (
                <li key={revision.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${selected ? styles.selected : ''}`}
                    aria-pressed={selected}
                    onClick={() => onSelect(revision.id)}
                  >
                    <span className={styles.rowTop}>
                      <span className={styles.revisionNumber}>
                        {REVISION_NUMBER_PREFIX}{revision.revisionNo}
                      </span>
                      <span
                        className={styles.time}
                        title={absoluteDateTime(revision.createdAt)}
                      >
                        {relativeTime(revision.createdAt)}
                      </span>
                    </span>
                    <span className={styles.rowMeta}>
                      {formatBytes(revision.byteLength)}
                      <span aria-hidden="true">·</span>
                      {VALIDATION_LEVEL_COPY[revision.validation.level].label}
                    </span>
                    <span className={styles.badges}>
                      {isCurrent && <Badge tone="accent">{REVISION_CURRENT_LABEL}</Badge>}
                      {isServed && <Badge tone="quiet">{REVISION_SERVED_LABEL}</Badge>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
          {(nextCursor !== null || loadMoreError !== null) && (
            <div className={styles.pagination} aria-live="polite">
              {loadMoreError !== null ? (
                <div className={styles.messageBlock} role="alert">
                  <p className={styles.message}>{loadMoreError}</p>
                  {nextCursor !== null && (
                    <Button variant="ghost" onClick={onLoadMore}>
                      {REVISION_HISTORY_RETRY}
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  variant="ghost"
                  loading={loadingMore}
                  aria-label={loadingMore ? REVISION_HISTORY_LOADING_MORE : undefined}
                  onClick={onLoadMore}
                >
                  {REVISION_HISTORY_LOAD_MORE}
                </Button>
              )}
            </div>
          )}
        </section>

        <section className={styles.detailSection} aria-labelledby="revision-detail-heading">
          <h3 id="revision-detail-heading" className={styles.sectionLabel}>{REVISION_DETAIL_LABEL}</h3>
          {selectedId === null ? (
            <p className={styles.message}>{REVISION_HISTORY_SELECT}</p>
          ) : detailLoading ? (
            <p className={styles.message} role="status">{REVISION_HISTORY_DETAIL_LOADING}</p>
          ) : detailError !== null ? (
            <div className={styles.messageBlock} role="alert">
              <p className={styles.message}>{detailError}</p>
              <Button variant="ghost" onClick={() => onSelect(selectedId)}>
                {REVISION_HISTORY_RETRY}
              </Button>
            </div>
          ) : detail === null ? (
            <p className={styles.message}>{REVISION_HISTORY_SELECT}</p>
          ) : (
            <RevisionDetail
              revision={detail}
              diff={diff}
              diffLoading={diffLoading}
              diffError={diffError}
              diffVisible={diffVisible}
              onCompare={onCompare}
              onRetryDiff={onRetryDiff}
              onShowSource={onShowSource}
            />
          )}
        </section>
      </div>
    </div>
  )
}

function RevisionDetail({
  revision,
  diff,
  diffLoading,
  diffError,
  diffVisible,
  onCompare,
  onRetryDiff,
  onShowSource,
}: {
  revision: Revision
  diff: RevisionDiff | null
  diffLoading: boolean
  diffError: string | null
  diffVisible: boolean
  onCompare: () => void
  onRetryDiff: () => void
  onShowSource: () => void
}) {
  const decoded = useMemo(() => decodeToEditor(revision.source), [revision.source])
  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <div>
          <p className={styles.detailTitle}>{REVISION_NUMBER_PREFIX}{revision.revisionNo}</p>
        </div>
        <div className={styles.badges}>
          {revision.isCurrent && <Badge tone="accent">{REVISION_CURRENT_LABEL}</Badge>}
          {revision.isServed && <Badge tone="quiet">{REVISION_SERVED_LABEL}</Badge>}
          <ValidationLevelBadge result={revision.validation} />
        </div>
      </div>

      <dl className={styles.metadata}>
        <div>
          <dt>{REVISION_CREATED_LABEL}</dt>
          <dd>{absoluteDateTime(revision.createdAt)}</dd>
        </div>
        <div>
          <dt>{REVISION_BYTES_LABEL}</dt>
          <dd>{formatBytes(revision.byteLength)}</dd>
        </div>
        <div>
          <dt>{REVISION_PARENT_LABEL}</dt>
          <dd className={styles.code}>
            {revision.parentRevisionId ?? REVISION_NO_PARENT}
          </dd>
        </div>
        <div className={styles.hashRow}>
          <dt>{REVISION_HASH_LABEL}</dt>
          <dd className={styles.code}>{revision.contentHash}</dd>
        </div>
        {revision.validatorVersion !== null && (
          <div>
            <dt>{REVISION_VALIDATOR_VERSION_LABEL}</dt>
            <dd className={styles.code}>{revision.validatorVersion}</dd>
          </div>
        )}
      </dl>

      <p className={styles.sourceNotice}>{REVISION_HISTORY_SOURCE_NOTICE}</p>
      <div className={styles.detailMode} role="group" aria-label={REVISION_DIFF_VIEW_MODE}>
        <Button
          variant={diffVisible ? 'ghost' : 'secondary'}
          onClick={onShowSource}
          aria-pressed={!diffVisible}
        >
          {REVISION_DIFF_SHOW_SOURCE}
        </Button>
        {revision.parentRevisionId !== null ? (
          <Button
            variant={diffVisible ? 'secondary' : 'ghost'}
            onClick={onCompare}
            aria-pressed={diffVisible}
          >
            {REVISION_DIFF_COMPARE}
          </Button>
        ) : (
          <span className={styles.initialNotice}>{REVISION_DIFF_INITIAL}</span>
        )}
      </div>

      {diffVisible && revision.parentRevisionId !== null ? (
        diffLoading ? (
          <p className={styles.message} role="status">{REVISION_DIFF_LOADING}</p>
        ) : diffError !== null ? (
          <div className={styles.messageBlock} role="alert">
            <p className={styles.message}>{diffError}</p>
            <Button variant="ghost" onClick={onRetryDiff}>{REVISION_DIFF_RETRY}</Button>
          </div>
        ) : diff !== null ? (
          <RevisionDiffPanel diff={diff} />
        ) : (
          <p className={styles.message} role="status">{REVISION_DIFF_LOADING}</p>
        )
      ) : (
        <Panel
          title={`${REVISION_NUMBER_PREFIX}${revision.revisionNo}${REVISION_SOURCE_TITLE_SUFFIX}`}
          flush
        >
          <SourceEditor
            text={decoded.text}
            onChange={() => undefined}
            bytes={revision.source}
            info={decoded.info}
            readOnly
          />
        </Panel>
      )}
    </div>
  )
}
