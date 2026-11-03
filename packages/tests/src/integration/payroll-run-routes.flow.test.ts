import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { createTestEmployee, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { mongoose } from 'db/connection'
import { AuditLog, Employee, Org, PayrollRun, Payslip } from 'db/models'
import { approvePayroll } from 'services/biz/payroll.service'
import { getRepos } from 'services/context'

/**
 * The routes the payroll screens call run the one calculation (FR-25 R0 #9).
 *
 * There were two: `/calculate` worked out its own figures, with no employer contributions, and only
 * tests called `calculatePayroll`, so the suite passed on code nobody ran. `/approve` flipped a
 * status and never called `approvePayroll`, so approving a run in the UI made no payslips.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia

async function makeWorld() {
  const org = await createTestOrg({ settings: {
    baseCurrency: 'EUR', fiscalYearStart: 1, dateFormat: 'DD.MM.YYYY', timezone: 'Europe/Berlin', locale: 'en',
    taxConfig: { vatEnabled: true, defaultVatRate: 18, vatRates: [{ name: 'Standard', rate: 18 }], taxIdLabel: 'VAT ID' },
    payroll: { payFrequency: 'monthly', socialSecurityRate: 10, healthInsuranceRate: 5, pensionRate: 0 },
    modules: [],
  } } as any)
  const orgId = String(org._id)
  const tokens: Record<string, string> = {}
  let admin: any
  for (const role of ['admin', 'hr_manager', 'manager'] as Role[]) {
    const user = await createTestUser(org._id, { role } as any)
    if (role === 'admin') admin = user
    tokens[role] = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId, role, email: String(user.email), username: role, firstName: 'P', lastName: 'R',
      permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
    })
  }
  const employee = await createTestEmployee(org._id, {
    salary: { baseSalary: 1000, currency: 'EUR', frequency: 'monthly' },
    deductions: [{ type: 'tax', name: 'Income tax', percentage: 10 }],
  } as any)

  const call = async (method: string, rest: string, body?: unknown, role = 'admin') => {
    const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/payroll/run${rest}`, {
      method,
      headers: { authorization: `Bearer ${tokens[role]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
    let json: any = null
    try { json = await res.json() } catch { /* not json */ }
    return { status: res.status, json }
  }
  const newRun = async () => (await call('POST', '', {
    name: 'A month of fictional work', period: { from: '2026-01-01', to: '2026-01-31' }, currency: 'EUR',
  })).json.payrollRun
  const calculatedRun = async () => {
    const run = await newRun()
    return (await call('POST', `/${run.id}/calculate`)).json.payrollRun
  }

  return { org, orgId, admin, tokens, employee, call, newRun, calculatedRun }
}

