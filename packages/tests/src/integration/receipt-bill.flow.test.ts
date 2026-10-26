import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { receiptBillController } from 'invoicing-api/src/controllers/receipt-bill.controller'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { planDeleteDocFiles } from 'services/biz/files/doc-delete.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { DocFile, Invoice, Product, StockLevel, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.31 / #168 — the supplier's bill for goods a receipt already booked (FR-22 B-4).
 *
 * Goods come before the invoice: a receipt books them, and days later the supplier's bill is
 * entered. A bill receives its own goods, so the bill typed in for them used to put them in stock
 * a second time. Made FROM the receipt, the bill is linked to it (`stockSource`, detectedBy
 * 'manual') and moves no stock on any path; the receipt is billed once (D-2), a void gives it
 * back, and nothing rolls the receipt back while a bill stands on it (§5.3, §5.4).
 *
 * Driven over HTTP through the real controllers: the guards live on the routes.
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(invoiceController).use(receiptBillController).use(movementController).use(productController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const other = await createTestContact(org._id, { companyName: 'Друг доставчик ЕООД', type: 'supplier' } as any)
  const warehouse = await createTestWarehouse(org._id, { isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { sku: 'PRD-0002', name: 'Гайка М8', purchasePrice: 2, sellingPrice: 4, taxRate: 20 } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** A completed goods receipt into the warehouse, as the receipt form books it. */
  async function receipt(lines: Array<[any, number, number]>, opts: { contactId?: string | null; date?: string; confirm?: boolean } = {}) {
    const ls = lines.map(([p, q, cost]) => ({ productId: String(p._id), quantity: q, unitCost: cost, totalCost: q * cost }))
    const contactId = opts.contactId === null ? undefined : (opts.contactId ?? String(supplier._id))
    const created = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: opts.date || '2026-10-20', toWarehouseId: String(warehouse._id),
      ...(contactId ? { contactId } : {}), lines: ls, totalAmount: ls.reduce((s, l) => s + l.totalCost, 0),
    })
    expect(created.status).toBe(200)
    const id = created.json.stockMovement._id || created.json.stockMovement.id
    if (opts.confirm !== false) expect((await call('POST', `/warehouse/movement/${id}/confirm`, {})).status).toBe(200)
    return StockMovement.findById(id).lean().exec() as Promise<any>
  }

  const fromReceipt = (movementIds: unknown[], extra: Record<string, any> = {}) =>
    call('POST', '/invoicing/bills/from-receipt', { movementIds: movementIds.map(String), ...extra })
  const stock = async (product: any) =>
    Number(((await StockLevel.findOne({ orgId, productId: product._id, warehouseId: warehouse._id }).lean().exec()) as any)?.quantity ?? 0)
  const load = (id: unknown) => Invoice.findById(id).lean().exec() as Promise<any>
  const mv = (id: unknown) => StockMovement.findById(id).lean().exec() as Promise<any>
  const movementCount = () => StockMovement.countDocuments({ orgId }).exec()
  /** Receive a bill the way its form does: the supplier's number, then „Получи". */
  async function receive(bill: any, reference = 'F-1001') {
    const put = await call('PUT', `/invoices/${bill.id}`, { reference })
    expect(put.status).toBe(200)
    return call('POST', `/invoices/${bill.id}/receive`)
  }

  return { org, orgId, user, supplier, other, warehouse, bolt, nut, call, receipt, fromReceipt, stock, load, mv, movementCount, receive }
}

