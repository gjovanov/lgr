import { describe, it, expect } from 'bun:test'
import { calculatePerson, UnsupportedPayrollCaseError, type BgPersonInput } from 'services/biz/payroll/bg/engine'
import { bgnToEur, bgnWageToEur, fromCents, percentOf, shareOf, toCents } from 'services/biz/payroll/bg/money'
import { parametersForPeriod, PayrollParameterMissingError, rowAsOf } from 'services/biz/payroll/bg/parameters'
import { PAYROLL_PARAMETERS } from 'services/biz/payroll/bg/parameters.data'
import { workingDays } from 'services/biz/payroll/bg/calendar'
import { birthDateOfEgn, bornBefore1960, egnChecksumHolds } from 'services/biz/payroll/bg/person-id'

/**
 * FR-25 §10: the engine as a table, with made-up people. Each expectation is worked out by hand from
 * §7.4's rules, so that this suite says what the law says rather than what the code does.
 *
 * September 2026 has 20 working days, and wholesale trade is row 58 of Annex 1А: group 5 has a floor
 * of 620.20. The rates are the third category's, ТЗПБ 0.5 for its activity.
 */
const SEPTEMBER = '202609'
const params = (period: string) => parametersForPeriod(PAYROLL_PARAMETERS, period)

const fullMonth = { worked: 20, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 0 }

const person = (over: Partial<BgPersonInput> = {}): BgPersonInput => ({
  period: SEPTEMBER,
  insuredType: '01',
  bornBefore1960: false,
  qualificationGroup: 5,
  mainActivityRow: 58,
  kid: '4690',
  days: fullMonth,
  salary: { amount: 1000 },
  ...over,
})

const run = (over: Partial<BgPersonInput> = {}) => calculatePerson(person(over), params(over.period ?? SEPTEMBER))

describe('rounding (the rule, in digits)', () => {
  it('holds a tie that the double formula gets wrong', () => {
    // 101.25 × 2.8% is exactly 2.835, and 205.00 × 0.5% exactly 1.025.
    expect(Math.round(101.25 * (2.8 / 100) * 100) / 100).toBe(2.83)
    expect(fromCents(percentOf(toCents(101.25), 2.8))).toBe(2.84)
    expect(Math.round(205 * (0.5 / 100) * 100) / 100).toBe(1.02)
    expect(fromCents(percentOf(toCents(205), 0.5))).toBe(1.03)
  })

  it('leaves the second decimal on a third of 0 to 4, and adds one on 5 to 9', () => {
    expect(percentOf(10_000, 1.004)).toBe(100)
    expect(shareOf(1234, 1, 100)).toBe(12)
    expect(shareOf(1250, 1, 100)).toBe(13)
    expect(shareOf(1249, 1, 100)).toBe(12)
  })

  it('rounds the magnitude and restores the sign on a correction', () => {
    expect(shareOf(-1250, 1, 100)).toBe(-13)
    expect(shareOf(-1249, 1, 100)).toBe(-12)
    expect(percentOf(toCents(-205), 0.5)).toBe(-103)
  })
})

describe('a full month', () => {
  it('works out contributions, tax and net', () => {
    const r = run()
    expect(r.gross).toBe(1000)
    expect(r.insurableIncome).toEqual({ doo: 1000, dzpo: 1000, zo: 1000 })
    expect(r.contributions).toEqual({
      doo: { employer: 109.2, employee: 83.8 },
      tzpb: { employer: 5, employee: 0 },
      dzpo: { employer: 28, employee: 22 },
      zo: { employer: 48, employee: 32 },
      gvrs: { employer: 0, employee: 0 },
    })
    expect(r.employeeContributions).toBe(137.8)
    expect(r.employerContributions).toBe(190.2)
    expect(r.taxBase).toBe(862.2)
    expect(r.tax).toBe(86.22)
    expect(r.net).toBe(775.98)
    expect(r.declaredNet).toBe(775.98)
  })

  it('rounds each share per person, once, on the percentage the form carries', () => {
    // 1234.55 × 8.38% = 103.45529, × 10.92% = 134.81286: never the sum of rounded sub-funds.
    const r = run({ salary: { amount: 1234.55 } })
    expect(r.contributions.doo).toEqual({ employer: 134.81, employee: 103.46 })
    expect(r.rates.doo).toEqual({ employer: 10.92, employee: 8.38 })
  })

  it('takes the higher pension rate and no universal fund for a person born before 1960', () => {
    const r = run({ bornBefore1960: true })
    expect(r.rates.doo).toEqual({ employer: 13.72, employee: 10.58 })
    expect(r.contributions.doo).toEqual({ employer: 137.2, employee: 105.8 })
    expect(r.contributions.dzpo).toEqual({ employer: 0, employee: 0 })
    expect(r.insurableIncome.dzpo).toBe(0)
  })
})

