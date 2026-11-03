import { AbsenceEntry, Employee, EmploymentContract, PayrollElement, PayrollRun, Payslip } from 'db/models'
import { mongoose } from 'db/connection'
import { runItemPath } from '../../personal-data/crypto.js'
import { openEmployeePersonal, type EmployeePersonal } from '../../personal-data/employee-personal.js'
import { forOrg, type OrgVault } from '../../personal-data/personal-data.service.js'
import { daysFromAbsences, openAbsenceDetail, type AbsenceCode } from './absence.js'
import { daysInMonth, workingDays } from './calendar.js'
import { openContractPay, salaryAsOf } from './contract-pay.js'
import { calculatePerson, UnsupportedPayrollCaseError, type BgDays, type BgEarning, type BgPersonInput, type BgPersonResult } from './engine.js'
import type { EmplRow } from './files/empl2021.js'
import { fromCents, toCents } from './money.js'
import { loadParameters } from './parameters.service.js'
import { periodStart, type BgParameters } from './parameters.js'
import { birthDateOfEgn, bornBefore1960 } from './person-id.js'

/**
 * FR-25 §6.4: a month's run under `settings.payroll.engine: 'bg'`: one person at a time through the
 * engine, each person's line sealed on the run, the totals in clear.
 *
 * ⚠ The sealed JSON holds no id: a restore into another org rewrites ids and must not have to look
 * inside. What a line is about is in the clear `employeeId` and `contractId`, and those are bound
 * into the value's additional data (`runItemPath`).
 */
export interface BgRunItem {
  days: BgDays
  result: BgPersonResult
  /** The filed обр. 1 record of an imported month. */
  declaration?: EmplRow
}

export interface SealedRunItem {
  employeeId: unknown
  contractId?: unknown
  sealed: string
}

const MODEL = 'PayrollRun'
const FILED_PATH = 'filed'

/** A person's month, sealed on this run. */
export function sealRunItem(vault: OrgVault, runId: string, entry: { employeeId: unknown; contractId?: unknown }, item: BgRunItem): SealedRunItem {
  return { employeeId: entry.employeeId, contractId: entry.contractId, sealed: vault.seal(MODEL, runId, runItemPath(entry), item) }
}

export function openRunItem(vault: OrgVault, runId: string, entry: SealedRunItem): BgRunItem {
  return vault.open<BgRunItem>(MODEL, runId, runItemPath(entry), entry.sealed)
}

export const sealFiled = (vault: OrgVault, runId: string, filed: unknown) => vault.seal(MODEL, runId, FILED_PATH, filed)
export const openFiled = <T>(vault: OrgVault, runId: string, sealed: string) => vault.open<T>(MODEL, runId, FILED_PATH, sealed)

const FUNDS = ['doo', 'tzpb', 'dzpo', 'zo', 'gvrs'] as const

/** What a run shows without opening anyone: sums, the way `ЗАП` carries them. */
export function runTotals(results: readonly BgPersonResult[]) {
  const sum = (of: (r: BgPersonResult) => number) => fromCents(results.reduce((total, r) => total + toCents(of(r)), 0))
  const contributions = Object.fromEntries(FUNDS.map((fund) => {
    const onTop = fund === 'zo' ? { employer: sum(r => r.healthOnLeave.amount), employee: sum(r => r.healthOnUnpaidLeave.amount) } : { employer: 0, employee: 0 }
    return [fund, {
      employer: fromCents(toCents(sum(r => r.contributions[fund].employer)) + toCents(onTop.employer)),
      employee: fromCents(toCents(sum(r => r.contributions[fund].employee)) + toCents(onTop.employee)),
    }]
  }))
  const grossPay = sum(r => r.gross)
  const totalDeductions = fromCents(toCents(sum(r => r.employeeContributions)) + toCents(sum(r => r.tax)))
  return {
    grossPay,
    totalDeductions,
    netPay: sum(r => r.net),
    totalEmployerCost: fromCents(toCents(grossPay) + toCents(sum(r => r.employerContributions))),
    employeeCount: results.length,
    insurableIncome: sum(r => r.insurableIncome.doo),
    tax: sum(r => r.tax),
    contributions,
  }
}

