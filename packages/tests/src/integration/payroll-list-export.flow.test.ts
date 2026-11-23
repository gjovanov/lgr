import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestEmployee, createTestOrg, createTestPayrollRun, createTestPayslip, createTestTimesheet, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, Org, Payslip, Role, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { forOrg } from 'services/biz/personal-data/personal-data.service'
import type { CapabilityId } from 'config/access'

/**
 * #830: the payroll lists' Export (Employees, Payroll runs, Payslips, Timesheets) and a payslip's PDF, over the real
 * route table.
 *
 * - An export applies the list's filters, and needs what reading the list needs.
 * - It prints no pay of a person and nothing sealed: not an employee's base salary or masked ЕГН, not a payslip's
 *   amounts, not a run's lines.
 * - A sealed payslip's PDF is a reveal: `payroll-people.reveal`, a reason, and the audit row `/reveal` writes. One of
 *   the generic run prints on the list's own permission and writes no such row.
 *
 * Made-up people and round amounts nobody earns.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

const SALARY = 4321.5
const MASK = '******0014'
const GROSS = 1234.56
const NET = 987.65
const SEALED_NET = 1551.96

async function call(method: string, path: string, token: string, body?: unknown) {
  return app.handle(new Request(`http://localhost/api/org/${orgId}/payroll/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}

/** Every cell of the workbook's first sheet, as text, row by row. */
async function sheetRows(res: Response): Promise<string[][]> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(await res.arrayBuffer())
  const rows: string[][] = []
  book.worksheets[0].eachRow(row => {
    const values = (row.values as unknown[]).slice(1).map(v => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v)))
    rows.push(values)
  })
  return rows
}

const dataRows = (rows: string[][], firstHeader: string) => rows.slice(rows.findIndex(r => r[0] === firstHeader) + 1)

