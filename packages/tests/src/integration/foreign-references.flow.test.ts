import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse,
  createTestAccount, createTestBankAccount, createTestInvoice,
} from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { createApiApp } from '../../../portal-api/src/api'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { runInRequest } from 'db/home/request-context'
import { CashOrder, PaymentOrder, JournalEntry, InventoryCount, StockMovement, StockLevel, Invoice } from 'db/models'

/**
 * A document of one org names records of that org only, and a view resolves the ids a document
 * holds inside the org.
 *
 * Two layers, each tested here on its own:
 *   - writes: `db/plugins/reference-guard.ts`, installed by `tenantPlugin`, refuses (422,
 *     `foreign_reference`) a write inside a request whose new references name another org's record;
 *   - reads: the lookups that resolve stored ids now filter by the org, so a reference planted
 *     outside a request (where the guard is off) still shows nothing.
 */

const MARK = 'ZZFOREIGN'
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: any
let w: Awaited<ReturnType<typeof world>>

const oid = () => new mongoose.Types.ObjectId()
const id = (d: any) => String(d?._id ?? d?.id)

async function world() {
  const A = await createTestOrg({ slug: 'refs-a' } as any)
  const B = await createTestOrg({ slug: 'refs-b' } as any)
  const user = await createTestUser(A._id, { role: 'admin', email: 'admin@refs-a.test' } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(A._id), email: 'admin@refs-a.test', username: 'refs', firstName: 'R', lastName: 'A',
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const own = {
    contact: await createTestContact(A._id, { type: 'both', companyName: 'Own Client' } as any),
    product: await createTestProduct(A._id, { name: 'Own bolt', sku: 'OWN-1' } as any),
    warehouse: await createTestWarehouse(A._id, { name: 'Own WH', isDefault: true } as any),
    account: await createTestAccount(A._id, { code: '501', name: 'Own cash' } as any),
    account2: await createTestAccount(A._id, { code: '502', name: 'Own bank' } as any),
    bank: await createTestBankAccount(A._id, { name: 'Own bank account' } as any),
  }
  const foreign = {
    contact: await createTestContact(B._id, { type: 'both', companyName: `${MARK}-CONTACT`, email: 'zzforeign@b.test' } as any),
    product: await createTestProduct(B._id, { name: `${MARK}-PRODUCT`, sku: `${MARK}-SKU` } as any),
    warehouse: await createTestWarehouse(B._id, { name: `${MARK}-WH`, isDefault: true } as any),
    account: await createTestAccount(B._id, { code: '9999', name: `${MARK}-ACCOUNT` } as any),
    bank: await createTestBankAccount(B._id, { name: `${MARK}-BANK` } as any),
  }
  const foreignInvoice = await createTestInvoice(B._id, foreign.contact._id, { invoiceNumber: `${MARK}-INV-1` } as any)

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
  return { A, B, user, own, foreign, foreignInvoice, call }
}

// The bodies the six routes accept, with every reference taken from `r` (own or foreign per field).
const bodies = {
  cashOrder: (r: Record<string, string>) => ({ type: 'receipt', amount: 1, currency: 'EUR', description: 'refs', date: '2026-11-10', contactId: r.contactId, accountId: r.accountId, counterAccountId: r.counterAccountId }),
  paymentOrder: (r: Record<string, string>) => ({ type: 'outgoing', amount: 1, currency: 'EUR', date: '2026-11-10', contactId: r.contactId, bankAccountId: r.bankAccountId, invoiceIds: r.invoiceId ? [r.invoiceId] : [] }),
  journal: (r: Record<string, string>) => ({ date: '2026-11-10', description: 'refs', lines: [{ accountId: r.accountId, contactId: r.contactId, debit: 5, credit: 0 }, { accountId: id(w.own.account2), debit: 0, credit: 5 }] }),
  inventoryCount: (r: Record<string, string>) => ({ warehouseId: r.warehouseId, date: '2026-11-10', type: 'full', lines: [{ productId: r.productId, systemQuantity: 0, countedQuantity: 3, difference: 3, variance: 3, varianceCost: 3 }] }),
  movement: (r: Record<string, string>) => ({ type: 'receipt', date: '2026-11-10', toWarehouseId: r.warehouseId, contactId: r.contactId, totalAmount: 2, lines: [{ productId: r.productId, quantity: 2, unitCost: 1, totalCost: 2 }] }),
  invoice: (r: Record<string, string>) => ({
    type: 'invoice', direction: 'outgoing', contactId: r.contactId, issueDate: '2026-11-10', dueDate: '2026-11-20', currency: 'EUR',
    subtotal: 1, taxTotal: 0.2, total: 1.2, discountTotal: 0,
    lines: [{ productId: r.productId, description: 'x', quantity: 1, unitPrice: 1, taxRate: 20, taxAmount: 0.2, lineTotal: 1.2, discount: 0, warehouseId: r.warehouseId }],
  }),
}
const ownRefs = () => ({
  contactId: id(w.own.contact), accountId: id(w.own.account), counterAccountId: id(w.own.account2), bankAccountId: id(w.own.bank),
  warehouseId: id(w.own.warehouse), productId: id(w.own.product),
})
const foreignRef = (field: string) => ({
  contactId: id(w.foreign.contact), accountId: id(w.foreign.account), counterAccountId: id(w.foreign.account), bankAccountId: id(w.foreign.bank),
  warehouseId: id(w.foreign.warehouse), productId: id(w.foreign.product), invoiceId: id(w.foreignInvoice),
} as Record<string, string>)[field]

const ROUTES: Array<{ name: keyof typeof bodies; path: string; key: string; model: any; fields: string[] }> = [
  { name: 'cashOrder', path: '/invoicing/cash-order', key: 'cashOrder', model: CashOrder, fields: ['contactId', 'accountId', 'counterAccountId'] },
  { name: 'paymentOrder', path: '/invoicing/payment-order', key: 'paymentOrder', model: PaymentOrder, fields: ['contactId', 'bankAccountId', 'invoiceId'] },
  { name: 'journal', path: '/accounting/journal', key: 'journalEntry', model: JournalEntry, fields: ['accountId', 'contactId'] },
  { name: 'inventoryCount', path: '/warehouse/inventory-count', key: 'inventoryCount', model: InventoryCount, fields: ['warehouseId', 'productId'] },
  { name: 'movement', path: '/warehouse/movement', key: 'stockMovement', model: StockMovement, fields: ['warehouseId', 'contactId', 'productId'] },
  { name: 'invoice', path: '/invoices', key: 'invoice', model: Invoice, fields: ['contactId', 'productId', 'warehouseId'] },
]

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
  w = await world()
}, 120_000)
afterAll(async () => { await teardownTestDB() }, 60_000)

