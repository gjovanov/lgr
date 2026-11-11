import { describe, it, expect } from 'bun:test'
import { HOUR_MS, clockOffsetKind, formatClockStep } from 'config/fiscal-clock'

/** #450: what a held clock's step means, as the device page and the lists say it. */
describe('clockOffsetKind', () => {
  const MIN = 60_000
  it('an hour ahead, give or take ten minutes: the device kept summer time', () => {
    expect(clockOffsetKind(-HOUR_MS)).toBe('kept-summer-time')
    expect(clockOffsetKind(-HOUR_MS + 9 * MIN)).toBe('kept-summer-time')
    expect(clockOffsetKind(-HOUR_MS - 9 * MIN)).toBe('kept-summer-time')
  })
  it('an hour behind: it kept winter time', () => {
    expect(clockOffsetKind(HOUR_MS)).toBe('kept-winter-time')
    expect(clockOffsetKind(HOUR_MS - 5 * MIN)).toBe('kept-winter-time')
  })
  it('anything else is a clock off by that much', () => {
    expect(clockOffsetKind(-HOUR_MS + 11 * MIN)).toBe('off')
    expect(clockOffsetKind(10 * MIN)).toBe('off')
    expect(clockOffsetKind(-2 * HOUR_MS)).toBe('off')
  })
})

describe('formatClockStep', () => {
  it('signed hours and minutes', () => {
    expect(formatClockStep(-HOUR_MS)).toBe('-1 h 0 min')
    expect(formatClockStep(HOUR_MS + 2 * 60_000)).toBe('+1 h 2 min')
    expect(formatClockStep(-12 * 60_000)).toBe('-12 min')
  })
})
