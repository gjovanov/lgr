import { fromCents, percentOf, shareOf, toCents } from './money.js'
import type { BgParameters, Share } from './parameters.js'

/**
 * FR-25 §6.4: one person's month, for вид осигурен `01`, in §7.4's order. Import-pure and
 * deterministic: the route, the importer's proof and the shadow all call this one function.
 *
 *   days → earnings → insurable income, with floor and cap → contributions, each share rounded per
 *   person → tax base → reliefs → tax → net → advance and payment split
 *
 * What the filed files prove of this is in FR-25 §9: from insurable income on it reproduces them to
 * the cent. Earnings come from the contract, and those are proven only as far as the sheets go.
 *
 * ⚠ Anything this does not know is refused (D11). A type it does not implement is never calculated
 * as `01`: a wrong declaration is worse than a question.
 */
const KNOWN_INSURED_TYPES: ReadonlySet<string> = new Set(['01'])

/** The law's 70% for the employer's first two sick days (КСО чл. 40(5)). */
const SICK_PAY_NUMERATOR = 7
const SICK_PAY_DENOMINATOR = 10
/** ЗЗО чл. 40(1)(4)(б): health contributions during unpaid leave are on half the base. */
const UNPAID_LEAVE_BASE_DIVISOR = 2

export class UnsupportedPayrollCaseError extends Error {
  readonly code = 'unsupported_payroll_case'
  readonly statusCode = 422
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedPayrollCaseError'
  }
}

export interface BgDays {
  /** Days actually worked, and days of paid leave. Обр. 1's field 20 is their sum. */
  worked: number
  paidLeave: number
  /** Field 21: incapacity НОИ pays for. */
  incapacity: number
  /** Field 22: childcare. */
  childcare: number
  /** Field 23: no contributions, counted as service. */
  uncontributed: number
  /** Field 24: unpaid leave counted as service. */
  unpaidLeave: number
  /** Field 25: the employer's first sick days. */
  employerSick: number
}

export type BgLineCode = 'salary' | 'classSupplement' | 'paidLeave' | 'employerSickPay' | (string & {})

export interface BgEarning {
  code: BgLineCode
  amount: number
  /** Both default to true: leaving an amount out of a base is the decision to state. */
  insurable?: boolean
  taxable?: boolean
}

export interface BgPersonInput {
  /** `YYYYMM`. */
  period: string
  /** Вид осигурен, as on обр. 1. */
  insuredType: string
  bornBefore1960: boolean
  /** Qualification group 1 to 9, and the row of Annex 1: they choose the floor. */
  qualificationGroup?: number
  mainActivityRow?: number
  /** The employer's activity code: its first two digits choose ТЗПБ. */
  kid?: string
  /** A percentage for ТЗПБ, for a period whose annex is not held. */
  tzpbRate?: number
  /** A part-time contract's floor is proportional. Both default to the statutory eight. */
  hoursPerDay?: number
  statutoryHours?: number
  days: BgDays
  /** The contract's basic pay, when the month's salary is derived from it. */
  salary?: {
    amount: number
    /**
     * КТ чл. 177: the daily base for leave. Without one, this month's day: (salary + class) ÷ days
     * worked. That is what the filed sheets show, and not what КТ чл. 177 says: FR-25 §12 asks which.
     */
    leaveDailyBase?: number
  }
  /**
   * Amounts that are not derived: one-off pay, or everything, for a month taken from a declaration.
   *
   * ⚠ The class supplement is one of these (`classSupplement`). РКС № 17/2026 struck parts of КТ
   * чл. 355 as amended by ДВ 69/2026, and what applies after it needs the accountant, so this release
   * does not derive it from length of service. `classPercent` and `experienceAtStart` on a contract
   * are data, and nothing calculates from them.
   */
  earnings?: BgEarning[]
  reliefs?: {
    /** ЗДДФЛ чл. 18: 50% or more reduced capacity. */
    disability?: boolean
    /** ЗДДФЛ чл. 22в, taken in advance on a one-time declaration. */
    children?: number
  }
  /** January: what the annual recalculation gives back (+) or takes (−) (ЗДДФЛ чл. 49). */
  annualTaxCorrection?: number
  advancePaid?: number
  paidCash?: number
}

