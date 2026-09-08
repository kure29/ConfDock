import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import {
  HighlightStyle,
  StreamLanguage,
  syntaxTree,
  syntaxHighlighting,
} from '@codemirror/language'
import type { StreamParser } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { TargetId } from '../core'

export type ConfigHighlightLanguage = 'yaml' | 'json' | 'ini'

/** The product-level Target mapping. It is intentionally independent of file
 * names: a Project's selected Target is authoritative everywhere else too. */
export function highlightLanguageForTarget(targetId: TargetId): ConfigHighlightLanguage {
  switch (targetId) {
    case 'mihomo':
      return 'yaml'
    case 'sing-box':
      return 'json'
    case 'surge':
    case 'loon':
    case 'quantumult-x':
    case 'shadowrocket':
      return 'ini'
  }
}

interface IniState {
  mode: 'start' | 'section' | 'value' | 'plain'
  valueStarted: boolean
}

/**
 * A deliberately conservative tokenizer for the INI-like formats used by
 * Surge, Loon, Quantumult X, and Shadowrocket.
 *
 * This is not a validator. Unknown and incomplete lines stay plain text. `//`
 * is only a comment marker at the beginning of a logical line, so URLs remain
 * one value token instead of being cut off at their scheme separator.
 */
const iniParser: StreamParser<IniState> = {
  name: 'ConfDock INI',
  startState: () => ({ mode: 'start', valueStarted: false }),
  tokenTable: {
    sectionName: tags.heading,
    keyName: tags.propertyName,
    separator: tags.separator,
    punctuation: tags.punctuation,
    stringValue: tags.string,
    numberValue: tags.number,
    boolValue: tags.bool,
    lineComment: tags.lineComment,
  },
  token(stream, state) {
    if (stream.sol()) {
      state.mode = 'start'
      state.valueStarted = false
    }

    if (stream.eatSpace()) return null

    if (state.mode === 'start') {
      if (
        stream.peek() === '#' ||
        stream.peek() === ';' ||
        stream.match('//', false)
      ) {
        stream.skipToEnd()
        return 'lineComment'
      }
      if (stream.peek() === '[') {
        stream.next()
        state.mode = 'section'
        return 'punctuation'
      }
      const key = stream.match(/^[^=:\s][^=:]*?(?=\s*[=:])/)
      if (key) return 'keyName'
      if (stream.peek() === '=' || stream.peek() === ':') {
        stream.next()
        state.mode = 'value'
        return 'separator'
      }
      state.mode = 'plain'
    }

    if (state.mode === 'section') {
      if (stream.peek() === ']') {
        stream.next()
        state.mode = 'plain'
        return 'punctuation'
      }
      if (stream.skipTo(']')) return 'sectionName'
      stream.skipToEnd()
      return 'sectionName'
    }

    if (state.mode === 'value') {
      if (state.valueStarted && (stream.peek() === '#' || stream.peek() === ';')) {
        stream.skipToEnd()
        return 'lineComment'
      }
      const quote = stream.peek()
      if (quote === '"' || quote === "'") {
        stream.next()
        let escaped = false
        while (!stream.eol()) {
          const character = stream.next()
          if (character === quote && !escaped) break
          escaped = character === '\\' && !escaped
          if (character !== '\\') escaped = false
        }
        state.valueStarted = true
        return 'stringValue'
      }
      if (stream.match(/^(?:true|false|yes|no|on|off)(?=\s*(?:,|$))/i)) {
        state.valueStarted = true
        return 'boolValue'
      }
      if (stream.match(/^-?(?:0x[\da-f]+|\d+(?:\.\d+)?)(?=\s*(?:,|$))/i)) {
        state.valueStarted = true
        return 'numberValue'
      }
      if (stream.eat(/[,{}()[\]]/)) {
        state.valueStarted = true
        return 'punctuation'
      }
      if (stream.eatWhile(/[^\s,]/)) {
        state.valueStarted = true
        return 'stringValue'
      }
    }

    stream.skipToEnd()
    return null
  },
}

export const iniLanguage = StreamLanguage.define(iniParser)

/** @lezer/yaml intentionally treats plain scalars as generic content. These
 * narrow lexical classes add the three visual categories the raw editor needs
 * without parsing values, validating semantics, or rewriting the document. */
export function yamlScalarClassName(value: string): string {
  if (/^(?:true|false|null|~)$/i.test(value)) return 'cd-syntax-boolean'
  if (/^[+-]?(?:0|[1-9][\d_]*)(?:\.[\d_]+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return 'cd-syntax-number'
  }
  return 'cd-syntax-string'
}

function yamlScalarDecorations(view: EditorView): DecorationSet {
  const decorations = new RangeSetBuilder<Decoration>()
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name !== 'Literal' || node.node.parent?.name === 'Key') return
        const value = view.state.sliceDoc(node.from, node.to)
        decorations.add(
          node.from,
          node.to,
          Decoration.mark({ class: yamlScalarClassName(value) }),
        )
      },
    })
  }
  return decorations.finish()
}

const yamlScalarHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = yamlScalarDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = yamlScalarDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** Stable class names make the restrained palette testable without coupling
 * tests to CodeMirror's generated CSS-module identifiers. */
export const confdockHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, class: 'cd-syntax-comment' },
  { tag: tags.heading, class: 'cd-syntax-section' },
  { tag: [tags.propertyName, tags.attributeName], class: 'cd-syntax-key' },
  { tag: [tags.punctuation, tags.separator, tags.bracket], class: 'cd-syntax-punctuation' },
  { tag: tags.string, class: 'cd-syntax-string' },
  { tag: tags.number, class: 'cd-syntax-number' },
  { tag: [tags.bool, tags.null], class: 'cd-syntax-boolean' },
  { tag: tags.keyword, class: 'cd-syntax-keyword' },
])

export function languageExtensionForTarget(targetId: TargetId): Extension {
  switch (highlightLanguageForTarget(targetId)) {
    case 'yaml':
      return [yaml(), yamlScalarHighlighting]
    case 'json':
      return json()
    case 'ini':
      return iniLanguage
  }
}

export function syntaxHighlightingExtension(): Extension {
  return syntaxHighlighting(confdockHighlightStyle, { fallback: true })
}
