import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestStockMovement,
} from '../helpers/factories'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { productSupplierController } from 'warehouse-api/src/controllers/product-supplier.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { InternalOrder, Invoice, Order, StockMovement } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { getInternalOrderSuggestions } from 'services/biz/reservation-ops.service'
import {
  billEvidenceFilter, findProductIdsBySuppliers, findProductIdsWithoutSupplier, getDefaultSuppliers,
  getRecentSupplierDocuments, getSupplierFacts, receiptEvidenceFilter,
} from 'services/biz/product-suppliers.service'

/**
 * FR-28.1 / .2 / .6 / .7 / .11 — which suppliers an article was bought from, read from the documents.
 *
 * What the cases pin (spec §6):
 *   - a received bill counts; a draft, a voided, a cancelled one and an incoming credit note do not;
 *   - a receipt counts only when no bill covers it, and a bill with its receipt counts once;
 *   - editing an issued bill's supplier or a line's article moves the fact at once, and a void removes it;
 *   - a receipt naming no supplier names none;
 *   - the default order, and who may see any of it (the keys are ABSENT from the JSON, not hidden);
 *   - neither evidence query is a collection scan.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(productController).use(productSupplierController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const { Types } = mongoose

const day = (iso: string) => new Date(`${iso}T10:00:00Z`)

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const alfa = await createTestContact(org._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const beta = await createTestContact(org._id, { type: 'supplier', companyName: 'Beta Tools' } as any)
  const gamma = await createTestContact(org._id, { type: 'both', companyName: 'Gamma Supply' } as any)
  const client = await createTestContact(org._id, { type: 'customer', companyName: 'Delta Client' } as any)
  const bolt = await createTestProduct(org._id, { name: 'Hex bolt M8x40', sku: 'PRD-0001' } as any)
  const nut = await createTestProduct(org._id, { name: 'Hex nut M8', sku: 'PRD-0002' } as any)
  const washer = await createTestProduct(org._id, { name: 'Washer M8', sku: 'PRD-0003' } as any)

  const claims = (over: object) => ({
    id: String(user._id), orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ...over,
  })
  const token = (over: object = {}) => (signer as any).decorator.jwt.sign(claims(over)) as Promise<string>

  async function call(tok: string, path: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse${path}`, { headers: { authorization: `Bearer ${tok}` } }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }

  let n = 0
  /** A bill, in the status the case needs; one line per `[product, quantity, unitPrice]`. */
  function bill(supplier: any, lines: Array<[any, number, number]>, over: Record<string, unknown> = {}) {
    return createTestInvoice(org._id, supplier._id, {
      invoiceNumber: `BILL-2026-${String(++n).padStart(5, '0')}`,
      type: 'invoice', direction: 'incoming', status: 'received', currency: 'EUR',
      issueDate: day('2026-05-10'),
      lines: lines.map(([p, quantity, unitPrice]) => ({
        productId: p._id, description: p.name, quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 20, taxAmount: 0, lineTotal: quantity * unitPrice,
      })),
      ...over,
    } as any)
  }
  /** A goods receipt, completed unless the case says otherwise. */
  function receipt(supplier: any | null, lines: Array<[any, number, number]>, over: Record<string, unknown> = {}) {
    return createTestStockMovement(org._id, {
      movementNumber: `SM-2026-${String(++n).padStart(5, '0')}`,
      type: 'receipt', status: 'completed', date: day('2026-05-12'),
      ...(supplier ? { contactId: supplier._id } : {}),
      lines: lines.map(([p, quantity, unitCost]) => ({ productId: p._id, quantity, unitCost, totalCost: quantity * unitCost })),
      ...over,
    } as any)
  }
  const factsOf = async (product: any, opts = {}) => (await getSupplierFacts(orgId, [String(product._id)], opts))[String(product._id)]

  return { org, orgId, user, alfa, beta, gamma, client, bolt, nut, washer, token, call, bill, receipt, factsOf }
}

