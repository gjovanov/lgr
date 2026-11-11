import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse, createTestAccount,
  createTestBankAccount, createTestEmployee, createTestFiscalYear, createTestPayrollRun, createTestStockLevel,
} from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import {
  BankAccount, ExchangeRate, FiscalPeriod, FiscalYear, FixedAsset, BankReconciliation, CashOrder, PaymentOrder,
  Payslip, Timesheet, InventoryCount, PriceList, StockLevel, StockMovement, Warehouse,
} from 'db/models'
import { SERVER_OWNED, type OwnedModel } from 'services/biz/server-owned'

/**
 * The twelve controllers that store a body as the document, over their real routes.
 *
 * A body gives the fields that are its own. A field the server sets (a number, an actor, a
 * lifecycle step, a seal, a ledger link, a timestamp) it may restate, never choose: 422
 * `server_owned_field`, and nothing is written. What each screen sends still saves.
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: any
let w: Awaited<ReturnType<typeof world>>

const oid = () => String(new mongoose.Types.ObjectId())
const id = (d: any) => String(d?._id ?? d?.id)
let seq = 0
const n = () => ++seq

async function world() {
  const A = await createTestOrg({ slug: 'owned-a' } as any)
  const B = await createTestOrg({ slug: 'owned-b' } as any)
  const user = await createTestUser(A._id, { role: 'admin', email: 'admin@owned-a.test' } as any)
  const other = await createTestUser(A._id, { role: 'member', email: 'other@owned-a.test' } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(A._id), email: 'admin@owned-a.test', username: 'owned', firstName: 'O', lastName: 'A',
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const contact = await createTestContact(A._id, { type: 'both', companyName: 'Client' } as any)
  const product = await createTestProduct(A._id, { name: 'Bolt', sku: 'OWN-BOLT' } as any)
  const warehouse = await createTestWarehouse(A._id, { name: 'WH', isDefault: true } as any)
  const account = await createTestAccount(A._id, { code: '501', name: 'Cash' } as any)
  const account2 = await createTestAccount(A._id, { code: '503', name: 'Bank' } as any)
  const bank = await createTestBankAccount(A._id, { name: 'Bank account' } as any)
  const employee = await createTestEmployee(A._id)
  const year = await createTestFiscalYear(A._id, { name: 'FY base', startDate: new Date('2019-01-01'), endDate: new Date('2019-12-31') } as any)
  const run = await createTestPayrollRun(A._id, user._id as any)
  await createTestStockLevel(A._id, product._id as any, warehouse._id as any, { quantity: 5, avgCost: 2 } as any)

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.handle(new Request(`http://localhost/api/org/${id(A)}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }
  return { A, B, user, other, contact, product, warehouse, account, account2, bank, employee, year, run, call }
}

interface Route {
  model: OwnedModel
  path: string
  key: string
  Model: any
  /** What the screen (or, where there is none, a plain API client) sends to create one. */
  make: () => Record<string, unknown>
  /** An ordinary edit. */
  edit: Record<string, unknown>
}