describe('a write never stores another org\'s record by id', () => {
  for (const route of ROUTES) {
    it(`${route.path}: the own org's records are accepted (control)`, async () => {
      const r = await w.call('POST', route.path, bodies[route.name](ownRefs()))
      expect(r.status).toBe(200)
      expect(r.json?.[route.key]).toBeTruthy()
    })

    for (const field of route.fields) {
      it(`${route.path}: POST naming another org's ${field} is refused, and nothing is stored`, async () => {
        const before = await route.model.countDocuments({ orgId: w.A._id })
        const r = await w.call('POST', route.path, bodies[route.name]({ ...ownRefs(), [field]: foreignRef(field) }))
        expect(r.status).toBe(422)
        expect(r.json?.code).toBe('foreign_reference')
        expect(await route.model.countDocuments({ orgId: w.A._id })).toBe(before)
      })
    }
  }

  it('a PUT that would point a saved document at another org\'s record is refused, and the document is unchanged', async () => {
    const puts: Array<{ path: string; key: string; model: any; make: () => any; change: Record<string, unknown>; field: string }> = [
      { path: '/invoicing/cash-order', key: 'cashOrder', model: CashOrder, make: () => bodies.cashOrder(ownRefs()), change: { contactId: foreignRef('contactId') }, field: 'contactId' },
      { path: '/invoicing/payment-order', key: 'paymentOrder', model: PaymentOrder, make: () => bodies.paymentOrder(ownRefs()), change: { bankAccountId: foreignRef('bankAccountId') }, field: 'bankAccountId' },
      { path: '/accounting/journal', key: 'journalEntry', model: JournalEntry, make: () => bodies.journal(ownRefs()), change: bodies.journal({ ...ownRefs(), accountId: foreignRef('accountId') }), field: 'lines' },
      { path: '/warehouse/inventory-count', key: 'inventoryCount', model: InventoryCount, make: () => bodies.inventoryCount(ownRefs()), change: { warehouseId: foreignRef('warehouseId') }, field: 'warehouseId' },
      { path: '/warehouse/movement', key: 'stockMovement', model: StockMovement, make: () => bodies.movement(ownRefs()), change: { contactId: foreignRef('contactId') }, field: 'contactId' },
      { path: '/invoices', key: 'invoice', model: Invoice, make: () => bodies.invoice(ownRefs()), change: { contactId: foreignRef('contactId') }, field: 'contactId' },
    ]
    const refused: string[] = []
    for (const p of puts) {
      const made = await w.call('POST', p.path, p.make())
      expect(made.status).toBe(200)
      const docId = id(made.json[p.key])
      const before = JSON.stringify((await p.model.findById(docId).lean())?.[p.field])
      const r = await w.call('PUT', `${p.path}/${docId}`, p.change)
      if (r.status === 422 && r.json?.code === 'foreign_reference') refused.push(p.path)
      expect(JSON.stringify((await p.model.findById(docId).lean())?.[p.field])).toBe(before)
    }
    expect(refused).toEqual(puts.map(p => p.path))
  })

  it('an id that names no record at all is still stored: old documents and transactions name such ids', async () => {
    const r = await w.call('POST', '/invoicing/cash-order', bodies.cashOrder({ ...ownRefs(), contactId: String(oid()) }))
    expect(r.status).toBe(200)
  })

  it('a saved document whose reference names nothing any more still saves an unrelated change', async () => {
    const made = await w.call('POST', '/invoicing/cash-order', bodies.cashOrder(ownRefs()))
    await CashOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(id(made.json.cashOrder)) }, { $set: { contactId: oid() } })
    const r = await w.call('PUT', `/invoicing/cash-order/${id(made.json.cashOrder)}`, { description: 'still saves' })
    expect(r.status).toBe(200)
  })
})

