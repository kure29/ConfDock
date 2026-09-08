import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  EditorView,
  gutter,
  GutterMarker,
  gutters,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Diagnostic, DiagnosticSeverity, DocumentInfo, SourceSpan, TargetId } from '../core'
import { decodeToEditor, spanToEditorRange } from '../lib/bytes'
import {
  BOM_NOTICE,
  ENCODING_COPY,
  LINE_ENDING_COPY,
  MIXED_LINE_ENDING_WARNING,
  formatBytes,
} from '../lib/copy'
import { lineCount, linesInRange } from '../lib/lines'
import {
  highlightLanguageForTarget,
  languageExtensionForTarget,
  syntaxHighlightingExtension,
} from './editorLanguage'
import styles from './SourceEditor.module.css'

const EXTERNAL_CHANGE = Annotation.define<boolean>()

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
  targetId: TargetId
  /** History entries use the same byte-aware viewer without enabling edits. */
  readOnly?: boolean
  /** Native bytes are required for lossless SourceSpan mapping. */
  bytes: Uint8Array
  /** Describes the native bytes for the metadata line and editing policy. */
  info: DocumentInfo
  markers?: readonly EditorMarker[]
  reveal?: RevealRequest | null
}

const severityRank: Record<DiagnosticSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
}

class DiagnosticGutterMarker extends GutterMarker {
  constructor(readonly severity: DiagnosticSeverity) {
    super()
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof DiagnosticGutterMarker && other.severity === this.severity
  }

  override toDOM(): HTMLElement {
    const dot = document.createElement('span')
    dot.className = `cd-diagnostic-dot cd-diagnostic-${this.severity}`
    dot.setAttribute('aria-hidden', 'true')
    return dot
  }
}

const DIAGNOSTIC_MARKERS: Record<DiagnosticSeverity, DiagnosticGutterMarker> = {
  info: new DiagnosticGutterMarker('info'),
  warning: new DiagnosticGutterMarker('warning'),
  error: new DiagnosticGutterMarker('error'),
}

function diagnosticGutter(markers: readonly EditorMarker[]): Extension {
  const byLine = new Map<number, DiagnosticSeverity>()
  for (const marker of markers) {
    const current = byLine.get(marker.line)
    if (current === undefined || severityRank[marker.severity] > severityRank[current]) {
      byLine.set(marker.line, marker.severity)
    }
  }
  return gutter({
    class: 'cm-diagnostic-gutter',
    renderEmptyElements: true,
    lineMarker(view, line) {
      const severity = byLine.get(view.state.doc.lineAt(line.from).number)
      return severity === undefined ? null : DIAGNOSTIC_MARKERS[severity]
    },
  })
}

function editability(readOnly: boolean, label: string): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({
      'aria-label': label,
      'aria-readonly': String(readOnly),
      'aria-multiline': 'true',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    }),
  ]
}

/**
 * The primary raw editor. CodeMirror owns line layout, scrolling, selection,
 * history, IME handling, and viewport rendering. React still owns native bytes:
 * this component only emits LF-view text for real document transactions and
 * never parses, formats, or serializes configuration content.
 */
export function SourceEditor({
  text,
  onChange,
  targetId,
  bytes,
  info,
  markers = [],
  reveal,
  readOnly = false,
}: SourceEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const languageCompartment = useRef(new Compartment())
  const markerCompartment = useRef(new Compartment())
  const editabilityCompartment = useRef(new Compartment())

  onChangeRef.current = onChange
  const effectivelyReadOnly = readOnly || info.lineEnding === 'mixed'
  const label = readOnly ? '历史版本源码（只读）' : '配置源码'

  useLayoutEffect(() => {
    if (host.current === null) return
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        gutters({ fixed: true }),
        markerCompartment.current.of(diagnosticGutter(markers)),
        drawSelection(),
        dropCursor(),
        history(),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorState.tabSize.of(2),
        languageCompartment.current.of(languageExtensionForTarget(targetId)),
        syntaxHighlightingExtension(),
        editabilityCompartment.current.of(editability(effectivelyReadOnly, label)),
        EditorView.editorAttributes.of({
          'data-highlight-language': highlightLanguageForTarget(targetId),
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(EXTERNAL_CHANGE))) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
      ],
    })
    const mounted = new EditorView({ state, parent: host.current })
    view.current = mounted
    return () => {
      mounted.destroy()
      if (view.current === mounted) view.current = null
    }
    // A keyed SourceEditor instance owns exactly one CodeMirror document.
  }, [])

  useLayoutEffect(() => {
    const current = view.current
    if (current === null || current.state.doc.toString() === text) return
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: text },
      annotations: [EXTERNAL_CHANGE.of(true), Transaction.addToHistory.of(false)],
    })
  }, [text])

  useEffect(() => {
    view.current?.dispatch({
      effects: languageCompartment.current.reconfigure(languageExtensionForTarget(targetId)),
    })
    view.current?.dom.setAttribute('data-highlight-language', highlightLanguageForTarget(targetId))
  }, [targetId])

  useEffect(() => {
    view.current?.dispatch({
      effects: markerCompartment.current.reconfigure(diagnosticGutter(markers)),
    })
  }, [markers])

  useEffect(() => {
    view.current?.dispatch({
      effects: editabilityCompartment.current.reconfigure(editability(effectivelyReadOnly, label)),
    })
  }, [effectivelyReadOnly, label])

  useEffect(() => {
    if (!reveal || view.current === null) return
    const range = spanToEditorRange(bytes, reveal.span)
    view.current.dispatch({
      selection: { anchor: range.start, head: range.end },
      effects: EditorView.scrollIntoView(range.start, { y: 'center' }),
    })
    view.current.focus()
    // A reveal is a one-shot request; changing bytes alone must not refocus.
  }, [reveal?.nonce, bytes])

  const total = lineCount(text)

  return (
    <div className={styles.editor}>
      <div className={styles.pane}>
        <div className={styles.host} ref={host} />
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