const ROUTES: Route[] = [
  {
    model: 'BankAccount', path: '/accounting/bank-account', key: 'bankAccount', Model: BankAccount,
    make: () => ({ name: `Acc ${n()}`, bankName: 'Bank', accountNumber: `BG${n()}`, iban: '', swift: '', accountId: id(w.account), currency: 'EUR', isDefault: false, isActive: true }),
    edit: { name: 'Renamed' },
  },
  {
    model: 'ExchangeRate', path: '/accounting/exchange-rate', key: 'exchangeRate', Model: ExchangeRate,
    make: () => ({ fromCurrency: 'EUR', toCurrency: 'USD', rate: 1.1, date: '2026-11-10', source: 'manual' }),
    edit: { rate: 1.2 },
  },
  {
    model: 'FiscalPeriod', path: '/accounting/fiscal-period', key: 'fiscalPeriod', Model: FiscalPeriod,
    make: () => ({ fiscalYearId: id(w.year), name: `P${n()}`, number: n(), startDate: '2019-01-01', endDate: '2019-01-31', status: 'open' }),
    edit: { status: 'closed' },
  },
  {
    model: 'FiscalYear', path: '/accounting/fiscal-year', key: 'fiscalYear', Model: FiscalYear,
    make: () => { const y = 2030 + n(); return { name: `FY ${y}`, startDate: `${y}-01-01T00:00:00.000Z`, endDate: `${y}-12-31T00:00:00.000Z`, status: 'open' } },
    // The Fiscal years screen locks a year with exactly this save.
    edit: { status: 'locked' },
  },
  {
    model: 'FixedAsset', path: '/accounting/fixed-asset', key: 'fixedAsset', Model: FixedAsset,
    make: () => ({
      code: `FA-${n()}`, name: 'Lathe', category: 'machines', accountId: id(w.account), depreciationAccountId: id(w.account), accumulatedDepAccountId: id(w.account2),
      purchaseDate: '2026-01-01', purchasePrice: 1000, salvageValue: 0, usefulLifeMonths: 60, depreciationMethod: 'straight_line', currentValue: 1000, status: 'active',
    }),
    edit: { status: 'disposed', disposalDate: '2026-11-01', disposalPrice: 100 },
  },
  {
    model: 'BankReconciliation', path: '/accounting/reconciliation', key: 'bankReconciliation', Model: BankReconciliation,
    make: () => ({ bankAccountId: id(w.bank), statementDate: '2026-10-31', statementBalance: 100, bookBalance: 100, difference: 0, status: 'draft', items: [] }),
    edit: { statementBalance: 120, difference: 20 },
  },
  {
    model: 'CashOrder', path: '/invoicing/cash-order', key: 'cashOrder', Model: CashOrder,
    make: () => ({ type: 'receipt', party: 'Иван Петров', date: '2026-11-10', amount: 25, accountId: id(w.account), counterAccountId: id(w.account2), description: 'каса' }),
    edit: { amount: 30, description: 'поправка' },
  },
  {
    model: 'PaymentOrder', path: '/invoicing/payment-order', key: 'paymentOrder', Model: PaymentOrder,
    make: () => ({ contactId: id(w.contact), type: 'outgoing', bankAccountId: id(w.bank), date: '2026-11-10', amount: 40, reference: 'ref', description: 'плащане', invoiceIds: [] }),
    edit: { amount: 45 },
  },
  {
    model: 'Payslip', path: '/payroll/payslip', key: 'payslip', Model: Payslip,
    make: () => ({ payrollRunId: id(w.run), employeeId: id(w.employee), period: { from: '2026-10-01', to: '2026-10-31' }, grossPay: 1000, totalDeductions: 200, netPay: 800, paymentMethod: 'bank_transfer', earnings: [], deductions: [] }),
    edit: { paymentReference: 'TR-1' },
  },
  {
    model: 'Timesheet', path: '/payroll/timesheet', key: 'timesheet', Model: Timesheet,
    make: () => ({ employeeId: id(w.employee), date: '2026-11-10', hoursWorked: 8, overtimeHours: 0, type: 'regular', status: 'submitted' }),
    edit: { hoursWorked: 7 },
  },
  {
    model: 'InventoryCount', path: '/warehouse/inventory-count', key: 'inventoryCount', Model: InventoryCount,
    make: () => ({
      warehouseId: id(w.warehouse), date: '2026-11-10', type: 'full', notes: '', itemCount: 1, varianceCount: 1,
      lines: [{ productId: id(w.product), systemQuantity: 5, countedQuantity: 7, variance: 2 }],
    }),
    edit: { notes: 'преброено два пъти' },
  },
  {
    model: 'PriceList', path: '/warehouse/price-list', key: 'priceList', Model: PriceList,
    make: () => ({ name: `List ${n()}`, currency: 'EUR', validFrom: '', validTo: '', isActive: true, items: [{ productId: id(w.product), price: 3, minQuantity: 1, discount: 0 }] }),
    edit: { currency: 'BGN' },
  },
]