describe('the reference guard below the routes, every kind of write', () => {
  const inRequest = <T>(fn: () => Promise<T>) =>
    runInRequest({ readOnly: false, route: 'POST /test', orgId: String(w.A._id), listedWriter: false }, fn)
  const cashOrder = (contactId: unknown) => ({
    orgId: w.A._id, orderNumber: `CO-T-${oid()}`, type: 'receipt', amount: 1, currency: 'EUR', description: 't',
    contactId, accountId: w.own.account._id, counterAccountId: w.own.account2._id, createdBy: w.user._id,
  })

  it('create, insertMany, bulkWrite, $set on a dotted path, $push, and an update whose filter names no org', async () => {
    const saved: any = await inRequest(() => CashOrder.create(cashOrder(w.own.contact._id)))
    const inv: any = await createTestInvoice(w.A._id, w.own.contact._id, { invoiceNumber: `INV-T-${oid()}` } as any)
    await inRequest(() => Invoice.updateOne({ _id: inv._id, orgId: w.A._id }, { $set: { 'lines.0.productId': w.own.product._id } }).exec())
    const tries: Array<[string, () => Promise<unknown>]> = [
      ['create', () => inRequest(() => CashOrder.create(cashOrder(w.foreign.contact._id)))],
      ['insertMany', () => inRequest(() => CashOrder.insertMany([cashOrder(String(w.foreign.contact._id))]))],
      ['bulkWrite', () => inRequest(() => CashOrder.bulkWrite([{ updateOne: { filter: { _id: saved._id, orgId: w.A._id }, update: { $set: { contactId: w.foreign.contact._id } } } }] as any))],
      ['$set dotted', () => inRequest(() => Invoice.findOneAndUpdate({ _id: inv._id, orgId: w.A._id }, { $set: { 'lines.0.productId': w.foreign.product._id } }).exec())],
      ['$push', () => inRequest(() => Invoice.updateOne({ _id: inv._id, orgId: w.A._id }, { $push: { lines: { productId: w.foreign.product._id, description: 'y', quantity: 1, unitPrice: 1 } } }).exec())],
      ['filter without org', () => inRequest(() => CashOrder.updateOne({ _id: saved._id }, { contactId: w.foreign.contact._id }).exec())],
      ['populated shape', () => inRequest(() => CashOrder.create(cashOrder({ _id: w.foreign.contact._id, companyName: 'x' })))],
    ]
    const passed: string[] = []
    for (const [name, run] of tries) {
      const err = await captureRejection(run())
      if (err?.name !== 'ForeignReferenceError') passed.push(`${name}: ${err?.message ?? 'resolved'}`)
    }
    expect(passed).toEqual([])
    expect(String((await CashOrder.findById(saved._id).lean() as any).contactId)).toBe(id(w.own.contact))
    expect(String((await Invoice.findById(inv._id).lean() as any).lines[0].productId)).toBe(id(w.own.product))
  })

  it('the same kinds of write naming the org\'s own records go through (no hook holds a write up)', async () => {
    const saved: any = await inRequest(() => CashOrder.create(cashOrder(w.own.contact._id)))
    const many: any[] = await inRequest(() => CashOrder.insertMany([cashOrder(String(w.own.contact._id)), cashOrder(String(w.own.contact._id))]))
    const bulk: any = await inRequest(() => CashOrder.bulkWrite([{ updateOne: { filter: { _id: saved._id, orgId: w.A._id }, update: { $set: { description: 'bulk' } } } }] as any))
    const pushed: any = await inRequest(() => CashOrder.updateOne({ _id: saved._id }, { contactId: w.own.contact._id }).exec())
    expect(many).toHaveLength(2)
    expect(bulk.modifiedCount).toBe(1)
    expect(pushed.matchedCount).toBe(1)
    await CashOrder.deleteMany({ _id: { $in: [saved._id, ...many.map(m => m._id)] } })
  })

  it('outside a request the guard is off: scripts, migrations and the copy job write as trusted code', async () => {
    const made: any = await CashOrder.create(cashOrder(w.foreign.contact._id))
    expect(String(made.contactId)).toBe(id(w.foreign.contact))
    await CashOrder.deleteOne({ _id: made._id })
  })
})