describe('what counts as procured through a supplier (§2.2)', () => {
  it('a received bill counts: supplier, date, price, quantity, documents and the document last used', async () => {
    const w = await world()
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]], { issueDate: day('2026-05-10') })
    const facts = await w.factsOf(w.bolt)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      supplierId: String(w.alfa._id), supplierName: 'Alfa Fasteners', quantity: 10, documents: 1,
      lastUnitPrice: 0.12, currency: 'EUR', lastDocument: { kind: 'bill', id: String(b._id), number: b.invoiceNumber },
    })
    expect(facts[0].lastPurchasedAt.toISOString()).toBe(day('2026-05-10').toISOString())
  })

  it('every received status counts: received, partially paid, paid, overdue', async () => {
    const w = await world()
    for (const status of ['received', 'partially_paid', 'paid', 'overdue']) await w.bill(w.alfa, [[w.bolt, 1, 1]], { status })
    expect((await w.factsOf(w.bolt))[0]).toMatchObject({ quantity: 4, documents: 4 })
  })

  it('a draft, a voided and a cancelled bill, an incoming credit note and an outgoing invoice do not', async () => {
    const w = await world()
    await w.bill(w.beta, [[w.nut, 5, 1]], { status: 'draft' })
    await w.bill(w.beta, [[w.nut, 5, 1]], { status: 'voided' })
    await w.bill(w.beta, [[w.nut, 5, 1]], { status: 'cancelled' })
    await w.bill(w.beta, [[w.nut, 5, 1]], { status: 'sent' })
    await w.bill(w.beta, [[w.nut, 5, 1]], { type: 'credit_note', status: 'received' })
    await w.bill(w.beta, [[w.nut, 5, 1]], { type: 'debit_note', status: 'received' })
    await w.bill(w.client, [[w.nut, 5, 1]], { direction: 'outgoing', status: 'sent' })
    expect(await w.factsOf(w.nut)).toEqual([])
  })

  it('a bill with no supplier names none', async () => {
    const w = await world()
    await Invoice.collection.insertOne({
      orgId: w.org._id, invoiceNumber: 'BILL-NOSUPPLIER', type: 'invoice', direction: 'incoming', status: 'received',
      issueDate: day('2026-05-10'), currency: 'EUR', lines: [{ productId: w.washer._id, quantity: 3, unitPrice: 1 }],
    })
    expect(await w.factsOf(w.washer)).toEqual([])
  })

  it("an order of the supplier's is intent, not a purchase (it is the On order figure)", async () => {
    const w = await world()
    await Order.create({
      orgId: w.org._id, orderNumber: 'ORDO-2026-00001', status: 'sent', statusHistory: [{ status: 'sent', changedAt: new Date() }],
      issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id,
      supplierGroups: [{ supplierId: w.alfa._id, lines: [{ productId: w.bolt._id, description: 'b', quantity: 5, unit: 'pcs', allocations: [] }] }],
    } as any)
    expect(await w.factsOf(w.bolt)).toEqual([])
  })

  it('a receipt that names its supplier and that nothing holds counts, priced at its unit cost in the base currency', async () => {
    const w = await world()
    const r = await w.receipt(w.alfa, [[w.nut, 20, 0.04]])
    const facts = await w.factsOf(w.nut)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      supplierId: String(w.alfa._id), quantity: 20, documents: 1, lastUnitPrice: 0.04, currency: 'EUR',
      lastDocument: { kind: 'receipt', id: String(r._id), number: r.movementNumber },
    })
  })

  it('a receipt that names no supplier names none', async () => {
    const w = await world()
    await w.receipt(null, [[w.nut, 20, 0.04]])
    expect(await w.factsOf(w.nut)).toEqual([])
  })

  it('a record-only, a reversed, an unbooked and a non-receipt movement do not', async () => {
    const w = await world()
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { recordOnly: true })
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { reversedBy: new Types.ObjectId() })
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { status: 'draft' })
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { status: 'cancelled' })
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { type: 'dispatch' })
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { type: 'return' })
    await w.receipt(w.alfa, [[w.washer, 1, 1]], { type: 'adjustment' })
    expect(await w.factsOf(w.washer)).toEqual([])
  })
})