async function giveRole(key: string, caps: CapabilityId[]) {
  const role: any = await Role.create({ orgId: org._id, name: `Payroll export ${key}`, caps, isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: [] } } as any)
  await User.updateOne({ _id: people[key]._id }, { $set: { roleId: role._id } }).exec()
  forgetMember(people[key]._id)
  forgetRole(role._id)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'payroll-list-export' } as any)
  orgId = String(org._id)
  for (const key of ['admin', 'clerk', 'revealer', 'runsReader']) {
    people[key] = await createTestUser(org._id, { role: key === 'admin' ? 'admin' : 'member', username: `pe-${key}`, email: `${key}@payroll-export.test` } as any)
  }
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  // Reads the people's lists, and a payslip that is not sealed; no reveal.
  await giveRole('clerk', ['payroll-people.view'])
  // The same, and `payroll.personal`'s reveal.
  await giveRole('revealer', ['payroll-people.view', 'payroll-people.reveal'])
  // A run's totals, and nobody's line (FR-25 §3.11).
  await giveRole('runsReader', ['payroll-runs.view'])
  for (const key of Object.keys(people)) tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!))

  const ana = await createTestEmployee(org._id, {
    employeeNumber: 'PE-001', firstName: 'Ana', lastName: 'Primerova', department: 'Sales', nationalIdMask: MASK,
    salary: { baseSalary: SALARY, currency: 'EUR', frequency: 'monthly' },
  } as any)
  const boris = await createTestEmployee(org._id, { employeeNumber: 'PE-002', firstName: 'Boris', lastName: 'Obrazcov', department: 'Warehouse' } as any)
  ids.ana = String(ana._id)
  ids.boris = String(boris._id)

  const january = { from: new Date('2026-01-01'), to: new Date('2026-01-31') }
  const approved = await createTestPayrollRun(org._id, people.admin._id as any, {
    name: 'January approved', status: 'approved', period: january,
    totals: { grossPay: 2000, totalDeductions: 300, netPay: 1700, totalEmployerCost: 2400, employeeCount: 2 },
  } as any)
  await createTestPayrollRun(org._id, people.admin._id as any, { name: 'February draft', status: 'draft' } as any)
  ids.run = String(approved._id)

  const plain = await createTestPayslip(org._id, approved._id as any, ana._id as any, { period: january, grossPay: GROSS, totalDeductions: GROSS - NET, netPay: NET, earnings: [{ type: 'base', description: 'Salary', amount: GROSS }] } as any)
  await createTestPayslip(org._id, approved._id as any, boris._id as any, { period: january } as any)
  ids.plainSlip = String(plain._id)

  // A payslip of the Bulgarian engine: its amounts live sealed, bound to its id (FR-25 §3.12).
  const sealedId = new mongoose.Types.ObjectId()
  const vault = await forOrg(orgId)
  await Payslip.create({
    _id: sealedId, orgId: org._id, payrollRunId: approved._id, employeeId: boris._id, period: january, engine: 'bg',
    earnings: [], deductions: [], totalDeductions: 0, paymentMethod: 'bank_transfer', status: 'generated',
    sealed: vault.seal('Payslip', String(sealedId), 'sealed', {
      earnings: [{ type: 'salary', description: 'Заплата', amount: 2000 }],
      deductions: [{ type: 'tax', description: 'ДОД', amount: 448.04 }],
      grossPay: 2000, totalDeductions: 448.04, netPay: SEALED_NET,
      yearToDate: { grossPay: 2000, totalDeductions: 448.04, netPay: SEALED_NET },
    }),
  })
  ids.sealedSlip = String(sealedId)

  await createTestTimesheet(org._id, ana._id as any, { date: new Date('2026-01-05'), hoursWorked: 8, description: 'Stocktake' } as any)
  await createTestTimesheet(org._id, ana._id as any, { date: new Date('2026-02-10'), hoursWorked: 6 } as any)
  await createTestTimesheet(org._id, boris._id as any, { date: new Date('2026-01-06'), hoursWorked: 7.5 } as any)
}, 120_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('GET /payroll/employee/export', () => {
  it('applies the list\'s filters, and prints no pay and no identifier', async () => {
    const res = await call('GET', 'employee/export?format=xlsx&department=Sales', tokens.clerk)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    const rows = await sheetRows(res)
    const data = dataRows(rows, 'Employee number')
    expect(data.map(r => r[0])).toEqual(['PE-001'])
    expect(data[0][1]).toBe('Ana Primerova')
    const text = JSON.stringify(rows)
    expect(text).not.toContain(String(SALARY))
    expect(text).not.toContain('4321')
    expect(text).not.toContain(MASK)
  })

  it('finds by the search as the list does, and takes the screen\'s words for its headings', async () => {
    const labels = JSON.stringify({ title: 'Служители', columns: { employeeNumber: 'Номер' } })
    const res = await call('GET', `employee/export?search=Obrazcov&labels=${encodeURIComponent(labels)}`, tokens.clerk)
    const rows = await sheetRows(res)
    expect(rows[0][0]).toBe('Служители')
    expect(dataRows(rows, 'Номер').map(r => r[0])).toEqual(['PE-002'])
  })

  it('needs what the list needs: a role that reads only runs gets 403', async () => {
    expect((await call('GET', 'employee', tokens.runsReader)).status).toBe(403)
    expect((await call('GET', 'employee/export', tokens.runsReader)).status).toBe(403)
  })

  it('prints a PDF in the house style', async () => {
    const res = await call('GET', 'employee/export?format=pdf&department=Sales', tokens.clerk)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
  }, 60_000)
})

describe('GET /payroll/run/export', () => {
  it('a role that reads runs exports them, filtered, with their totals and nobody\'s line', async () => {
    const res = await call('GET', 'run/export?status=approved', tokens.runsReader)
    expect(res.status).toBe(200)
    const data = dataRows(await sheetRows(res), 'Name')
    const runs = data.filter(r => r[0] !== 'Total')
    expect(runs.map(r => r[0])).toEqual(['January approved'])
    expect(runs[0]).toContain('1700')
    expect(data.find(r => r[0] === 'Total')).toBeTruthy()
  })

  it('needs the runs\' read: a role that reads only the people gets 403', async () => {
    expect((await call('GET', 'run/export', tokens.clerk)).status).toBe(403)
  })
})