describe('reads resolve a stored id inside the org only', () => {
  // Planted with raw writes, as history (or a trusted script) could have stored them.
  async function plant() {
    const A = w.A._id
    const f = w.foreign
    const now = new Date()
    const [co, po, je, ic, sm, inv] = Array.from({ length: 6 }, () => new mongoose.Types.ObjectId())
    await CashOrder.collection.insertOne({ _id: co, orgId: A, orderNumber: 'CO-PLANT', type: 'receipt', amount: 1, currency: 'EUR', description: 'plant', contactId: f.contact._id, accountId: f.account._id, counterAccountId: f.account._id, createdBy: w.user._id, createdAt: now, updatedAt: now })
    await PaymentOrder.collection.insertOne({ _id: po, orgId: A, orderNumber: 'PO-PLANT', type: 'payment', amount: 1, currency: 'EUR', exchangeRate: 1, status: 'draft', contactId: f.contact._id, bankAccountId: f.bank._id, createdBy: w.user._id, createdAt: now, updatedAt: now })
    await JournalEntry.collection.insertOne({ _id: je, orgId: A, entryNumber: 'JE-PLANT', date: now, description: 'plant', type: 'standard', status: 'draft', lines: [{ _id: oid(), accountId: f.account._id, debit: 1, credit: 0 }, { _id: oid(), accountId: w.own.account._id, debit: 0, credit: 1 }], totalDebit: 1, totalCredit: 1, createdBy: w.user._id, createdAt: now, updatedAt: now })
    await InventoryCount.collection.insertOne({ _id: ic, orgId: A, countNumber: 'IC-PLANT', warehouseId: f.warehouse._id, date: now, type: 'full', status: 'draft', lines: [{ _id: oid(), productId: f.product._id, systemQuantity: 0, countedQuantity: 1, variance: 1, varianceCost: 1 }], createdBy: w.user._id, createdAt: now, updatedAt: now })
    await StockMovement.collection.insertOne({ _id: sm, orgId: A, movementNumber: 'SM-PLANT', type: 'receipt', status: 'draft', date: now, toWarehouseId: f.warehouse._id, contactId: f.contact._id, lines: [{ _id: oid(), productId: f.product._id, quantity: 1, unitCost: 1, totalCost: 1 }], totalAmount: 1, createdBy: w.user._id, createdAt: now, updatedAt: now })
    await StockLevel.collection.insertOne({ _id: oid(), orgId: A, productId: f.product._id, warehouseId: f.warehouse._id, quantity: 1, reservedQuantity: 0, availableQuantity: 1, avgCost: 1, createdAt: now, updatedAt: now })
    await Invoice.collection.insertOne({ _id: inv, orgId: A, invoiceNumber: 'INV-PLANT', type: 'invoice', direction: 'outgoing', status: 'draft', contactId: f.contact._id, issueDate: now, dueDate: now, currency: 'EUR', exchangeRate: 1, subtotal: 1, discountTotal: 0, taxTotal: 0, total: 1, totalBase: 1, amountPaid: 0, amountDue: 1, lines: [{ _id: oid(), productId: f.product._id, warehouseId: w.own.warehouse._id, description: 'x', quantity: 1, unitPrice: 1, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 1 }], createdBy: w.user._id, createdAt: now, updatedAt: now })
    return { co, po, je, ic, sm, inv }
  }

  it('lists and views show nothing of the other org', async () => {
    const p = await plant()
    const reads: Array<[string, string]> = [
      ['cash-order list', '/invoicing/cash-order?size=100'],
      ['payment-order list', '/invoicing/payment-order?size=100'],
      ['journal entry', `/accounting/journal/${p.je}`],
      ['inventory-count list', '/warehouse/inventory-count?size=100'],
      ['inventory count', `/warehouse/inventory-count/${p.ic}`],
      ['movement list', '/warehouse/movement?size=100'],
      ['movement', `/warehouse/movement/${p.sm}`],
      ['stock-level list', '/warehouse/stock-level?size=100'],
      ['invoice list', '/invoices?size=100'],
      ['invoice', `/invoices/${p.inv}`],
    ]
    const leaks: string[] = []
    for (const [name, path] of reads) {
      const r = await w.call('GET', path)
      expect(`${name} ${r.status}`).toBe(`${name} 200`)
      if (r.text.includes(MARK) || r.text.includes('zzforeign@b.test')) leaks.push(name)
    }
    expect(leaks).toEqual([])
  })
})

describe('no controller resolves stored ids across orgs', () => {
  it('every `findMany({ id: { $in … } })` in a controller also names the org', async () => {
    const { Glob } = await import('bun')
    const root = new URL('../../../', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
    const offenders: string[] = []
    for await (const f of new Glob('*-api/src/controllers/*.ts').scan(root)) {
      const lines = (await Bun.file(root + f).text()).split('\n')
      lines.forEach((l, i) => { if (/\.findMany\(\{\s*id:\s*\{\s*\$in/.test(l) && !/orgId/.test(l)) offenders.push(`${f}:${i + 1}: ${l.trim()}`) })
    }
    expect(offenders).toEqual([])
  })
})
