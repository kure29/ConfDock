import { absoluteDateTime } from './time'

export type HostedExpiryPreset = 'never' | '1d' | '7d' | '30d' | '90d' | 'custom'

export const HOSTED_EXPIRY_OPTIONS: readonly { value: HostedExpiryPreset; label: string }[] = [
  { value: 'never', label: '永不过期' },
  { value: '1d', label: '1 天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: '90d', label: '90 天' },
  { value: 'custom', label: '自定义时间' },
]

const DAY = 24 * 60 * 60 * 1000
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

function sameLocalMinute(
  date: Date,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): boolean {
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
  )
}

function localDateTimeToIso(value: string): string | null {
  const match = LOCAL_DATE_TIME.exec(value)
  if (match === null) return null
  const year = Number.parseInt(match[1]!, 10)
  const month = Number.parseInt(match[2]!, 10)
  const day = Number.parseInt(match[3]!, 10)
  const hour = Number.parseInt(match[4]!, 10)
  const minute = Number.parseInt(match[5]!, 10)
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hour, minute, 0, 0)
  if (!sameLocalMinute(date, year, month, day, hour, minute)) return null

  // A fall-back transition can map the same wall-clock value to two instants.
  // Reject that ambiguity instead of silently choosing the browser's default.
  const beforeOffset = new Date(date.getTime() - DAY / 2).getTimezoneOffset()
  const afterOffset = new Date(date.getTime() + DAY / 2).getTimezoneOffset()
  const offsetShift = afterOffset - beforeOffset
  if (offsetShift !== 0) {
    for (const direction of [-1, 1]) {
      const alternate = new Date(date.getTime() + direction * offsetShift * 60_000)
      if (sameLocalMinute(alternate, year, month, day, hour, minute)) return null
    }
  }
  return date.toISOString()
}

export function expiryFromPreset(
  preset: HostedExpiryPreset,
  customLocalValue: string,
  now: number = Date.now(),
): string | null {
  if (preset === 'never') return null
  if (preset === 'custom') return localDateTimeToIso(customLocalValue)
  const days = Number.parseInt(preset.slice(0, -1), 10)
  return new Date(now + days * DAY).toISOString()
}

export function localDateTimeValue(iso: string | null): string {
  if (iso === null) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

export function hostedExpiryStatus(expiresAt: string | null, revokedAt: string | null, now: number = Date.now()): string {
  if (revokedAt !== null) return '已撤销'
  if (expiresAt === null) return '永久有效'
  const timestamp = Date.parse(expiresAt)
  if (Number.isNaN(timestamp)) return '有效期未知'
  if (now >= timestamp) return '已过期'
  if (timestamp - now <= DAY) return `即将到期（${absoluteDateTime(expiresAt)}）`
  return `有效至 ${absoluteDateTime(expiresAt)}`
}

export function tokenName(value: string, fallback: string = '未命名地址'): string {
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}