/** A value for a server-set field that is neither empty nor what the server holds. */
function chosen(model: OwnedModel, field: string): unknown {
  if (field === 'status') return model === 'InventoryCount' ? 'completed' : 'executed'
  if (field === 'orderNumber' || field === 'countNumber') return 'ZZ-2026-99999'
  if (field === 'engine') return 'bg'
  if (field === 'sealed') return 'v1:forged'
  if (field === '__v') return 41
  if (/At$/.test(field)) return '2020-01-01T00:00:00.000Z'
  return oid() // an id: `_id`, `createdBy`, `journalEntryId`…
}

const stored = async (r: Route, docId: string) => JSON.stringify(await r.Model.findById(docId).lean().exec())

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  w = await world()
}, 120_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

describe('what each screen sends still saves', () => {
  for (const r of ROUTES) {
    it(`${r.path}: create, edit, and the document sent back as it was loaded`, async () => {
      const made = await w.call('POST', r.path, r.make())
      expect(`${made.status} ${made.text.slice(0, 200)}`).toStartWith('200')
      const docId = id(made.json[r.key])

      const edited = await w.call('PUT', `${r.path}/${docId}`, r.edit)
      expect(`${edited.status} ${edited.text.slice(0, 200)}`).toStartWith('200')
      for (const [k, v] of Object.entries(r.edit)) {
        const got = edited.json[r.key][k]
        expect(String(got).startsWith(String(v)) || got === v).toBe(true)
      }

      // A client that holds the whole document and sends it back, with one field changed. Its
      // `orgId` aside: a PUT's schema has refused that since S-25.
      const loaded = (await w.call('GET', `${r.path}/${docId}`)).json[r.key]
      expect(loaded).toBeTruthy()
      const { orgId: _org, ...whole } = loaded
      const back = await w.call('PUT', `${r.path}/${docId}`, whole)
      expect(`${back.status} ${back.text.slice(0, 200)}`).toStartWith('200')
    })
  }
})

describe('a body never chooses a field the server sets', () => {
  for (const r of ROUTES) {
    const onCreate = [...SERVER_OWNED[r.model], '_id', 'id', 'createdAt', 'updatedAt', '__v']
    for (const field of onCreate) {
      it(`${r.path}: POST choosing ${field} is refused, and nothing is stored`, async () => {
        const before = await r.Model.countDocuments({})
        const res = await w.call('POST', r.path, { ...r.make(), [field]: chosen(r.model, field) })
        expect(`${res.status} ${res.text.slice(0, 200)}`).toStartWith('422')
        expect(res.json?.code).toBe('server_owned_field')
        expect(res.json?.path).toBe(field)
        expect(await r.Model.countDocuments({})).toBe(before)
      })
    }

    it(`${r.path}: POST naming another org is refused, and nothing lands in either`, async () => {
      const before = await r.Model.countDocuments({})
      const res = await w.call('POST', r.path, { ...r.make(), orgId: id(w.B) })
      expect(res.status).toBe(422)
      expect(res.json?.path).toBe('orgId')
      expect(await r.Model.countDocuments({})).toBe(before)
    })

    const onSave = [...SERVER_OWNED[r.model], '_id', 'id', 'createdAt', '__v']
    for (const field of onSave) {
      it(`${r.path}: PUT changing ${field} is refused, and the document stays as it was`, async () => {
        const made = await w.call('POST', r.path, r.make())
        const docId = id(made.json[r.key])
        const before = await stored(r, docId)
        const res = await w.call('PUT', `${r.path}/${docId}`, { ...r.edit, [field]: chosen(r.model, field) })
        expect(`${res.status} ${res.text.slice(0, 200)}`).toStartWith('422')
        expect(res.json?.code).toBe('server_owned_field')
        expect(res.json?.path).toBe(field)
        expect(await stored(r, docId)).toBe(before)
      })
    }

    it(`${r.path}: update syntax in a body is refused, on a save and on a create`, async () => {
      const made = await w.call('POST', r.path, r.make())
      const docId = id(made.json[r.key])
      const before = await stored(r, docId)
      const count = await r.Model.countDocuments({})
      for (const body of [{ $set: r.edit }, { 'a.b': 1 }, { ...r.edit, 'createdBy.x': 1 }]) {
        const put = await w.call('PUT', `${r.path}/${docId}`, body)
        expect(`${put.status} ${JSON.stringify(body)}`).toStartWith('422')
        const post = await w.call('POST', r.path, { ...r.make(), ...body })
        expect(`${post.status} ${JSON.stringify(body)}`).toStartWith('422')
      }
      expect(await stored(r, docId)).toBe(before)
      expect(await r.Model.countDocuments({})).toBe(count)
    })
  }
})

