/**
 * The bounds of a report's period, from what a date field sends.
 *
 * `YYYY-MM-DD` names a whole DAY on the server's clock, the convention of the report handlers
 * (`dayStart`/`dayEnd`). `new Date('2026-01-31')` is that day's first millisecond, so a period ending
 * on it would leave out whatever was booked later on its last day. Anything else is read as the
 * moment it names.
 *
 * `undefined`: nothing was asked for. `null`: what was asked for is no date. A route answers that
 * with 422: an invalid Date reaches an aggregation as 1970, and the report comes back wrong, quietly.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/

function parse(value: unknown, dayTime: string): Date | undefined | null {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value)
  const date = new Date(DAY.test(text) ? `${text}T${dayTime}` : text)
  return Number.isNaN(date.getTime()) ? null : date
}

export function reportDayStart(value: unknown): Date | undefined | null {
  return parse(value, '00:00:00.000')
}

export function reportDayEnd(value: unknown): Date | undefined | null {
  return parse(value, '23:59:59.999')
}
