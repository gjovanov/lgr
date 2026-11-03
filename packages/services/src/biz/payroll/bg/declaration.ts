import type { BgDays, BgLine, BgPersonResult } from './engine.js'
import type { EmplRow } from './files/empl2021.js'
import { fromCents, percentOf, toCents } from './money.js'

/**
 * FR-25 §5.1: an imported month is what was filed. This reads a filed обр. 1 row into the shape a
 * calculated person has, its contributions worked out from the row's own income and percentages, as
 * Н-13 says they are (§7.4). It calculates nothing else. Import-pure.
 */
export function daysOfRow(row: EmplRow, paidLeave = 0): BgDays {
  return {
    worked: row.workedDays - paidLeave,
    paidLeave,
    incapacity: row.sickDays,
    childcare: row.childcareDays,
    uncontributed: row.noContributionDays,
    unpaidLeave: row.unpaidLeaveDays,
    employerSick: row.employerSickDays,
  }
}

export function resultOfRow(row: EmplRow, period: string, sheetLines?: BgLine[]): BgPersonResult {
  const insurable = toCents(row.insurableIncome)
  const share = (rate: number) => percentOf(insurable, rate)
  const contributions = {
    doo: { employer: share(row.dooRateEmployer), employee: share(row.dooRateEmployee) },
    tzpb: { employer: share(row.tzpbRate), employee: 0 },
    dzpo: { employer: share(row.upfRateEmployer), employee: share(row.upfRateEmployee) },
    zo: { employer: share(row.zoRateEmployer), employee: share(row.zoRateEmployee) },
    gvrs: { employer: percentOf(toCents(row.grossPay), row.gvrsRate), employee: 0 },
  }
  const onLeave = percentOf(toCents(row.zoBaseSick), row.zoRateSick)
  const onUnpaid = percentOf(toCents(row.healthOnlyBase), row.healthOnlyRate)
  const employee = contributions.doo.employee + contributions.dzpo.employee + contributions.zo.employee
  const employer = contributions.doo.employer + contributions.tzpb.employer + contributions.dzpo.employer
    + contributions.zo.employer + contributions.gvrs.employer + onLeave
  // Field 46 is blank for some people, and then the taxable income is the nearest thing to their pay.
  const gross = toCents(row.grossPay) || toCents(row.taxableIncome)
  const tax = toCents(row.tax)
  const net = gross - employee - tax
  const funds = Object.fromEntries(Object.entries(contributions).map(([fund, s]) => [fund, { employer: fromCents(s.employer), employee: fromCents(s.employee) }]))
  return {
    period,
    lines: sheetLines ?? [{ code: 'declared', amount: fromCents(gross) }],
    gross: fromCents(gross),
    taxableIncome: row.taxableIncome,
    insurableIncome: { doo: row.insurableIncome, dzpo: row.upfRateEmployee ? row.insurableIncome : 0, zo: row.insurableIncome },
    rates: {
      doo: { employer: row.dooRateEmployer, employee: row.dooRateEmployee },
      zo: { employer: row.zoRateEmployer, employee: row.zoRateEmployee },
      upf: { employer: row.upfRateEmployer, employee: row.upfRateEmployee },
      tzpb: row.tzpbRate,
    },
    contributions: funds as BgPersonResult['contributions'],
    healthOnLeave: { base: row.zoBaseSick, rate: row.zoRateSick, amount: fromCents(onLeave) },
    healthOnUnpaidLeave: { base: row.healthOnlyBase, rate: row.healthOnlyRate, amount: fromCents(onUnpaid) },
    employeeContributions: fromCents(employee),
    employerContributions: fromCents(employer),
    taxBase: fromCents(Math.max(toCents(row.taxableIncome) - employee, 0)),
    tax: row.tax,
    net: fromCents(net),
    declaredNet: row.netPay,
    paid: { advance: 0, bank: fromCents(net), cash: 0 },
  }
}