describe('insurable income', () => {
  it('rises to the floor of the group, and the tax stays on what was paid', () => {
    const r = run({ salary: { amount: 300 } })
    expect(r.insurableIncome.doo).toBe(620.2)
    // 620.20 × 8.38 + 3.20 + 2.20 = 51.97 + 19.85 + 13.64.
    expect(r.employeeContributions).toBe(85.46)
    expect(r.tax).toBe(21.45)
    expect(r.net).toBe(193.09)
  })

  it('takes the floor of the qualification group: Annex 1А sets 1129.00 for group 1', () => {
    expect(run({ salary: { amount: 900 }, qualificationGroup: 1 }).insurableIncome.doo).toBe(1129)
    expect(run({ salary: { amount: 900 }, qualificationGroup: 5 }).insurableIncome.doo).toBe(900)
  })

  it('follows the annex in force on the month: July has 550.66 where September has 620.20', () => {
    const july = { worked: 23, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 0 }
    expect(run({ period: '202607', days: july, salary: { amount: 300 } }).insurableIncome.doo).toBe(550.66)
  })

  it('stops at the cap of the month: 2026 has two', () => {
    const july = { worked: 23, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 0 }
    expect(run({ period: '202607', days: july, salary: { amount: 5000 } }).insurableIncome.doo).toBe(2111.64)
    expect(run({ salary: { amount: 5000 } }).insurableIncome.doo).toBe(2300)
  })

  it('declares a net no higher than the cap, and pays the whole of it', () => {
    const r = run({ salary: { amount: 5000 } })
    expect(r.net).toBeGreaterThan(2300)
    expect(r.declaredNet).toBe(2300)
    expect(r.paid.bank).toBe(r.net)
  })

  it('takes the floor in proportion to the days of a partial month', () => {
    const r = run({ salary: { amount: 500 }, days: { ...fullMonth, worked: 10 } })
    expect(r.lines).toEqual([{ code: 'salary', amount: 250, days: 10 }])
    expect(r.insurableIncome.doo).toBe(310.1)
  })

  it('and to the hours of a part-time contract', () => {
    const r = run({ salary: { amount: 300 }, hoursPerDay: 6, statutoryHours: 8 })
    expect(r.insurableIncome.doo).toBe(465.15)
  })

  it('has none on a month with no day to insure', () => {
    const r = run({ days: { ...fullMonth, worked: 0, childcare: 20 }, salary: { amount: 1000 } })
    expect(r.insurableIncome.doo).toBe(0)
    expect(r.rates.tzpb).toBe(0)
    expect(r.tax).toBe(0)
  })
})

describe('the days', () => {
  it('pays the employer\'s two sick days at 70% of the month\'s average, outside taxable income', () => {
    const r = run({ days: { ...fullMonth, worked: 18, employerSick: 2 } })
    expect(r.lines).toEqual([
      { code: 'salary', amount: 900, days: 18 },
      { code: 'employerSickPay', amount: 70, days: 2 },
    ])
    expect(r.gross).toBe(970)
    expect(r.taxableIncome).toBe(900)
    expect(r.insurableIncome.doo).toBe(970)
  })

  it('never pays those days below 70% of the contract\'s day', () => {
    const r = run({ days: { ...fullMonth, worked: 0, employerSick: 2, incapacity: 18 } })
    expect(r.lines).toEqual([{ code: 'salary', amount: 0, days: 0 }, { code: 'employerSickPay', amount: 70, days: 2 }])
  })

  it('takes a typed sick pay as it is', () => {
    const r = run({ days: { ...fullMonth, worked: 18, employerSick: 2 }, earnings: [{ code: 'employerSickPay', amount: 80, taxable: false }] })
    expect(r.gross).toBe(980)
  })

  it('owes health on incapacity on the self-insured base, the employer\'s share, in proportion', () => {
    const r = run({ days: { ...fullMonth, worked: 15, employerSick: 2, incapacity: 3 } })
    // 620.20 × 3 / 20 = 93.03, × 4.8% = 4.47.
    expect(r.healthOnLeave).toEqual({ base: 93.03, rate: 4.8, amount: 4.47 })
  })

  it('owes none with the month at the cap: there is no room left under it', () => {
    const r = run({ salary: { amount: 9000 }, days: { ...fullMonth, worked: 15, employerSick: 2, incapacity: 3 } })
    expect(r.insurableIncome.doo).toBe(2300)
    expect(r.healthOnLeave.base).toBe(0)
  })

  it('declares health on unpaid leave on half the base, and leaves it out of the net', () => {
    const r = run({ days: { ...fullMonth, worked: 15, unpaidLeave: 5 } })
    // 620.20 / 2 × 5 / 20 = 77.525, half up: 77.53. × 8% = 6.20.
    expect(r.healthOnUnpaidLeave).toEqual({ base: 77.53, rate: 8, amount: 6.2 })
    expect(r.net).toBe(fromCents(toCents(r.gross) - toCents(r.employeeContributions) - toCents(r.tax)))
  })

  it('pays leave from the daily base it is given, or from this month\'s day, the class supplement in it', () => {
    const days = { ...fullMonth, worked: 15, paidLeave: 5 }
    expect(run({ days }).lines.at(-1)).toEqual({ code: 'paidLeave', amount: 250, days: 5 })
    expect(run({ days, salary: { amount: 1000, leaveDailyBase: 60 } }).lines.at(-1)).toEqual({ code: 'paidLeave', amount: 300, days: 5 })
    // 750 salary + 75 class over 15 days is 55 a day.
    const withClass = run({ days, earnings: [{ code: 'classSupplement', amount: 75 }] })
    expect(withClass.lines.find(l => l.code === 'paidLeave')).toEqual({ code: 'paidLeave', amount: 275, days: 5 })
    // With no day worked, the contract's day.
    expect(run({ days: { ...fullMonth, worked: 0, paidLeave: 20 } }).lines.at(-1)).toEqual({ code: 'paidLeave', amount: 1000, days: 20 })
  })
})