/** Audit entries are written after the response: wait for the row, and fail if it never comes. */
async function auditRow(orgId: string, entityId: string, action: string) {
  for (let i = 0; i < 50; i++) {
    // As `createAuditEntry` stores it: an id as an ObjectId.
    const row = await AuditLog.findOne({ orgId, entityId: new mongoose.Types.ObjectId(entityId), action }).lean()
    if (row) return row
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return null
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('POST /run/:id/calculate', () => {
  it('runs the service\'s calculation: gross, deductions, net, and the employer\'s contributions', async () => {
    const w = await makeWorld()
    const run = await w.newRun()

    const { status, json } = await w.call('POST', `/${run.id}/calculate`)

    expect(status).toBe(200)
    expect(json.payrollRun.status).toBe('calculated')
    expect(json.payrollRun.items).toHaveLength(1)
    const item = json.payrollRun.items[0]
    expect(item.employeeId).toBe(String(w.employee._id))
    expect(item.grossPay).toBe(1000)
    expect(item.totalDeductions).toBe(100)
    expect(item.netPay).toBe(900)
    // The figures the route used to leave out: 10% + 5%, and a zero rate is no line at all.
    expect(item.employerContributions.map((c: any) => [c.type, c.amount])).toEqual([['social_security', 100], ['health_insurance', 50]])
    expect(item.totalEmployerCost).toBe(1150)
    expect(json.payrollRun.totals).toEqual({ grossPay: 1000, totalDeductions: 100, netPay: 900, totalEmployerCost: 1150, employeeCount: 1 })
  })

  it('counts this org\'s active employees and nobody else', async () => {
    const w = await makeWorld()
    const other = await makeWorld()
    await createTestEmployee(w.org._id, { status: 'terminated', salary: { baseSalary: 9999, currency: 'EUR', frequency: 'monthly' }, deductions: [] } as any)

    const { json } = await w.call('POST', `/${(await w.newRun()).id}/calculate`)

    expect(json.payrollRun.items.map((i: any) => i.employeeId)).toEqual([String(w.employee._id)])
    expect(String(other.employee._id)).not.toBe(String(w.employee._id))
  })

  it('recalculates a calculated run, as the screen lets it, from the salaries as they are now', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()
    await Employee.updateOne({ _id: w.employee._id }, { $set: { 'salary.baseSalary': 2000 } })

    const { status, json } = await w.call('POST', `/${run.id}/calculate`)

    expect(status).toBe(200)
    expect(json.payrollRun.status).toBe('calculated')
    expect(json.payrollRun.items).toHaveLength(1)
    expect(json.payrollRun.items[0].grossPay).toBe(2000)
    expect(json.payrollRun.totals.netPay).toBe(1800)
  })

  it('refuses a run past that with 400, and leaves it as it was', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()
    await w.call('POST', `/${run.id}/approve`)
    await Employee.updateOne({ _id: w.employee._id }, { $set: { 'salary.baseSalary': 2000 } })

    const { status } = await w.call('POST', `/${run.id}/calculate`)

    expect(status).toBe(400)
    expect((await PayrollRun.findById(run.id).lean() as any).items[0].grossPay).toBe(1000)
  })

  it('answers 404 for another org\'s run', async () => {
    const w = await makeWorld()
    const other = await makeWorld()
    const theirs = await other.newRun()

    expect((await w.call('POST', `/${theirs.id}/calculate`)).status).toBe(404)
    expect((await PayrollRun.findById(theirs.id).lean() as any).status).toBe('draft')
  })

  it('works for an org and an employee stored without the optional parts', async () => {
    const w = await makeWorld()
    await Org.updateOne({ _id: w.org._id }, { $unset: { 'settings.payroll': 1 } })
    await Employee.collection.updateOne({ _id: w.employee._id }, { $unset: { deductions: 1 } })

    const { status, json } = await w.call('POST', `/${(await w.newRun()).id}/calculate`)

    expect(status).toBe(200)
    const item = json.payrollRun.items[0]
    expect(item.employerContributions).toEqual([])
    expect(item.totalEmployerCost).toBe(1000)
    expect(item.netPay).toBe(1000)
  })

  it('keeps its audit entry', async () => {
    const w = await makeWorld()
    const run = await w.newRun()

    await w.call('POST', `/${run.id}/calculate`)

    expect(await auditRow(w.orgId, run.id, 'calculate')).not.toBeNull()
  })
})

