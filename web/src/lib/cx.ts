/** Join class names, dropping anything falsy. The only styling helper needed
 * when every component owns a CSS Module. */
export function cx(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(' ')
}
