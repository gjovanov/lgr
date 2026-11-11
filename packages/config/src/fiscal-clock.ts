/**
 * #450 — a fiscal device's clock that the scheduled sync would not set (a step larger than it takes on its own,
 * `fiscal/clock#MAX_STEP_MS`), as the server and the screens say it.
 *
 * `stepMs` is how far the device's clock would move: the verified time minus the device's. Negative: the device is
 * ahead. An hour, give or take ten minutes, is the summer-time change the device did not make: ahead after the last
 * Sunday of October (it kept summer time), behind after the last Sunday of March (it kept winter time). A fiscalized
 * device refuses a time earlier than its last fiscal record by itself (Н-18); LGR shows that refusal and adds no rule
 * of its own (the owner's decision on #450).
 *
 * Import-pure: the time sync, the device page and the lists read it.
 */

export const HOUR_MS = 60 * 60 * 1000
/** How far from a whole hour a step may be and still read as a summer-time change the device missed. */
export const SUMMER_TIME_TOLERANCE_MS = 10 * 60 * 1000

export type ClockOffsetKind = 'kept-summer-time' | 'kept-winter-time' | 'off'

export function clockOffsetKind(stepMs: number): ClockOffsetKind {
  if (Math.abs(stepMs + HOUR_MS) <= SUMMER_TIME_TOLERANCE_MS) return 'kept-summer-time'
  if (Math.abs(stepMs - HOUR_MS) <= SUMMER_TIME_TOLERANCE_MS) return 'kept-winter-time'
  return 'off'
}

/** What the scheduled sync recorded on the device when it held its clock back. */
export interface ClockHeld {
  /** The device's clock when it was read. */
  deviceTime: string | Date
  /** The verified time at that moment. */
  serverTime: string | Date
  /** `serverTime − deviceTime`: negative, the device is ahead. */
  stepMs: number
  /** When the sync held it. */
  at: string | Date
}

/** "+1 h 0 min" / "-1 h 2 min" / "+12 min": a step, for a person. */
export function formatClockStep(stepMs: number): string {
  const sign = stepMs < 0 ? '-' : '+'
  const minutes = Math.round(Math.abs(stepMs) / 60_000)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${sign}${h} h ${m} min` : `${sign}${m} min`
}