describe('POST /run/:id/approve', () => {
  it('generates the payslips, where it used to generate none', async () => {
    const w = await makeWorld()
    await createTestEmployee(w.org._id, { salary: { baseSalary: 3000, currency: 'EUR', frequency: 'monthly' }, deductions: [] } as any)
    const run = await w.calculatedRun()

    const { status, json } = await w.call('POST', `/${run.id}/approve`)

    expect(status).toBe(200)
    expect(json.payrollRun.status).toBe('approved')
    expect(json.payrollRun.approvedBy).toBe(String(w.admin._id))

    const slips = await Payslip.find({ orgId: w.org._id, payrollRunId: run.id }).lean() as any[]
    expect(slips).toHaveLength(2)
    const slip = slips.find(s => String(s.employeeId) === String(w.employee._id))
    expect(slip.grossPay).toBe(1000)
    expect(slip.totalDeductions).toBe(100)
    expect(slip.netPay).toBe(900)
    expect(slip.status).toBe('generated')
    expect(slip.earnings[0]).toMatchObject({ type: 'base_salary', amount: 1000 })
    expect(slip.deductions[0]).toMatchObject({ type: 'tax', description: 'Income tax', amount: 100 })
  })

  it('writes them in one batch, not one insert per person', async () => {
    const w = await makeWorld()
    for (let i = 0; i < 4; i++) {
      await createTestEmployee(w.org._id, { salary: { baseSalary: 1000 + i, currency: 'EUR', frequency: 'monthly' }, deductions: [] } as any)
    }
    const run = await w.calculatedRun()
    const batch = spyOn(Payslip, 'insertMany')
    const single = spyOn(Payslip, 'create')
    try {
      await w.call('POST', `/${run.id}/approve`)
      expect(batch).toHaveBeenCalledTimes(1)
      expect(single).not.toHaveBeenCalled()
    } finally {
      batch.mockRestore()
      single.mockRestore()
    }
    expect(await Payslip.countDocuments({ payrollRunId: run.id })).toBe(5)
  })

  it('approving twice makes them once', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()

    await w.call('POST', `/${run.id}/approve`)
    const again = await w.call('POST', `/${run.id}/approve`)

    expect(again.status).toBe(400)
    expect(await Payslip.countDocuments({ payrollRunId: run.id })).toBe(1)
  })

  it('two approvals at once make them once too', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()

    const answers = await Promise.all([w.call('POST', `/${run.id}/approve`), w.call('POST', `/${run.id}/approve`)])

    expect(answers.map(a => a.status).sort()).toEqual([200, 400])
    expect(await Payslip.countDocuments({ payrollRunId: run.id })).toBe(1)
  })

  it('refuses a run not calculated yet, and answers 404 for another org\'s', async () => {
    const w = await makeWorld()
    const other = await makeWorld()
    const draft = await w.newRun()
    const theirs = await other.calculatedRun()

    expect((await w.call('POST', `/${draft.id}/approve`)).status).toBe(400)
    expect((await w.call('POST', `/${theirs.id}/approve`)).status).toBe(404)
    expect(await Payslip.countDocuments({ payrollRunId: { $in: [draft.id, theirs.id] } })).toBe(0)
  })

  it('still asks for the same roles', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()

    expect((await w.call('POST', `/${run.id}/approve`, undefined, 'manager')).status).toBe(403)
    expect((await w.call('POST', `/${run.id}/approve`, undefined, 'hr_manager')).status).toBe(200)
  })

  it('keeps its audit entry', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()

    await w.call('POST', `/${run.id}/approve`)

    expect(await auditRow(w.orgId, run.id, 'approve')).not.toBeNull()
  })

  it('a batch that fails leaves the run calculated and no payslips, so it can be approved again', async () => {
    const w = await makeWorld()
    const run = await w.calculatedRun()
    const real = getRepos()
    const payslips = Object.create(real.payslips)
    payslips.createMany = async () => { throw new Error('the database is having a moment') }

    expectRejection(await captureRejection(approvePayroll(run.id, String(w.admin._id), { ...real, payslips })), 'having a moment')

    const after = await PayrollRun.findById(run.id).lean() as any
    expect(after.status).toBe('calculated')
    expect(after.approvedBy ?? null).toBeNull()
    expect(after.approvedAt ?? null).toBeNull()
    expect(await Payslip.countDocuments({ payrollRunId: run.id })).toBe(0)

    expect((await w.call('POST', `/${run.id}/approve`)).status).toBe(200)
    expect(await Payslip.countDocuments({ payrollRunId: run.id })).toBe(1)
  })
})