describe('the steps the server takes are still taken, and only by their own routes', () => {
  it('a count is completed by its action, which books the adjustment; never by a save', async () => {
    const r = ROUTES.find(x => x.model === 'InventoryCount')!
    const made = await w.call('POST', r.path, r.make())
    expect(made.status).toBe(200)
    const docId = id(made.json.inventoryCount)
    const fresh: any = await InventoryCount.findById(docId).lean().exec()
    expect(fresh.status).toBe('in_progress')
    expect(String(fresh.createdBy)).toBe(id(w.user))
    expect(fresh.countNumber).toMatch(/^IC-\d{4}-\d{5}$/)

    const level = async () => ((await StockLevel.findOne({ orgId: w.A._id, productId: w.product._id, warehouseId: w.warehouse._id }).lean().exec()) as any)?.quantity
    const movements = await StockMovement.countDocuments({ orgId: w.A._id })

    // The save that used to mark it completed, with a movement of the caller's choosing.
    const forged = await w.call('PUT', `${r.path}/${docId}`, { status: 'completed', adjustmentMovementId: oid(), completedBy: id(w.other), completedAt: '2026-01-01T00:00:00.000Z' })
    expect(forged.status).toBe(422)
    expect(forged.json?.code).toBe('server_owned_field')
    expect(await level()).toBe(5)
    expect(await StockMovement.countDocuments({ orgId: w.A._id })).toBe(movements)

    // A line's cost set by path, past the pricing the handler does on `lines`.
    const before: any = await InventoryCount.findById(docId).lean().exec()
    const byPath = await w.call('PUT', `${r.path}/${docId}`, { 'lines.0.varianceCost': 999 })
    expect(byPath.status).toBe(422)
    expect(((await InventoryCount.findById(docId).lean().exec()) as any).lines[0].varianceCost).toBe(before.lines[0].varianceCost)

    const done = await w.call('POST', `${r.path}/${docId}/complete`)
    expect(`${done.status} ${done.text.slice(0, 200)}`).toStartWith('200')
    const after: any = await InventoryCount.findById(docId).lean().exec()
    expect(after.status).toBe('completed')
    expect(String(after.completedBy)).toBe(id(w.user))
    expect(after.completedAt).toBeInstanceOf(Date)
    expect(after.adjustmentMovementId).toBeTruthy()
    expect(await level()).toBe(7)
    expect(await StockMovement.countDocuments({ orgId: w.A._id })).toBe(movements + 1)

    // And a completed count is closed to a save, as before.
    expect((await w.call('PUT', `${r.path}/${docId}`, { notes: 'late' })).status).toBe(409)
  })

  it('a count cannot be born completed', async () => {
    const r = ROUTES.find(x => x.model === 'InventoryCount')!
    const before = await InventoryCount.countDocuments({})
    for (const extra of [{ status: 'completed' }, { status: 'cancelled' }, { completedBy: id(w.user) }, { adjustmentMovementId: oid() }, { countNumber: 'IC-2026-00001' }, { createdBy: id(w.other) }]) {
      const res = await w.call('POST', r.path, { ...r.make(), ...extra })
      expect(`${res.status} ${JSON.stringify(extra)}`).toStartWith('422')
    }
    expect(await InventoryCount.countDocuments({})).toBe(before)
    // Restating what a new count starts as is not choosing it.
    expect((await w.call('POST', r.path, { ...r.make(), status: 'in_progress', createdBy: id(w.user), orgId: id(w.A) })).status).toBe(200)
  })

  it('a payment order is executed by its action, never by a save; its number and author stay', async () => {
    const r = ROUTES.find(x => x.model === 'PaymentOrder')!
    const made = await w.call('POST', r.path, r.make())
    const docId = id(made.json.paymentOrder)
    const fresh: any = await PaymentOrder.findById(docId).lean().exec()
    expect(fresh.status).toBe('draft')
    expect(String(fresh.createdBy)).toBe(id(w.user))

    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'executed' })).status).toBe(422)
    expect((await w.call('PUT', `${r.path}/${docId}`, { orderNumber: 'PO-2026-00001' })).status).toBe(422)
    expect((await w.call('PUT', `${r.path}/${docId}`, { createdBy: id(w.other) })).status).toBe(422)
    expect(((await PaymentOrder.findById(docId).lean().exec()) as any).status).toBe('draft')

    expect((await w.call('POST', `${r.path}/${docId}/execute`)).status).toBe(200)
    const executed: any = await PaymentOrder.findById(docId).lean().exec()
    expect(executed.status).toBe('executed')
    expect(executed.executedAt).toBeInstanceOf(Date)

    // A stale screen that still says `draft` no longer takes the order back to a draft.
    const stale = await w.call('PUT', `${r.path}/${docId}`, { amount: 41, status: 'draft' })
    expect(stale.status).toBe(422)
    expect(((await PaymentOrder.findById(docId).lean().exec()) as any).status).toBe('executed')
    // One that says what is true saves.
    expect((await w.call('PUT', `${r.path}/${docId}`, { amount: 41, status: 'executed', orderNumber: executed.orderNumber })).status).toBe(200)
    expect(((await PaymentOrder.findById(docId).lean().exec()) as any).amount).toBe(41)
  })

  it('a timesheet names who approved it: the caller, whatever the body says', async () => {
    const r = ROUTES.find(x => x.model === 'Timesheet')!
    const docId = id((await w.call('POST', r.path, r.make())).json.timesheet)
    expect(((await Timesheet.findById(docId).lean().exec()) as any).approvedBy).toBeUndefined()

    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'approved', approvedBy: id(w.other) })).status).toBe(422)
    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'approved' })).status).toBe(200)
    const approved: any = await Timesheet.findById(docId).lean().exec()
    expect(approved.status).toBe('approved')
    expect(String(approved.approvedBy)).toBe(id(w.user))

    // An edit that leaves the status alone leaves the approver alone.
    expect((await w.call('PUT', `${r.path}/${docId}`, { hoursWorked: 6, status: 'approved' })).status).toBe(200)
    expect(String(((await Timesheet.findById(docId).lean().exec()) as any).approvedBy)).toBe(id(w.user))

    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'rejected' })).status).toBe(200)
    expect(((await Timesheet.findById(docId).lean().exec()) as any).approvedBy ?? null).toBeNull()

    // Born approved: the same stamp.
    const born = await w.call('POST', r.path, { ...r.make(), status: 'approved' })
    expect(born.status).toBe(200)
    expect(String(((await Timesheet.findById(id(born.json.timesheet)).lean().exec()) as any).approvedBy)).toBe(id(w.user))
  })

  it('a reconciliation names who completed it and when', async () => {
    const r = ROUTES.find(x => x.model === 'BankReconciliation')!
    const docId = id((await w.call('POST', r.path, r.make())).json.bankReconciliation)
    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'completed', reconciledBy: id(w.other) })).status).toBe(422)
    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'completed' })).status).toBe(200)
    const done: any = await BankReconciliation.findById(docId).lean().exec()
    expect(String(done.reconciledBy)).toBe(id(w.user))
    expect(done.reconciledAt).toBeInstanceOf(Date)
    expect((await w.call('PUT', `${r.path}/${docId}`, { status: 'draft' })).status).toBe(200)
    const reopened: any = await BankReconciliation.findById(docId).lean().exec()
    expect(reopened.reconciledBy ?? null).toBeNull()
    expect(reopened.reconciledAt ?? null).toBeNull()
  })

  it('a price list\'s `deactivatedAt` follows `isActive`, on a save as on a delete', async () => {
    const r = ROUTES.find(x => x.model === 'PriceList')!
    const docId = id((await w.call('POST', r.path, r.make())).json.priceList)
    const at = async () => ((await PriceList.findById(docId).lean().exec()) as any).deactivatedAt ?? null

    expect((await w.call('PUT', `${r.path}/${docId}`, { isActive: false })).status).toBe(200)
    expect(await at()).toBeInstanceOf(Date)
    expect((await w.call('PUT', `${r.path}/${docId}`, { isActive: true })).status).toBe(200)
    expect(await at()).toBeNull()

    expect((await w.call('DELETE', `${r.path}/${docId}`)).status).toBe(200)
    expect(await at()).toBeInstanceOf(Date)
    // The form's own save of a switched-off list, with the box ticked again.
    expect((await w.call('PUT', `${r.path}/${docId}`, { name: `Back ${n()}`, currency: 'EUR', validFrom: '', validTo: '', isActive: true, items: [] })).status).toBe(200)
    expect(await at()).toBeNull()
  })

  it('a payslip is sealed by a run, never by a body', async () => {
    const r = ROUTES.find(x => x.model === 'Payslip')!
    const before = await Payslip.countDocuments({})
    expect((await w.call('POST', r.path, { ...r.make(), engine: 'bg', sealed: 'v1:forged', grossPay: undefined, netPay: undefined })).status).toBe(422)
    expect(await Payslip.countDocuments({})).toBe(before)
    const docId = id((await w.call('POST', r.path, r.make())).json.payslip)
    expect((await w.call('PUT', `${r.path}/${docId}`, { sealed: 'v1:forged' })).status).toBe(422)
    expect(((await Payslip.findById(docId).lean().exec()) as any).sealed).toBeUndefined()
  })

  it('a document cannot be backdated', async () => {
    const r = ROUTES.find(x => x.model === 'CashOrder')!
    const t0 = Date.now()
    expect((await w.call('POST', r.path, { ...r.make(), createdAt: '2019-01-01T00:00:00.000Z' })).status).toBe(422)
    const made = await w.call('POST', r.path, r.make())
    const doc: any = await CashOrder.findById(id(made.json.cashOrder)).lean().exec()
    expect(new Date(doc.createdAt).getTime()).toBeGreaterThanOrEqual(t0 - 1000)
  })
})

describe('the other body-storing routes rely on their schemas', () => {
  it('a declared body schema drops what it does not declare, a field or a field path', async () => {
    // `unit/server-owned.test.ts` lists the controllers that hand a body to the store because
    // their routes declare its fields. This is that premise, on one of them.
    const path = `/warehouse/warehouse/${id(w.warehouse)}`
    const res = await w.call('PUT', path, { name: 'WH renamed', deactivatedAt: '2020-01-01T00:00:00.000Z', 'address.city': 'Never', createdAt: '2019-01-01T00:00:00.000Z' })
    expect(`${res.status} ${res.text.slice(0, 200)}`).toStartWith('200')
    const now: any = await Warehouse.findById(w.warehouse._id).lean().exec()
    expect(now.name).toBe('WH renamed')
    expect(now.deactivatedAt).toBeUndefined()
    expect(now.address?.city ?? null).not.toBe('Never')
    expect(new Date(now.createdAt).getFullYear()).toBeGreaterThan(2019)
  })
})
