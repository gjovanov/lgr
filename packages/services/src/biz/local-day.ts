/**
 * A calendar day in a time zone, as the UTC instants it starts and ends at.
 *
 * The API runs in a container whose clock is UTC, and `new Date('2026-10-21')` is 00:00 UTC — in
 * Sofia that is 02:00 or 03:00 on the 21st, and as the END of a period it drops the whole day
 * (FR-21 B-7: the SUPTO export lost the last day of every POS table). A Bulgarian business day
 * starts at Bulgarian midnight; these give its instants.
 *
 * Import-pure. Same `Intl` approach as `fiscal/zoned-time.ts` (which services cannot import:
 * fiscal depends on services), with its midnight-as-"24" guard and two correction passes for DST.
 */

/** Bulgarian local time: the zone Наредба Н-18 and the fiscal devices keep. */
export const BULGARIAN_TIME_ZONE = 'Europe/Sofia'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value)
}

function wallClock(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at))
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
}

/** The instant `timeZone` reaches 00:00 on `date` (`YYYY-MM-DD`). */
export function localDayStart(date: string, timeZone: string = BULGARIAN_TIME_ZONE): Date {
  const m = DATE_ONLY.exec(date)
  if (!m) throw new Error(`Not a calendar date: ${date}`)
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  let t = target
  for (let pass = 0; pass < 2; pass++) t += target - wallClock(t, timeZone)
  return new Date(t)
}

/**
 * The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone`. Right for both ways a document
 * keeps its date: a date-only value stored as 00:00 UTC is 02:00/03:00 of the same day in Sofia, and
 * a till sale's moment of sale is the day the shop rang it — which, from 00:00 to 02:00/03:00 Sofia
 * time, the UTC date (`toISOString`) names as the day before.
 */
export function localDayOf(at: Date | string | number, timeZone: string = BULGARIAN_TIME_ZONE): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)
  const get = (t: string) => p.find(x => x.type === t)?.value || ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** The last millisecond of `date` (`YYYY-MM-DD`) in `timeZone`. */
export function localDayEnd(date: string, timeZone: string = BULGARIAN_TIME_ZONE): Date {
  const m = DATE_ONLY.exec(date)
  if (!m) throw new Error(`Not a calendar date: ${date}`)
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10)
  return new Date(localDayStart(next, timeZone).getTime() - 1)
}
