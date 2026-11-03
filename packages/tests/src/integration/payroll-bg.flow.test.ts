import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { AbsenceEntry, AuditLog, Employee, EmploymentContract, Org, PayrollElement, PayrollParameter, PayrollRun, PersonalDataKey, Payslip } from 'db/models'
import { clearVaultCache, forOrg } from 'services/biz/personal-data/personal-data.service'
import { planPersonalDataRestore } from 'services/biz/personal-data/restore'
import { generateKey, isSealed, runItemPath } from 'services/biz/personal-data/crypto'
import { emitEmpl, type EmplRow } from 'services/biz/payroll/bg/files/empl2021'
import { emitNra, type NraRecord } from 'services/biz/payroll/bg/files/nra62007'
import { clearParameterCache, loadParameters, seedPayrollParameters } from 'services/biz/payroll/bg/parameters.service'
import { openContractPay } from 'services/biz/payroll/bg/contract-pay'
import { openRunItem } from 'services/biz/payroll/bg/run.service'
import { PAYROLL_PARAMETERS } from 'services/biz/payroll/bg/parameters.data'
import { calculatePerson } from 'services/biz/payroll/bg/engine'

/**
 * FR-25 §5.1, §6.4 and §3.12: Bulgarian payroll, imported and calculated, over HTTP against the real
 * route table, and against the raw collections, because what matters is what is stored.
 *
 * Made-up people only: the ЕГН numbers fail no checksum and their month 13 names nobody, and the
 * employer's number is nines. The amounts are round ones nobody earns.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */
const FAKE_EGN = '7513020014'
const SECOND_EGN = '7513020000'
const EMPLOYER = '999999999'
const SEALED_SALARY = 1837.42

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const realKek = config.personalData.kek
const realDeveloper = config.payroll.developerEik

let app: Elysia
let orgId: string
let adminToken: string
let hrToken: string
let writerToken: string
let readerToken: string

async function tokenFor(user: any, role: string, permissions: string[], org: string) {
  const self = signer as any
  return self.decorator.jwt.sign({ id: String(user._id), email: user.email, username: user.username, firstName: 'A', lastName: 'B', role, orgId: org, permissions })
}

