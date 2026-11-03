import { workingDays, type WorkCalendar } from './calendar.js'

/**
 * FR-25 §7.4: what a month's calculation is allowed to know about the law, resolved by date.
 * Import-pure: `parameters.service.ts` reads the rows, this turns them into one month's values.
 */
export interface ParameterRow {
  key: string
  /** `YYYY-MM-DD`. */
  effectiveFrom: string
  value: unknown
  currency?: string
  source: string
}

export interface Share {
  employer: number
  employee: number
}

export interface ActivityFloor {
  /** The annex's row number, which обр. 1's field 30 carries. */
  row: number
  kid: string
  name: string
  /** Per qualification group, 1 to 9. A blank cell is a group the annex does not set for this row. */
  amounts: (number | null)[]
}

export interface ActivityRisk {
  kid: string
  name: string
  rate: number
}

export interface BgParameters {
  /** `YYYY-MM-DD`, the first day of the month these are for. */
  asOf: string
  currency: 'BGN' | 'EUR'
  minWage: number
  maxInsurableIncome: number
  minInsurableSelfInsured: number
  rates: {
    pensionBefore1960: Share
    pensionFrom1960: Share
    sickness: Share
    unemployment: Share
    upf: Share
    health: Share
    gvrs: number
    tax: number
  }
  relief: {
    disabilityMonthly: number
    /** One child, two, three or more. Null for a period no row covers. */
    childrenMonthly: readonly number[] | null
  }
  /** Annex 1 or 1А of the period, or null where the period's annex is not held. */
  minInsurableByActivity: readonly ActivityFloor[] | null
  /** Annex 2 or 2А of the period, or null likewise. */
  tzpbByActivity: readonly ActivityRisk[] | null
  /** Working days of the month. */
  workingDays: number
  calendar: WorkCalendar
}

export class PayrollParameterMissingError extends Error {
  readonly code = 'payroll_parameter_missing'
  readonly statusCode = 422
  constructor(key: string, asOf: string) {
    super(`No payroll parameter ${key} is in force on ${asOf}`)
    this.name = 'PayrollParameterMissingError'
  }
}

/** The row in force on a date: the latest that has started. Rows need not be sorted. */
export function rowAsOf(rows: readonly ParameterRow[], key: string, date: string): ParameterRow | null {
  let best: ParameterRow | null = null
  for (const row of rows) {
    if (row.key === key && row.effectiveFrom <= date && (!best || row.effectiveFrom > best.effectiveFrom)) best = row
  }
  return best
}

/** `YYYYMM` as the date its parameters are looked up on. The law's periods start on a first of a month. */
export function periodStart(period: string): string {
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(period)) throw new Error('a payroll period is YYYYMM')
  return `${period.slice(0, 4)}-${period.slice(4)}-01`
}

export function parametersForPeriod(rows: readonly ParameterRow[], period: string): BgParameters {
  const asOf = periodStart(period)
  const required = <T>(key: string): T => {
    const row = rowAsOf(rows, key, asOf)
    if (!row) throw new PayrollParameterMissingError(key, asOf)
    return row.value as T
  }
  const optional = <T>(key: string): T | null => (rowAsOf(rows, key, asOf)?.value as T) ?? null
  const share = (name: string): Share => ({ employer: required(`rate.${name}.employer`), employee: required(`rate.${name}.employee`) })

  const calendarRow = rowAsOf(rows, 'calendar', asOf)
  // A calendar is the year's: last year's holidays are no answer for this year's month.
  if (!calendarRow || calendarRow.effectiveFrom.slice(0, 4) !== asOf.slice(0, 4)) throw new PayrollParameterMissingError('calendar', asOf)
  const calendar = calendarRow.value as WorkCalendar

  return {
    asOf,
    currency: required('currency'),
    minWage: required('minWage'),
    maxInsurableIncome: required('maxInsurableIncome'),
    minInsurableSelfInsured: required('minInsurableSelfInsured'),
    rates: {
      pensionBefore1960: share('pension.before1960'),
      pensionFrom1960: share('pension.from1960'),
      sickness: share('sickness'),
      unemployment: share('unemployment'),
      upf: share('upf'),
      health: share('health'),
      gvrs: required('rate.gvrs'),
      tax: required('rate.tax'),
    },
    relief: {
      disabilityMonthly: required('relief.disability.monthly'),
      childrenMonthly: optional('relief.children.monthly'),
    },
    minInsurableByActivity: optional('minInsurableByActivity'),
    tzpbByActivity: optional('tzpbByActivity'),
    workingDays: workingDays(calendar, Number(period.slice(0, 4)), Number(period.slice(4))),
    calendar,
  }
}