describe('amounts that are not derived', () => {
  it('takes the class supplement as an input: nothing here derives it from length of service', () => {
    const r = run({ earnings: [{ code: 'classSupplement', amount: 120.5 }] })
    expect(r.lines).toContainEqual({ code: 'classSupplement', amount: 120.5 })
    expect(r.gross).toBe(1120.5)
  })

  it('leaves a compensation at leaving out of insurable income and the declared net', () => {
    const r = run({ earnings: [{ code: 'compensation', amount: 500, insurable: false }] })
    expect(r.insurableIncome.doo).toBe(1000)
    expect(r.taxableIncome).toBe(1500)
    // Tax on 1362.20 is 136.22. The wage's own net is what a full month without it has.
    expect(r.tax).toBe(136.22)
    expect(r.net).toBe(1225.98)
    expect(r.declaredNet).toBe(775.98)
  })

  it('splits what is paid: the advance and the cash, the rest through the bank', () => {
    expect(run({ advancePaid: 200, paidCash: 100 }).paid).toEqual({ advance: 200, bank: 475.98, cash: 100 })
  })

  it('adds January\'s annual correction to the net, and leaves the month\'s tax alone', () => {
    const r = run({ annualTaxCorrection: -1.25 })
    expect(r.tax).toBe(86.22)
    expect(r.net).toBe(774.73)
  })
})