describe('a bill and the goods it covers count once (the receipt-to-bill link, FR-22.31)', () => {
  it('a receipt held by a RECEIVED bill is that bill, not a second purchase', async () => {
    const w = await world()
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]], { issueDate: day('2026-05-20') })
    // The claim `receipt-bill.service.ts` writes: `invoiceId` on the receipt, the receipt on the bill.
    await w.receipt(w.alfa, [[w.bolt, 10, 0.1]], { invoiceId: b._id, date: day('2026-05-12') })
    await Invoice.updateOne({ _id: b._id }, { $set: { stockSource: { marker: 'movement:x', docNumber: 'SM', movementIds: [], detectedBy: 'manual', linkedAt: new Date() } } })
    const facts = await w.factsOf(w.bolt)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ quantity: 10, documents: 1, lastUnitPrice: 0.12, lastDocument: { kind: 'bill' } })
  })

  it("a bill's own receipt (written when it was received) does not count beside it", async () => {
    const w = await world()
    const b = await w.bill(w.beta, [[w.nut, 4, 2]])
    await w.receipt(w.beta, [[w.nut, 4, 2]], { invoiceId: b._id })
    expect((await w.factsOf(w.nut))[0]).toMatchObject({ quantity: 4, documents: 1, lastDocument: { kind: 'bill' } })
  })

  it('a receipt held only by a DRAFT bill still counts: the draft is no evidence yet, and the goods came', async () => {
    const w = await world()
    const r = await w.receipt(w.alfa, [[w.bolt, 10, 0.1]])
    const draft = await w.bill(w.alfa, [[w.bolt, 10, 0.12]], {
      status: 'draft',
      stockSource: { marker: `movement:${r._id}`, docNumber: r.movementNumber, movementIds: [r._id], detectedBy: 'manual', linkedAt: new Date() },
    })
    await StockMovement.updateOne({ _id: r._id }, { $set: { invoiceId: draft._id } })

    let facts = await w.factsOf(w.bolt)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ quantity: 10, documents: 1, lastUnitPrice: 0.1, lastDocument: { kind: 'receipt' } })

    // Received: the bill is the purchase, at the supplier's price, and the receipt stops counting.
    await Invoice.updateOne({ _id: draft._id }, { $set: { status: 'received' } })
    facts = await w.factsOf(w.bolt)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ quantity: 10, documents: 1, lastUnitPrice: 0.12, lastDocument: { kind: 'bill', id: String(draft._id) } })
  })

  it('a voided bill gives its receipt back: the claim is released, and the goods are a purchase of their own again', async () => {
    const w = await world()
    const r = await w.receipt(w.alfa, [[w.bolt, 10, 0.1]])
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]], {
      stockSource: { marker: `movement:${r._id}`, docNumber: r.movementNumber, movementIds: [r._id], detectedBy: 'manual', linkedAt: new Date() },
    })
    await StockMovement.updateOne({ _id: r._id }, { $set: { invoiceId: b._id } })
    expect((await w.factsOf(w.bolt))[0]).toMatchObject({ documents: 1, lastDocument: { kind: 'bill' } })

    // What the void route does: the bill goes, `releaseReceiptLinks` unsets the claim.
    await Invoice.updateOne({ _id: b._id }, { $set: { status: 'voided' } })
    await StockMovement.updateOne({ _id: r._id }, { $unset: { invoiceId: 1 } })
    expect((await w.factsOf(w.bolt))[0]).toMatchObject({ quantity: 10, documents: 1, lastDocument: { kind: 'receipt', id: String(r._id) } })
  })

  it("a voided bill's OWN receipt (reversed with it) is nobody's purchase", async () => {
    const w = await world()
    const b = await w.bill(w.beta, [[w.nut, 4, 2]])
    await w.receipt(w.beta, [[w.nut, 4, 2]], { invoiceId: b._id })
    await Invoice.updateOne({ _id: b._id }, { $set: { status: 'voided' } })
    expect(await w.factsOf(w.nut)).toEqual([])
  })
})

describe('the facts move with the documents, at once', () => {
  it("editing an issued bill's supplier moves the fact to the new supplier", async () => {
    const w = await world()
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    expect((await w.factsOf(w.bolt))[0].supplierName).toBe('Alfa Fasteners')
    await Invoice.updateOne({ _id: b._id }, { $set: { contactId: w.beta._id } })
    const facts = await w.factsOf(w.bolt)
    expect(facts).toHaveLength(1)
    expect(facts[0].supplierName).toBe('Beta Tools')
  })

  it("editing a line's article moves the fact to the new article", async () => {
    const w = await world()
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await Invoice.updateOne({ _id: b._id }, { $set: { 'lines.0.productId': w.nut._id } })
    expect(await w.factsOf(w.bolt)).toEqual([])
    expect((await w.factsOf(w.nut))[0]).toMatchObject({ quantity: 10, supplierName: 'Alfa Fasteners' })
  })

  it("editing a bill's price moves the last price: a stored copy would keep the old one", async () => {
    const w = await world()
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await Invoice.updateOne({ _id: b._id }, { $set: { 'lines.0.unitPrice': 0.15 } })
    expect((await w.factsOf(w.bolt))[0].lastUnitPrice).toBe(0.15)
  })

  it('voiding the bill removes its fact', async () => {
    const w = await world()
    const b = await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    expect(await w.factsOf(w.bolt)).toHaveLength(1)
    await Invoice.updateOne({ _id: b._id }, { $set: { status: 'voided' } })
    expect(await w.factsOf(w.bolt)).toEqual([])
  })
})