describe('a bill made from a goods receipt (FR-22.31)', () => {
  it('is a draft bill of the supplier, with the receipt\'s lines at their costs, linked to it', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5.5], [w.nut, 4, 2.25]])

    const res = await w.fromReceipt([r._id])
    expect(res.status).toBe(200)
    const bill = await w.load(res.json.invoice.id)

    expect([bill.type, bill.direction, bill.status]).toEqual(['invoice', 'incoming', 'draft'])
    expect(bill.invoiceNumber).toMatch(/^DRF-/)
    expect(String(bill.contactId)).toBe(String(w.supplier._id))
    expect(bill.lines.map((l: any) => [String(l.productId), l.quantity, l.unitPrice, l.taxRate, String(l.warehouseId), l.description])).toEqual([
      [String(w.bolt._id), 10, 5.5, 20, String(w.warehouse._id), 'Болт М8'],
      [String(w.nut._id), 4, 2.25, 20, String(w.warehouse._id), 'Гайка М8'],
    ])
    // 55 + 9 = 64 net, 20 % VAT.
    expect([bill.subtotal, bill.taxTotal, bill.total, bill.amountDue]).toEqual([64, 12.8, 76.8, 76.8])
    expect(bill.stockSource).toMatchObject({ marker: `movement:${r._id}`, docNumber: r.movementNumber, detectedBy: 'manual' })
    expect(bill.stockSource.movementIds.map(String)).toEqual([String(r._id)])
    // The receipt is claimed by the bill: the product ledger names it next to the receipt.
    expect(String((await w.mv(r._id)).invoiceId)).toBe(String(bill._id))
    const ledger = await getProductLedger(w.orgId, String(w.bolt._id))
    expect(ledger.entries.find((e: any) => e.documentRef === r.movementNumber)?.invoiceNumber).toBe(bill.invoiceNumber)

    // Both pages name the other.
    const page = await w.call('GET', `/invoices/${bill._id}`)
    expect(page.json.invoice.receipts.map((x: any) => [x.number, x.held])).toEqual([[r.movementNumber, true]])
    const rPage = await w.call('GET', `/warehouse/movement/${r._id}`)
    expect(rPage.json.stockMovement).toMatchObject({ number: r.movementNumber, billable: false, bill: { number: bill.invoiceNumber } })
    const list = await w.call('GET', '/warehouse/movement?type=receipt')
    expect(list.json.stockMovements.find((m: any) => m.number === r.movementNumber).bill.number).toBe(bill.invoiceNumber)
  }, 60_000)

  it('receiving it moves no stock — B-4: the goods are counted once', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5], [w.nut, 4, 2]])
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([10, 4])
    const movements = await w.movementCount()

    const bill = (await w.fromReceipt([r._id])).json.invoice
    const res = await w.receive(bill)
    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('received')
    expect(res.json.invoice.invoiceNumber).toMatch(/^BILL-/)

    // Exactly what the receipt booked, and not one movement more.
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([10, 4])
    expect(await w.movementCount()).toBe(movements)
    expect(await StockMovement.countDocuments({ orgId: w.orgId, invoiceId: bill.id }).exec()).toBe(1)
  }, 60_000)

  it('a receipt is billed once: a second bill answers 409, and of two at once only one is made', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 3, 5]])
    expect((await w.fromReceipt([r._id])).status).toBe(200)
    const again = await w.fromReceipt([r._id])
    expect([again.status, again.json.code]).toEqual([409, 'receipt_already_billed'])

    const r2 = await w.receipt([[w.nut, 2, 2]])
    const raced = await Promise.all([w.fromReceipt([r2._id]), w.fromReceipt([r2._id])])
    expect(raced.map(x => x.status).sort()).toEqual([200, 409])
    expect(await Invoice.countDocuments({ orgId: w.orgId, 'stockSource.movementIds': r2._id }).exec()).toBe(1)
  }, 60_000)

  it('voiding it moves nothing and gives the receipt back, to be billed again (§5.3)', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const bill = (await w.fromReceipt([r._id])).json.invoice
    expect((await w.receive(bill)).status).toBe(200)
    const movements = await w.movementCount()

    const voided = await w.call('POST', `/invoices/${bill.id}/void`)
    expect(voided.status).toBe(200)
    expect(voided.json.invoice.status).toBe('voided')
    expect(await w.stock(w.bolt)).toBe(10)
    expect(await w.movementCount()).toBe(movements)
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()
    // The voided bill keeps the record of what it was for.
    expect((await w.load(bill.id)).stockSource.docNumber).toBe(r.movementNumber)
    expect((await w.call('GET', `/warehouse/movement/${r._id}`)).json.stockMovement.billable).toBe(true)

    const second = await w.fromReceipt([r._id])
    expect(second.status).toBe(200)
    expect((await w.receive(second.json.invoice, 'F-1002')).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(10)
  }, 60_000)

  it('deleting or voiding a DRAFT made from a receipt gives the receipt back too', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 1, 5]])
    const draft = (await w.fromReceipt([r._id])).json.invoice
    expect((await w.call('DELETE', `/invoices/${draft.id}`)).status).toBe(200)
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()

    const draft2 = (await w.fromReceipt([r._id])).json.invoice
    expect((await w.call('POST', `/invoices/${draft2.id}/void`)).status).toBe(200)
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()
    expect((await w.fromReceipt([r._id])).status).toBe(200)
  }, 60_000)

  it('a receipt a live bill stands on cannot be rolled back under it (§5.4)', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const bill = (await w.fromReceipt([r._id])).json.invoice
    const doc = await DocFile.create({
      orgId: w.org._id, docType: 'stokrazp', docNumber: '3000016317', docDate: '2026-10-20',
      originalName: 'stokrazp_3000016317.pdf', currentPath: '/nowhere', currentChecksum: 'x',
      mimeType: 'application/pdf', size: 1, uploadedBy: w.user._id, status: 'committed', committedIds: [r._id],
      uploadedAt: new Date(Date.now() - 3_600_000),
    } as any)

    const blocked = await planDeleteDocFiles(w.orgId, [String(doc._id)], { rollback: true })
    expect(blocked.plans[0].blocked).toContain(bill.invoiceNumber)
    expect(blocked.plans[0].movements[0].action).toBe('skip')

    expect((await w.call('POST', `/invoices/${bill.id}/void`)).status).toBe(200)
    const free = await planDeleteDocFiles(w.orgId, [String(doc._id)], { rollback: true })
    expect(free.plans[0].blocked).toBeUndefined()
    expect(free.plans[0].movements[0].action).toBe('reverse')
  }, 60_000)

  it('covers several receipts of ONE supplier, and refuses two suppliers (422) claiming nothing', async () => {
    const w = await world()
    const a1 = await w.receipt([[w.bolt, 10, 5]])
    const a2 = await w.receipt([[w.nut, 6, 2], [w.bolt, 2, 5]])
    const res = await w.fromReceipt([a1._id, a2._id])
    expect(res.status).toBe(200)
    const bill = await w.load(res.json.invoice.id)
    expect(bill.lines.map((l: any) => [l.description, l.quantity])).toEqual([['Болт М8', 10], ['Гайка М8', 6], ['Болт М8', 2]])
    expect(bill.stockSource.marker).toBe(`movement:${a1._id},${a2._id}`)
    expect(bill.stockSource.docNumber).toBe(`${a1.movementNumber}, ${a2.movementNumber}`)

    const b = await w.receipt([[w.bolt, 1, 5]], { contactId: String(w.other._id) })
    const a3 = await w.receipt([[w.bolt, 1, 5]])
    const bills = await Invoice.countDocuments({ orgId: w.orgId }).exec()
    const mixed = await w.fromReceipt([a3._id, b._id])
    expect([mixed.status, mixed.json.code]).toEqual([422, 'mixed_suppliers'])
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(bills)
    expect((await w.mv(a3._id)).invoiceId).toBeUndefined()
    expect((await w.mv(b._id)).invoiceId).toBeUndefined()
  }, 60_000)

  it('refuses what is not a booked receipt of a supplier, or is a bill\'s own receipt', async () => {
    const w = await world()
    const draft = await w.receipt([[w.bolt, 1, 5]], { confirm: false })
    expect((await w.fromReceipt([draft._id])).json.code).toBe('receipt_not_completed')
    const anonymous = await w.receipt([[w.bolt, 1, 5]], { contactId: null })
    expect((await w.fromReceipt([anonymous._id])).json.code).toBe('receipt_without_supplier')
    expect((await w.fromReceipt(['6a0000000000000000000000'])).status).toBe(404)
    expect((await w.fromReceipt(['not-an-id'])).status).toBe(404)

    // A plain bill books its own receipt; that receipt is already billed — by that bill.
    const plain = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-20', currency: 'EUR',
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 2, unitPrice: 5, taxRate: 20 }],
      subtotal: 10, total: 12,
    })
    expect((await w.call('POST', `/invoices/${plain.json.invoice.id}/receive`)).status).toBe(200)
    const own = await StockMovement.findOne({ orgId: w.orgId, invoiceId: plain.json.invoice.id }).lean().exec() as any
    const res = await w.fromReceipt([own._id])
    expect([res.status, res.json.code]).toEqual([409, 'receipt_already_billed'])
  }, 60_000)

  it('a plain create or edit can neither forge the link nor take it away', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const forged = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-20', currency: 'EUR',
      stockSource: { marker: `movement:${r._id}`, docNumber: r.movementNumber, movementIds: [String(r._id)], detectedBy: 'manual' },
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 3, unitPrice: 5, taxRate: 20 }],
      subtotal: 15, total: 18,
    })
    expect(forged.status).toBe(200)
    expect((await w.load(forged.json.invoice.id)).stockSource?.marker).toBeUndefined()
    const putForged = await w.call('PUT', `/invoices/${forged.json.invoice.id}`, { stockSource: { marker: 'movement:x', detectedBy: 'manual' } })
    expect(putForged.status).toBe(200)
    expect((await w.load(forged.json.invoice.id)).stockSource?.marker).toBeUndefined()
    // Not linked, so it receives its own goods, as every plain bill does.
    expect((await w.call('POST', `/invoices/${forged.json.invoice.id}/receive`)).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(13)

    const r2 = await w.receipt([[w.nut, 4, 2]])
    const bill = (await w.fromReceipt([r2._id])).json.invoice
    expect((await w.call('PUT', `/invoices/${bill.id}`, { stockSource: { marker: '' }, reference: 'F-7' })).status).toBe(200)
    expect((await w.load(bill.id)).stockSource.marker).toBe(`movement:${r2._id}`)
  }, 60_000)

  it('keeps the supplier\'s prices as typed, but bills what was received (D-2)', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const bill = (await w.fromReceipt([r._id])).json.invoice
    const line = (over: Record<string, any> = {}) => ({
      productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 10, unitPrice: 5, taxRate: 20, ...over,
    })

    const priced = await w.call('PUT', `/invoices/${bill.id}`, { lines: [line({ unitPrice: 5.4 })], subtotal: 54, total: 64.8 })
    expect(priced.status).toBe(200)
    expect((await w.load(bill.id)).lines[0].unitPrice).toBe(5.4)
    // Split in two lines: the same 10 received.
    expect((await w.call('PUT', `/invoices/${bill.id}`, { lines: [line({ quantity: 6 }), line({ quantity: 4 })] })).status).toBe(200)
    // A transport fee on the supplier's invoice holds no stock.
    expect((await w.call('PUT', `/invoices/${bill.id}`, { lines: [line(), { description: 'Транспорт', quantity: 1, unitPrice: 15, taxRate: 20 }] })).status).toBe(200)

    const less = await w.call('PUT', `/invoices/${bill.id}`, { lines: [line({ quantity: 9 })] })
    expect([less.status, less.json.code]).toEqual([422, 'receipt_quantity_mismatch'])
    expect(less.json.lines[0]).toMatchObject({ received: 10, billed: 9 })
    const extra = await w.call('PUT', `/invoices/${bill.id}`, { lines: [line(), line({ productId: String(w.nut._id), description: 'Гайка М8', quantity: 1 })] })
    expect([extra.status, extra.json.code]).toEqual([422, 'receipt_quantity_mismatch'])
    const other = await w.call('PUT', `/invoices/${bill.id}`, { contactId: String(w.other._id) })
    expect([other.status, other.json.code]).toEqual([422, 'supplier_mismatch'])
  }, 60_000)

  it('receiving it carries the billed price forward to future receipts, and re-costs nothing', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5], [w.nut, 4, 2]])
    const avgBefore = Number(((await StockLevel.findOne({ orgId: w.orgId, productId: w.bolt._id }).lean().exec()) as any).avgCost)
    const bill = (await w.fromReceipt([r._id])).json.invoice
    // The nut's purchase price was changed since the receipt: that is newer than this bill.
    await Product.updateOne({ _id: w.nut._id }, { $set: { purchasePrice: 2.6 } }).exec()
    const lines = [
      { productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 10, unitPrice: 5.5, taxRate: 20 },
      { productId: String(w.nut._id), warehouseId: String(w.warehouse._id), description: 'Гайка М8', quantity: 4, unitPrice: 2.2, taxRate: 20 },
    ]
    expect((await w.call('PUT', `/invoices/${bill.id}`, { lines, reference: 'F-9', subtotal: 63.8, total: 76.56 })).status).toBe(200)
    expect((await w.call('POST', `/invoices/${bill.id}/receive`)).status).toBe(200)

    const [bolt, nut] = await Promise.all([Product.findById(w.bolt._id).lean().exec() as any, Product.findById(w.nut._id).lean().exec() as any])
    expect(bolt.purchasePrice).toBe(5.5)
    expect(nut.purchasePrice).toBe(2.6)
    const level: any = await StockLevel.findOne({ orgId: w.orgId, productId: w.bolt._id }).lean().exec()
    expect([level.quantity, level.avgCost]).toEqual([10, avgBefore])
  }, 60_000)
})

