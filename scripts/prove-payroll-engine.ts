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
import { declarationKey, readPersonnel, readSalarySheets, sheetKey } from './lib/payroll-exports'
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
      base += toCents(result.taxBase)
      withheld += toCents(row.tax)
    }
  }
  return { months, correction: fromCents(withheld - percentOf(base, 10)) }
}

let skipped = 0
const versionNotes: string[] = []
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
    const plain = calculatePerson({ ...input, earnings: filedEarnings(row) }, p)
    // A person's disability relief is on no file held: a row whose tax needs it is told so, and counted.
    const relieved = same(plain.tax, row.tax) ? null : calculatePerson({ ...input, earnings: filedEarnings(row), reliefs: { disability: true } }, p)
    const withFiled = relieved ?? plain
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
    const baseHolds = same(withFiled.healthOnLeave.base, row.zoBaseSick)
    record('ЗО on sick and childcare days: base = field 32', baseHolds, period)
    if (!baseHolds) {
      // January 2026 was filed with 22 working days where the calendar has 20: all sixteen rows.
      const asFiled = calculatePerson({ ...input, earnings: filedEarnings(row) }, { ...p, workingDays: filedWorkingDays(period) })
      record('ЗО base, on the miss above, with the working days the month was filed with', same(asFiled.healthOnLeave.base, row.zoBaseSick), period)
    }
    if (row.zoBaseSick > 0) record('ЗО on sick and childcare days: rate = field 33', withFiled.healthOnLeave.rate === row.zoRateSick, period)
    record('ЗО on unpaid leave: base = field 44', same(withFiled.healthOnUnpaidLeave.base, row.healthOnlyBase), period)
    if (row.healthOnlyBase > 0) record('ЗО on unpaid leave: rate = field 45', withFiled.healthOnUnpaidLeave.rate === row.healthOnlyRate, period)

    // Tax.
    record('tax = (field 48 − employee contributions) × 10%', !relieved, period)
    if (relieved) record('tax, on the misses above, with the disability relief', same(relieved.tax, row.tax), period)

    // Net.
    const reliefs = relieved ? { disability: true } : undefined
    if (!period.endsWith('01')) {
      record('net: declared net = field 50, outside January', same(withFiled.declaredNet, row.netPay), period)
      continue
    }
    const { months, correction } = annualCorrection(row.personId, year - 1, (r, m) => results.get(m)?.get(r) ?? null)
    const inCurrency = period === '202601' ? Math.sign(correction) * bgnToEur(Math.abs(correction)) : correction
    const corrected = calculatePerson({ ...input, earnings: filedEarnings(row), reliefs, annualTaxCorrection: inCurrency }, p)
    record(`net: January, with the annual recalculation (${months === 12 ? 'twelve months held' : 'fewer than twelve held'})`, same(corrected.declaredNet, row.netPay), period)
    if (!same(corrected.declaredNet, row.netPay)) {
      record('net: January\'s misses, within 2 cents', Math.abs(toCents(corrected.declaredNet) - toCents(row.netPay)) <= 2, period)
    }
  }
}

// Months with several versions: what differs, and whether the net holds on each.
for (const [period, versions] of empl) {
  if (versions.length < 2) continue
  const p = parametersForPeriod(PAYROLL_PARAMETERS, period)
  const newest = monthRows.get(period)!
  const parts: string[] = []
  for (const version of versions.slice(1)) {
    const older = parseEmpl(root.open(version.rel))
    const fields = new Set<string>()
    let onlyOne = 0
    for (const row of older) {
      const other = newest.find(r => r.personId === row.personId)
      if (!other) { onlyOne++; continue }
      for (const key of Object.keys(row) as (keyof EmplRow)[]) if (row[key] !== other[key]) fields.add(String(key))
    }
    onlyOne += newest.filter(r => !older.some(o => o.personId === r.personId)).length
    const netHolds = older.filter((row) => {
      const input = inputOf(row, period, p)
      return input && same(calculatePerson({ ...input, earnings: filedEarnings(row) }, p).declaredNet, row.netPay)
    }).length
    parts.push(`rows ${older.length}, people on one only ${onlyOne}, fields that differ ${[...fields].join(',') || 'none'}, net rule holds on ${netHolds}`)
  }
  const netNewest = newest.filter((row) => {
    const input = inputOf(row, period, p)
    return input && same(calculatePerson({ ...input, earnings: filedEarnings(row) }, p).declaredNet, row.netPay)
  }).length
  versionNotes.push(`${period}: newest rows ${newest.length}, net rule holds on ${netNewest}; older: ${parts.join(' | ')}`)
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
    const owed = toCents(tax.tax ?? 0)
    if (period === '202601') {
      // December was withheld in leva, and January's return is in euro.
      record('обр. 6, January 2026: its tax = December\'s at the fixed rate', toCents(bgnToEur(fromCents(withheld))) === owed, period)
    } else if (period.endsWith('02')) {
      // The annual recalculation reaches the payment after January (ЗДДФЛ чл. 49).
      const year = Number(period.slice(0, 4)) - 1
      const refunded = previousRows.reduce((sum, row) => sum + toCents(annualCorrection(row.personId, year, (r, m) => results.get(m)?.get(r) ?? null).correction), 0)
      const inCurrency = period === '202602' ? toCents(bgnToEur(fromCents(Math.abs(refunded)))) * Math.sign(refunded) : refunded
      record('обр. 6, February: its tax = January\'s less the annual recalculation, within 1 unit', Math.abs(withheld - inCurrency - owed) <= 100, period)
    } else {
      record('обр. 6: its tax = Σ tax of the previous month\'s обр. 1', withheld === owed, period)
    }
  }
}