describe('several documents, several suppliers, and their order', () => {
  it('sums the quantity and the documents of one supplier; the last price is the latest document', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.1]], { issueDate: day('2026-03-01') })
    await w.bill(w.alfa, [[w.bolt, 5, 0.2]], { issueDate: day('2026-06-01') })
    await w.receipt(w.alfa, [[w.bolt, 2.5, 0.3]], { date: day('2026-04-15') })
    const [fact] = await w.factsOf(w.bolt)
    expect(fact).toMatchObject({ quantity: 17.5, documents: 3, lastUnitPrice: 0.2, lastDocument: { kind: 'bill' } })
    expect(fact.lastPurchasedAt.toISOString()).toBe(day('2026-06-01').toISOString())
  })

  it('a bill outranks a receipt on the same instant', async () => {
    const w = await world()
    await w.receipt(w.alfa, [[w.bolt, 1, 0.3]], { date: day('2026-06-01') })
    await w.bill(w.alfa, [[w.bolt, 1, 0.2]], { issueDate: day('2026-06-01') })
    expect((await w.factsOf(w.bolt))[0]).toMatchObject({ lastUnitPrice: 0.2, lastDocument: { kind: 'bill' } })
  })

  it('lists the most recent supplier first, ties by supplier id', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]], { issueDate: day('2026-03-01') })
    await w.bill(w.beta, [[w.bolt, 1, 1]], { issueDate: day('2026-06-01') })
    await w.receipt(w.gamma, [[w.bolt, 1, 1]], { date: day('2026-04-01') })
    expect((await w.factsOf(w.bolt)).map((f) => f.supplierName)).toEqual(['Beta Tools', 'Gamma Supply', 'Alfa Fasteners'])

    const tie = await world()
    await tie.bill(tie.alfa, [[tie.bolt, 1, 1]], { issueDate: day('2026-06-01') })
    await tie.bill(tie.beta, [[tie.bolt, 1, 1]], { issueDate: day('2026-06-01') })
    const ids = (await tie.factsOf(tie.bolt)).map((f) => f.supplierId)
    expect(ids).toEqual([...ids].sort())
  })

  it('answers every article asked about, empty included, and ignores what is no id', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    const facts = await getSupplierFacts(w.orgId, [String(w.bolt._id), String(w.nut._id), 'not-an-id', ''])
    expect(Object.keys(facts).sort()).toEqual([String(w.bolt._id), String(w.nut._id)].sort())
    expect(facts[String(w.nut._id)]).toEqual([])
  })

  it('never reads another organization', async () => {
    const w = await world()
    const other = await world()
    await other.bill(other.alfa, [[other.bolt, 99, 9]])
    expect(await w.factsOf(w.bolt)).toEqual([])
    // Another organization's article id, asked through this organization.
    const crossed = await getSupplierFacts(w.orgId, [String(other.bolt._id)])
    expect(crossed[String(other.bolt._id)]).toEqual([])
  })

  it('leaves the prices out when the caller may not see them', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await w.receipt(w.beta, [[w.bolt, 1, 0.3]])
    for (const fact of await w.factsOf(w.bolt, { includePrices: false })) {
      expect('lastUnitPrice' in fact).toBe(false)
      expect('currency' in fact).toBe(false)
    }
    const docs = await getRecentSupplierDocuments(w.orgId, String(w.bolt._id), { includePrices: false })
    expect(docs).toHaveLength(2)
    for (const d of docs) {
      expect('unitPrice' in d).toBe(false)
      expect('currency' in d).toBe(false)
    }
  })
})

describe('the other two questions', () => {
  it('finds the articles any of these suppliers sold', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await w.receipt(w.beta, [[w.nut, 1, 1]])
    await w.bill(w.gamma, [[w.washer, 1, 1]])
    const sorted = async (ids: string[]) => (await findProductIdsBySuppliers(w.orgId, ids)).sort()
    expect(await sorted([String(w.alfa._id)])).toEqual([String(w.bolt._id)])
    expect(await sorted([String(w.alfa._id), String(w.beta._id)])).toEqual([String(w.bolt._id), String(w.nut._id)].sort())
    expect(await sorted([String(w.client._id)])).toEqual([])
    expect(await sorted([])).toEqual([])
    expect(await sorted(['nope'])).toEqual([])
  })

  it('finds the articles no document says a supplier sold, and agrees with the facts', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await w.bill(w.beta, [[w.nut, 1, 1]], { status: 'draft' })
    expect((await findProductIdsWithoutSupplier(w.orgId)).sort()).toEqual([String(w.nut._id), String(w.washer._id)].sort())

    // The two never disagree: an article is in exactly one of "has a supplier" and "has none".
    const all = [w.bolt, w.nut, w.washer].map((p) => String(p._id))
    const facts = await getSupplierFacts(w.orgId, all)
    const without = new Set(await findProductIdsWithoutSupplier(w.orgId))
    for (const id of all) expect(without.has(id)).toBe(facts[id].length === 0)
  })

  it('does not list a service or a product of another organization as "without a supplier" of this one', async () => {
    const w = await world()
    const other = await world()
    const ids = new Set(await findProductIdsWithoutSupplier(w.orgId))
    expect(ids.has(String(other.bolt._id))).toBe(false)
    expect(ids.has(String(w.bolt._id))).toBe(true)
  })
})