const iso = (date: Date | string | undefined | null) => (date ? new Date(date).toISOString().slice(0, 10) : undefined)

/** `YYYYMM` of a run: its own, or the month its period starts in. */
export function periodCodeOf(run: { periodCode?: string; period?: { from: Date | string } }): string {
  if (run.periodCode) return run.periodCode
  return (iso(run.period?.from) ?? '').slice(0, 7).replace('-', '')
}

/** What one person's calculation needs that is not in `BgPersonInput`'s derived part. */
export interface BgMonthInput {
  employeeId: string
  contractId?: string
  days?: BgDays
  earnings?: BgEarning[]
  leaveDailyBase?: number
  annualTaxCorrection?: number
  advancePaid?: number
  paidCash?: number
}

/** The first and last day of a contract inside the month: partial months are the same calculation. */
function spanInMonth(contract: any, year: number, month: number): { from: number; to: number } {
  const first = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = daysInMonth(year, month)
  const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const start = iso(contract.startDate ?? contract.date) ?? first
  const end = iso(contract.endDate) ?? last
  return { from: start > first ? Number(start.slice(8)) : 1, to: end < last ? Number(end.slice(8)) : lastDay }
}

async function daysOnRecord(orgId: unknown, contract: any, period: string, p: BgParameters): Promise<BgDays> {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4))
  const span = spanInMonth(contract, year, month)
  const scheduled = workingDays(p.calendar, year, month, span.from, span.to)
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(year, month, 1))
  const entries: any[] = await AbsenceEntry.find({ orgId, employeeId: contract.employeeId, from: { $lt: end }, to: { $gte: start } }).lean().exec()
  const absences: { code: AbsenceCode; workingDays: number }[] = []
  for (const entry of entries) {
    const detail = await openAbsenceDetail(orgId, entry)
    if (!detail) continue
    // An absence over a month's end counts here only for the days of this month.
    const whole = entry.from >= start && entry.to < end
    const firstDay = entry.from >= start ? new Date(entry.from).getUTCDate() : 1
    const lastDay = entry.to < end ? new Date(entry.to).getUTCDate() : daysInMonth(year, month)
    absences.push({ code: detail.code, workingDays: whole ? entry.workingDays : workingDays(p.calendar, year, month, firstDay, lastDay) })
  }
  return daysFromAbsences(scheduled, absences)
}

function birthOf(personal: EmployeePersonal, employeeNumber: string): string {
  const birth = personal.dateOfBirth ? String(personal.dateOfBirth).slice(0, 10) : birthDateOfEgn(String(personal.nationalId ?? ''))
  if (!birth) throw new UnsupportedPayrollCaseError(`employee ${employeeNumber} has no date of birth, which the pension rate needs`)
  return birth
}

/** What a person's record says about the tax of this month, and what it says that is not implemented. */
function reliefsOf(personal: EmployeePersonal, employeeNumber: string, firstDay: string, lastDay: string): BgPersonInput['reliefs'] {
  if (personal.insuredAtMaxElsewhere) throw new UnsupportedPayrollCaseError(`employee ${employeeNumber} is insured at the cap elsewhere, which is not implemented`)
  if (Number(personal.childRelief?.disabledChildren) > 0) throw new UnsupportedPayrollCaseError(`employee ${employeeNumber} has relief for a child with a disability, which is not implemented`)
  const { disabled } = personal
  const inForce = Number(disabled?.percent) >= 50 && (!disabled.from || disabled.from <= lastDay) && (!disabled.to || disabled.to >= firstDay)
  return { disability: inForce, children: personal.childRelief?.children }
}

/** A refusal names the employee number, so that someone can act on it, and never the person. */
function calculateOne(input: BgPersonInput, p: BgParameters, employeeNumber: string): BgPersonResult {
  try {
    return calculatePerson(input, p)
  } catch (e) {
    if (e instanceof UnsupportedPayrollCaseError) throw new UnsupportedPayrollCaseError(`employee ${employeeNumber}: ${e.message}`)
    throw e
  }
}

