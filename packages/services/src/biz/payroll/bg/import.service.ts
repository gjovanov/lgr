import { Employee, EmploymentContract, PayrollRun } from 'db/models'
import { mongoose } from 'db/connection'
import { logger } from '../../../logger/logger.js'
import { sealedEmployeeFields } from '../../personal-data/employee-personal.js'
import { forOrg, type OrgVault } from '../../personal-data/personal-data.service.js'
import { foldContractEvents, type FoldedContract, type PersonnelSnapshot } from './contract-fold.js'
import { openContractPay, sealContractPay, type EmploymentPay } from './contract-pay.js'
import { daysOfRow, resultOfRow } from './declaration.js'
import { seedPayrollElements } from './elements.js'
import type { BgLine } from './engine.js'
import type { ContractEvent } from './files/contract-events.js'
import { emitEmpl, type EmplRow } from './files/empl2021.js'
import { emitNra, type NraFile } from './files/nra62007.js'
import { birthDateOfEgn } from './person-id.js'
import { openFiled, openRunItem, runTotals, sealFiled, sealRunItem, type BgRunItem, type SealedRunItem } from './run.service.js'

/**
 * FR-25 §5.1: payroll imported as filed. Every step answers with what it would change, and `dryRun`
 * stops there, so a re-import can be proven with a dry rerun rather than a live one.
 *
 * ⚠ What these answer is counts and month names: an import's result lands in a terminal. No name,
 * ЕГН or amount of one person leaves here, in a response, a log or an audit row.
 */
const ID_KINDS: readonly string[] = ['egn', 'lnch', 'service', 'bulstat']
const NO_VALUE = '-'

export interface ImportPerson {
  personId: string
  /** Field 5 of обр. 1: 0 for an ЕГН. */
  personIdKind: number
  firstName?: string
  middleName?: string
  lastName: string
  /** Still on the newest month held. */
  active: boolean
  /** `YYYY-MM-DD`, the earliest this person is known from. */
  knownFrom: string
}

export interface ImportOptions {
  dryRun: boolean
}

async function employeesByPerson(orgId: unknown, vault: OrgVault, personIds: readonly string[]): Promise<Map<string, any>> {
  const hmacOf = new Map(personIds.map(id => [vault.blindIndex('nationalId', id), id]))
  const found: any[] = await Employee.find({ orgId, nationalIdHmac: { $in: [...hmacOf.keys()] } }).lean().exec()
  return new Map(found.map(employee => [hmacOf.get(employee.nationalIdHmac)!, employee]))
}

async function nextEmployeeNumber(orgId: unknown): Promise<number> {
  const numbers: any[] = await Employee.find({ orgId, employeeNumber: /^E-\d+$/ }, { employeeNumber: 1 }).lean().exec()
  return numbers.reduce((max, e) => Math.max(max, Number(e.employeeNumber.slice(2))), 0) + 1
}

export async function importEmployees(orgId: unknown, people: readonly ImportPerson[], { dryRun }: ImportOptions) {
  const vault = await forOrg(orgId)
  const known = await employeesByPerson(orgId, vault, people.map(p => p.personId))
  const report = { people: people.length, create: 0, update: 0, unchanged: 0 }
  let number = await nextEmployeeNumber(orgId)

  for (const person of people) {
    const status = person.active ? 'active' : 'terminated'
    const names = { firstName: person.firstName || NO_VALUE, middleName: person.middleName || undefined, lastName: person.lastName }
    const existing = known.get(person.personId)
    if (existing) {
      const fields = { ...names, status }
      const changed = (Object.keys(fields) as (keyof typeof fields)[]).some(k => (existing[k] ?? undefined) !== fields[k])
      if (!changed) { report.unchanged++; continue }
      report.update++
      if (!dryRun) await Employee.updateOne({ _id: existing._id }, { $set: fields }).exec()
      continue
    }
    report.create++
    if (dryRun) continue
    const id = new mongoose.Types.ObjectId()
    const birth = birthDateOfEgn(person.personId)
    const sealed = await sealedEmployeeFields(orgId, String(id), null, {
      identifierType: ID_KINDS[person.personIdKind] ?? 'egn',
      nationalId: person.personId,
      ...(birth ? { dateOfBirth: birth } : {}),
    })
    await Employee.create({
      _id: id,
      orgId,
      employeeNumber: `E-${String(number++).padStart(4, '0')}`,
      ...names,
      department: NO_VALUE,
      position: NO_VALUE,
      employmentType: 'full_time',
      contractStartDate: new Date(`${person.knownFrom}T00:00:00Z`),
      status,
      // The real pay is sealed on the contract. This field predates it, and it is in clear.
      salary: { baseSalary: 0, currency: 'EUR', frequency: 'monthly' },
      deductions: [],
      benefits: [],
      documents: [],
      ...sealed,
    })
  }
  logger.info({ ...report, dryRun }, 'Payroll import: employees')
  return report
}

const dateOf = (value: string | undefined) => (value ? new Date(`${value}T00:00:00Z`) : undefined)

