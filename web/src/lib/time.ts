/** Relative and absolute time formatting, in Chinese. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "刚刚" / "12 分钟前" / "3 小时前" / "昨天" / "5 天前", falling back to an
 * absolute date past a week. Deliberately coarse: this is a single-admin tool
 * and the list only needs to answer "did I touch this recently".
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const timestamp = Date.parse(iso)
  if (Number.isNaN(timestamp)) return '时间未知'

  const elapsed = now - timestamp
  if (elapsed < 0) return '刚刚'
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`

  const days = Math.floor(elapsed / DAY)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return absoluteDate(iso)
}

/** `2026-08-30` — used once relative time stops being useful. */
export function absoluteDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** `2026-08-30 14:07` — the full form, shown in `title` attributes so the
 * coarse relative label never hides the real timestamp. */
export function absoluteDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${absoluteDate(iso)} ${hours}:${minutes}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