describe('the default supplier (FR-28.11)', () => {
  it('is the supplier of the most recent purchase', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]], { issueDate: day('2026-03-01') })
    await w.bill(w.beta, [[w.bolt, 1, 1]], { issueDate: day('2026-06-01') })
    const d = (await getDefaultSuppliers(w.orgId, [String(w.bolt._id)])).get(String(w.bolt._id))
    expect(d).toEqual({ supplierId: String(w.beta._id), basis: 'purchase' })
  })

  it('falls back to the supplier of the newest supplier order that carried the article', async () => {
    const w = await world()
    const order = (n: number, supplier: any, createdAt: string) => Order.create({
      orgId: w.org._id, orderNumber: `ORDO-2026-0000${n}`, status: 'draft', statusHistory: [{ status: 'draft', changedAt: new Date() }],
      issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id, createdAt: day(createdAt),
      supplierGroups: [{ supplierId: supplier._id, lines: [{ productId: w.nut._id, description: 'n', quantity: 1, unit: 'pcs', allocations: [] }] }],
    } as any)
    await order(1, w.alfa, '2026-01-01')
    await order(2, w.gamma, '2026-02-01')
    const d = (await getDefaultSuppliers(w.orgId, [String(w.nut._id)])).get(String(w.nut._id))
    expect(d).toEqual({ supplierId: String(w.gamma._id), basis: 'order', orderNumber: 'ORDO-2026-00002' })
  })

  it('a purchase outranks an order, and an article with neither has none', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await Order.create({
      orgId: w.org._id, orderNumber: 'ORDO-2026-00009', status: 'sent', statusHistory: [{ status: 'sent', changedAt: new Date() }],
      issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id,
      supplierGroups: [{ supplierId: w.beta._id, lines: [{ productId: w.bolt._id, description: 'b', quantity: 1, unit: 'pcs', allocations: [] }] }],
    } as any)
    const answers = await getDefaultSuppliers(w.orgId, [String(w.bolt._id), String(w.washer._id)])
    expect(answers.get(String(w.bolt._id))).toMatchObject({ supplierId: String(w.alfa._id), basis: 'purchase' })
    expect(answers.has(String(w.washer._id))).toBe(false)
  })
})

describe('the supplier hint of a customer order is the default supplier (FR-28.11)', () => {
  /** A confirmed customer order that is short of one article: what makes `getInternalOrderSuggestions` answer. */
  async function shortOrder(w: Awaited<ReturnType<typeof world>>, prod: any) {
    return InternalOrder.create({
      orgId: w.org._id, orderNumber: 'ORDI-2026-00001', status: 'confirmed', statusHistory: [{ status: 'confirmed', changedAt: new Date() }],
      contactId: w.client._id, issueDate: new Date(), requestedDeliveryDate: new Date(Date.now() + 7 * 864e5), priority: 'normal',
      currency: 'EUR', exchangeRate: 1, lines: [{ productId: prod._id, description: 'line', quantity: 5, unit: 'pcs' }], createdBy: w.user._id,
    } as any) as any
  }
  const orderFor = (w: Awaited<ReturnType<typeof world>>, supplier: any, prod: any) => Order.create({
    orgId: w.org._id, orderNumber: 'ORDO-2026-00031', status: 'draft', statusHistory: [{ status: 'draft', changedAt: new Date() }],
    issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id,
    supplierGroups: [{ supplierId: supplier._id, lines: [{ productId: prod._id, description: 'x', quantity: 1, unit: 'pcs', allocations: [] }] }],
  } as any)

  it('names the supplier of the last purchase, even when a supplier order carried the article too', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await orderFor(w, w.beta, w.bolt)
    const ordi = await shortOrder(w, w.bolt)
    const [line] = await getInternalOrderSuggestions(w.orgId, String(ordi._id))
    expect(line.supplierHint).toEqual({ supplierId: String(w.alfa._id), source: 'purchase' })
  })

  it('falls back to the newest supplier order, naming it, when nothing was ever bought', async () => {
    const w = await world()
    await orderFor(w, w.beta, w.nut)
    const ordi = await shortOrder(w, w.nut)
    const [line] = await getInternalOrderSuggestions(w.orgId, String(ordi._id))
    expect(line.supplierHint).toEqual({ supplierId: String(w.beta._id), orderNumber: 'ORDO-2026-00031', source: 'order' })
  })

  it('has no hint for an article nobody bought and nobody ordered', async () => {
    const w = await world()
    const ordi = await shortOrder(w, w.washer)
    const [line] = await getInternalOrderSuggestions(w.orgId, String(ordi._id))
    expect(line.supplierHint).toBeUndefined()
  })
})

