/**
 * FR-25 §7.4: which days are working days. Import-pure. Partial months, the floor and leave are all
 * shares of this number, so a wrong calendar is wrong everywhere: it comes from dated parameters.
 */
export interface WorkCalendar {
  /** `MMDD`: the official non-working days of the year, moved days included. */
  holidays: readonly string[]
  /** `MMDD`: a Saturday or Sunday declared a working day. */
  workingWeekends: readonly string[]
}

const pad = (n: number) => String(n).padStart(2, '0')

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Working days of `year`-`month` between two days of it, both counted. */
export function workingDays(calendar: WorkCalendar, year: number, month: number, fromDay = 1, toDay = daysInMonth(year, month)): number {
  const holidays = new Set(calendar.holidays)
  const working = new Set(calendar.workingWeekends)
  let count = 0
  for (let day = fromDay; day <= toDay; day++) {
    const key = `${pad(month)}${pad(day)}`
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
    const weekend = weekday === 0 || weekday === 6
    if (working.has(key) || (!weekend && !holidays.has(key))) count++
  }
  return count
}
