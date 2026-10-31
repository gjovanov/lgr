/**
 * Which fiscal period (or fiscal year) a moment belongs to.
 *
 * Both store their LAST DAY as `endDate`, at 00:00 of that day in the server's timezone:
 * `generateMonthlyPeriods` and `computeFiscalYearRange` build them that way, and so does a date
 * picked in the UI. A timestamp later on that day is still inside the range, so `endDate` is
 * compared with the start of the timestamp's DAY, never with the timestamp itself.
 *
 * Until 2026-10-31 every lookup used `endDate >= date`. On the last day of each month that
 * matched no period for anything booked after midnight: `ensureFiscalPeriod` threw, and no
 * automatic journal entry was created that day (invoice, payment, stock valuation, POS close).
 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Mongo filter for the fiscal period or year that contains `date`. */
export function fiscalRangeFilter(date: Date) {
  return { startDate: { $lte: date }, endDate: { $gte: startOfDay(date) } }
}

/** The same test as `fiscalRangeFilter`, for rows already in memory. */
export function fiscalRangeContains(range: { startDate: Date; endDate: Date }, date: Date): boolean {
  return range.startDate <= date && range.endDate >= startOfDay(date)
}
