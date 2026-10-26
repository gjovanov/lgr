import { describe, it, expect } from 'bun:test'
import { isDateOnly, localDayEnd, localDayStart } from 'services/biz/local-day'
import { suptoPeriod } from 'services/biz/supto-export.service'

/**
 * FR-21 B-7 — a Bulgarian calendar day as UTC instants. `new Date('2026-10-21')` is 00:00 UTC,
 * which as the end of a period dropped the whole last day from the SUPTO POS tables.
 */

describe('localDayStart / localDayEnd (Europe/Sofia)', () => {
  it('summer time is UTC+3', () => {
    expect(localDayStart('2026-07-15').toISOString()).toBe('2026-07-14T21:00:00.000Z')
    expect(localDayEnd('2026-07-15').toISOString()).toBe('2026-07-15T20:59:59.999Z')
  })

  it('winter time is UTC+2', () => {
    expect(localDayStart('2026-01-15').toISOString()).toBe('2026-01-14T22:00:00.000Z')
    expect(localDayEnd('2026-01-15').toISOString()).toBe('2026-01-15T21:59:59.999Z')
  })

  it('the day the clocks go back is 25 hours long', () => {
    // 2026-10-25: 04:00 EEST → 03:00 EET.
    const start = localDayStart('2026-10-25')
    const end = localDayEnd('2026-10-25')
    expect(start.toISOString()).toBe('2026-10-24T21:00:00.000Z')
    expect(end.toISOString()).toBe('2026-10-25T21:59:59.999Z')
    expect((end.getTime() + 1 - start.getTime()) / 3600_000).toBe(25)
  })

  it('the day the clocks go forward is 23 hours long', () => {
    // 2026-03-29: 03:00 EET → 04:00 EEST.
    const start = localDayStart('2026-03-29')
    const end = localDayEnd('2026-03-29')
    expect(start.toISOString()).toBe('2026-03-28T22:00:00.000Z')
    expect((end.getTime() + 1 - start.getTime()) / 3600_000).toBe(23)
  })

  it('crosses month and year ends', () => {
    expect(localDayEnd('2026-12-31').toISOString()).toBe('2026-12-31T21:59:59.999Z')
    expect(localDayStart('2027-01-01').toISOString()).toBe('2026-12-31T22:00:00.000Z')
  })

  it('takes another zone when asked', () => {
    expect(localDayStart('2026-07-15', 'UTC').toISOString()).toBe('2026-07-15T00:00:00.000Z')
  })

  it('refuses what is not a calendar date', () => {
    expect(isDateOnly('2026-07-15')).toBe(true)
    expect(isDateOnly('2026-07-15T10:00:00Z')).toBe(false)
    expect(() => localDayStart('15.07.2026')).toThrow()
  })
})

describe('suptoPeriod', () => {
  it('a one-day export covers the whole Bulgarian day', () => {
    const p = suptoPeriod('2026-10-21', '2026-10-21')
    expect(p.dateFrom.toISOString()).toBe('2026-10-20T21:00:00.000Z')
    expect(p.dateTo.toISOString()).toBe('2026-10-21T20:59:59.999Z')
  })

  it('a date-only cash sale (00:00 UTC) still falls inside its Bulgarian day', () => {
    const p = suptoPeriod('2026-10-21', '2026-10-21')
    const issueDate = new Date('2026-10-21')
    expect(issueDate >= p.dateFrom && issueDate <= p.dateTo).toBe(true)
    const nextDay = new Date('2026-10-22')
    expect(nextDay <= p.dateTo).toBe(false)
  })

  it('a full timestamp is taken as it is', () => {
    const p = suptoPeriod('2026-10-21T08:00:00.000Z', '2026-10-21T09:00:00.000Z')
    expect(p.dateFrom.toISOString()).toBe('2026-10-21T08:00:00.000Z')
    expect(p.dateTo.toISOString()).toBe('2026-10-21T09:00:00.000Z')
  })
})