export interface BgLine {
  code: BgLineCode
  amount: number
  days?: number
}

export interface FundShare {
  employer: number
  employee: number
}

export interface BgPersonResult {
  period: string
  lines: BgLine[]
  /** All pay, sick pay included: the sheet's ФРЗ. */
  gross: number
  /** Field 48: sick pay is not taxable income (ЗДДФЛ чл. 13). */
  taxableIncome: number
  insurableIncome: { doo: number; dzpo: number; zo: number }
  /** Percentages as declared: employer's and employee's, ДОО being pension + sickness + unemployment. */
  rates: {
    doo: Share
    zo: Share
    upf: Share
    tzpb: number
  }
  contributions: {
    doo: FundShare
    tzpb: FundShare
    dzpo: FundShare
    zo: FundShare
    gvrs: FundShare
  }
  /** Fields 32–33: health contributions on the days of sick leave and childcare, the employer's. */
  healthOnLeave: { base: number; rate: number; amount: number }
  /**
   * Fields 44–45: health contributions on unpaid leave. Declared, and not taken from pay: in all 15
   * months that have some the filed net leaves them out. Who bears them is the accountant's to say.
   */
  healthOnUnpaidLeave: { base: number; rate: number; amount: number }
  /** What leaves the person's pay, and what the employer owes on top. */
  employeeContributions: number
  employerContributions: number
  taxBase: number
  tax: number
  /** What the person is owed. */
  net: number
  /** Field 50: the wage's net, capped at the highest insurable income (НПОПДОО чл. 32). */
  declaredNet: number
  paid: { advance: number; bank: number; cash: number }
}

function refuseUnknown(input: BgPersonInput): void {
  if (!KNOWN_INSURED_TYPES.has(String(input.insuredType).padStart(2, '0'))) {
    throw new UnsupportedPayrollCaseError(`вид осигурен ${input.insuredType} is not implemented`)
  }
}

function floorPerMonth(input: BgPersonInput, p: BgParameters): number {
  const table = p.minInsurableByActivity
  if (!table) return p.minInsurableSelfInsured
  // An annex is in force for this period: no row or no group is a gap in the input, not a low floor.
  if (input.mainActivityRow === undefined || input.qualificationGroup === undefined) {
    throw new UnsupportedPayrollCaseError(`the floor of ${input.period} needs the activity row and the qualification group`)
  }
  const row = table.find(r => r.row === input.mainActivityRow)
  const amount = row?.amounts[input.qualificationGroup - 1]
  if (amount === null || amount === undefined) {
    throw new UnsupportedPayrollCaseError(`Annex 1 has no amount for row ${input.mainActivityRow}, group ${input.qualificationGroup}`)
  }
  return amount
}

// TODO(FR-25 §7.5, item 4): Annexes 2 and 2А are by КИД-2025, and Н-13 still says КИД 2008. The filed
// rows of 2026 fit a lookup by the first two digits of field 29, and which code set it expects is unread.
function tzpbRate(input: BgPersonInput, p: BgParameters): number {
  if (input.tzpbRate !== undefined) return input.tzpbRate
  const division = String(input.kid ?? '').replace(/\D/g, '').slice(0, 2)
  const row = p.tzpbByActivity?.find(r => r.kid === division)
  if (!row) throw new UnsupportedPayrollCaseError(`no ТЗПБ rate for ${input.period} and this activity`)
  return row.rate
}

function leavePay(input: BgPersonInput, salary: number, p: BgParameters): number {
  const { worked, paidLeave } = input.days
  const base = input.salary?.leaveDailyBase
  if (base !== undefined) return toCents(base) * paidLeave
  if (!worked) return shareOf(salary, paidLeave, p.workingDays)
  const classSupplement = (input.earnings ?? []).filter(e => e.code === 'classSupplement').reduce((sum, e) => sum + toCents(e.amount), 0)
  return shareOf(shareOf(salary, worked, p.workingDays) + classSupplement, paidLeave, worked)
}

