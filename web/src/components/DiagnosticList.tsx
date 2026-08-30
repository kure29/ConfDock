import type { Diagnostic, DocumentInfo, SourceSpan } from '../core'
import { spanToEditorRange } from '../lib/bytes'
import { SEVERITY_COPY } from '../lib/copy'
import { lineColumn } from '../lib/lines'
import { cx } from '../lib/cx'
import styles from './DiagnosticList.module.css'

interface DiagnosticListProps {
  diagnostics: readonly Diagnostic[]
  /** Needed to turn a byte span into a line number the user can act on. */
  text: string
  info: DocumentInfo
  /** Jump to the span in the raw editor. Omit to render positions as plain text. */
  onReveal?: (span: SourceSpan) => void
}

/**
 * One row per diagnostic: severity, machine code, message, position.
 *
 * The `code` is always shown. It is the stable identifier the Rust adapter
 * emitted (`mihomo.mixed_port_range`), which is what makes a report searchable
 * and comparable with the core's own tests — the prose message is a courtesy on
 * top of it.
 */
export function DiagnosticList({ diagnostics, text, info, onReveal }: DiagnosticListProps) {
  return (
    <ul className={styles.list}>
      {diagnostics.map((diagnostic, index) => {
        const position = describePosition(diagnostic.span, text, info)
        return (
          <li key={`${diagnostic.code}-${index}`} className={styles.item}>
            <span className={cx(styles.severity, styles[diagnostic.severity])}>
              {SEVERITY_COPY[diagnostic.severity]}
            </span>
            <div className={styles.body}>
              <p className={styles.message}>{diagnostic.message}</p>
              <p className={styles.meta}>
                <span className={styles.code}>{diagnostic.code}</span>
                {position !== null &&
                  (onReveal === undefined ? (
                    <span className={styles.position}>{position.label}</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.jump}
                      onClick={() => onReveal(position.span)}
                    >
                      {position.label}
                    </button>
                  ))}
              </p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function describePosition(
  span: SourceSpan | null,
  text: string,
  info: DocumentInfo,
): { label: string; span: SourceSpan } | null {
  if (span === null) return null
  const range = spanToEditorRange(text, info, span)
  const { line, column } = lineColumn(text, range.start)
  return { label: `第 ${line} 行 · 第 ${column} 列`, span }
}
