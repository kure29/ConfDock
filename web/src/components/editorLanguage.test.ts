import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { highlightTree } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import type { TargetId } from '../core'
import {
  confdockHighlightStyle,
  highlightLanguageForTarget,
  languageExtensionForTarget,
  yamlScalarClassName,
} from './editorLanguage'

interface HighlightedToken {
  text: string
  classes: string[]
}

function highlightedTokens(targetId: TargetId, source: string): HighlightedToken[] {
  const state = EditorState.create({
    doc: source,
    extensions: [languageExtensionForTarget(targetId)],
  })
  const tree = ensureSyntaxTree(state, state.doc.length, 1_000)
  if (tree === null) throw new Error('syntax tree did not finish')
  const tokens: HighlightedToken[] = []
  highlightTree(tree, confdockHighlightStyle, (from, to, classes) => {
    tokens.push({ text: source.slice(from, to), classes: classes.split(' ') })
  })
  return tokens
}

function classesFor(tokens: HighlightedToken[], fragment: string): string[] {
  return tokens.find((token) => token.text.includes(fragment))?.classes ?? []
}

describe('raw editor language selection', () => {
  it.each<[TargetId, 'yaml' | 'json' | 'ini']>([
    ['mihomo', 'yaml'],
    ['sing-box', 'json'],
    ['surge', 'ini'],
    ['loon', 'ini'],
    ['quantumult-x', 'ini'],
    ['shadowrocket', 'ini'],
  ])('maps %s to %s', (targetId, expected) => {
    expect(highlightLanguageForTarget(targetId)).toBe(expected)
  })
})

describe('raw editor syntax categories', () => {
  it('highlights the primary YAML categories without changing the source', () => {
    const source = '# 中文注释\nmixed-port: 7890\nenabled: true\nname: "家庭网络"\n'
    const tokens = highlightedTokens('mihomo', source)

    expect(classesFor(tokens, '# 中文注释')).toContain('cd-syntax-comment')
    expect(classesFor(tokens, 'mixed-port')).toContain('cd-syntax-key')
    expect(classesFor(tokens, ':')).toContain('cd-syntax-punctuation')
    expect(yamlScalarClassName('7890')).toBe('cd-syntax-number')
    expect(yamlScalarClassName('true')).toBe('cd-syntax-boolean')
    expect(classesFor(tokens, '家庭网络')).toContain('cd-syntax-string')
    expect(source).toBe('# 中文注释\nmixed-port: 7890\nenabled: true\nname: "家庭网络"\n')
  })

  it('highlights JSON keys, structure, strings, numbers, booleans, and null', () => {
    const source = '{"name":"家庭网络","port":7890,"enabled":false,"empty":null}'
    const tokens = highlightedTokens('sing-box', source)

    expect(classesFor(tokens, 'name')).toContain('cd-syntax-key')
    expect(classesFor(tokens, '{')).toContain('cd-syntax-punctuation')
    expect(classesFor(tokens, '家庭网络')).toContain('cd-syntax-string')
    expect(classesFor(tokens, '7890')).toContain('cd-syntax-number')
    expect(classesFor(tokens, 'false')).toContain('cd-syntax-boolean')
    expect(classesFor(tokens, 'null')).toContain('cd-syntax-boolean')
  })

  it('distinguishes INI sections, keys, values, numbers, booleans, and comments', () => {
    const source = [
      '[General]',
      'loglevel = notify',
      'ipv6 = false',
      'test-timeout = 5',
      '# comment',
      '',
    ].join('\n')
    const tokens = highlightedTokens('surge', source)

    expect(classesFor(tokens, 'General')).toContain('cd-syntax-section')
    expect(classesFor(tokens, '[')).toContain('cd-syntax-punctuation')
    expect(classesFor(tokens, 'loglevel')).toContain('cd-syntax-key')
    expect(classesFor(tokens, '=')).toContain('cd-syntax-punctuation')
    expect(classesFor(tokens, 'notify')).toContain('cd-syntax-string')
    expect(classesFor(tokens, 'false')).toContain('cd-syntax-boolean')
    expect(classesFor(tokens, '5')).toContain('cd-syntax-number')
    expect(classesFor(tokens, '# comment')).toContain('cd-syntax-comment')
  })

  it('keeps URLs, IPv4, IPv6, domains, paths, commas, and hyphens intact', () => {
    const source = [
      'server = https://example.com/a-b?q=1#fragment',
      'values = 1.1.1.1, [2001:db8::1], example.com, /a-b/c',
      '// actual comment',
    ].join('\n')
    const tokens = highlightedTokens('loon', source)

    expect(classesFor(tokens, 'https://example.com/a-b?q=1#fragment')).toContain('cd-syntax-string')
    expect(classesFor(tokens, 'https://example.com/a-b?q=1#fragment')).not.toContain(
      'cd-syntax-comment',
    )
    expect(classesFor(tokens, '1.1.1.1')).toContain('cd-syntax-string')
    expect(classesFor(tokens, '2001:db8::1')).toContain('cd-syntax-string')
    expect(classesFor(tokens, 'example.com')).toContain('cd-syntax-string')
    expect(classesFor(tokens, '/a-b/c')).toContain('cd-syntax-string')
    expect(classesFor(tokens, '// actual comment')).toContain('cd-syntax-comment')
  })

  it('leaves unrecognized and incomplete INI syntax editable as plain text', () => {
    const source = 'not a recognized assignment\n[unfinished\nkey = "unterminated\n'
    const state = EditorState.create({
      doc: source,
      extensions: [languageExtensionForTarget('quantumult-x')],
    })

    expect(() => ensureSyntaxTree(state, state.doc.length, 1_000)).not.toThrow()
    expect(state.doc.toString()).toBe(source)
    expect(classesFor(highlightedTokens('quantumult-x', source), 'not a recognized')).toEqual([])
  })
})
