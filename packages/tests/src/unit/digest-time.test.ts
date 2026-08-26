import { describe, it, expect } from 'bun:test'
// Import-pure module (no db/models) — this file must never boot Mongoose, same reasoning as
// export-access.test.ts and email-guards.test.ts.
import { orgLocalParts, previousLocalDate, digestHourReached } from 'services/biz/digest/digest-time'

/**
 * FR-11.5 (#21) — the scheduler's calendar arithmetic.
 *
 * `Org.settings.timezone` was read by NOTHING before this feature, so every assumption about
 * it is new and worth pinning: that an org's day starts on ITS clock, that DST does not
 * produce two digests or none, and that a missing or nonsense zone degrades instead of
 * taking the scheduler down for every other org.
 */

describe('orgLocalParts — the org clock', () => {
  it('reads the date and hour in the org zone, not the server zone', () => {
    // 22:30 UTC on 2026-08-25 is already the 26th in Sofia (UTC+3 in summer).
    const at = new Date('2026-08-25T22:30:00Z')
    expect(orgLocalParts(at, 'Europe/Sofia')).toEqual({ date: '2026-08-26', hour: 1 })
    expect(orgLocalParts(at, 'UTC')).toEqual({ date: '2026-08-25', hour: 22 })
    // …and still the 25th in New York.
    expect(orgLocalParts(at, 'America/New_York').date).toBe('2026-08-25')
  })

  it('renders midnight as hour 0, never 24', () => {
    // Some ICU versions return "24" for midnight under hour12:false.
    const midnightSofia = new Date('2026-08-25T21:00:00Z')
    const parts = orgLocalParts(midnightSofia, 'Europe/Sofia')
    expect(parts.hour).toBe(0)
    expect(parts.date).toBe('2026-08-26')
  })

  it('falls back to UTC for a missing or invalid zone instead of throwing', () => {
    const at = new Date('2026-08-25T22:30:00Z')
    const utc = orgLocalParts(at, 'UTC')
    expect(orgLocalParts(at, undefined)).toEqual(utc)
    expect(orgLocalParts(at, '')).toEqual(utc)
    expect(orgLocalParts(at, 'Mars/Olympus_Mons')).toEqual(utc)
  })

  describe('DST transitions (edge case 3)', () => {
    // Sofia springs forward 2026-03-29 03:00 and falls back 2026-10-25 04:00.
    it('survives the spring-forward day', () => {
      const before = orgLocalParts(new Date('2026-03-29T00:30:00Z'), 'Europe/Sofia')
      const after = orgLocalParts(new Date('2026-03-29T01:30:00Z'), 'Europe/Sofia')
      expect(before.date).toBe('2026-03-29')
      expect(after.date).toBe('2026-03-29')
      // 02:30 local does not exist that day; the clock jumps to 04:30.
      expect(after.hour).toBeGreaterThan(before.hour)
    })

    it('survives the fall-back day, where an hour repeats', () => {
      const first = orgLocalParts(new Date('2026-10-25T00:30:00Z'), 'Europe/Sofia')
      const second = orgLocalParts(new Date('2026-10-25T01:30:00Z'), 'Europe/Sofia')
      // Both are the same local date — which is what the run document keys on, so the
      // repeated wall-clock hour still yields exactly one digest.
      expect(first.date).toBe('2026-10-25')
      expect(second.date).toBe('2026-10-25')
    })
  })
})

describe('previousLocalDate — the day being reported on', () => {
  const cases: [string, string][] = [
    ['2026-08-26', '2026-08-25'],
    ['2026-08-01', '2026-07-31'],   // month boundary
    ['2026-01-01', '2025-12-31'],   // year boundary
    ['2026-03-01', '2026-02-28'],   // non-leap February
    ['2028-03-01', '2028-02-29'],   // leap February
    ['2026-03-30', '2026-03-29'],   // the day after Sofia's spring-forward
  ]
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(previousLocalDate(input)).toBe(expected)
    })
  }
})

describe('digestHourReached — catch-up semantics', () => {
  it('is false before the hour', () => {
    expect(digestHourReached(6, 7)).toBe(false)
    expect(digestHourReached(0, 7)).toBe(false)
  })

  it('is true AT the hour and every hour after — a restart at 11:00 still sends 07:00', () => {
    expect(digestHourReached(7, 7)).toBe(true)
    expect(digestHourReached(11, 7)).toBe(true)
    expect(digestHourReached(23, 7)).toBe(true)
  })

  it('defaults to 07:00 when the org configured no hour', () => {
    expect(digestHourReached(6, undefined)).toBe(false)
    expect(digestHourReached(7, undefined)).toBe(true)
  })

  it('clamps a nonsense hour rather than never firing', () => {
    expect(digestHourReached(0, -5)).toBe(true)
    expect(digestHourReached(23, 99)).toBe(true)
  })

  it('treats midnight as a legitimate send hour', () => {
    expect(digestHourReached(0, 0)).toBe(true)
  })
})