/** Salary and leave pay, from the contract and the days. In whole cents. */
function contractLines(input: BgPersonInput, p: BgParameters): { lines: { code: BgLineCode; cents: number; days?: number }[]; contractDay: number } {
  if (!input.salary) return { lines: [], contractDay: 0 }
  const salary = toCents(input.salary.amount)
  const lines: { code: BgLineCode; cents: number; days?: number }[] = [
    { code: 'salary', cents: shareOf(salary, input.days.worked, p.workingDays), days: input.days.worked },
  ]
  if (input.days.paidLeave) {
    lines.push({ code: 'paidLeave', cents: leavePay(input, salary, p), days: input.days.paidLeave })
  }
  return { lines, contractDay: shareOf(salary, 1, p.workingDays) }
}

export function calculatePerson(input: BgPersonInput, p: BgParameters): BgPersonResult {
  refuseUnknown(input)
  const { days } = input

  // Earnings.
  const { lines: fromContract, contractDay } = contractLines(input, p)
  const lines = [
    ...fromContract.map(l => ({ ...l, insurable: true, taxable: true })),
    ...(input.earnings ?? []).map(e => ({ code: e.code, cents: toCents(e.amount), insurable: e.insurable ?? true, taxable: e.taxable ?? true })),
  ]

  // The employer's sick days: 70% of the month's daily average, or of the contract's day if that is
  // more. Filed months with a typed amount carry it as an earning instead.
  const paidDays = days.worked + days.paidLeave
  if (days.employerSick > 0 && !lines.some(l => l.code === 'employerSickPay')) {
    const earned = lines.reduce((sum, l) => sum + (l.taxable ? l.cents : 0), 0)
    const monthDay = paidDays > 0 ? { cents: earned, days: paidDays } : { cents: contractDay, days: 1 }
    const fromMonth = shareOf(monthDay.cents, SICK_PAY_NUMERATOR * days.employerSick, SICK_PAY_DENOMINATOR * monthDay.days)
    const fromContractDay = shareOf(contractDay, SICK_PAY_NUMERATOR * days.employerSick, SICK_PAY_DENOMINATOR)
    lines.push({ code: 'employerSickPay', cents: Math.max(fromMonth, fromContractDay), days: days.employerSick, insurable: true, taxable: false })
  }

  const gross = lines.reduce((sum, l) => sum + l.cents, 0)
  const taxable = lines.reduce((sum, l) => sum + (l.taxable ? l.cents : 0), 0)
  const insurablePay = lines.reduce((sum, l) => sum + (l.insurable ? l.cents : 0), 0)

  // Insurable income: at least the floor for the days covered, proportional to the hours of a
  // part-time contract, and at most the month's cap.
  const statutoryHours = input.statutoryHours ?? 8
  const hoursPerDay = input.hoursPerDay ?? statutoryHours
  const floorDays = paidDays + days.employerSick
  const needsFloor = floorDays > 0
  const floor = needsFloor
    ? shareOf(toCents(floorPerMonth(input, p)), floorDays * hoursPerDay, p.workingDays * statutoryHours)
    : 0
  const insurable = Math.min(Math.max(insurablePay, floor), toCents(p.maxInsurableIncome))

  // Contributions: each share rounded once, per person. The percentages are summed first because the
  // declaration carries ДОО as one percentage, and the filed obligation is computed from that.
  const pension = input.bornBefore1960 ? p.rates.pensionBefore1960 : p.rates.pensionFrom1960
  const upf: Share = input.bornBefore1960 ? { employer: 0, employee: 0 } : p.rates.upf
  const doo: Share = {
    employer: sumRates(pension.employer, p.rates.sickness.employer, p.rates.unemployment.employer),
    employee: sumRates(pension.employee, p.rates.sickness.employee, p.rates.unemployment.employee),
  }
  const tzpb = insurable > 0 ? tzpbRate(input, p) : 0
  const contributions = {
    doo: { employer: percentOf(insurable, doo.employer), employee: percentOf(insurable, doo.employee) },
    tzpb: { employer: percentOf(insurable, tzpb), employee: 0 },
    dzpo: { employer: percentOf(insurable, upf.employer), employee: percentOf(insurable, upf.employee) },
    zo: { employer: percentOf(insurable, p.rates.health.employer), employee: percentOf(insurable, p.rates.health.employee) },
    gvrs: { employer: percentOf(gross, p.rates.gvrs), employee: 0 },
  }

  // Health on days nobody pays wages for, on the self-insured base, proportional to the days. With
  // the month's income at the cap there is no room left for it: seven filed rows have none, and every
  // row below the cap carries it whole.
  const healthBase = toCents(p.minInsurableSelfInsured)
  const roomBelowCap = toCents(p.maxInsurableIncome) - insurable
  const leaveBase = Math.min(shareOf(healthBase, days.incapacity + days.childcare, p.workingDays), roomBelowCap)
  const unpaidBase = shareOf(healthBase, days.unpaidLeave, UNPAID_LEAVE_BASE_DIVISOR * p.workingDays)
  const healthFull = sumRates(p.rates.health.employer, p.rates.health.employee)

  const employeeCents = contributions.doo.employee + contributions.dzpo.employee + contributions.zo.employee
  const employerCents = contributions.doo.employer + contributions.tzpb.employer + contributions.dzpo.employer
    + contributions.zo.employer + contributions.gvrs.employer + percentOf(leaveBase, p.rates.health.employer)

  // Tax.
  const relief = reliefCents(input, p)
  const taxBase = Math.max(taxable - employeeCents - relief, 0)
  const tax = percentOf(taxBase, p.rates.tax)

  // Net, and how it is paid.
  const correction = toCents(input.annualTaxCorrection ?? 0)
  const net = gross - employeeCents - tax + correction
  const advance = toCents(input.advancePaid ?? 0)
  const cash = toCents(input.paidCash ?? 0)

  // The declared net is the wage's: what is outside insurable pay, a compensation at leaving, is out
  // of it with the tax on it (two filed rows, both with such a compensation).
  const outsideWage = lines.reduce((sum, l) => sum + (l.insurable ? 0 : l.cents), 0)
  const outsideTaxable = lines.reduce((sum, l) => sum + (l.insurable || !l.taxable ? 0 : l.cents), 0)
  const taxOnWage = percentOf(Math.max(taxable - outsideTaxable - employeeCents - relief, 0), p.rates.tax)
  const wageNet = gross - outsideWage - employeeCents - taxOnWage + correction

  return {
    period: input.period,
    lines: lines.map(l => ({ code: l.code, amount: fromCents(l.cents), ...('days' in l && l.days !== undefined ? { days: l.days } : {}) })),
    gross: fromCents(gross),
    taxableIncome: fromCents(taxable),
    insurableIncome: { doo: fromCents(insurable), dzpo: input.bornBefore1960 ? 0 : fromCents(insurable), zo: fromCents(insurable) },
    rates: { doo, zo: p.rates.health, upf, tzpb },
    contributions: mapFunds(contributions),
    healthOnLeave: { base: fromCents(leaveBase), rate: p.rates.health.employer, amount: fromCents(percentOf(leaveBase, p.rates.health.employer)) },
    healthOnUnpaidLeave: { base: fromCents(unpaidBase), rate: healthFull, amount: fromCents(percentOf(unpaidBase, healthFull)) },
    employeeContributions: fromCents(employeeCents),
    employerContributions: fromCents(employerCents),
    taxBase: fromCents(taxBase),
    tax: fromCents(tax),
    net: fromCents(net),
    declaredNet: fromCents(Math.min(wageNet, toCents(p.maxInsurableIncome))),
    paid: { advance: fromCents(advance), bank: fromCents(net - advance - cash), cash: fromCents(cash) },
  }
}

const sumRates = (...rates: number[]) => rates.reduce((sum, r) => sum + Math.round(r * 100), 0) / 100

function mapFunds<K extends string>(funds: Record<K, FundShare>): Record<K, FundShare> {
  const out = {} as Record<K, FundShare>
  for (const key of Object.keys(funds) as K[]) out[key] = { employer: fromCents(funds[key].employer), employee: fromCents(funds[key].employee) }
  return out
}

function reliefCents(input: BgPersonInput, p: BgParameters): number {
  let cents = 0
  if (input.reliefs?.disability) cents += toCents(p.relief.disabilityMonthly)
  const children = input.reliefs?.children ?? 0
  if (children > 0) {
    if (!p.relief.childrenMonthly) throw new UnsupportedPayrollCaseError(`no child relief is held for ${input.period}`)
    cents += toCents(p.relief.childrenMonthly[Math.min(children, p.relief.childrenMonthly.length) - 1])
  }
  return cents
}
