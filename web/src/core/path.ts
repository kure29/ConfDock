/**
 * Mirror of `crates/confdock-core/src/path.rs`.
 *
 * `ConfigPath` is an RFC 6901 JSON Pointer. In TypeScript it stays a plain
 * `string` — a wrapper class would only add ceremony — but construction and
 * decomposition must escape identically, or a Surge key like `dns-server` and a
 * section name containing `/` would produce paths the Rust side rejects.
 */

export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function unescapeSegment(segment: string): string {
  let output = ''
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] === '~') {
      const next = segment[index + 1]
      if (next === '0') output += '~'
      else if (next === '1') output += '/'
      else return output + segment.slice(index)
      index += 1
    } else {
      output += segment[index]
    }
  }
  return output
}

/** Mirrors `ConfigPath::from_segments`. */
export function pathFromSegments(segments: readonly string[]): string {
  return segments.map((segment) => `/${escapeSegment(segment)}`).join('')
}

/** Mirrors `ConfigPath::decoded_segments`. */
export function pathSegments(path: string): string[] {
  if (path === '') return []
  return path.slice(1).split('/').map(unescapeSegment)
}

/** Mirrors `ConfigPath::new`'s validation: empty, or `/`-prefixed with only
 * `~0` / `~1` tilde escapes. */
export function isValidPath(path: string): boolean {
  if (path !== '' && !path.startsWith('/')) return false
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== '~') continue
    const next = path[index + 1]
    if (next !== '0' && next !== '1') return false
    index += 1
  }
  return true
}

/** Human-facing rendering: `/log/level` reads better as `log › level` in a
 * field list, while the raw pointer stays available for the mono label. */
export function pathLabel(path: string): string {
  const segments = pathSegments(path)
  return segments.length === 0 ? '(根)' : segments.join(' › ')
}