describe('„Свържи с доставка" (FR-22.32)', () => {
  it('puts a delivery on an empty draft bill, and only on an empty draft', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const listed = await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)
    expect(listed.json.receipts.map((x: any) => x.number)).toEqual([r.movementNumber])
    expect((await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.other._id}`)).json.receipts).toEqual([])

    const empty = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR',
      reference: 'F-55', lines: [], subtotal: 0, total: 0,
    })
    const linked = await w.call('POST', `/invoicing/bills/${empty.json.invoice.id}/link-receipts`, { movementIds: [String(r._id)] })
    expect(linked.status).toBe(200)
    const bill = await w.load(empty.json.invoice.id)
    expect(bill.reference).toBe('F-55')
    expect(bill.lines.map((l: any) => [l.description, l.quantity, l.unitPrice])).toEqual([['Болт М8', 10, 5]])
    expect([bill.subtotal, bill.total]).toEqual([50, 60])
    expect(bill.stockSource.marker).toBe(`movement:${r._id}`)
    expect(String((await w.mv(r._id)).invoiceId)).toBe(String(bill._id))
    expect((await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts).toEqual([])
    expect((await w.call('POST', `/invoices/${bill._id}/receive`)).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(10)

    const r2 = await w.receipt([[w.nut, 1, 2]])
    const withLines = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR',
      lines: [{ productId: String(w.nut._id), warehouseId: String(w.warehouse._id), description: 'Гайка М8', quantity: 1, unitPrice: 2, taxRate: 20 }],
      subtotal: 2, total: 2.4,
    })
    const refused = await w.call('POST', `/invoicing/bills/${withLines.json.invoice.id}/link-receipts`, { movementIds: [String(r2._id)] })
    expect([refused.status, refused.json.code]).toEqual([422, 'bill_not_empty'])
    const received = await w.call('POST', `/invoicing/bills/${bill._id}/link-receipts`, { movementIds: [String(r2._id)] })
    expect(received.status).toBe(422)
    expect((await w.mv(r2._id)).invoiceId).toBeUndefined()
  }, 60_000)
})

describe('a billed receipt keeps its own day in the reports', () => {
  it('the warehouse report and the digest count it on the day the goods came, not the bill\'s', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]], { date: '2026-05-10' })
    const bill = (await w.fromReceipt([r._id], { issueDate: '2026-05-15' })).json.invoice
    expect((await w.receive(bill)).status).toBe(200)

    const entry = reportById('warehouse-operations')!
    const purchases = async (day: string) => (await entry.handler!({
      orgId: w.orgId, output: 'table',
      params: validateParams(entry, { operation: 'purchases', period: { preset: 'custom', from: day, to: day } }),
    })).rows.reduce((s: number, x: any) => s + Number(x.quantity || 0), 0)
    expect(await purchases('2026-05-10')).toBe(10)
    expect(await purchases('2026-05-15')).toBe(0)

    const loaded = async (day: string) => ((await buildDailyDigest(w.orgId, day)).materials as any).loaded.rowCount
    expect(await loaded('2026-05-10')).toBe(1)
    expect(await loaded('2026-05-15')).toBe(0)
  }, 60_000)
})