describe('reliefs', () => {
  it('takes disability relief off the tax base', () => {
    expect(run({ reliefs: { disability: true } }).taxBase).toBe(524.75)
  })

  it('takes child relief by the number of children, three or more alike', () => {
    expect(run({ reliefs: { children: 1 } }).taxBase).toBe(606.55)
    expect(run({ reliefs: { children: 2 } }).taxBase).toBe(350.91)
    expect(run({ reliefs: { children: 3 } }).taxBase).toBe(95.26)
    expect(run({ reliefs: { children: 7 } }).taxBase).toBe(95.26)
  })

  it('never takes the base below zero', () => {
    const r = run({ salary: { amount: 300 }, reliefs: { disability: true, children: 3 } })
    expect(r.taxBase).toBe(0)
    expect(r.tax).toBe(0)
  })

  it('refuses a relief no row covers, rather than giving none', () => {
    const july2025 = { worked: 23, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 0 }
    let caught: unknown
    try { run({ period: '202507', days: july2025, tzpbRate: 0.5, reliefs: { children: 1 } }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(UnsupportedPayrollCaseError)
  })
})

describe('what it refuses (D11)', () => {
  const refusal = (over: Partial<BgPersonInput>) => {
    try {
      run(over)
      return null
    } catch (e) {
      return e as Error
    }
  }

  it('never calculates another insured type as 01', () => {
    expect(refusal({ insuredType: '12' })).toBeInstanceOf(UnsupportedPayrollCaseError)
    expect(refusal({ insuredType: '1' })).toBeNull()
  })

  it('wants the group and the row where an annex is in force', () => {
    expect(refusal({ qualificationGroup: undefined })).toBeInstanceOf(UnsupportedPayrollCaseError)
    expect(refusal({ mainActivityRow: 999 })).toBeInstanceOf(UnsupportedPayrollCaseError)
  })

  it('takes a blank cell of the annex as a gap, not as no floor', () => {
    // Row 81 of Annex 1А sets only group 3.
    expect(refusal({ mainActivityRow: 81, qualificationGroup: 1 })).toBeInstanceOf(UnsupportedPayrollCaseError)
    expect(refusal({ mainActivityRow: 81, qualificationGroup: 3 })).toBeNull()
  })

  it('wants an activity for ТЗПБ', () => {
    expect(refusal({ kid: '' })).toBeInstanceOf(UnsupportedPayrollCaseError)
  })
})

describe('parameters', () => {
  it('are looked up by date, never by year', () => {
    expect(params('202503').maxInsurableIncome).toBe(3750)
    expect(params('202504').maxInsurableIncome).toBe(4130)
    expect(params('202503').minInsurableSelfInsured).toBe(933)
    expect(params('202504').minInsurableSelfInsured).toBe(1077)
    expect(params('202607').maxInsurableIncome).toBe(2111.64)
    expect(params('202608').maxInsurableIncome).toBe(2300)
    expect(params('202607').minInsurableSelfInsured).toBe(550.66)
    expect(params('202608').minInsurableSelfInsured).toBe(620.2)
  })

  it('run in leva until the euro', () => {
    expect(params('202512').currency).toBe('BGN')
    expect(params('202601').currency).toBe('EUR')
    expect(params('202512').minWage).toBe(1077)
    expect(params('202601').minWage).toBe(620.2)
  })

  it('hold the annexes only where the law is on file', () => {
    expect(params('202512').minInsurableByActivity).toBeNull()
    expect(params('202607').minInsurableByActivity?.find(r => r.row === 58)?.amounts[0]).toBe(664.17)
    expect(params('202608').minInsurableByActivity?.find(r => r.row === 58)?.amounts[0]).toBe(1129)
  })

  it('all 86 rows of each annex, and ТЗПБ for every division', () => {
    expect(params('202607').minInsurableByActivity).toHaveLength(86)
    expect(params('202608').minInsurableByActivity).toHaveLength(86)
    expect(params('202608').tzpbByActivity?.find(r => r.kid === '46')?.rate).toBe(0.5)
    expect(params('202608').tzpbByActivity?.find(r => r.kid === '02')?.rate).toBe(1.1)
  })

  it('refuse a month with no calendar, rather than using last year\'s', () => {
    let caught: unknown
    try { params('202701') } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(PayrollParameterMissingError)
  })

  it('take the latest row that has started', () => {
    const rows = [
      { key: 'x', effectiveFrom: '2026-08-01', value: 2, source: 't' },
      { key: 'x', effectiveFrom: '2026-01-01', value: 1, source: 't' },
    ]
    expect(rowAsOf(rows, 'x', '2026-07-31')?.value).toBe(1)
    expect(rowAsOf(rows, 'x', '2026-08-01')?.value).toBe(2)
    expect(rowAsOf(rows, 'x', '2025-12-31')).toBeNull()
  })
})

describe('the calendar', () => {
  const calendar = (year: number) => rowAsOf(PAYROLL_PARAMETERS, 'calendar', `${year}-06-01`)!.value as any

  it('counts the working days of a month', () => {
    expect(workingDays(calendar(2026), 2026, 9)).toBe(20)
    expect(workingDays(calendar(2025), 2025, 12)).toBe(19)
    expect(workingDays(calendar(2024), 2024, 5)).toBe(19)
  })

  it('counts a span of days inside it', () => {
    expect(workingDays(calendar(2026), 2026, 9, 1, 4)).toBe(4)
    expect(workingDays(calendar(2026), 2026, 9, 7, 8)).toBe(1)
  })

  it('counts a weekend declared a working day', () => {
    expect(workingDays({ holidays: [], workingWeekends: ['0905'] }, 2026, 9, 5, 5)).toBe(1)
  })
})

describe('the euro (ЗВЕРБ)', () => {
  it('rounds a wage up on any non-zero third decimal, and a deduction by the general rule', () => {
    expect(bgnWageToEur(1000)).toBe(511.3)
    expect(bgnToEur(1000)).toBe(511.29)
    expect(bgnWageToEur(1213)).toBe(620.2)
    expect(bgnToEur(4130)).toBe(2111.64)
  })
})

describe('an ЕГН', () => {
  it('says when its person was born, the month carrying the century', () => {
    expect(birthDateOfEgn('5912120000')).toBe('1959-12-12')
    expect(birthDateOfEgn('0141010000')).toBe('2001-01-01')
    expect(birthDateOfEgn('9921010000')).toBe('1899-01-01')
    expect(bornBefore1960('1959-12-31')).toBe(true)
    expect(bornBefore1960('1960-01-01')).toBe(false)
  })

  it('names no date in the fixtures: month 13 is nobody\'s', () => {
    expect(birthDateOfEgn('7513020014')).toBeNull()
    expect(egnChecksumHolds('7513020014')).toBe(true)
    expect(egnChecksumHolds('7513020015')).toBe(false)
  })
})