describe('the Suppliers tab: the last ten documents', () => {
  it('lists the newest first, bills and receipts, capped at ten', async () => {
    const w = await world()
    for (let i = 1; i <= 8; i++) await w.bill(w.alfa, [[w.bolt, i, 1]], { issueDate: day(`2026-03-${String(i).padStart(2, '0')}`) })
    for (let i = 1; i <= 4; i++) await w.receipt(w.beta, [[w.bolt, i, 1]], { date: day(`2026-04-${String(i).padStart(2, '0')}`) })
    const docs = await getRecentSupplierDocuments(w.orgId, String(w.bolt._id))
    expect(docs).toHaveLength(10)
    expect(docs.map((d) => d.date.getTime())).toEqual([...docs.map((d) => d.date.getTime())].sort((a, b) => b - a))
    expect(docs.filter((d) => d.kind === 'receipt')).toHaveLength(4)
    expect(docs[0]).toMatchObject({ kind: 'receipt', supplierName: 'Beta Tools' })
  })

  it('leaves the receipts out for a caller who may not open a stock movement', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await w.receipt(w.beta, [[w.bolt, 1, 1]])
    const docs = await getRecentSupplierDocuments(w.orgId, String(w.bolt._id), { includeReceipts: false })
    expect(docs.map((d) => d.kind)).toEqual(['bill'])
  })
})