describe('GET /payroll/payslip/export', () => {
  it('finds the employee by the search, and prints whose payslip and which month, never an amount', async () => {
    const res = await call('GET', 'payslip/export?search=Primerova', tokens.clerk)
    expect(res.status).toBe(200)
    const rows = await sheetRows(res)
    const data = dataRows(rows, 'Employee')
    expect(data.map(r => r[0])).toEqual(['Ana Primerova'])
    const text = JSON.stringify(rows)
    expect(text).not.toContain(String(GROSS))
    expect(text).not.toContain(String(NET))
  })

  it('lists a sealed payslip with nothing of what it seals', async () => {
    const res = await call('GET', 'payslip/export?search=Obrazcov', tokens.revealer)
    const rows = await sheetRows(res)
    expect(dataRows(rows, 'Employee')).toHaveLength(2)
    const text = JSON.stringify(rows)
    expect(text).not.toContain(String(SEALED_NET))
    expect(text).not.toContain('pd1.')
  })

  it('the list\'s own search finds the employee too: the list and its export agree', async () => {
    const list = await (await call('GET', 'payslip?search=Primerova', tokens.clerk)).json()
    expect(list.payslips.map((s: any) => String(s.employeeId))).toEqual([ids.ana])
  })

  it('needs the people\'s read', async () => {
    expect((await call('GET', 'payslip/export', tokens.runsReader)).status).toBe(403)
  })
})

describe('GET /payroll/timesheet/export', () => {
  it('applies the employee and the days the list is filtered by', async () => {
    const res = await call('GET', `timesheet/export?employeeId=${ids.ana}&dateFrom=2026-01-01&dateTo=2026-01-31`, tokens.clerk)
    expect(res.status).toBe(200)
    const data = dataRows(await sheetRows(res), 'Employee')
    const entries = data.filter(r => r[0] !== 'Total')
    expect(entries).toHaveLength(1)
    expect(entries[0][0]).toBe('Ana Primerova')
    expect(entries[0][1]).toBe('2026-01-05')
    expect(entries[0]).toContain('Stocktake')
  })

  it('and the list shows the same rows', async () => {
    const list = await (await call('GET', `timesheet?employeeId=${ids.ana}&dateFrom=2026-01-01&dateTo=2026-01-31`, tokens.clerk)).json()
    expect(list.timesheets).toHaveLength(1)
  })

  it('needs the people\'s read', async () => {
    expect((await call('GET', 'timesheet/export', tokens.runsReader)).status).toBe(403)
  })
})

describe('POST /payroll/payslip/:id/pdf', () => {
  const revealRows = (id: string) => AuditLog.countDocuments({ orgId, entityType: 'payslip', entityId: new mongoose.Types.ObjectId(id), action: 'reveal' })

  it('prints a payslip of the generic run on the list\'s permission, and records no reveal', async () => {
    const res = await call('POST', `payslip/${ids.plainSlip}/pdf`, tokens.clerk, { labels: { title: 'Фиш' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    expect(await revealRows(ids.plainSlip)).toBe(0)
  }, 60_000)

  it('refuses a role that does not read the people', async () => {
    expect((await call('POST', `payslip/${ids.plainSlip}/pdf`, tokens.runsReader, {})).status).toBe(403)
  })

  it('a sealed payslip needs payroll.personal: 403 without it, and nothing recorded', async () => {
    const res = await call('POST', `payslip/${ids.sealedSlip}/pdf`, tokens.clerk, { reason: 'employee_request' })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('permission_required')
    expect(await revealRows(ids.sealedSlip)).toBe(0)
  })

  it('a sealed payslip prints with a reason, and only with one', async () => {
    const res = await call('POST', `payslip/${ids.sealedSlip}/pdf`, tokens.revealer, {})
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('reason_required')
    expect(await revealRows(ids.sealedSlip)).toBe(0)
  })

  it('prints a sealed payslip for payroll.personal, and writes the reveal\'s audit row: the reason, never the value', async () => {
    const res = await call('POST', `payslip/${ids.sealedSlip}/pdf`, tokens.revealer, { reason: 'employee_request' })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    const row: any = await AuditLog.findOne({ orgId, entityType: 'payslip', entityId: new mongoose.Types.ObjectId(ids.sealedSlip), action: 'reveal' }).lean()
    expect(row).toBeTruthy()
    expect(row.module).toBe('payroll')
    expect(String(row.userId)).toBe(String(people.revealer._id))
    expect(row.changes).toHaveLength(1)
    expect(row.changes[0]).toMatchObject({ field: 'sealed.pdf', oldValue: 'employee_request', newValue: '[REDACTED]' })
    expect(JSON.stringify(row)).not.toContain(String(SEALED_NET))
  }, 60_000)

  it('answers 404 for a payslip that is not there', async () => {
    expect((await call('POST', `payslip/${new mongoose.Types.ObjectId()}/pdf`, tokens.admin, {})).status).toBe(404)
  })
})