function contractFields(contract: FoldedContract, employeeId: unknown) {
  return {
    employeeId,
    date: dateOf(contract.date)!,
    type: contract.type,
    ekatte: contract.ekatte,
    startDate: dateOf(contract.startDate),
    endDate: dateOf(contract.endDate),
    position: contract.position,
    nkpd: contract.nkpd,
    kid: contract.kid,
    socialSecurityType: contract.socialSecurityType,
    healthSecurityType: contract.healthSecurityType,
    hoursPerDay: contract.hoursPerDay,
    daysPerWeek: contract.daysPerWeek,
    statutoryHours: contract.statutoryHours,
    annualLeaveDays: contract.annualLeaveDays,
    classPercent: contract.classPercent,
    experienceAtStart: contract.experienceAtStart,
    currency: contract.salaries.at(-1)?.currency ?? 'EUR',
    amendments: contract.amendments.map(a => ({ ...a, date: dateOf(a.date)!, effectiveFrom: dateOf(a.effectiveFrom)! })),
    termination: contract.termination ? { ...contract.termination, date: dateOf(contract.termination.date) } : undefined,
    source: 'import' as const,
  }
}

const comparable = (value: unknown) => JSON.stringify(value, (_, v) => (v === null ? undefined : v))

function sameContract(existing: any, fields: ReturnType<typeof contractFields>, pay: EmploymentPay | null, wanted: EmploymentPay): boolean {
  const clear = (doc: any) => comparable({
    type: doc.type, ekatte: doc.ekatte, startDate: doc.startDate, endDate: doc.endDate, position: doc.position, nkpd: doc.nkpd, kid: doc.kid,
    hoursPerDay: doc.hoursPerDay, amendments: (doc.amendments ?? []).map((a: any) => [a.date, a.effectiveFrom, a.byLaw ?? false]),
    termination: doc.termination?.date ?? null,
  })
  return clear(existing) === clear(fields) && comparable(pay) === comparable(wanted)
}

/** Folds what the files say into contracts, and lists what they leave open for the accountant. */
export async function importContracts(
  orgId: unknown,
  body: { events: ContractEvent[]; snapshots: PersonnelSnapshot[]; people: string[] },
  { dryRun }: ImportOptions,
) {
  const vault = await forOrg(orgId)
  const { contracts, gaps } = foldContractEvents(body.events, body.snapshots, body.people)
  const known = await employeesByPerson(orgId, vault, [...new Set(contracts.map(c => c.personId))])
  const report = { contracts: contracts.length, create: 0, update: 0, unchanged: 0, unknownPeople: 0, gaps: {} as Record<string, number> }
  for (const { gap } of gaps) report.gaps[gap] = (report.gaps[gap] ?? 0) + 1

  for (const contract of contracts) {
    const employee = known.get(contract.personId)
    if (!employee) { report.unknownPeople++; continue }
    const fields = contractFields(contract, employee._id)
    const wanted: EmploymentPay = { salaries: contract.salaries }
    const existing: any = await EmploymentContract.findOne({ orgId, employeeId: employee._id, date: fields.date }).lean().exec()
    if (existing) {
      if (sameContract(existing, fields, await openContractPay(orgId, existing), wanted)) { report.unchanged++; continue }
      report.update++
      if (!dryRun) await EmploymentContract.updateOne({ _id: existing._id }, { $set: { ...fields, pay: await sealContractPay(orgId, String(existing._id), wanted) } }).exec()
      continue
    }
    report.create++
    if (dryRun) continue
    const id = new mongoose.Types.ObjectId()
    await EmploymentContract.create({ _id: id, orgId, ...fields, pay: await sealContractPay(orgId, String(id), wanted) })
  }
  logger.info({ ...report, dryRun }, 'Payroll import: contracts')
  return report
}

export interface ImportMonth {
  /** `YYYYMM`. */
  period: string
  /** Which file this is, by the date PlusMinus wrote it. */
  version: string
  rows: EmplRow[]
  /** The month's payroll sheet, where an export exists. */
  sheet?: { personId: string; lines: BgLine[]; paidLeaveDays?: number }[]
  /** The month's обр. 6, where it is held. */
  filed?: NraFile
}

const currencyOfPeriod = (period: string) => (period < '202601' ? 'BGN' : 'EUR')

const monthBounds = (period: string) => {
  const year = Number(period.slice(0, 4))
  const month = Number(period.slice(4))
  return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 0)) }
}

async function contractsOf(orgId: unknown, employeeIds: unknown[], period: string): Promise<Map<string, any>> {
  const { from, to } = monthBounds(period)
  const rows: any[] = await EmploymentContract.find({
    orgId,
    employeeId: { $in: employeeIds },
    $and: [
      { $or: [{ startDate: { $lte: to } }, { startDate: null, date: { $lte: to } }] },
      { $or: [{ endDate: null }, { endDate: { $gte: from } }] },
    ],
  }).lean().exec()
  return new Map(rows.map(c => [String(c.employeeId), c]))
}

export type MonthAction = 'create' | 'replace' | 'unchanged' | 'refused'