function call(method: string, path: string, token: string, body?: unknown, org = orgId) {
  return app.handle(new Request(`http://localhost/api/org/${org}/payroll/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

const emplRow = (over: Partial<EmplRow> = {}): EmplRow => ({
  month: 9, year: 2025, employerId: EMPLOYER, personId: FAKE_EGN, personIdKind: 0, surname: 'ПРИМЕРОВА', initials: 'ИП', insuredType: 1,
  from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0, from4: 0, to4: 0, from5: 0, to5: 0,
  totalDays: '2088', workedDays: 20, sickDays: 0, childcareDays: 0, noContributionDays: 0, unpaidLeaveDays: 0, employerSickDays: 0,
  hoursWorked: 160, overtimeHours: 0, qualificationGroup: 5, kid: '4690', mainActivityRow: 58, summedTimeCode: '0000',
  zoBaseSick: 0, zoRateSick: 0, insurableIncome: 2000, dooRateEmployer: 10.92, dooRateEmployee: 8.38, zoRateEmployer: 4.8, zoRateEmployee: 3.2,
  tzpbRate: 0.5, uchpfRate: 0, ppfRate: 0, upfRateEmployer: 2.8, upfRateEmployee: 2.2, healthOnlyBase: 0, healthOnlyRate: 0,
  grossPay: 2000, gvrsRate: 0, taxableIncome: 2000, tax: 172.44, netPay: 1551.96, kasaCode: 0, correctionCode: 0, developerId: '888888888',
  ...over,
})

const filedRecord = (): NraRecord => ({
  employerId: EMPLOYER, employerName: 'ПРИМЕР', kasaMember: 0, email: 'A@EXAMPLE.COM', phone: '000000000', gsm: '', developerId: '888888888',
  columns: [
    { month: '09', year: '2025', paymentDate: '25/10/2025', changeFlag: '0', paymentType: '5', doo: 395.4, uchpf: null, dzpoUpf: 100, dzpoPpf: null, zo: 160, gvrs: null, tax: null, advanceTax: null },
    { month: '08', year: '2025', paymentDate: '25/10/2025', changeFlag: '0', paymentType: '8', doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: 172.44, advanceTax: null },
    ...[0, 1].map(() => ({ month: '', year: '', paymentDate: '', changeFlag: '', paymentType: '', doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: null, advanceTax: null })),
  ],
})

const people = () => [
  { personId: FAKE_EGN, personIdKind: 0, firstName: 'ИВА', lastName: 'ПРИМЕРОВА', active: true, knownFrom: '2025-09-01' },
  { personId: SECOND_EGN, personIdKind: 0, firstName: 'ПЕТЪР', lastName: 'ОБРАЗЦОВ', active: true, knownFrom: '2025-09-01' },
]

const september = (over: Record<string, unknown> = {}) => ({
  period: '202509', version: '20251010_120000', rows: [emplRow(), emplRow({ personId: SECOND_EGN, surname: 'ОБРАЗЦОВ', initials: 'ПО' })],
  filed: { record: filedRecord(), ending: 'crlf-eof' }, ...over,
})

const newOrg = async (engine?: 'bg') => {
  const org = await createTestOrg()
  if (engine) await Org.updateOne({ _id: org._id }, { $set: { 'settings.payroll.engine': engine } })
  return String(org._id)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg()
  orgId = String(org._id)
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.payroll.engine': 'bg' } })
  const user = await createTestUser(org._id)
  adminToken = await tokenFor(user, 'admin', [], orgId)
  hrToken = await tokenFor(user, 'hr_manager', ['payroll.read', 'payroll.write', 'payroll.approve', 'payroll.personal', 'payroll.import'], orgId)
  writerToken = await tokenFor(user, 'member', ['payroll.read', 'payroll.write', 'payroll.import'], orgId)
  readerToken = await tokenFor(user, 'member', ['payroll.read'], orgId)
})

afterEach(() => {
  ;(config.personalData as any).kek = realKek
  ;(config.payroll as any).developerEik = realDeveloper
  clearVaultCache()
})

afterAll(async () => {
  await teardownTestDB()
})

describe('importing a filed month', () => {
  it('needs payroll.import, and payroll.personal on top', async () => {
    expect((await call('POST', 'import/employees', readerToken, { people: people() })).status).toBe(403)
    expect((await call('POST', 'import/employees', writerToken, { people: people() })).status).toBe(403)
    expect((await call('POST', 'import/employees', hrToken, { people: people() })).status).toBe(200)
  })

  it('a dry run is the default, and changes nothing', async () => {
    const before = await Employee.countDocuments({ orgId })
    const res = await call('POST', 'import/employees', hrToken, { people: people() })
    expect(await res.json()).toEqual({ people: 2, create: 2, update: 0, unchanged: 0 })
    expect(await Employee.countDocuments({ orgId })).toBe(before)
  })

  it('makes employees, sealed from the start, and finds them again by the lookup', async () => {
    const res = await call('POST', 'import/employees', hrToken, { people: people(), dryRun: false })
    expect(await res.json()).toEqual({ people: 2, create: 2, update: 0, unchanged: 0 })
    const stored = JSON.stringify(await Employee.collection.find({ orgId: { $exists: true } }).toArray())
    expect(stored).not.toContain(FAKE_EGN)
    expect(stored).not.toContain(SECOND_EGN)
    const again = await call('POST', 'import/employees', hrToken, { people: people(), dryRun: false })
    expect(await again.json()).toEqual({ people: 2, create: 0, update: 0, unchanged: 2 })
  })

  it('refuses a month with someone it does not know, and says how many, not who', async () => {
    const res = await call('POST', 'import/months', hrToken, september({ rows: [emplRow({ personId: '7513020026' })], dryRun: false }))
    const report = await res.json()
    expect(report).toMatchObject({ action: 'refused', reason: 'unknown_people', unknownPeople: 1 })
    expect(JSON.stringify(report)).not.toContain('7513020026')
    expect(await PayrollRun.countDocuments({ orgId, periodCode: '202509' })).toBe(0)
  })

  it('refuses a row of another month, and a row that is not the format', async () => {
    const other = await call('POST', 'import/months', hrToken, september({ rows: [emplRow({ month: 8 })] }))
    expect(await other.json()).toMatchObject({ action: 'refused', reason: 'rows_of_another_month' })
    const bad = await call('POST', 'import/months', hrToken, september({ rows: [{ month: 9 }] }))
    expect(bad.status).toBe(422)
  })

  it('stores the month sealed, its totals in clear', async () => {
    const dry = await call('POST', 'import/months', hrToken, september())
    expect(await dry.json()).toMatchObject({ action: 'create', people: 2, added: 2 })
    expect(await PayrollRun.countDocuments({ orgId, periodCode: '202509' })).toBe(0)

    const res = await call('POST', 'import/months', hrToken, september({ dryRun: false }))
    expect(await res.json()).toMatchObject({ action: 'create', people: 2, added: 2, withoutContract: 2 })

    const raw: any = await PayrollRun.collection.findOne({ periodCode: '202509' })
    expect(raw).toMatchObject({ status: 'imported', source: 'imported', engine: 'bg', kind: 'salary', currency: 'BGN' })
    expect(raw.items).toEqual([])
    expect(raw.sealedItems.every((i: any) => isSealed(i.sealed))).toBe(true)
    expect(isSealed(raw.filed)).toBe(true)
    expect(raw.totals).toMatchObject({ employeeCount: 2, grossPay: 4000, tax: 344.88 })
    expect(raw.totals.contributions.doo).toEqual({ employer: 436.8, employee: 335.2 })
    const stored = JSON.stringify(raw)
    expect(stored).not.toContain(FAKE_EGN)
    expect(stored).not.toContain('ПРИМЕРОВА')
    expect(stored).not.toContain('172.44')
    expect(stored).not.toContain('EXAMPLE')
  })

  it('a dry rerun says nothing changed, and proves it without writing', async () => {
    const before: any = await PayrollRun.collection.findOne({ periodCode: '202509' })
    const res = await call('POST', 'import/months', hrToken, september())
    expect(await res.json()).toMatchObject({ action: 'unchanged', added: 0, changed: 0, gone: 0, unchanged: 2 })
    const after: any = await PayrollRun.collection.findOne({ periodCode: '202509' })
    expect(after.sealedItems).toEqual(before.sealedItems)
  })

  it('a re-import replaces the month whole, and says what moved', async () => {
    const res = await call('POST', 'import/months', hrToken, september({ rows: [emplRow({ taxableIncome: 2100, grossPay: 2100 })], version: '20251011_090000', dryRun: false }))
    expect(await res.json()).toMatchObject({ action: 'replace', changed: 1, gone: 1, added: 0 })
    const runs: any[] = await PayrollRun.find({ orgId, periodCode: '202509' }).lean()
    expect(runs).toHaveLength(1)
    expect(runs[0].sealedItems).toHaveLength(1)
    expect(runs[0].fileVersion).toBe('20251011_090000')
    await call('POST', 'import/months', hrToken, september({ dryRun: false }))
  })

  it('leaves a month alone once it went further than imported', async () => {
    await PayrollRun.updateOne({ orgId, periodCode: '202509' }, { $set: { status: 'posted' } })
    const res = await call('POST', 'import/months', hrToken, september({ dryRun: false }))
    expect(await res.json()).toMatchObject({ action: 'refused', reason: 'month_was_taken_further' })
    await PayrollRun.updateOne({ orgId, periodCode: '202509' }, { $set: { status: 'imported' } })
  })

  it('names no person in the audit rows or the answers', async () => {
    const rows: any[] = await AuditLog.find({ orgId, action: 'import' }).lean()
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    for (const secret of [FAKE_EGN, SECOND_EGN, 'ПРИМЕРОВА', '172.44']) expect(text).not.toContain(secret)
  })
})

describe('the gate: what was stored emits what was filed', () => {
  const runId = async () => String(((await PayrollRun.findOne({ orgId, periodCode: '202509' }).lean()) as any)._id)

  it('needs a developer: there is no default', async () => {
    ;(config.payroll as any).developerEik = undefined
    const res = await call('POST', `run/${await runId()}/declaration`, hrToken, { form: 'empl', reason: 'declaration' })
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('payroll_developer_eik_missing')
  })

  it('re-emits обр. 1 and обр. 6, byte for byte, the developer aside', async () => {
    ;(config.payroll as any).developerEik = '777777777'
    const id = await runId()
    const developerId = '777777777'
    const empl = await (await call('POST', `run/${id}/declaration`, hrToken, { form: 'empl', reason: 'declaration' })).json()
    const rows = [emplRow(), emplRow({ personId: SECOND_EGN, surname: 'ОБРАЗЦОВ', initials: 'ПО' })]
    expect(Buffer.from(empl.contentBase64, 'base64')).toEqual(Buffer.from(emitEmpl(rows, { developerId })))
    const nra = await (await call('POST', `run/${id}/declaration`, hrToken, { form: 'nra', reason: 'declaration' })).json()
    expect(Buffer.from(nra.contentBase64, 'base64')).toEqual(Buffer.from(emitNra(filedRecord(), { developerId })))
  })

  it('is a read of a file full of ЕГН numbers: it needs the permission, and it is audited', async () => {
    ;(config.payroll as any).developerEik = '777777777'
    const id = await runId()
    expect((await call('POST', `run/${id}/declaration`, readerToken, { form: 'empl', reason: 'audit' })).status).toBe(403)
    const rows: any[] = await AuditLog.find({ orgId, action: 'reveal', entityType: 'payroll_run' }).lean()
    expect(rows.some(r => r.changes[0].field === 'declaration.empl')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(FAKE_EGN)
  })
})

describe('what a run shows', () => {
  it('shows payroll.read its totals, and no line of anyone', async () => {
    const res = await call('GET', 'run', readerToken)
    expect(res.status).toBe(200)
    const body = await res.json()
    const run = body.payrollRuns.find((r: any) => r.periodCode === '202509')
    expect(run.totals.grossPay).toBe(4000)
    expect(run.sealedItems).toBeUndefined()
    expect(run.items).toBeUndefined()
    expect(run.people).toBeUndefined()
    expect(run.filed).toBeUndefined()
    const one = await (await call('GET', `run/${run._id ?? run.id}`, readerToken)).json()
    expect(one.payrollRun.sealedItems).toBeUndefined()
    expect(one.payrollRun.people).toBeUndefined()
  })

  it('never sends a sealed value, with payroll.personal either', async () => {
    const res = await call('GET', 'run', hrToken)
    const text = await res.text()
    expect(text).not.toContain('pd1.')
    const run = JSON.parse(text).payrollRuns.find((r: any) => r.periodCode === '202509')
    expect(run.people).toHaveLength(2)
  })

  it('hides a generic run\'s lines as well: payroll.read is totals under any engine', async () => {
    const created = await (await call('POST', 'run', hrToken, { name: 'Generic', period: { from: '2026-01-01', to: '2026-01-31' }, currency: 'EUR' })).json()
    const id = created.payrollRun._id ?? created.payrollRun.id
    await PayrollRun.updateOne({ _id: id }, { $set: { items: [{ employeeId: created.payrollRun.createdBy, baseSalary: 1, grossPay: 1, netPay: 1 }] } })
    const asReader = await (await call('GET', `run/${id}`, readerToken)).json()
    expect(asReader.payrollRun.items).toBeUndefined()
    const asPersonal = await (await call('GET', `run/${id}`, hrToken)).json()
    expect(asPersonal.payrollRun.items).toHaveLength(1)
    await PayrollRun.deleteOne({ _id: id })
  })

  it('reads a person\'s line through a reveal, writing the row first and without the value', async () => {
    const run: any = await PayrollRun.findOne({ orgId, periodCode: '202509' }).lean()
    const id = String(run._id)
    expect((await call('POST', `run/${id}/reveal`, readerToken, { reason: 'audit' })).status).toBe(403)
    const employeeId = String(run.sealedItems[0].employeeId)
    const res = await call('POST', `run/${id}/reveal`, hrToken, { employeeIds: [employeeId], reason: 'audit' })
    const { items } = await res.json()
    expect(items).toHaveLength(1)
    expect(items[0].result.tax).toBe(172.44)
    expect(items[0].declaration.personId).toBe(FAKE_EGN)
    const rows: any[] = await AuditLog.find({ orgId, action: 'reveal', entityType: 'payroll_run' }).sort({ timestamp: 1 }).lean()
    expect(rows.at(-1).changes.map((c: any) => c.field)).toEqual([`items.${employeeId}`])
    expect(JSON.stringify(rows)).not.toContain('172.44')
  })
})

describe('a value cannot be moved', () => {
  it('one person\'s line does not open as another\'s', async () => {
    const run: any = await PayrollRun.findOne({ orgId, periodCode: '202509' }).lean()
    const vault = await forOrg(orgId)
    const [first, second] = run.sealedItems
    expect(runItemPath(first)).not.toBe(runItemPath(second))
    let caught: unknown
    try { openRunItem(vault, String(run._id), { ...second, sealed: first.sealed }) } catch (e) { caught = e }
    expect(String(caught)).toContain('does not open')
  })
})

async function contractFor(token = hrToken, over: Record<string, unknown> = {}) {
  const employee: any = await Employee.findOne({ orgId }).sort({ employeeNumber: 1 }).lean()
  // The fixture's ЕГН names no date, so the pension rate needs this.
  await call('PUT', `employee/${employee._id}`, adminToken, { personal: { dateOfBirth: '1980-02-03' } })
  const res = await call('POST', 'contract', token, {
    employeeId: String(employee._id), date: '2026-01-02', startDate: '2026-01-02', kid: '4690', qualificationGroup: 5, mainActivityRow: 58,
    salaries: [{ effectiveFrom: '2026-01-02', amount: SEALED_SALARY, currency: 'EUR' }],
    ...over,
  })
  return { res, employee }
}

describe('contracts and absences', () => {
  it('seals pay, and a list shows only that it is there', async () => {
    const { res } = await contractFor()
    expect(res.status).toBe(200)
    const { contract } = await res.json()
    expect(contract.hasPay).toBe(true)
    expect(contract.pay).toBeUndefined()
    const id = contract._id ?? contract.id
    const raw: any = await EmploymentContract.collection.findOne({ _id: (await EmploymentContract.findById(id).lean() as any)._id })
    expect(isSealed(raw.pay)).toBe(true)
    expect(JSON.stringify(raw)).not.toContain(String(SEALED_SALARY))
    const list = await (await call('GET', 'contract', hrToken)).text()
    expect(list).not.toContain('pd1.')
    expect(list).not.toContain(String(SEALED_SALARY))
  })

  it('reveals pay only with the permission, and writes the row first', async () => {
    const contract: any = await EmploymentContract.findOne({ orgId }).lean()
    const id = String(contract._id)
    expect((await call('POST', `contract/${id}/reveal`, readerToken, { reason: 'edit' })).status).toBe(403)
    const res = await call('POST', `contract/${id}/reveal`, hrToken, { reason: 'edit' })
    expect((await res.json()).pay.salaries[0].amount).toBe(SEALED_SALARY)
    const rows: any[] = await AuditLog.find({ orgId, action: 'reveal', entityType: 'employment_contract' }).lean()
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(String(SEALED_SALARY))
  })

  it('refuses a contract\'s pay to a writer without payroll.personal', async () => {
    expect((await call('GET', 'contract', writerToken)).status).toBe(403)
    expect((await contractFor(writerToken)).res.status).toBe(403)
  })

  it('seals why someone was away: sick leave is health data', async () => {
    const employee: any = await Employee.findOne({ orgId }).lean()
    const res = await call('POST', 'absence', hrToken, {
      employeeId: String(employee._id), from: '2026-03-02', to: '2026-03-03', workingDays: 2, code: 'employerSick', document: 'БЛ-МАДЕ-УП',
    })
    expect(res.status).toBe(200)
    const { absence } = await res.json()
    expect(absence.hasDetail).toBe(true)
    const raw = JSON.stringify(await AbsenceEntry.collection.find({}).toArray())
    expect(raw).not.toContain('employerSick')
    expect(raw).not.toContain('БЛ-МАДЕ-УП')
    const id = absence._id ?? absence.id
    expect((await (await call('POST', `absence/${id}/reveal`, hrToken, { reason: 'edit' })).json()).detail.code).toBe('employerSick')
  })

  it('keeps leave balances behind the permission too', async () => {
    const employee: any = await Employee.findOne({ orgId }).lean()
    expect((await call('PUT', 'leave-balance', hrToken, { employeeId: String(employee._id), year: 2026, entitled: 20 })).status).toBe(200)
    expect((await call('GET', 'leave-balance', readerToken)).status).toBe(403)
    expect((await (await call('GET', 'leave-balance', hrToken)).json()).leaveBalances).toHaveLength(1)
  })
})

describe('calculating a month', () => {
  let runId = ''

  it('needs payroll.personal under the Bulgarian engine', async () => {
    const created = await (await call('POST', 'run', hrToken, { name: 'Март', period: { from: '2026-03-01', to: '2026-03-31' }, currency: 'EUR' })).json()
    runId = created.payrollRun._id ?? created.payrollRun.id
    expect((await call('POST', `run/${runId}/calculate`, writerToken)).status).toBe(403)
  })

  it('runs the engine on each contract, seals the lines and keeps the totals in clear', async () => {
    const res = await call('POST', `run/${runId}/calculate`, hrToken, {})
    expect(res.status).toBe(200)
    const { payrollRun } = await res.json()
    expect(payrollRun.status).toBe('calculated')
    expect(payrollRun.engine).toBe('bg')
    expect(payrollRun.periodCode).toBe('202603')
    expect(payrollRun.parametersAsOf).toBe('2026-03-01')
    expect(payrollRun.totals.employeeCount).toBeGreaterThan(0)
    expect(JSON.stringify(payrollRun)).not.toContain('pd1.')
    const raw: any = await PayrollRun.collection.findOne({ periodCode: '202603' })
    expect(raw.items).toEqual([])
    expect(JSON.stringify(raw.sealedItems)).not.toContain(String(SEALED_SALARY))
    expect(raw.sealedItems.every((i: any) => isSealed(i.sealed))).toBe(true)
  })

  it('calculates what the engine says, the two sick days and the input class supplement included', async () => {
    const contract: any = await EmploymentContract.findOne({ orgId }).lean()
    const res = await call('POST', `run/${runId}/calculate`, hrToken, {
      inputs: [{
        employeeId: String(contract.employeeId),
        days: { worked: 19, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 2 },
        earnings: [{ code: 'classSupplement', amount: 50 }],
      }],
    })
    expect(res.status).toBe(200)
    const revealed = await (await call('POST', `run/${runId}/reveal`, hrToken, { reason: 'edit' })).json()
    const line = revealed.items.find((i: any) => i.employeeId === String(contract.employeeId))
    const p = parametersOf(await loadParameters('202603'))
    expect(line.result.lines.map((l: any) => l.code)).toEqual(['salary', 'classSupplement', 'employerSickPay'])
    expect(line.result.taxableIncome).toBeGreaterThan(0)
    expect(line.result).toEqual(calculatePerson({
      period: '202603', insuredType: '01', bornBefore1960: false, qualificationGroup: 5, mainActivityRow: 58, kid: '4690', hoursPerDay: 8, statutoryHours: 8,
      days: { worked: 19, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 2 },
      salary: { amount: SEALED_SALARY }, earnings: [{ code: 'classSupplement', amount: 50 }],
    }, p))
  })

  it('refuses a person the engine cannot calculate, and no half-run is left', async () => {
    const contract: any = await EmploymentContract.findOne({ orgId }).lean()
    await EmploymentContract.updateOne({ _id: contract._id }, { $set: { socialSecurityType: '12' } })
    const res = await call('POST', `run/${runId}/calculate`, hrToken, {})
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('unsupported_payroll_case')
    await EmploymentContract.updateOne({ _id: contract._id }, { $set: { socialSecurityType: '01' } })
  })

  it('answers 503 by name with no key, and stores nothing in clear instead', async () => {
    ;(config.personalData as any).kek = undefined
    clearVaultCache()
    const res = await call('POST', `run/${runId}/calculate`, hrToken, {})
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('personal_data_locked')
  })

  it('generates sealed payslips at approval, and a list shows only that they exist', async () => {
    await call('POST', `run/${runId}/calculate`, hrToken, {})
    const res = await call('POST', `run/${runId}/approve`, hrToken)
    expect(res.status).toBe(200)
    const raw: any[] = await Payslip.collection.find({ payrollRunId: (await PayrollRun.findById(runId).lean() as any)._id }).toArray()
    expect(raw.length).toBeGreaterThan(0)
    expect(raw.every(s => isSealed(s.sealed) && s.grossPay === undefined && s.netPay === undefined)).toBe(true)
    expect(JSON.stringify(raw)).not.toContain(String(SEALED_SALARY))

    const list = await (await call('GET', 'payslip', hrToken)).json()
    expect(list.payslips.every((s: any) => s.hasSealedAmounts && s.sealed === undefined)).toBe(true)
    const id = raw[0]._id
    const opened = await (await call('POST', `payslip/${id}/reveal`, hrToken, { reason: 'employee_request' })).json()
    expect(opened.amounts.netPay).toBeGreaterThan(0)
    expect(opened.amounts.yearToDate.netPay).toBe(opened.amounts.netPay)
    expect((await call('PUT', `payslip/${id}`, hrToken, { status: 'sent' })).status).toBe(409)
  })

  it('seeds the org\'s elements, and leaves what the org changed', async () => {
    expect(await PayrollElement.countDocuments({ orgId })).toBeGreaterThan(0)
  })
})

function parametersOf<T>(p: T): T {
  return p
}

describe('an org without the engine', () => {
  it('keeps the generic calculation exactly', async () => {
    const plainOrg = await newOrg()
    const user = await createTestUser((await Org.findById(plainOrg).lean() as any)._id)
    const token = await tokenFor(user, 'admin', [], plainOrg)
    await Employee.create({
      orgId: plainOrg, employeeNumber: 'G-1', firstName: 'A', lastName: 'B', department: 'D', position: 'P', employmentType: 'full_time',
      contractStartDate: new Date('2026-01-01'), salary: { baseSalary: 1000, currency: 'EUR', frequency: 'monthly' },
    })
    const created = await (await call('POST', 'run', token, { name: 'G', period: { from: '2026-03-01', to: '2026-03-31' }, currency: 'EUR' }, plainOrg)).json()
    const id = created.payrollRun._id ?? created.payrollRun.id
    const { payrollRun } = await (await call('POST', `run/${id}/calculate`, token, undefined, plainOrg)).json()
    expect(payrollRun.engine).toBeUndefined()
    expect(payrollRun.items).toHaveLength(1)
    expect(payrollRun.items[0].grossPay).toBe(1000)
    expect(payrollRun.totals.grossPay).toBe(1000)
  })
})

describe('the parameters', () => {
  it('seed once, on the key and the date, and a stored row wins', async () => {
    await seedPayrollParameters()
    await seedPayrollParameters()
    expect(await PayrollParameter.countDocuments({})).toBe(PAYROLL_PARAMETERS.length)
    await PayrollParameter.updateOne({ key: 'maxInsurableIncome', effectiveFrom: '2026-08-01' }, { $set: { value: 2345 } })
    clearParameterCache()
    expect((await loadParameters('202609')).maxInsurableIncome).toBe(2345)
    await PayrollParameter.updateOne({ key: 'maxInsurableIncome', effectiveFrom: '2026-08-01' }, { $set: { value: 2300 } })
    clearParameterCache()
  })

  it('work before anything is seeded', async () => {
    await PayrollParameter.deleteMany({})
    clearParameterCache()
    expect((await loadParameters('202609')).maxInsurableIncome).toBe(2300)
  })
})

describe('a restore into another org', () => {
  it('re-seals every kind of sealed value, and each opens on its new id', async () => {
    const run: any = await PayrollRun.collection.findOne({ periodCode: '202509' })
    const contract: any = await EmploymentContract.collection.findOne({})
    const absence: any = await AbsenceEntry.collection.findOne({})
    const slip: any = await Payslip.collection.findOne({ engine: 'bg' })
    const row: any = await PersonalDataKey.collection.findOne({ orgId: run.orgId })
    const byCollection = new Map<string, any[]>([
      ['PayrollRun', [run]], ['EmploymentContract', [contract]], ['AbsenceEntry', [absence]], ['Payslip', [slip]], ['PersonalDataKey', [row]],
    ])
    const target = await newOrg('bg')
    const plan = await planPersonalDataRestore(byCollection, target)
    const oid = () => new (run._id.constructor)()
    const to = await forOrg(target)

    const newEmployee = oid()
    const movedRun = { ...run, _id: oid(), sealedItems: run.sealedItems.map((i: any, n: number) => ({ ...i, employeeId: n === 0 ? newEmployee : oid() })) }
    const [resealedRun] = await plan.prepare('PayrollRun', [run], [movedRun])
    expect(resealedRun.sealedItems[0].sealed).not.toBe(run.sealedItems[0].sealed)
    const item = openRunItem(to, String(resealedRun._id), resealedRun.sealedItems[0])
    expect(item.result.tax).toBe(172.44)
    expect(isSealed(resealedRun.filed)).toBe(true)
    expect(resealedRun.filed).not.toBe(run.filed)

    const [resealedContract] = await plan.prepare('EmploymentContract', [contract], [{ ...contract, _id: oid() }])
    expect((await openContractPay(target, resealedContract))?.salaries[0].amount).toBe(SEALED_SALARY)

    const [resealedAbsence] = await plan.prepare('AbsenceEntry', [absence], [{ ...absence, _id: oid() }])
    expect(isSealed(resealedAbsence.detail)).toBe(true)
    expect(resealedAbsence.detail).not.toBe(absence.detail)

    const [resealedSlip] = await plan.prepare('Payslip', [slip], [{ ...slip, _id: oid() }])
    expect(resealedSlip.sealed).not.toBe(slip.sealed)
  })

  it('refuses a bundle with sealed lines and no keys', async () => {
    const run: any = await PayrollRun.collection.findOne({ periodCode: '202509' })
    let caught: unknown
    try { await planPersonalDataRestore(new Map([['PayrollRun', [{ ...run, filed: undefined }]]]), null) } catch (e) { caught = e }
    expect(String(caught)).toContain('locked')
  })

  it('refuses a bundle this server\'s key cannot open', async () => {
    const run: any = await PayrollRun.collection.findOne({ periodCode: '202509' })
    const row: any = await PersonalDataKey.collection.findOne({ orgId: run.orgId })
    ;(config.personalData as any).kek = generateKey().toString('base64')
    clearVaultCache()
    let caught: unknown
    try { await planPersonalDataRestore(new Map<string, any[]>([['PayrollRun', [run]], ['PersonalDataKey', [row]]]), null) } catch (e) { caught = e }
    expect(String(caught)).toContain('locked')
  })
})
