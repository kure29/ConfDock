/**
 * Line arithmetic for the editor gutter and for jumping from a diagnostic to a
 * position in the source.
 *
 * Everything here operates on **character indexes in the editor text**, not on
 * byte offsets. Convert a `SourceSpan` with `spanToEditorRange` from
 * `lib/bytes.ts` first; mixing the two is the bug that puts the caret in the
 * middle of a Chinese character.
 */

/** Character index where each line begins. Always has at least one entry. */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1)
  }
  return starts
}

export function lineCount(text: string): number {
  return lineStarts(text).length
}

/** 1-based line number containing `charIndex`. Binary search over `starts`. */
export function lineAt(starts: readonly number[], charIndex: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((starts[middle] as number) <= charIndex) low = middle
    else high = middle - 1
  }
  return low + 1
}

/** 1-based line and column, the form diagnostics are usually read in. */
export function lineColumn(
  text: string,
  charIndex: number,
): { line: number; column: number } {
  const starts = lineStarts(text)
  const line = lineAt(starts, charIndex)
  return { line, column: charIndex - (starts[line - 1] as number) + 1 }
}

/** Character range of a 1-based line, excluding its newline. */
export function lineRange(
  text: string,
  line: number,
): { start: number; end: number } {
  const starts = lineStarts(text)
  const start = starts[line - 1]
  if (start === undefined) return { start: text.length, end: text.length }
  const nextStart = starts[line]
  const end = nextStart === undefined ? text.length : nextStart - 1
  return { start, end }
}

/** Distinct 1-based line numbers touched by a character range. Used to put
 * markers in the gutter for a multi-line span. */
export function linesInRange(
  text: string,
  range: { start: number; end: number },
): number[] {
  const starts = lineStarts(text)
  const first = lineAt(starts, range.start)
  const last = lineAt(starts, Math.max(range.start, range.end - 1))
  const lines: number[] = []
  for (let line = first; line <= last; line += 1) lines.push(line)
  return lines
}
