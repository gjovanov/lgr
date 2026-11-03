#!/usr/bin/env bun
/**
 * FR-25 §6.4's proof: each filed person-month goes through the one engine, and what comes out is
 * compared with what was filed. Nothing is calculated here that the engine does not calculate.
 *
 *   bun scripts/prove-payroll-engine.ts --root <dir of *.sealed> --identity <seal key file>
 *
 * Each check prints passes, misses and the months with misses. It says how far the engine is from
 * the truth, so a miss stays a miss: the misses a filed month explains are named, never hidden.
 *
 * ⚠ Opens the files in memory and prints counts and month names only. Never a name, an ЕГН or an
 * amount of one person.
 */
import { calculatePerson, type BgPersonInput, type BgPersonResult } from '../packages/services/src/biz/payroll/bg/engine'
import { parseEmpl, type EmplRow } from '../packages/services/src/biz/payroll/bg/files/empl2021'
import { parseNra } from '../packages/services/src/biz/payroll/bg/files/nra62007'
import { bgnToEur, fromCents, percentOf, toCents } from '../packages/services/src/biz/payroll/bg/money'
import { parametersForPeriod, type BgParameters } from '../packages/services/src/biz/payroll/bg/parameters'
import { PAYROLL_PARAMETERS } from '../packages/services/src/biz/payroll/bg/parameters.data'
import { birthDateOfEgn, bornBefore1960 } from '../packages/services/src/biz/payroll/bg/person-id'
import { workingDays } from '../packages/services/src/biz/payroll/bg/calendar'
import { declarationFiles, requiredArg, sealedRoot, versionsByMonth } from './lib/sealed-payroll'

interface Check { pass: number; miss: number; months: Set<string> }
const checks = new Map<string, Check>()

function record(name: string, ok: boolean, period: string): void {
  if (!checks.has(name)) checks.set(name, { pass: 0, miss: 0, months: new Set() })
  const check = checks.get(name)!
  if (ok) check.pass++
  else { check.miss++; check.months.add(period) }
}

const same = (a: number, b: number) => toCents(a) === toCents(b)

function daysOf(row: EmplRow): BgPersonInput['days'] {
  return {
    worked: row.workedDays, paidLeave: 0, incapacity: row.sickDays, childcare: row.childcareDays,
    uncontributed: row.noContributionDays, unpaidLeave: row.unpaidLeaveDays, employerSick: row.employerSickDays,
  }
}

function inputOf(row: EmplRow, period: string, p: BgParameters): BgPersonInput | null {
  const birth = birthDateOfEgn(row.personId)
  if (!birth) return null
  return {
    period,
    insuredType: String(row.insuredType).padStart(2, '0'),
    bornBefore1960: bornBefore1960(birth),
    qualificationGroup: row.qualificationGroup,
    mainActivityRow: row.mainActivityRow,
    kid: row.kid,
    // Before 2026 no annex is held: the filed percentage stands in, and proves nothing about ТЗПБ.
    ...(p.tzpbByActivity ? {} : { tzpbRate: row.tzpbRate }),
    statutoryHours: Number(row.totalDays[2]) || 8,
    hoursPerDay: Number(row.totalDays[3]) || 8,
    days: daysOf(row),
  }
}

/** The filed taxable income as the month's pay, sick pay left for the engine to work out. */
const filedPay = (row: EmplRow) => [{ code: 'declared', amount: row.taxableIncome }]

/**
 * The month's pay as filed. Above taxable income, gross is the employer's sick pay. Below it, taxable
 * income holds a compensation at leaving, which is not insurable. With no gross filed (field 46 is
 * blank for some people) the engine works out the sick pay itself.
 */
function filedEarnings(row: EmplRow) {
  const gross = toCents(row.grossPay)
  const taxable = toCents(row.taxableIncome)
  if (gross > taxable) return [...filedPay(row), { code: 'employerSickPay', amount: fromCents(gross - taxable), taxable: false }]
  if (gross > 0 && gross < taxable) return [{ code: 'declared', amount: row.grossPay }, { code: 'compensation', amount: fromCents(taxable - gross), insurable: false }]
  return filedPay(row)
}

