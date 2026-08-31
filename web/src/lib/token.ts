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

export function expiryFromPreset(
  preset: HostedExpiryPreset,
  customLocalValue: string,
  now: number = Date.now(),
): string | null {
  if (preset === 'never') return null
  if (preset === 'custom') {
    const date = new Date(customLocalValue)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
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
