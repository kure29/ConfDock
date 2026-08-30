import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Revision, RevisionSummary } from '../api'
import { decodeToEditor } from '../lib/bytes'
import {
  REVISION_BYTES_LABEL,
  REVISION_CREATED_LABEL,
  REVISION_CURRENT_LABEL,
  REVISION_DETAIL_LABEL,
  REVISION_HASH_LABEL,
  REVISION_HISTORY_DESCRIPTION,
  REVISION_HISTORY_DETAIL_LOADING,
  REVISION_HISTORY_EMPTY,
  REVISION_HISTORY_LOADING,
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
import { ValidationLevelBadge } from './ValidationLevelBadge'
import styles from './RevisionHistory.module.css'

interface RevisionHistoryProps {
  projectId: string
  /** Increment after a save so unchanged saves refresh validation metadata too. */
  refreshKey: number
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
  const requestSerial = useRef(0)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    requestSerial.current += 1
    setRevisions(null)
    setListError(null)
    setSelectedId(null)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    let live = true
    void (async () => {
      const result = await api.listRevisions(projectId)
      if (!live) return
      if (result.ok) {
        setRevisions(result.value)
        setListError(null)
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
    const serial = requestSerial.current + 1
    requestSerial.current = serial
    setSelectedId(revisionId)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    const result = await api.getRevision(projectId, revisionId)
    if (requestSerial.current !== serial) return
    setDetailLoading(false)
    if (result.ok) setDetail(result.value)
    else setDetailError(result.error.message)
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
                    onClick={() => void select(revision.id)}
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
              <Button variant="ghost" onClick={() => void select(selectedId)}>
                {REVISION_HISTORY_RETRY}
              </Button>
            </div>
          ) : detail === null ? (
            <p className={styles.message}>{REVISION_HISTORY_SELECT}</p>
          ) : (
            <RevisionDetail
              revision={detail}
            />
          )}
        </section>
      </div>
    </div>
  )
}

function RevisionDetail({
  revision,
}: {
  revision: Revision
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
    </div>
  )
}