const root = sealedRoot(requiredArg('root'), requiredArg('identity'))
const files = declarationFiles(root)
const empl = versionsByMonth(files, 'empl')
const nra = versionsByMonth(files, 'nra')

/** Every month's newest version, kept for the checks that span months. */
const monthRows = new Map<string, EmplRow[]>()
for (const [period, versions] of empl) monthRows.set(period, parseEmpl(root.open(versions[0].rel)))

/** What the engine withheld and owes for a year, per person: the annual recalculation (ЗДДФЛ чл. 49). */
function annualCorrection(personId: string, year: number, inputFor: (row: EmplRow, period: string) => BgPersonResult | null): { months: number; correction: number } {
  let base = 0
  let withheld = 0
  let months = 0
  for (const [period, rows] of monthRows) {
    if (!period.startsWith(String(year))) continue
    for (const row of rows) {
      if (row.personId !== personId) continue
      const result = inputFor(row, period)
      if (!result) continue
      months++
      base += toCents(row.taxableIncome) - toCents(result.employeeContributions)
      withheld += toCents(row.tax)
    }
  }
  return { months, correction: fromCents(withheld - percentOf(base, 10)) }
}

let skipped = 0
const results = new Map<string, Map<EmplRow, BgPersonResult>>()

for (const [period, rows] of monthRows) {
  const p = parametersForPeriod(PAYROLL_PARAMETERS, period)
  const inMonth = new Map<EmplRow, BgPersonResult>()
  results.set(period, inMonth)
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4))

  for (const row of rows) {
    const input = inputOf(row, period, p)
    if (!input) { skipped++; continue }

    // The days.
    const daySum = row.workedDays + row.sickDays + row.childcareDays + row.noContributionDays + row.unpaidLeaveDays + row.employerSickDays
    record('days: field 19\'s first two = the sum of 20..25', Number(row.totalDays.slice(0, 2)) === daySum, period)
    const fromDay = row.from1 || 1
    const toDay = row.to1 || new Date(Date.UTC(year, month, 0)).getUTCDate()
    record('days: the sum = working days of the calendar, in the from-to span', daySum === workingDays(p.calendar, year, month, fromDay, toDay), period)

    // The rates, on rows that carry them.
    const withFiled = calculatePerson({ ...input, earnings: filedEarnings(row) }, p)
    inMonth.set(row, withFiled)
    if (row.insurableIncome > 0) {
      record('rates: ДОО, employer and employee', withFiled.rates.doo.employer === row.dooRateEmployer && withFiled.rates.doo.employee === row.dooRateEmployee, period)
      record('rates: ЗО, employer and employee', withFiled.rates.zo.employer === row.zoRateEmployer && withFiled.rates.zo.employee === row.zoRateEmployee, period)
      record('rates: УПФ, employer and employee', withFiled.rates.upf.employer === row.upfRateEmployer && withFiled.rates.upf.employee === row.upfRateEmployee, period)
      if (p.tzpbByActivity) record('rates: ТЗПБ from Annex 2 (2026 only)', withFiled.rates.tzpb === row.tzpbRate, period)
    }

    // Income: from what was paid, with the floor and the cap.
    record('insurable income from filed gross, floor and cap = field 34', same(withFiled.insurableIncome.doo, row.insurableIncome), period)

    // Sick pay, the one earning worked out here.
    if (row.employerSickDays > 0 && row.grossPay > 0) {
      const worked = calculatePerson({ ...input, earnings: filedPay(row) }, p)
      record('employer sick pay: 70% of the month\'s daily average = field 46 − field 48', same(worked.gross, row.grossPay), period)
    }

    // Health on the days nobody pays wages for.
    record('ЗО on sick and childcare days: base = field 32', same(withFiled.healthOnLeave.base, row.zoBaseSick), period)
    if (row.zoBaseSick > 0) record('ЗО on sick and childcare days: rate = field 33', withFiled.healthOnLeave.rate === row.zoRateSick, period)
    record('ЗО on unpaid leave: base = field 44', same(withFiled.healthOnUnpaidLeave.base, row.healthOnlyBase), period)
    if (row.healthOnlyBase > 0) record('ЗО on unpaid leave: rate = field 45', withFiled.healthOnUnpaidLeave.rate === row.healthOnlyRate, period)

    // Tax.
    const taxed = same(withFiled.tax, row.tax)
    record('tax = (field 48 − employee contributions) × 10%', taxed, period)
    if (!taxed) {
      const relieved = calculatePerson({ ...input, earnings: filedEarnings(row), reliefs: { disability: true } }, p)
      record('tax, on the misses above, with the disability relief', same(relieved.tax, row.tax), period)
    }

    // Net.
    const january = period.endsWith('01')
    if (!january) record('net: declared net = field 50, outside January', same(withFiled.declaredNet, row.netPay), period)
    else {
      const { months, correction } = annualCorrection(row.personId, year - 1, (r, m) => results.get(m)?.get(r) ?? null)
      const inCurrency = p.currency === 'EUR' && period === '202601' ? bgnToEur(Math.abs(correction)) * Math.sign(correction) : correction
      const corrected = calculatePerson({ ...input, earnings: filedEarnings(row), annualTaxCorrection: inCurrency }, p)
      const ok = same(corrected.declaredNet, row.netPay)
      record(`net: January, with the annual recalculation (${months === 12 ? 'twelve months held' : 'fewer than twelve held'})`, ok, period)
    }
  }
}