export async function calculateBgRun(orgId: unknown, run: any, inputs: readonly BgMonthInput[] = []) {
  if (run.kind === 'advance') throw new UnsupportedPayrollCaseError('an advance run is not implemented')
  const period = periodCodeOf(run)
  const p = await loadParameters(period)
  const asOf = periodStart(period)
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4))
  const monthEnd = new Date(Date.UTC(year, month, 0))
  const monthStart = new Date(`${asOf}T00:00:00Z`)
  const lastDay = iso(monthEnd)!

  const contracts: any[] = await EmploymentContract.find({
    orgId,
    $and: [
      { $or: [{ startDate: { $lte: monthEnd } }, { startDate: null, date: { $lte: monthEnd } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: monthStart } }] },
    ],
  }).lean().exec()
  const employees: any[] = await Employee.find({ orgId, _id: { $in: contracts.map(c => c.employeeId) } }).lean().exec()
  const employeeOf = new Map(employees.map(e => [String(e._id), e]))
  const inputOf = new Map(inputs.map(i => [`${i.employeeId}|${i.contractId ?? ''}`, i]))

  const vault = await forOrg(orgId)
  const runId = String(run.id ?? run._id)
  const items: SealedRunItem[] = []
  const results: BgPersonResult[] = []

  for (const contract of contracts) {
    const employee = employeeOf.get(String(contract.employeeId))
    if (!employee) continue
    const given = inputOf.get(`${contract.employeeId}|${contract._id}`) ?? inputOf.get(`${contract.employeeId}|`)
    const pay = await openContractPay(orgId, contract)
    const salary = pay ? salaryAsOf(pay, lastDay) : null
    if (!salary) throw new UnsupportedPayrollCaseError(`employee ${employee.employeeNumber} has no salary on ${lastDay}`)
    if (salary.currency !== p.currency) throw new UnsupportedPayrollCaseError(`employee ${employee.employeeNumber}'s salary is in ${salary.currency} in a period that runs in ${p.currency}`)
    const days = given?.days ?? await daysOnRecord(orgId, contract, period, p)
    const personal = await openEmployeePersonal(orgId, employee)
    const input: BgPersonInput = {
      period,
      insuredType: contract.socialSecurityType,
      bornBefore1960: bornBefore1960(birthOf(personal, employee.employeeNumber)),
      qualificationGroup: contract.qualificationGroup,
      mainActivityRow: contract.mainActivityRow,
      kid: contract.activityKid ?? contract.kid,
      hoursPerDay: contract.hoursPerDay,
      statutoryHours: contract.statutoryHours,
      days,
      salary: { amount: salary.amount, leaveDailyBase: given?.leaveDailyBase },
      earnings: given?.earnings,
      reliefs: reliefsOf(personal, employee.employeeNumber, asOf, lastDay),
      annualTaxCorrection: given?.annualTaxCorrection,
      advancePaid: given?.advancePaid,
      paidCash: given?.paidCash,
    }
    const result = calculateOne(input, p, employee.employeeNumber)
    results.push(result)
    items.push(sealRunItem(vault, runId, { employeeId: contract.employeeId, contractId: contract._id }, { days, result }))
  }

  return {
    period,
    update: {
      engine: 'bg' as const,
      periodCode: period,
      kind: run.kind ?? 'salary',
      source: 'engine' as const,
      parametersAsOf: asOf,
      currency: p.currency,
      items: [],
      sealedItems: items,
      totals: runTotals(results),
      status: 'calculated',
    },
  }
}

/** Only the people asked for, or all of them. The caller writes the audit row before answering. */
export async function openRunItems(orgId: unknown, run: any, employeeIds?: readonly string[]) {
  const vault = await forOrg(orgId)
  const runId = String(run.id ?? run._id)
  const wanted = employeeIds?.length ? new Set(employeeIds.map(String)) : null
  return (run.sealedItems ?? [])
    .filter((entry: SealedRunItem) => !wanted || wanted.has(String(entry.employeeId)))
    .map((entry: SealedRunItem) => ({ employeeId: entry.employeeId, contractId: entry.contractId, ...openRunItem(vault, runId, entry) }))
}

const SLIP_MODEL = 'Payslip'
const SLIP_PATH = 'sealed'

export interface SealedPayslip {
  earnings: { type: string; description: string; amount: number }[]
  deductions: { type: string; description: string; amount: number }[]
  grossPay: number
  totalDeductions: number
  netPay: number
  yearToDate: { grossPay: number; totalDeductions: number; netPay: number }
}