// The input side: how days and earnings became gross, as far as the month's sheets show it.
const sheets = await readSalarySheets(root)
const personnel = await readPersonnel(root)
const byDeclaration = new Map<string, { row: EmplRow; period: string }>()
for (const [period, rows] of monthRows) for (const row of rows) byDeclaration.set(declarationKey(period, row.surname, row.initials), { row, period })
const newestSheet = new Map<string, typeof sheets[number]['rows'][number]>()
for (const sheet of [...sheets].sort((a, b) => a.stamp.localeCompare(b.stamp))) for (const row of sheet.rows) newestSheet.set(sheetKey(row), row)

/** The working days a month was filed with: the sum of the days of a person there all month. */
function filedWorkingDays(period: string): number {
  const sums = monthRows.get(period)!.filter(r => !r.from1 && !r.to1).map(r => r.workedDays + r.sickDays + r.childcareDays + r.noContributionDays + r.unpaidLeaveDays + r.employerSickDays)
  return sums.sort((a, b) => sums.filter(x => x === b).length - sums.filter(x => x === a).length)[0] ?? 0
}

interface Linked { period: string; decl: EmplRow; values: Record<string, number>; wd: number }
const linked: Linked[] = []
for (const [key, sheetRow] of newestSheet) {
  const found = byDeclaration.get(key)
  if (!found) { record('sheets: a person\'s row finds its обр. 1 row', false, sheetRow.period); continue }
  record('sheets: a person\'s row finds its обр. 1 row', true, sheetRow.period)
  linked.push({ period: found.period, decl: found.row, values: sheetRow.values, wd: filedWorkingDays(found.period) })
}
const v = (l: Linked, label: string) => l.values[label] ?? 0
for (const l of linked) {
  record('sheet: ФРЗ = salary + class + leave + sick pay', same(v(l, 'ФРЗ'), v(l, 'Заплата') + v(l, 'ДТВ за стаж') + v(l, 'Пл.отп. чл.155,ал.1') + v(l, 'Болн. сума раб-л')), l.period)
  record('sheet: worked + leave days = field 20', v(l, 'Отр. дни') + v(l, 'Платен отпуск') === l.decl.workedDays, l.period)
  record('sheet: insurable income = field 34', same(v(l, 'Осигурителен доход'), l.decl.insurableIncome), l.period)
  record('sheet: tax = field 49', same(v(l, 'ДОД'), l.decl.tax), l.period)
  record('sheet: to receive = field 50', same(v(l, 'Сума за получаване'), l.decl.netPay), l.period)
}

// The month's salary from the contract's: the person's full months give the salary, and every other
// month must be that salary × days / working days. A salary changes, so each month looks for one.
const fullSalaries = new Map<string, Set<number>>()
for (const l of linked) {
  if (v(l, 'Отр. дни') === l.wd && !v(l, 'Платен отпуск')) {
    const key = `${l.decl.personId}|${l.period.slice(0, 4)}`
    if (!fullSalaries.has(key)) fullSalaries.set(key, new Set())
    fullSalaries.get(key)!.add(toCents(v(l, 'Заплата')))
  }
}
for (const l of linked) {
  const days = v(l, 'Отр. дни')
  if (!days || days === l.wd) continue
  const candidates = fullSalaries.get(`${l.decl.personId}|${l.period.slice(0, 4)}`)
  if (!candidates) { record('salary: a part month with no full month that year to compare', true, l.period); continue }
  const holds = [...candidates].some(salary => Math.abs(Math.round(salary * days / l.wd) - toCents(v(l, 'Заплата'))) <= 1)
  record('salary = full salary × days worked / working days, ±1 cent', holds, l.period)
}