// The month's obligations against обр. 6.
for (const [period, versions] of nra) {
  const inMonth = results.get(period)
  if (!inMonth) continue
  const { record: filed } = parseNra(root.open(versions[0].rel))
  let doo = 0
  let dzpo = 0
  let zo = 0
  for (const r of inMonth.values()) {
    doo += toCents(r.contributions.doo.employer) + toCents(r.contributions.doo.employee) + toCents(r.contributions.tzpb.employer)
    dzpo += toCents(r.contributions.dzpo.employer) + toCents(r.contributions.dzpo.employee)
    zo += toCents(r.contributions.zo.employer) + toCents(r.contributions.zo.employee) + toCents(r.healthOnLeave.amount) + toCents(r.healthOnUnpaidLeave.amount)
  }
  const [contributions, tax] = filed.columns
  record('обр. 6: ДОО = Σ per person', doo === toCents(contributions.doo ?? 0), period)
  record('обр. 6: ДЗПО = Σ per person', dzpo === toCents(contributions.dzpoUpf ?? 0), period)
  record('обр. 6: ЗО = Σ per person', zo === toCents(contributions.zo ?? 0), period)
  const previous = `${period.slice(4) === '01' ? Number(period.slice(0, 4)) - 1 : period.slice(0, 4)}${period.slice(4) === '01' ? '12' : String(Number(period.slice(4)) - 1).padStart(2, '0')}`
  const previousRows = monthRows.get(previous)
  if (previousRows) {
    const withheld = previousRows.reduce((sum, row) => sum + toCents(row.tax), 0)
    record('обр. 6: its tax = Σ tax of the previous month\'s обр. 1', withheld === toCents(tax.tax ?? 0), period)
  }
}

console.log(`person-months: ${[...monthRows.values()].reduce((n, r) => n + r.length, 0)}, without an ЕГН to date: ${skipped}, months: ${monthRows.size}`)
for (const [name, c] of checks) {
  console.log(`${String(c.pass).padStart(5)} pass ${String(c.miss).padStart(4)} miss  ${name}${c.miss ? `\n      missed in: ${[...c.months].sort().join(' ')}` : ''}`)
}