export const openPayslip = (vault: OrgVault, doc: { id?: string; _id?: unknown; sealed: string }) =>
  vault.open<SealedPayslip>(SLIP_MODEL, String(doc.id ?? doc._id), SLIP_PATH, doc.sealed)

function slipOf(result: BgPersonResult, labels: Map<string, string>, before: SealedPayslip['yearToDate']): SealedPayslip {
  const deductions = [
    { type: 'doo', description: 'ДОО', amount: result.contributions.doo.employee },
    { type: 'dzpo', description: 'ДЗПО', amount: result.contributions.dzpo.employee },
    { type: 'zo', description: 'ЗО', amount: result.contributions.zo.employee },
    { type: 'tax', description: 'ДОД', amount: result.tax },
  ].filter(d => d.amount !== 0)
  const totalDeductions = fromCents(deductions.reduce((sum, d) => sum + toCents(d.amount), 0))
  const add = (a: number, b: number) => fromCents(toCents(a) + toCents(b))
  return {
    earnings: result.lines.map(l => ({ type: String(l.code), description: labels.get(String(l.code)) ?? String(l.code), amount: l.amount })),
    deductions,
    grossPay: result.gross,
    totalDeductions,
    netPay: result.net,
    yearToDate: {
      grossPay: add(before.grossPay, result.gross),
      totalDeductions: add(before.totalDeductions, totalDeductions),
      netPay: add(before.netPay, result.net),
    },
  }
}

/** FR-25 §3.10: what one person receives, generated at approval from the run's sealed lines. */
export async function generateBgPayslips(orgId: unknown, run: any): Promise<number> {
  const vault = await forOrg(orgId)
  const runId = String(run.id ?? run._id)
  const elements: any[] = await PayrollElement.find({ orgId }).lean().exec()
  const labels = new Map(elements.map(e => [e.code, e.label]))
  const year = periodCodeOf(run).slice(0, 4)
  const yearStart = new Date(`${year}-01-01T00:00:00Z`)
  const entries: SealedRunItem[] = run.sealedItems ?? []

  // The year so far, per person, in one read.
  const earlier: any[] = await Payslip.find({
    orgId,
    employeeId: { $in: entries.map(e => e.employeeId) },
    sealed: { $exists: true },
    'period.from': { $gte: yearStart, $lt: new Date(run.period.from) },
  }).lean().exec()
  const yearToDate = new Map<string, { grossPay: number; totalDeductions: number; netPay: number }>()
  for (const doc of earlier) {
    const slip = openPayslip(vault, doc)
    const key = String(doc.employeeId)
    const held = yearToDate.get(key) ?? { grossPay: 0, totalDeductions: 0, netPay: 0 }
    yearToDate.set(key, {
      grossPay: held.grossPay + toCents(slip.grossPay),
      totalDeductions: held.totalDeductions + toCents(slip.totalDeductions),
      netPay: held.netPay + toCents(slip.netPay),
    })
  }

  const slips = entries.map((entry) => {
    const { result } = openRunItem(vault, runId, entry)
    const held = yearToDate.get(String(entry.employeeId)) ?? { grossPay: 0, totalDeductions: 0, netPay: 0 }
    const id = new mongoose.Types.ObjectId()
    return {
      _id: id,
      orgId,
      payrollRunId: runId,
      employeeId: entry.employeeId,
      period: run.period,
      earnings: [],
      deductions: [],
      totalDeductions: 0,
      engine: 'bg',
      sealed: vault.seal(SLIP_MODEL, String(id), SLIP_PATH, slipOf(result, labels, {
        grossPay: fromCents(held.grossPay), totalDeductions: fromCents(held.totalDeductions), netPay: fromCents(held.netPay),
      })),
      paymentMethod: result.paid.bank > 0 ? 'bank_transfer' : 'cash',
      status: 'generated',
    }
  })
  await Payslip.insertMany(slips)
  return slips.length
}

export async function runDocument(orgId: unknown, id: string): Promise<any> {
  return PayrollRun.findOne({ _id: id, orgId }).lean().exec()
}