describe('who may see supplier facts (FR-28.6, .3): the keys are absent, not hidden', () => {
  // Roles as tokens carry them: an inventory-only role reads no bills; a Seller holds invoicing but its areas lack `purchases`.
  const INVENTORY_ONLY = { role: 'member', permissions: ['inventory.read'] }
  const SELLER = { role: 'seller', permissions: ['invoicing.read', 'invoicing.write', 'inventory.read'], areas: [] as string[] }
  const BILLS_READER = { role: 'accountant', permissions: ['invoicing.read', 'inventory.read'] }

  it('by-products: a caller who reads bills gets facts and counts; anyone else gets no `suppliers` key at all', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await w.bill(w.beta, [[w.bolt, 1, 0.5]])
    const path = `/product-supplier/by-products?productIds=${w.bolt._id},${w.nut._id}`

    const admin = await w.call(await w.token(), path)
    expect(admin.status).toBe(200)
    expect(admin.json.suppliers[String(w.bolt._id)]).toHaveLength(2)
    expect(admin.json.suppliers[String(w.nut._id)]).toEqual([])
    expect(admin.json.counts[String(w.bolt._id)]).toBe(2)
    expect(admin.json.suppliers[String(w.bolt._id)][0]).toMatchObject({ lastUnitPrice: expect.any(Number), currency: 'EUR' })

    for (const who of [BILLS_READER]) {
      const r = await w.call(await w.token(who), path)
      expect(r.status).toBe(200)
      expect(Object.keys(r.json)).toContain('suppliers')
    }
    for (const who of [INVENTORY_ONLY, SELLER]) {
      const r = await w.call(await w.token(who), path)
      expect(r.status).toBe(200)
      expect(r.json).toEqual({})
      // The JSON is checked, not a column: nothing of the facts is anywhere in the body.
      expect(r.text).not.toContain('Alfa')
      expect(r.text).not.toContain('Beta')
      expect(r.text).not.toContain('supplier')
      expect(r.text).not.toContain('lastUnitPrice')
    }
  })

  it('by-products: at most 100 articles, five facts each, and the count says how many there are', async () => {
    const w = await world()
    const suppliers = []
    for (let i = 0; i < 7; i++) suppliers.push(await createTestContact(w.org._id, { type: 'supplier', companyName: `Supplier ${i}` } as any))
    for (let i = 0; i < 7; i++) await w.bill(suppliers[i], [[w.bolt, 1, 1]], { issueDate: day(`2026-02-${String(i + 1).padStart(2, '0')}`) })
    const r = await w.call(await w.token(), `/product-supplier/by-products?productIds=${w.bolt._id}`)
    expect(r.json.suppliers[String(w.bolt._id)]).toHaveLength(5)
    expect(r.json.counts[String(w.bolt._id)]).toBe(7)
    // The five are the most recent.
    expect(r.json.suppliers[String(w.bolt._id)][0].supplierName).toBe('Supplier 6')

    const many = Array.from({ length: 101 }, () => String(new Types.ObjectId())).join(',')
    const tooMany = await w.call(await w.token(), `/product-supplier/by-products?productIds=${many}`)
    expect(tooMany.status).toBe(422)
    expect(tooMany.json.code).toBe('too_many_products')
    const none = await w.call(await w.token(), '/product-supplier/by-products')
    expect(none.json).toEqual({ suppliers: {}, counts: {} })
  })

  it('the tab: facts and documents for a caller who reads bills, 403 for anyone else, 404 for an unknown article', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await w.receipt(w.beta, [[w.bolt, 2, 0.1]])
    const ok = await w.call(await w.token(), `/product-supplier/${w.bolt._id}`)
    expect(ok.status).toBe(200)
    expect(ok.json.suppliers).toHaveLength(2)
    expect(ok.json.documents).toHaveLength(2)

    for (const who of [INVENTORY_ONLY, SELLER]) {
      const refused = await w.call(await w.token(who), `/product-supplier/${w.bolt._id}`)
      expect(refused.status).toBe(403)
      expect(refused.json).toMatchObject({ code: 'capability_required', capabilities: ['bills.view'] })
      expect(refused.text).not.toContain('Alfa')
    }
    // A caller with invoicing alone never reaches the route: `warehouse/*` reads need `products.view` or
    // `.lookup` (`config/access/routes.ts`), which the access guards pin. What a caller who reads bills but not
    // stock movements gets back (the bills, no receipts) is `includeReceipts`, tested above on the service.

    const missing = await w.call(await w.token(), `/product-supplier/${new Types.ObjectId()}`)
    expect(missing.status).toBe(404)
  })

  it('the list: the supplier filters are refused with 403 for a caller who may not read bills', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    for (const who of [INVENTORY_ONLY, SELLER]) {
      const bySupplier = await w.call(await w.token(who), `/product?supplierId=${w.alfa._id}`)
      expect(bySupplier.status).toBe(403)
      expect(bySupplier.json).toMatchObject({ code: 'capability_required', capabilities: ['bills.view'] })
      const none = await w.call(await w.token(who), '/product?noSupplier=true')
      expect(none.status).toBe(403)
      // The same caller reads the list as before: only the supplier filters are refused.
      const plain = await w.call(await w.token(who), '/product')
      expect(plain.status).toBe(200)
      expect(plain.json.products.length).toBe(3)
    }
  })
})

/** What the winning plans of an explain document do: the stages they run and the indexes they read. */
function winningPlans(explain: unknown): { stages: string[]; indexes: string[] } {
  const stages: string[] = []
  const indexes: string[] = []
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'stage' && typeof x === 'string') stages.push(x)
        else if (k === 'indexName' && typeof x === 'string') indexes.push(x)
        else if (k !== 'rejectedPlans') walk(x)
      }
    }
  }
  walk(explain)
  return { stages, indexes }
}

describe('the indexes (FR-28.2): the evidence queries read the index made for them', () => {
  it('reads bills and receipts by article, and by supplier, through their own index and never a collection scan', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await w.receipt(w.alfa, [[w.bolt, 1, 1]])
    const pids = [w.bolt._id]
    const suppliers = [w.alfa._id]
    const claims: any[] = []

    //  alone is too weak: the older { orgId, direction, … } indexes satisfy it by prefix and read
    // every bill of the organization. Each question names the index it is meant to read.
    const cases: Array<[string, unknown, string[]]> = [
      ['bills by article', await Invoice.aggregate([{ $match: { ...billEvidenceFilter(w.orgId), 'lines.productId': { $in: pids } } }]).explain('queryPlanner'), ['orgId_1_direction_1_lines.productId_1']],
      ['bills by supplier', await Invoice.find({ ...billEvidenceFilter(w.orgId), contactId: { $in: suppliers } } as any).explain('queryPlanner'), ['orgId_1_direction_1_contactId_1']],
      // Either index bounds the scan by organization (and type): the receipts that name a supplier are few next to the
      // bills, so which of the two the planner prefers is immaterial; both beat a scan.
      ['receipts by article', await StockMovement.aggregate([{ $match: { ...receiptEvidenceFilter(w.orgId, claims), 'lines.productId': { $in: pids } } }]).explain('queryPlanner'), ['orgId_1_lines.productId_1_date_-1', 'orgId_1_type_1_contactId_1']],
      ['receipts by supplier', await StockMovement.find({ ...receiptEvidenceFilter(w.orgId, claims), contactId: { $in: suppliers } } as any).explain('queryPlanner'), ['orgId_1_type_1_contactId_1']],
    ]
    for (const [name, plan, expected] of cases) {
      const { stages, indexes } = winningPlans(plan)
      expect({ name, collscan: stages.includes('COLLSCAN') }).toEqual({ name, collscan: false })
      expect({ name, index: indexes.some((i) => expected.includes(i)) ? 'expected' : indexes }).toEqual({ name, index: 'expected' })
    }
  })

  it('the three indexes are declared on the schemas', async () => {
    const names = (idx: any[]) => idx.map((i) => Object.keys(i[0]).join('+'))
    expect(names(Invoice.schema.indexes())).toContain('orgId+direction+lines.productId')
    expect(names(Invoice.schema.indexes())).toContain('orgId+direction+contactId')
    expect(names(StockMovement.schema.indexes())).toContain('orgId+type+contactId')
  })
})

