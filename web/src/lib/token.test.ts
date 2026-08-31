import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expiryFromPreset,
  hostedExpiryStatus,
  localDateTimeValue,
} from './token'

afterEach(() => vi.useRealTimers())

describe('hosted token expiry helpers', () => {
  it('converts presets and local custom times to explicit UTC', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'))
    expect(expiryFromPreset('1d', '')).toBe('2026-09-01T00:00:00.000Z')
    expect(expiryFromPreset('7d', '')).toBe('2026-09-07T00:00:00.000Z')
    expect(expiryFromPreset('30d', '')).toBe('2026-09-30T00:00:00.000Z')
    expect(expiryFromPreset('90d', '')).toBe('2026-11-29T00:00:00.000Z')
    expect(expiryFromPreset('never', '')).toBeNull()
    expect(expiryFromPreset('custom', '2026-09-01T08:30')).toBe(
      new Date('2026-09-01T08:30').toISOString(),
    )
  })

  it('uses the now >= expiry boundary and local display formatting', () => {
    const expiry = '2026-09-01T00:00:00Z'
    const now = Date.parse('2026-08-31T00:00:00Z')
    expect(hostedExpiryStatus(null, null, now)).toBe('永久有效')
    expect(hostedExpiryStatus(expiry, null, now)).toContain('即将到期')
    expect(hostedExpiryStatus(expiry, null, Date.parse(expiry))).toBe('已过期')
    expect(hostedExpiryStatus(expiry, '2026-08-30T00:00:00Z', now)).toBe('已撤销')
    expect(localDateTimeValue(expiry)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})
