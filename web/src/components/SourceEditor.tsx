import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import type { Diagnostic, DiagnosticSeverity, DocumentInfo, SourceSpan } from '../core'
import { decodeToEditor, spanToEditorRange } from '../lib/bytes'
import {
  BOM_NOTICE,
  ENCODING_COPY,
  LINE_ENDING_COPY,
  MIXED_LINE_ENDING_WARNING,
  formatBytes,
} from '../lib/copy'
import { cx } from '../lib/cx'
import { lineCount, linesInRange } from '../lib/lines'
import styles from './SourceEditor.module.css'

/** Both the gutter and the textarea are laid out from this one number, so the
 * numbers cannot drift away from the lines they label. */
const LINE_HEIGHT = 21

const DOT_CLASS: Record<DiagnosticSeverity, string | undefined> = {
  error: styles.dotError,
  warning: styles.dotWarning,
  info: styles.dotInfo,
}

export interface EditorMarker {
  line: number
  severity: DiagnosticSeverity
}

export interface RevealRequest {
  span: SourceSpan
  /** Changes on every request so repeating the same span still re-reveals it. */
  nonce: number
}

interface SourceEditorProps {
  text: string
  onChange: (next: string) => void
  /** Native bytes are required for lossless SourceSpan mapping. */
  bytes: Uint8Array
  /** Describes the native bytes for the metadata line and editing policy. */
  info: DocumentInfo
  markers?: readonly EditorMarker[]
  reveal?: RevealRequest | null
}

/**
 * The primary editor: a line-number gutter and a plain monospace textarea.
 *
 * No syntax highlighting, and therefore no CodeMirror/Monaco dependency. The
 * document is the source of truth (ADR-001) and a textarea edits it without a
 * translation layer that could reformat bytes behind the user's back.
 *
 * `wrap="off"` is not a style choice: with soft wrapping one logical line can
 * occupy several visual rows and every gutter number below it would point at the
 * wrong line.
 */
export function SourceEditor({ text, onChange, bytes, info, markers = [], reveal }: SourceEditorProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)

  const total = lineCount(text)
  const bySeverity = useMemo(() => {
    const map = new Map<number, DiagnosticSeverity>()
    for (const marker of markers) {
      // Errors win over warnings on the same line.
      const existing = map.get(marker.line)
      if (existing === 'error') continue
      if (existing === 'warning' && marker.severity === 'info') continue
      map.set(marker.line, marker.severity)
    }
    return map
  }, [markers])

  /** Vertical scroll only — the gutter has no horizontal extent to sync. */
  function onScroll() {
    if (gutter.current && textarea.current) {
      gutter.current.scrollTop = textarea.current.scrollTop
    }
  }

  useLayoutEffect(() => {
    onScroll()
  }, [text])

  useEffect(() => {
    if (!reveal) return
    const element = textarea.current
    if (!element) return
    const range = spanToEditorRange(bytes, reveal.span)
    element.focus()
    element.setSelectionRange(range.start, range.end)
    // Centre the line rather than relying on the browser's minimal scroll, so a
    // diagnostic near the bottom edge does not land under the fold.
    const line = linesInRange(text, range)[0] ?? 1
    const target = (line - 1) * LINE_HEIGHT - element.clientHeight / 2
    element.scrollTop = Math.max(0, target)
    onScroll()
    // Deliberately keyed on the nonce alone: `text` and `info` are read here,
    // but a reveal is a one-shot request, not a value to stay in sync with.
  }, [reveal?.nonce, bytes])

  const numbers: number[] = []
  for (let line = 1; line <= total; line += 1) numbers.push(line)

  return (
    <div className={styles.editor}>
      <div className={styles.pane}>
        <div className={styles.gutter} ref={gutter} aria-hidden="true">
          {numbers.map((line) => {
            const severity = bySeverity.get(line)
            return (
              <div key={line} className={styles.number} style={{ height: LINE_HEIGHT }}>
                {severity !== undefined && (
                  <span className={cx(styles.dot, DOT_CLASS[severity])} />
                )}
                {line}
              </div>
            )
          })}
        </div>
        <textarea
          ref={textarea}
          className={styles.textarea}
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          onScroll={onScroll}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label="配置源码"
          readOnly={info.lineEnding === 'mixed'}
        />
      </div>
      <div className={styles.meta}>
        <span>{ENCODING_COPY[info.encoding]}</span>
        <span>{LINE_ENDING_COPY[info.lineEnding]}</span>
        <span>{formatBytes(info.byteLength)}</span>
        <span>{total} 行</span>
        {!info.hasTrailingNewline && <span>结尾无换行</span>}
      </div>
      {info.encoding === 'utf8-bom' && <p className={styles.note}>{BOM_NOTICE}</p>}
      {info.lineEnding === 'mixed' && (
        <p className={styles.mixedWarning}>{MIXED_LINE_ENDING_WARNING}</p>
      )}
    </div>
  )
}

/** Gutter markers for a set of diagnostics. Kept next to the editor so the
 * byte-span-to-line conversion lives in exactly one place. */
export function diagnosticMarkers(
  diagnostics: readonly Diagnostic[],
  bytes: Uint8Array,
): EditorMarker[] {
  const text = decodeToEditor(bytes).text
  const markers: EditorMarker[] = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.span === null) continue
    const range = spanToEditorRange(bytes, diagnostic.span)
    for (const line of linesInRange(text, range)) {
      markers.push({ line, severity: diagnostic.severity })
    }
  }
  return markers
}
