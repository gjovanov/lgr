import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestAccount, createTestBankAccount, createTestContact, createTestEmployee, createTestOrg, createTestPaymentOrder, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { FixedAsset, PaymentOrder, Timesheet } from 'db/models'

/**
 * #675 — each screen's own payload, sent to its route as the screen sends it:
 *   - Fixed assets → New: the model's fields (purchase date and price, useful life in months, the three accounts,
 *     `straight_line`), where the form sent names the model does not have and answered 500.
 *   - Exchange rates → New: `source` is the model's `manual` / `api`, where a free-text box answered 500.
 *   - Timesheets: the model's lower-case values and `overtimeHours`, where `Regular` / `Draft` answered 500.
 * And on the server:
 *   - a PUT of a route that stores the body runs the model's validators: `status: 'Approved'` is refused, not stored;
 *   - executing a payment order keeps who executed it.
 *
 * NOTE: no `.rejects` / `.resolves` (Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: any
let orgId = ''
let userId = ''
let token = ''
const accounts: string[] = []
let employeeId = ''

async function call(method: string, path: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  const org = await createTestOrg({ slug: 'form-payloads' } as any)
  orgId = String(org._id)
  const user = await createTestUser(org._id, { role: 'admin', email: 'admin@form-payloads.test' } as any)
  userId = String(user._id)
  token = await (signer as any).decorator.jwt.sign({
    id: userId, orgId, email: 'admin@form-payloads.test', username: 'forms', firstName: 'F', lastName: 'P',
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  for (const [code, name] of [['204', 'Equipment'], ['603', 'Depreciation expense'], ['241', 'Accumulated depreciation']]) {
    accounts.push(String((await createTestAccount(org._id, { code, name } as any))._id))
  }
  employeeId = String((await createTestEmployee(org._id))._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('Fixed assets → New, as the form sends it', () => {
  // `FixedAssetFormView#payload`: useful life entered in years, stored in months; the book value starts at the price.
  const payload = () => ({
    code: 'FA-001', name: 'Forklift', category: 'Machinery', purchaseDate: '2026-11-01', purchasePrice: 12_000,
    salvageValue: 1_200, usefulLifeMonths: 60, depreciationMethod: 'straight_line', status: 'active',
    accountId: accounts[0], depreciationAccountId: accounts[1], accumulatedDepAccountId: accounts[2], currentValue: 12_000,
  })

  it('saves, and an edit of its own fields saves too', async () => {
    const created = await call('POST', '/accounting/fixed-asset', payload())
    expect(created.status).toBe(200)
    const id = String(created.json.fixedAsset?._id ?? created.json.fixedAsset?.id)
    const stored: any = await FixedAsset.findById(id).lean().exec()
    expect(stored).toMatchObject({ usefulLifeMonths: 60, depreciationMethod: 'straight_line', currentValue: 12_000 })

    const { currentValue: _kept, ...edit } = payload()
    const updated = await call('PUT', `/accounting/fixed-asset/${id}`, { ...edit, name: 'Forklift 2' })
    expect(updated.status).toBe(200)
    expect(((await FixedAsset.findById(id).lean().exec()) as any).currentValue).toBe(12_000)
  })

  it('the names the form used to send are refused on an edit too, no longer stored', async () => {
    const created = await call('POST', '/accounting/fixed-asset', { ...payload(), code: 'FA-002' })
    const id = String(created.json.fixedAsset?._id ?? created.json.fixedAsset?.id)
    const r = await call('PUT', `/accounting/fixed-asset/${id}`, { depreciationMethod: 'straight-line' })
    expect(r.status).toBe(500)
    expect(r.json.message).toContain('"depreciationMethod" is not one of the allowed values')
    expect(((await FixedAsset.findById(id).lean().exec()) as any).depreciationMethod).toBe('straight_line')
  })
})

describe('Exchange rates → New, as the form sends it', () => {
  it("saves with the form's default source", async () => {
    const r = await call('POST', '/accounting/exchange-rate', { fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92, date: '2026-11-11', source: 'manual' })
    expect(r.status).toBe(200)
  })
})

describe('Timesheets, as the form sends them', () => {
  it('a new one saves with the lower-case values and keeps its overtime', async () => {
    const r = await call('POST', '/payroll/timesheet', { employeeId, date: '2026-11-10', hoursWorked: 8, overtimeHours: 2, type: 'regular', status: 'submitted' })
    expect(r.status).toBe(200)
    const id = String(r.json.timesheet?._id ?? r.json.timesheet?.id)
    expect(await Timesheet.findById(id).lean().exec()).toMatchObject({ overtimeHours: 2, type: 'regular', status: 'submitted' })
  })

  it('an edit validates: a value the model does not have is refused, not stored', async () => {
    const r = await call('POST', '/payroll/timesheet', { employeeId, date: '2026-11-09', hoursWorked: 8, type: 'regular', status: 'submitted' })
    const id = String(r.json.timesheet?._id ?? r.json.timesheet?.id)
    const wrong = await call('PUT', `/payroll/timesheet/${id}`, { status: 'Approved' })
    expect(wrong.status).toBe(500)
    expect(wrong.json.message).toContain('"status" is not one of the allowed values')
    expect(((await Timesheet.findById(id).lean().exec()) as any).status).toBe('submitted')
    const right = await call('PUT', `/payroll/timesheet/${id}`, { status: 'approved' })
    expect(right.status).toBe(200)
    expect(((await Timesheet.findById(id).lean().exec()) as any).status).toBe('approved')
  })
})

describe('Payment orders: who executed one is kept', () => {
  it('executedBy is stored with executedAt', async () => {
    const org = await createTestOrg({ slug: 'form-payloads-po' } as any)
    const bank = await createTestBankAccount(org._id)
    const contact = await createTestContact(org._id, { companyName: 'Supplier' } as any)
    const order = await createTestPaymentOrder(org._id, contact._id as any, bank._id as any, { status: 'approved' } as any)
    // A member of the order's org: `executedBy` is a reference, and #641's guard keeps references inside the org.
    const executor = await createTestUser(org._id, { role: 'admin', email: 'admin@form-payloads-po.test' } as any)
    const tokenB = await (signer as any).decorator.jwt.sign({
      id: String(executor._id), orgId: String(org._id), email: 'admin@form-payloads-po.test', username: 'forms-po', firstName: 'F', lastName: 'P',
      role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    const res = await app.handle(new Request(`http://localhost/api/org/${String(org._id)}/invoicing/payment-order/${String(order._id)}/execute`, {
      method: 'POST', headers: { authorization: `Bearer ${tokenB}` },
    }))
    expect({ status: res.status, body: res.status === 200 ? '' : await res.text() }).toEqual({ status: 200, body: '' })
    const stored: any = await PaymentOrder.findById(order._id).lean().exec()
    expect(stored.status).toBe('executed')
    expect(String(stored.executedBy)).toBe(String(executor._id))
  })
})