/** Replaces one month whole. The export has no stable row key, so a month is the unit of an import. */
export async function importMonth(orgId: unknown, userId: unknown, month: ImportMonth, { dryRun }: ImportOptions) {
  const { period, rows } = month
  const report = {
    period, action: 'refused' as MonthAction, people: rows.length, added: 0, changed: 0, gone: 0, unchanged: 0, unknownPeople: 0, withoutContract: 0, reason: undefined as string | undefined,
  }
  const year = Number(period.slice(0, 4))
  const monthNumber = Number(period.slice(4))
  if (rows.some(row => row.year !== year || row.month !== monthNumber)) return { ...report, reason: 'rows_of_another_month' }

  const vault = await forOrg(orgId)
  const people = await employeesByPerson(orgId, vault, rows.map(row => row.personId))
  report.unknownPeople = rows.filter(row => !people.has(row.personId)).length
  if (report.unknownPeople) return { ...report, reason: 'unknown_people' }

  const contracts = await contractsOf(orgId, [...people.values()].map(e => e._id), period)
  const sheet = new Map((month.sheet ?? []).map(entry => [entry.personId, entry]))
  const existing: any = await PayrollRun.findOne({ orgId, periodCode: period, kind: 'salary', source: 'imported' }).lean().exec()
  if (existing && existing.status !== 'imported') return { ...report, reason: 'month_was_taken_further' }

  const runId = existing ? String(existing._id) : String(new mongoose.Types.ObjectId())
  const before = new Map<string, BgRunItem>()
  for (const entry of existing?.sealedItems ?? []) before.set(String(entry.employeeId), openRunItem(vault, runId, entry))

  const sealedItems: SealedRunItem[] = []
  const results = []
  const seen = new Set<string>()
  for (const row of rows) {
    const employee = people.get(row.personId)
    const contract = contracts.get(String(employee._id))
    if (!contract) report.withoutContract++
    const onSheet = sheet.get(row.personId)
    const result = resultOfRow(row, period, onSheet?.lines)
    const item: BgRunItem = { days: daysOfRow(row, onSheet?.paidLeaveDays ?? 0), result, declaration: row }
    results.push(result)
    const key = String(employee._id)
    seen.add(key)
    const held = before.get(key)
    if (!held) report.added++
    else if (comparable(held) === comparable(item)) report.unchanged++
    else report.changed++
    sealedItems.push(sealRunItem(vault, runId, { employeeId: employee._id, contractId: contract?._id }, item))
  }
  report.gone = [...before.keys()].filter(key => !seen.has(key)).length

  const heldFiled = existing?.filed ? openFiled(vault, runId, existing.filed) : undefined
  const filedChanged = comparable(heldFiled) !== comparable(month.filed)
  const untouched = existing && !report.added && !report.changed && !report.gone && !filedChanged
  report.action = untouched ? 'unchanged' : existing ? 'replace' : 'create'
  if (dryRun || untouched) return report

  const { from, to } = monthBounds(period)
  const fields = {
    sealedItems,
    filed: month.filed ? sealFiled(vault, runId, month.filed) : undefined,
    fileVersion: month.version,
    totals: runTotals(results),
  }
  if (existing) {
    await PayrollRun.updateOne({ _id: existing._id }, { $set: fields }).exec()
  } else {
    await seedPayrollElements(orgId)
    await PayrollRun.create({
      _id: runId,
      orgId,
      name: `${period.slice(0, 4)}-${period.slice(4)}`,
      period: { from, to },
      status: 'imported',
      currency: currencyOfPeriod(period),
      engine: 'bg',
      periodCode: period,
      kind: 'salary',
      source: 'imported',
      createdBy: userId,
      items: [],
      ...fields,
    })
  }
  logger.info({ period, action: report.action, people: report.people }, 'Payroll import: month')
  return report
}

export class DeveloperEikMissingError extends Error {
  readonly code = 'payroll_developer_eik_missing'
  readonly statusCode = 422
  constructor() {
    super('A declaration names its software: set PAYROLL_DEVELOPER_EIK')
    this.name = 'DeveloperEikMissingError'
  }
}

/** §5.1's gate: an imported month's file, emitted again from what was stored. */
export async function emitImportedDeclaration(orgId: unknown, run: any, form: 'empl' | 'nra', developerId: string | undefined): Promise<Uint8Array> {
  if (!developerId) throw new DeveloperEikMissingError()
  const vault = await forOrg(orgId)
  const runId = String(run._id ?? run.id)
  if (form === 'nra') {
    if (!run.filed) throw new Error('this month holds no обр. 6')
    const { record, ending } = openFiled<NraFile>(vault, runId, run.filed)
    return emitNra(record, { developerId, ending })
  }
  const rows = (run.sealedItems ?? []).map((entry: SealedRunItem) => {
    const { declaration } = openRunItem(vault, runId, entry)
    if (!declaration) throw new Error('this run was not imported from a declaration')
    return declaration
  })
  return emitEmpl(rows, { developerId })
}