// FR-28.2's budget: a page of 100 articles in 300 ms or less (95th percentile) over 25 000 articles and 20 000
// bills, and the supplier filter likewise. It takes a minute to build and measures a machine, so it runs on mars
// or in the nightly: `LGR_PERF=1 bun test packages/tests/src/integration/product-suppliers.flow.test.ts`.
const perf = process.env.LGR_PERF === '1' ? describe : describe.skip
perf('the budget (opt-in: LGR_PERF=1)', () => {
  it('answers a page of 100 articles, and the supplier filter, within 300 ms at the 95th percentile', async () => {
    const w = await world()
    const ARTICLES = 25_000
    const BILLS = 20_000
    const SUPPLIERS = 200
    const productIds = Array.from({ length: ARTICLES }, () => new Types.ObjectId())
    const supplierIds = Array.from({ length: SUPPLIERS }, () => new Types.ObjectId())
    const orgOid = w.org._id
    await (await import('db/models')).Product.collection.insertMany(productIds.map((_id, i) => ({
      _id, orgId: orgOid, sku: `PRD-${String(i).padStart(6, '0')}`, name: `Article ${i}`, category: 'General', type: 'goods', unit: 'pcs', trackInventory: true, isActive: true,
    })))
    const rnd = (n: number) => Math.floor(Math.random() * n)
    const docs = Array.from({ length: BILLS }, (_, i) => ({
      orgId: orgOid, invoiceNumber: `BILL-PERF-${i}`, type: 'invoice', direction: 'incoming', status: 'received',
      contactId: supplierIds[rnd(SUPPLIERS)], issueDate: new Date(Date.UTC(2026, rnd(11), 1 + rnd(27))), currency: 'EUR',
      lines: Array.from({ length: 3 + rnd(6) }, () => ({ productId: productIds[rnd(ARTICLES)], quantity: 1 + rnd(20), unitPrice: 1 + rnd(50) })),
    }))
    for (let i = 0; i < docs.length; i += 5000) await Invoice.collection.insertMany(docs.slice(i, i + 5000) as any)
    await Invoice.syncIndexes()

    const timed = async (fn: () => Promise<unknown>) => {
      const runs: number[] = []
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now()
        await fn()
        runs.push(performance.now() - t0)
      }
      runs.sort((a, b) => a - b)
      return runs[Math.ceil(runs.length * 0.95) - 1]
    }
    const page = productIds.slice(0, 100).map(String)
    const factsP95 = await timed(() => getSupplierFacts(w.orgId, page))
    const filterP95 = await timed(() => findProductIdsBySuppliers(w.orgId, [String(supplierIds[0])]))
    // "No supplier" is the heaviest of the three: it has to see every purchased article to name the rest. The spec
    // sets no budget for it, so it is measured and held to a generous one, to catch a regression and not a machine.
    const noSupplierP95 = await timed(() => findProductIdsWithoutSupplier(w.orgId))
    console.log(`FR-28.2 budget: facts p95 ${factsP95.toFixed(0)} ms, supplier filter p95 ${filterP95.toFixed(0)} ms, no-supplier p95 ${noSupplierP95.toFixed(0)} ms`)
    expect(factsP95).toBeLessThanOrEqual(300)
    expect(filterP95).toBeLessThanOrEqual(300)
    expect(noSupplierP95).toBeLessThanOrEqual(1000)
  }, 600_000)
})
