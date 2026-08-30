import type {
  RevisionDiff as RevisionDiffModel,
  RevisionDiffDocument,
  RevisionDiffLine,
} from '../api'
import {
  REVISION_BYTES_LABEL,
  REVISION_DIFF_ADDITIONS,
  REVISION_DIFF_BOM,
  REVISION_DIFF_CRLF,
  REVISION_DIFF_DELETIONS,
  REVISION_DIFF_EOF,
  REVISION_DIFF_FROM,
  REVISION_DIFF_HUNK_PREFIX,
  REVISION_DIFF_IDENTICAL,
  REVISION_DIFF_LINE_ENDING,
  REVISION_DIFF_LF,
  REVISION_DIFF_NO_LINE_CHANGES,
  REVISION_DIFF_METADATA,
  REVISION_DIFF_NEW_LINE,
  REVISION_DIFF_NO,
  REVISION_DIFF_NONE,
  REVISION_DIFF_OLD_LINE,
  REVISION_DIFF_TO,
  REVISION_DIFF_TRAILING_NEWLINE,
  REVISION_DIFF_YES,
  REVISION_HASH_LABEL,
  REVISION_NUMBER_PREFIX,
  formatBytes,
  LINE_ENDING_COPY,
} from '../lib/copy'
import styles from './RevisionDiff.module.css'

export interface RevisionDiffProps {
  diff: RevisionDiffModel
}

/** A deliberately small, read-only renderer for the service's structured diff. */
export function RevisionDiff({ diff }: RevisionDiffProps) {
  return (
    <div className={styles.diff} aria-label={`${REVISION_DIFF_FROM} ${REVISION_NUMBER_PREFIX}${diff.from.revisionNo} ${REVISION_DIFF_TO} ${REVISION_NUMBER_PREFIX}${diff.to.revisionNo}`}>
      <div className={styles.heading}>
        <h4 className={styles.direction}>
          {REVISION_NUMBER_PREFIX}{diff.from.revisionNo}
          <span aria-hidden="true"> → </span>
          {REVISION_NUMBER_PREFIX}{diff.to.revisionNo}
        </h4>
        <div className={styles.counts} aria-label={`${REVISION_DIFF_ADDITIONS} ${diff.additions}，${REVISION_DIFF_DELETIONS} ${diff.deletions}`}>
          <span className={styles.additions}>+{diff.additions} {REVISION_DIFF_ADDITIONS}</span>
          <span className={styles.deletions}>−{diff.deletions} {REVISION_DIFF_DELETIONS}</span>
        </div>
      </div>

      <div className={styles.metadata}>
        <h5 className={styles.metadataTitle}>{REVISION_DIFF_METADATA}</h5>
        <div className={styles.metadataGrid}>
          <DiffDocumentMetadata label={REVISION_DIFF_FROM} document={diff.from} />
          <DiffDocumentMetadata label={REVISION_DIFF_TO} document={diff.to} />
        </div>
      </div>

      {diff.identical ? (
        <p className={styles.identical} role="status">{REVISION_DIFF_IDENTICAL}</p>
      ) : diff.hunks.length === 0 ? (
        <p className={styles.noChanges}>{REVISION_DIFF_NO_LINE_CHANGES}</p>
      ) : (
        <div className={styles.hunks}>
          {diff.hunks.map((hunk, index) => (
            <section
              className={styles.hunk}
              key={`${hunk.oldStart}-${hunk.newStart}-${index}`}
              aria-labelledby={`revision-diff-hunk-${index}`}
            >
              <h5 id={`revision-diff-hunk-${index}`} className={styles.hunkHeader}>
                {REVISION_DIFF_HUNK_PREFIX} {index + 1}
                <span className={styles.hunkRange}>
                  {formatRange(hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount)}
                </span>
              </h5>
              <ol className={styles.lines}>
                {hunk.lines.map((line, lineIndex) => (
                  <DiffLine key={`${line.oldLineNo ?? 'x'}-${line.newLineNo ?? 'x'}-${lineIndex}`} line={line} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function DiffDocumentMetadata({
  label,
  document,
}: {
  label: string
  document: RevisionDiffDocument
}) {
  return (
    <section className={styles.document} aria-label={label}>
      <h6 className={styles.documentTitle}>{label}</h6>
      <dl>
        <div>
          <dt>{REVISION_NUMBER_PREFIX}</dt>
          <dd>{document.revisionNo}</dd>
        </div>
        <div>
          <dt>{REVISION_BYTES_LABEL}</dt>
          <dd>{formatBytes(document.byteLength)}</dd>
        </div>
        <div>
          <dt>{REVISION_DIFF_BOM}</dt>
          <dd>{document.hasUtf8Bom ? REVISION_DIFF_YES : REVISION_DIFF_NO}</dd>
        </div>
        <div>
          <dt>{REVISION_DIFF_LINE_ENDING}</dt>
          <dd>{LINE_ENDING_COPY[document.lineEnding]}</dd>
        </div>
        <div>
          <dt>{REVISION_DIFF_TRAILING_NEWLINE}</dt>
          <dd>{document.trailingNewline ? REVISION_DIFF_YES : REVISION_DIFF_NO}</dd>
        </div>
        <div className={styles.hash}>
          <dt>{REVISION_HASH_LABEL}</dt>
          <dd>{document.contentHash}</dd>
        </div>
      </dl>
    </section>
  )
}

function DiffLine({ line }: { line: RevisionDiffLine }) {
  const kindLabel = line.kind === 'context' ? ' ' : line.kind === 'delete' ? '−' : '+'
  const ending = line.lineEnding === 'none'
    ? REVISION_DIFF_EOF
    : line.lineEnding === 'lf'
      ? REVISION_DIFF_LF
      : line.lineEnding === 'crlf'
        ? REVISION_DIFF_CRLF
        : REVISION_DIFF_NONE
  const label = line.kind === 'context'
    ? `${REVISION_DIFF_OLD_LINE} ${line.oldLineNo}，${REVISION_DIFF_NEW_LINE} ${line.newLineNo}`
    : line.kind === 'delete'
      ? `${REVISION_DIFF_OLD_LINE} ${line.oldLineNo}`
      : `${REVISION_DIFF_NEW_LINE} ${line.newLineNo}`
  return (
    <li className={`${styles.line} ${styles[line.kind]}`} aria-label={`${label}，${ending}`}>
      <span className={styles.marker} aria-hidden="true">{kindLabel}</span>
      <span className={styles.oldLineNo} aria-hidden="true">{line.oldLineNo ?? ''}</span>
      <span className={styles.newLineNo} aria-hidden="true">{line.newLineNo ?? ''}</span>
      <span className={styles.text}>{line.text}</span>
      <span className={styles.ending}>{ending}</span>
    </li>
  )
}

function formatRange(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}