// The personnel export's own salary, in the months around it.
for (const snapshot of personnel) {
  if (!snapshot.salary) continue
  const period = snapshot.asOf.slice(0, 7).replace('-', '')
  const l = linked.find(x => x.period === period && x.decl.personId === snapshot.personId)
  if (!l || v(l, 'Отр. дни') !== l.wd || v(l, 'Платен отпуск')) continue
  record('salary: a full month = the personnel export\'s basic salary of that month', same(v(l, 'Заплата'), snapshot.salary), period)
}

// Whether the class supplement can be derived: its share of the salary against the export's class %.
// A tolerance, because the export's date is not the month's. РКС № 17/2026 leaves the rule to the
// accountant whatever this says, so nothing calculates from it.
for (const l of linked) {
  const supplement = v(l, 'ДТВ за стаж')
  const salary = v(l, 'Заплата')
  if (!supplement || !salary) continue
  const snapshot = personnel.filter(p => p.personId === l.decl.personId && p.classPercent !== undefined)
    .sort((a, b) => Math.abs(Number(a.asOf.slice(0, 4)) - Number(l.period.slice(0, 4))) - Math.abs(Number(b.asOf.slice(0, 4)) - Number(l.period.slice(0, 4))))[0]
  if (!snapshot) continue
  record('class supplement ÷ salary = the export\'s class %, within 0.15 points', Math.abs(supplement / salary * 100 - snapshot.classPercent!) <= 0.15, l.period)
}

// The class supplement against the salary, month after month: the same percentage is a rule.
const classShares = new Map<string, Set<string>>()
for (const l of linked) {
  if (!v(l, 'ДТВ за стаж') || !v(l, 'Заплата')) continue
  const key = `${l.decl.personId}|${l.period.slice(0, 4)}`
  if (!classShares.has(key)) classShares.set(key, new Set())
  classShares.get(key)!.add((v(l, 'ДТВ за стаж') / v(l, 'Заплата')).toFixed(3))
}
const steady = [...classShares.values()].filter(shares => shares.size === 1).length
versionNotes.push(`class supplement ÷ salary, per person-year: ${classShares.size} seen, ${steady} with one share all year`)

// Leave pay: the last month with at least ten worked days gives the day (КТ чл. 177).
const declOf = (personId: string, period: string) => monthRows.get(period)?.find(r => r.personId === personId)
const stepBack = (period: string) => {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4))
  return month === 1 ? `${year - 1}12` : `${year}${String(month - 1).padStart(2, '0')}`
}
for (const l of linked) {
  const leaveDays = v(l, 'Платен отпуск')
  if (!leaveDays) continue
  let back = stepBack(l.period)
  let base: EmplRow | undefined
  for (let i = 0; i < 12 && !base; i++, back = stepBack(back)) {
    const row = declOf(l.decl.personId, back)
    if (row && row.workedDays >= 10) base = row
  }
  const paid = toCents(v(l, 'Пл.отп. чл.155,ал.1'))
  const worked = v(l, 'Отр. дни')
  if (worked) {
    const thisMonth = Math.round(toCents(v(l, 'Заплата') + v(l, 'ДТВ за стаж')) * leaveDays / worked)
    record('leave pay = this month\'s (salary + class) ÷ days worked × leave days, ±1 cent', Math.abs(thisMonth - paid) <= 1, l.period)
    record('leave pay, the same, within 1%', Math.abs(thisMonth - paid) <= paid * 0.01, l.period)
  }
  if (!base) continue
  const income = base.grossPay || base.taxableIncome
  const lastMonth = Math.round(toCents(income) * leaveDays / base.workedDays)
  record('leave pay = КТ чл. 177: the last 10-day month\'s gross ÷ its days × leave days, ±1 cent', Math.abs(lastMonth - paid) <= 1, l.period)
}

console.log(`person-months: ${[...monthRows.values()].reduce((n, r) => n + r.length, 0)}, without an ЕГН to date: ${skipped}, months: ${monthRows.size}`)
for (const [name, c] of checks) {
  console.log(`${String(c.pass).padStart(5)} pass ${String(c.miss).padStart(4)} miss  ${name}${c.miss ? `\n      missed in: ${[...c.months].sort().join(' ')}` : ''}`)
}
for (const note of versionNotes) console.log(note)
