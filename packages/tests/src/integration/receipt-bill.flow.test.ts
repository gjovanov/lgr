import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { receiptBillController } from 'invoicing-api/src/controllers/receipt-bill.controller'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { deleteDocFiles, planDeleteDocFiles } from 'services/biz/files/doc-delete.service'
import { mapMovementExtraction, mapStoreOperations } from 'services/biz/doc-import/map-movement'
import { persistMovement } from 'services/biz/doc-import/persist-movement'
import { deliveryNote, movementMarker } from 'config/movement-notes'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { RECEIPT_OVERLAP_WINDOW_DAYS, receiptsOverlapping, releaseReceiptLinks } from 'services/biz/receipt-bill.service'
import { getRepos } from 'services/context'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { AuditLog, Contact, DocFile, Invoice, JournalEntry, Product, StockLevel, StockMovement } from 'db/models'
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
  async function receipt(lines: Array<[any, number, number]>, opts: { contactId?: string | null; date?: string; confirm?: boolean; noWarehouse?: boolean } = {}) {
    const ls = lines.map(([p, q, cost]) => ({ productId: String(p._id), quantity: q, unitCost: cost, totalCost: q * cost }))
    const contactId = opts.contactId === null ? undefined : (opts.contactId ?? String(supplier._id))
    const created = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: opts.date || '2026-10-20', ...(opts.noWarehouse ? {} : { toWarehouseId: String(warehouse._id) }),
      ...(contactId ? { contactId } : {}), lines: ls, totalAmount: ls.reduce((s, l) => s + l.totalCost, 0),
    })
    expect(created.status).toBe(200)
    const id = created.json.stockMovement._id || created.json.stockMovement.id
    if (opts.confirm !== false) expect((await call('POST', `/warehouse/movement/${id}/confirm`, {})).status).toBe(200)
    return StockMovement.findById(id).lean().exec() as Promise<any>
  }

  /** A supplier bill typed by hand: it receives its own goods unless it is linked. */
  async function typedBill(lines: Array<[any, number, number]>, opts: Record<string, any> = {}) {
    const ls = lines.map(([p, q, price]) => ({
      productId: String(p._id), ...(opts.noWarehouse ? {} : { warehouseId: String(warehouse._id) }), description: p.name, quantity: q, unitPrice: price, taxRate: 20,
    }))
    const subtotal = ls.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
    const { noWarehouse: _skip, contactId, ...rest } = opts
    const created = await call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', ...(contactId === null ? {} : { contactId: contactId ?? String(supplier._id) }),
      issueDate: '2026-10-21', currency: 'EUR', lines: ls, subtotal, total: +(subtotal * 1.2).toFixed(2), ...rest,
    })
    expect(created.status).toBe(200)
    return created.json.invoice
  }
  const receiveBill = (bill: any, body?: any) => call('POST', `/invoices/${bill.id || bill._id}/receive`, body)
  const fromReceipt = (movementIds: unknown[], extra: Record<string, any> = {}) =>
    call('POST', '/invoicing/bills/from-receipt', { movementIds: movementIds.map(String), ...extra })
  const linkReceipts = (bill: any, movementIds: unknown[], extra: Record<string, any> = {}) =>
    call('POST', `/invoicing/bills/${bill.id || bill._id}/link-receipts`, { movementIds: movementIds.map(String), ...extra })
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

  return { org, orgId, user, supplier, other, warehouse, bolt, nut, call, receipt, typedBill, receiveBill, fromReceipt, linkReceipts, stock, load, mv, movementCount, receive }
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
    // Not linked, so it receives its own goods, as every plain bill does: asked first, since the
    // receipt is the same supplier's (FR-22.31c), and booked when the user says so.
    const forgedBill = forged.json.invoice
    expect((await w.receiveBill(forgedBill)).json.code).toBe('receipt_overlap')
    expect((await w.receiveBill(forgedBill, { acknowledgeOverlap: true })).status).toBe(200)
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

/** An audit entry is written after the response: wait for it. */
async function auditRow(filter: Record<string, unknown>): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const row = await AuditLog.findOne(filter).lean().exec()
    if (row) return row
    await Bun.sleep(20)
  }
  return null
}

/**
 * Run `meanwhile` just before the claim's compare-and-set on `target` reaches the database: what a
 * concurrent request would have done between the read and the write, without leaving it to timing.
 */
function beforeClaimOf(target: any, meanwhile: () => Promise<unknown>) {
  const real = StockMovement.updateOne.bind(StockMovement)
  let fired = false
  return spyOn(StockMovement, 'updateOne').mockImplementation(((filter: any, update: any) => {
    const query: any = real(filter, update)
    if (fired || String(filter?._id) !== String(target._id)) return query
    fired = true
    const exec = query.exec.bind(query)
    query.exec = async () => {
      await meanwhile()
      return exec()
    }
    return query
  }) as any)
}

describe('a receipt that names no supplier (FR-22.31a)', () => {
  it('asks for the supplier, then bills it: the receipt takes the supplier, stock stays, links both ways', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5], [w.nut, 4, 2]], { contactId: null })
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([10, 4])
    const movements = await w.movementCount()

    const page = (await w.call('GET', `/warehouse/movement/${r._id}`)).json.stockMovement
    expect(page).toMatchObject({ billable: true, needsSupplier: true })
    expect(page.notBillable).toBeUndefined()

    const refused = await w.fromReceipt([r._id])
    expect([refused.status, refused.json.code]).toEqual([422, 'receipt_without_supplier'])
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()

    const res = await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })
    expect(res.status).toBe(200)
    const bill = await w.load(res.json.invoice.id)
    expect(String(bill.contactId)).toBe(String(w.supplier._id))
    expect(bill.lines.map((l: any) => [l.description, l.quantity, l.unitPrice])).toEqual([['Болт М8', 10, 5], ['Гайка М8', 4, 2]])
    expect(bill.stockSource.supplierGivenTo.map(String)).toEqual([String(r._id)])
    const claimed = await w.mv(r._id)
    expect(String(claimed.contactId)).toBe(String(w.supplier._id))
    expect(String(claimed.invoiceId)).toBe(String(bill._id))

    const audit = await auditRow({ orgId: w.org._id, entityType: 'stock_movement', entityId: r._id, action: 'update' })
    expect(audit?.changes?.[0]).toMatchObject({ field: 'contactId', newValue: String(w.supplier._id) })

    const received = await w.receive(res.json.invoice)
    expect(received.status).toBe(200)
    expect(received.json.invoice.status).toBe('received')
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([10, 4])
    expect(await w.movementCount()).toBe(movements)

    expect((await w.call('GET', `/invoices/${bill._id}`)).json.invoice.receipts.map((x: any) => x.number)).toEqual([r.movementNumber])
    const after = (await w.call('GET', `/warehouse/movement/${r._id}`)).json.stockMovement
    expect(after).toMatchObject({ billable: false, bill: { id: String(bill._id) } })
    expect(after.needsSupplier).toBeUndefined()
  }, 60_000)

  it('names the supplier in what reads the receipt, and leaves its journal entry alone', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]], { contactId: null })
    const entries = await JournalEntry.find({ orgId: w.orgId, sourceId: r._id }).lean().exec()
    expect((await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })).status).toBe(200)

    const ledger = await getProductLedger(w.orgId, String(w.bolt._id))
    expect(ledger.entries.find((e: any) => e.documentRef === r.movementNumber)?.contactId).toBe(String(w.supplier._id))
    expect(await JournalEntry.find({ orgId: w.orgId, sourceId: r._id }).lean().exec()).toEqual(entries)
  }, 60_000)

  it('of two conversions naming different suppliers one wins, and the receipt keeps that one', async () => {
    const w = await world()
    for (const product of [w.bolt, w.nut]) {
      const r = await w.receipt([[product, 7, 3]], { contactId: null })
      const raced = await Promise.all([
        w.fromReceipt([r._id], { contactId: String(w.supplier._id) }),
        w.fromReceipt([r._id], { contactId: String(w.other._id) }),
      ])
      expect(raced.map(x => x.status).sort()).toEqual([200, 409])
      const won = raced.find(x => x.status === 200)!
      const bills = await Invoice.find({ orgId: w.orgId, 'stockSource.movementIds': r._id }).lean().exec() as any[]
      expect(bills.map(b => String(b._id))).toEqual([String(won.json.invoice.id)])
      const m = await w.mv(r._id)
      expect(String(m.contactId)).toBe(String(bills[0].contactId))
      expect(String(m.invoiceId)).toBe(String(bills[0]._id))
    }
  }, 60_000)

  it('does not overwrite a supplier that reached the receipt after it was read', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 7, 3]], { contactId: null })
    const spy = beforeClaimOf(r, () => StockMovement.collection.updateOne({ _id: r._id }, { $set: { contactId: w.other._id } }))
    try {
      const lost = await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })
      expect([lost.status, lost.json.code]).toEqual([409, 'receipt_already_billed'])
    } finally {
      spy.mockRestore()
    }
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.other._id))
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
  }, 60_000)

  it('a claim lost on the second receipt gives the first its claim back, and takes its supplier off', async () => {
    const w = await world()
    const first = await w.receipt([[w.bolt, 7, 3]], { contactId: null })
    const second = await w.receipt([[w.nut, 2, 2]], { contactId: null })
    const elsewhere = new Invoice()._id
    const [lower, higher] = [first, second].sort((a, b) => String(a._id).localeCompare(String(b._id)))
    const spy = beforeClaimOf(higher, () => StockMovement.collection.updateOne({ _id: higher._id }, { $set: { invoiceId: elsewhere } }))
    try {
      const lost = await w.fromReceipt([first._id, second._id], { contactId: String(w.supplier._id) })
      expect([lost.status, lost.json.code]).toEqual([409, 'receipt_already_billed'])
    } finally {
      spy.mockRestore()
    }
    const back = await w.mv(lower._id)
    expect(back.invoiceId).toBeUndefined()
    expect(back.contactId).toBeUndefined()
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
  }, 60_000)

  it('refuses a supplier that is no supplier of this org, and one that contradicts a receipt', async () => {
    const w = await world()
    const anonymous = await w.receipt([[w.bolt, 1, 5]], { contactId: null })
    const named = await w.receipt([[w.nut, 1, 2]])
    const customer = await createTestContact(w.org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
    const both = await createTestContact(w.org._id, { companyName: 'И двете АД', type: 'both' } as any)
    const gone = await createTestContact(w.org._id, { companyName: 'Закрит ЕООД', type: 'supplier', isActive: false } as any)
    const otherOrg = await createTestOrg()
    const foreign = await createTestContact(otherOrg._id, { companyName: 'Чужд доставчик', type: 'supplier' } as any)

    for (const contactId of [String(customer._id), String(gone._id), String(foreign._id), 'not-an-id', '6a0000000000000000000000']) {
      const res = await w.fromReceipt([anonymous._id], { contactId })
      expect([res.status, res.json.code]).toEqual([422, 'supplier_not_found'])
    }
    const contradiction = await w.fromReceipt([named._id], { contactId: String(w.other._id) })
    expect([contradiction.status, contradiction.json.code]).toEqual([422, 'supplier_mismatch'])
    const mixed = await w.fromReceipt([anonymous._id, named._id], { contactId: String(w.other._id) })
    expect([mixed.status, mixed.json.code]).toEqual([422, 'supplier_mismatch'])

    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect((await w.mv(anonymous._id)).contactId).toBeUndefined()
    expect((await w.mv(anonymous._id)).invoiceId).toBeUndefined()
    expect(String((await w.mv(named._id)).contactId)).toBe(String(w.supplier._id))

    // A contact that is both a customer and a supplier is a supplier.
    expect((await w.fromReceipt([anonymous._id], { contactId: String(both._id) })).status).toBe(200)
    expect(String((await w.mv(anonymous._id)).contactId)).toBe(String(both._id))
  }, 60_000)

  it('a draft receipt\'s supplier can be cleared, so a wrong pick need not be confirmed', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 7, 3]], { confirm: false })
    expect(String(r.contactId)).toBe(String(w.supplier._id))

    const cleared = await w.call('PUT', `/warehouse/movement/${r._id}`, { contactId: null })
    expect(cleared.status).toBe(200)
    expect((await w.mv(r._id)).contactId ?? null).toBeNull()
    // Left out, it stays.
    await w.call('PUT', `/warehouse/movement/${r._id}`, { contactId: String(w.other._id) })
    await w.call('PUT', `/warehouse/movement/${r._id}`, { notes: 'x' })
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.other._id))

    await w.call('PUT', `/warehouse/movement/${r._id}`, { contactId: null })
    expect((await w.call('POST', `/warehouse/movement/${r._id}/confirm`, {})).status).toBe(200)
    const billed = await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })
    expect(billed.status).toBe(200)
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.supplier._id))
  }, 60_000)

  it('a deactivated supplier can still be billed for the receipt that names it, and takes no other', async () => {
    const w = await world()
    const own = await w.receipt([[w.bolt, 7, 3]])
    const unnamed = await w.receipt([[w.nut, 2, 2]], { contactId: null })
    await Contact.updateOne({ _id: w.supplier._id }, { $set: { isActive: false } }).exec()

    const refused = await w.fromReceipt([unnamed._id], { contactId: String(w.supplier._id) })
    expect([refused.status, refused.json.code]).toEqual([422, 'supplier_not_found'])
    const billed = await w.fromReceipt([own._id], { contactId: String(w.supplier._id) })
    expect(billed.status).toBe(200)
    expect(String((await w.load(billed.json.invoice.id)).contactId)).toBe(String(w.supplier._id))
  }, 60_000)

  it('bills a named and an unnamed receipt together, and only the unnamed one takes the supplier', async () => {
    const w = await world()
    const anonymous = await w.receipt([[w.bolt, 1, 5]], { contactId: null })
    const named = await w.receipt([[w.nut, 1, 2]])
    expect((await w.fromReceipt([anonymous._id, named._id])).json.code).toBe('receipt_without_supplier')

    const res = await w.fromReceipt([anonymous._id, named._id], { contactId: String(w.supplier._id) })
    expect(res.status).toBe(200)
    const bill = await w.load(res.json.invoice.id)
    expect(bill.stockSource.supplierGivenTo.map(String)).toEqual([String(anonymous._id)])

    // Voiding gives each back as it was: the unnamed one names nobody, the named one its supplier.
    expect((await w.call('POST', `/invoices/${bill._id}/void`)).status).toBe(200)
    expect((await w.mv(anonymous._id)).contactId).toBeUndefined()
    expect(String((await w.mv(named._id)).contactId)).toBe(String(w.supplier._id))
  }, 60_000)

  it('a wrong supplier stays correctable: void or delete the bill, and another supplier can bill the receipt', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 3, 5]], { contactId: null })

    const wrong = (await w.fromReceipt([r._id], { contactId: String(w.other._id) })).json.invoice
    expect((await w.call('DELETE', `/invoices/${wrong.id}`)).status).toBe(200)
    const deleted = await w.mv(r._id)
    expect([deleted.invoiceId, deleted.contactId]).toEqual([undefined, undefined])
    expect((await w.call('GET', `/warehouse/movement/${r._id}`)).json.stockMovement).toMatchObject({ billable: true, needsSupplier: true })

    const wrongAgain = (await w.fromReceipt([r._id], { contactId: String(w.other._id) })).json.invoice
    expect((await w.receive(wrongAgain)).status).toBe(200)
    expect((await w.call('POST', `/invoices/${wrongAgain.id}/void`)).status).toBe(200)
    const voided = await w.mv(r._id)
    expect([voided.invoiceId, voided.contactId]).toEqual([undefined, undefined])
    const audit = await auditRow({ orgId: w.org._id, entityId: r._id, correlationId: wrongAgain.id, 'changes.newValue': null })
    expect(audit?.changes?.[0]).toMatchObject({ field: 'contactId', oldValue: String(w.other._id) })

    const right = await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })
    expect(right.status).toBe(200)
    expect((await w.receive(right.json.invoice, 'F-2')).status).toBe(200)
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.supplier._id))
    expect(await w.stock(w.bolt)).toBe(3)
  }, 60_000)

  it('adds nothing to a document whose receipts named their supplier: every other invoice reads as it did', async () => {
    const w = await world()
    const plain = await w.load((await w.typedBill([[w.bolt, 1, 5]])).id)
    expect(plain.stockSource?.supplierGivenTo).toBeUndefined()
    const r = await w.receipt([[w.nut, 1, 2]])
    const billed = await w.load((await w.fromReceipt([r._id])).json.invoice.id)
    expect(billed.stockSource.supplierGivenTo).toBeUndefined()
  }, 60_000)

  describe('a release a void or a delete did not finish (the next touch does)', () => {
    /** The void's own write, and nothing after it: what a crash between the two leaves. */
    const voidedWithNoRelease = async (w: any, wrong: any) => {
      const r = await w.receipt([[w.bolt, 7, 3]], { contactId: null })
      const made = (await w.fromReceipt([r._id], { contactId: String(wrong._id) })).json.invoice
      await Invoice.updateOne({ _id: made.id }, { $set: { status: 'voided' } }).exec()
      const stuck = await w.mv(r._id)
      expect(String(stuck.contactId)).toBe(String(wrong._id))
      expect(String(stuck.invoiceId)).toBe(String(made.id))
      return { r, made }
    }

    it('the receipt page finishes it: the wrong supplier goes, and the page asks again', async () => {
      const w = await world()
      const { r, made } = await voidedWithNoRelease(w, w.other)

      const page = (await w.call('GET', `/warehouse/movement/${r._id}`)).json.stockMovement
      expect(page).toMatchObject({ billable: true, needsSupplier: true })
      expect(page.contactId ?? null).toBeNull()
      expect(page.invoiceId ?? null).toBeNull()
      const m = await w.mv(r._id)
      expect([m.contactId, m.invoiceId]).toEqual([undefined, undefined])

      const audit = await auditRow({ orgId: w.org._id, entityType: 'stock_movement', entityId: r._id, action: 'update', correlationId: new Invoice({ _id: made.id })._id, changes: { $elemMatch: { field: 'contactId', newValue: null } } })
      expect(audit.changes[0]).toMatchObject({ field: 'contactId', newValue: null })
    }, 60_000)

    it('a bill for the right supplier finishes it on its way, instead of refusing it for ever', async () => {
      const w = await world()
      const { r } = await voidedWithNoRelease(w, w.other)
      const right = await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })
      expect(right.status).toBe(200)
      const m = await w.mv(r._id)
      expect(String(m.contactId)).toBe(String(w.supplier._id))
      expect(String(m.invoiceId)).toBe(String(right.json.invoice.id))
    }, 60_000)

    it('so does linking one', async () => {
      const w = await world()
      const { r } = await voidedWithNoRelease(w, w.other)
      const empty = await w.call('POST', '/invoices', { type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0 })
      expect((await w.linkReceipts(empty.json.invoice, [r._id])).status).toBe(200)
      expect(String((await w.mv(r._id)).contactId)).toBe(String(w.supplier._id))
    }, 60_000)

    it('only ever gives back what the voided bill holds: a receipt another bill took since stays taken', async () => {
      const w = await world()
      const { r, made } = await voidedWithNoRelease(w, w.other)
      const live = new Invoice()._id
      await StockMovement.updateOne({ _id: r._id }, { $set: { invoiceId: live } }).exec()
      await releaseReceiptLinks(w.orgId, await w.load(made.id))
      expect(String((await w.mv(r._id)).invoiceId)).toBe(String(live))
    }, 60_000)

    it('a delete gives the receipts back before the bill goes, so the record of who wrote the supplier cannot go first', async () => {
      const w = await world()
      const r = await w.receipt([[w.bolt, 7, 3]], { contactId: null })
      const made = (await w.fromReceipt([r._id], { contactId: String(w.other._id) })).json.invoice
      const repo = getRepos().invoices
      const real = repo.deleteInOrg.bind(repo)
      let atDelete: any = null
      const spy = spyOn(repo, 'deleteInOrg').mockImplementation((async (...args: any[]) => {
        atDelete = await w.mv(r._id)
        return (real as any)(...args)
      }) as any)
      try {
        expect((await w.call('DELETE', `/invoices/${made.id}`)).status).toBe(200)
      } finally {
        spy.mockRestore()
      }
      expect(atDelete).toBeTruthy()
      expect([atDelete.contactId, atDelete.invoiceId]).toEqual([undefined, undefined])
      expect(await w.load(made.id)).toBeNull()
    }, 60_000)
  })

  it('a Files rollback that voids the bill gives the receipt back the same way', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 3, 5]], { contactId: null })
    const typed = await w.typedBill([[w.bolt, 3, 5]])
    expect((await w.linkReceipts(typed, [r._id], { replaceLines: true })).status).toBe(200)
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.supplier._id))
    const doc = await DocFile.create({
      orgId: w.org._id, docType: 'invoicem', docNumber: '0000000301', docDate: '2026-10-21',
      originalName: 'bill_0000000301.pdf', currentPath: '/nowhere', currentChecksum: 'x',
      mimeType: 'application/pdf', size: 1, uploadedBy: w.user._id, status: 'committed', committedIds: [typed.id],
      uploadedAt: new Date(Date.now() - 3_600_000),
    } as any)

    await deleteDocFiles(w.orgId, String(w.user._id), [String(doc._id)], { rollback: true, execute: true })
    expect((await w.load(typed.id)).status).toBe('voided')
    const m = await w.mv(r._id)
    expect([m.invoiceId, m.contactId]).toEqual([undefined, undefined])
    expect((await w.fromReceipt([r._id], { contactId: String(w.other._id) })).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(3)
  }, 60_000)

  it('„Свържи с доставка" lists them after the supplier\'s own, marked, and linking one gives it the bill\'s supplier', async () => {
    const w = await world()
    const anonymous = await w.receipt([[w.bolt, 5, 5]], { contactId: null, date: '2026-10-22' })
    const own = await w.receipt([[w.bolt, 2, 5]], { date: '2026-10-01' })
    const elsewhere = await w.receipt([[w.bolt, 1, 5]], { contactId: String(w.other._id) })

    const listed = (await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts
    expect(listed.map((x: any) => [x.number, !!x.noSupplier])).toEqual([[own.movementNumber, false], [anonymous.movementNumber, true]])
    expect(listed.map((x: any) => x.number)).not.toContain(elsewhere.movementNumber)

    const empty = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    const linked = await w.linkReceipts(empty.json.invoice, [own._id, anonymous._id])
    expect(linked.status).toBe(200)
    expect(String((await w.mv(anonymous._id)).contactId)).toBe(String(w.supplier._id))
    expect((await w.load(empty.json.invoice.id)).stockSource.supplierGivenTo.map(String)).toEqual([String(anonymous._id)])
    expect(await auditRow({ orgId: w.org._id, entityId: anonymous._id, action: 'update', 'changes.field': 'contactId' })).toBeTruthy()
    expect((await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts).toEqual([])
  }, 60_000)

  it('a contact already on the bill is proved only when a receipt is about to take it', async () => {
    const w = await world()
    const customer = await createTestContact(w.org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
    const named = await w.receipt([[w.bolt, 2, 5]], { contactId: String(customer._id) })
    const bill = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(customer._id), issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    expect((await w.linkReceipts(bill.json.invoice, [named._id], { contactId: String(customer._id) })).status).toBe(200)

    const anonymous = await w.receipt([[w.nut, 2, 2]], { contactId: null })
    const other = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(customer._id), issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    const refused = await w.linkReceipts(other.json.invoice, [anonymous._id])
    expect([refused.status, refused.json.code]).toEqual([422, 'supplier_not_found'])
    expect((await w.mv(anonymous._id)).contactId).toBeUndefined()
  }, 60_000)

  it('linking takes the supplier the user sees: a bill with none saved takes it, one that differs is refused', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 5, 5]], { contactId: null })
    const blank = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    expect(blank.status).toBe(200)
    const nobody = await w.linkReceipts(blank.json.invoice, [r._id])
    expect([nobody.status, nobody.json.code]).toEqual([422, 'receipt_without_supplier'])
    const customer = await createTestContact(w.org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
    expect((await w.linkReceipts(blank.json.invoice, [r._id], { contactId: String(customer._id) })).json.code).toBe('supplier_not_found')

    // The form shows another supplier than the bill saved: this receipt must not take the saved one.
    const saved = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.other._id), issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    const stale = await w.linkReceipts(saved.json.invoice, [r._id], { contactId: String(w.supplier._id) })
    expect([stale.status, stale.json.code]).toEqual([422, 'supplier_mismatch'])
    const m = await w.mv(r._id)
    expect([m.contactId, m.invoiceId]).toEqual([undefined, undefined])

    const linked = await w.linkReceipts(blank.json.invoice, [r._id], { contactId: String(w.supplier._id) })
    expect(linked.status).toBe(200)
    expect(String((await w.load(blank.json.invoice.id)).contactId)).toBe(String(w.supplier._id))
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.supplier._id))
  }, 60_000)
})

describe('a receipt that still cannot be billed says why (FR-22.31a)', () => {
  const page = async (w: any, m: any) => (await w.call('GET', `/warehouse/movement/${m._id}`)).json.stockMovement

  it('a draft, and a voided document\'s own receipt', async () => {
    const w = await world()
    const draft = await w.receipt([[w.bolt, 1, 5]], { confirm: false })
    expect(await page(w, draft)).toMatchObject({ billable: false, notBillable: { code: 'receipt_not_completed' } })

    const plain = await w.typedBill([[w.nut, 2, 2]])
    expect((await w.receiveBill(plain)).status).toBe(200)
    const own: any = await StockMovement.findOne({ orgId: w.orgId, invoiceId: plain.id, type: 'receipt' }).lean().exec()
    expect(await page(w, own)).toMatchObject({ billable: false, bill: { id: plain.id } })
    expect((await page(w, own)).notBillable).toBeUndefined()

    expect((await w.call('POST', `/invoices/${plain.id}/void`)).status).toBe(200)
    const number = (await w.load(plain.id)).invoiceNumber
    expect(await page(w, own)).toMatchObject({ billable: false, notBillable: { code: 'receipt_not_billable', number } })
    expect((await page(w, own)).bill).toBeUndefined()
  }, 60_000)

  it('the mirror of a removed document is no delivery: no bill, in no list, overlapping nothing', async () => {
    const w = await world()
    await w.receipt([[w.bolt, 10, 5]])
    const line = { productId: String(w.bolt._id), quantity: 6, unitCost: 5, totalCost: 30 }
    const out = await w.call('POST', '/warehouse/movement', { type: 'transfer', date: '2026-10-20', fromWarehouseId: String(w.warehouse._id), lines: [line], totalAmount: 30 })
    const outId = out.json.stockMovement._id || out.json.stockMovement.id
    expect((await w.call('POST', `/warehouse/movement/${outId}/confirm`, {})).status).toBe(200)
    const doc = await DocFile.create({
      orgId: w.org._id, docType: 'sklrazp', docNumber: '0000000777', docDate: '2026-10-20',
      originalName: 'sklrazp_0000000777.pdf', currentPath: '/nowhere', currentChecksum: 'x',
      mimeType: 'application/pdf', size: 1, uploadedBy: w.user._id, status: 'committed', committedIds: [outId],
      uploadedAt: new Date(Date.now() - 3_600_000),
    } as any)

    // The real rollback books the mirror: a `receipt` that names no supplier.
    await deleteDocFiles(w.orgId, String(w.user._id), [String(doc._id)], { rollback: true, execute: true })
    const mirror: any = await StockMovement.findOne({ orgId: w.orgId, type: 'receipt', status: 'completed', contactId: null }).lean().exec()
    expect(mirror).toBeTruthy()
    expect(await w.stock(w.bolt)).toBe(10)

    expect(await page(w, mirror)).toMatchObject({ billable: false, notBillable: { code: 'receipt_is_reversal' } })
    expect((await w.fromReceipt([mirror._id], { contactId: String(w.supplier._id) })).json.code).toBe('receipt_is_reversal')
    const listed = (await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts
    expect(listed.map((x: any) => x.id)).not.toContain(String(mirror._id))
    await StockMovement.deleteMany({ orgId: w.orgId, contactId: { $ne: null } }).exec()
    const bill = await w.typedBill([[w.bolt, 6, 5]])
    expect((await w.receiveBill(bill)).status).toBe(200)
  }, 60_000)

  it('a receipt rolled back in Files holds no goods: no bill, in no list, overlapping nothing', async () => {
    const w = await world()
    for (const contactId of [undefined, null]) {
      const product = contactId === null ? w.nut : w.bolt
      const r = await w.receipt([[product, 6, 5]], { contactId })
      const doc = await DocFile.create({
        orgId: w.org._id, docType: 'stokrazp', docNumber: `000000077${contactId === null ? 1 : 2}`, docDate: '2026-10-20',
        originalName: 'stokrazp.pdf', currentPath: '/nowhere', currentChecksum: 'x',
        mimeType: 'application/pdf', size: 1, uploadedBy: w.user._id, status: 'committed', committedIds: [r._id],
        uploadedAt: new Date(Date.now() - 3_600_000),
      } as any)
      await deleteDocFiles(w.orgId, String(w.user._id), [String(doc._id)], { rollback: true, execute: true })
      expect(await w.stock(product)).toBe(0)

      const original = await w.mv(r._id)
      expect(original.status).toBe('completed')
      const mirror: any = await StockMovement.findById(original.reversedBy).lean().exec()
      expect(mirror.notes).toContain(r.movementNumber)
      expect(original.reversedAt).toBeInstanceOf(Date)

      expect(await page(w, r)).toMatchObject({ billable: false, notBillable: { code: 'receipt_rolled_back' } })
      const refused = await w.fromReceipt([r._id], { contactId: String(w.supplier._id) })
      expect([refused.status, refused.json.code]).toEqual([422, 'receipt_rolled_back'])
      const listed = (await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts
      expect(listed.map((x: any) => x.id)).not.toContain(String(r._id))

      // The bill for those goods books them: they are not in stock, and nothing asks otherwise.
      const typed = await w.typedBill([[product, 6, 5]])
      expect((await w.receiveBill(typed)).status).toBe(200)
      expect(await w.stock(product)).toBe(6)
    }
  }, 60_000)

  it('a reversal pointing at a sale that is gone was never a claim, so it is not free', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 6, 5]], { contactId: null })
    await StockMovement.updateOne({ _id: r._id }, { $set: { invoiceId: new Invoice()._id } }).exec()
    expect(await page(w, r)).toMatchObject({ billable: false, notBillable: { code: 'receipt_not_billable' } })

    // A claim left by a crash names its supplier, and stays free as it was.
    const named = await w.receipt([[w.nut, 1, 2]])
    await StockMovement.updateOne({ _id: named._id }, { $set: { invoiceId: new Invoice()._id } }).exec()
    expect((await page(w, named)).billable).toBe(true)
  }, 60_000)
})

describe('a bill in another currency is not linked to a delivery (FR-22.32a)', () => {
  it('refuses it, whatever the door, and writes nothing', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const typed = await w.typedBill([[w.bolt, 10, 6]], { currency: 'USD', exchangeRate: 0.9 })
    const before = await w.load(typed.id)

    const refused = await w.linkReceipts(typed, [r._id], { replaceLines: true })
    expect([refused.status, refused.json.code]).toEqual([422, 'bill_foreign_currency'])
    expect([refused.json.currency, refused.json.baseCurrency]).toEqual(['USD', 'EUR'])
    const still = await w.load(typed.id)
    expect(still.lines.map((l: any) => l.unitPrice)).toEqual(before.lines.map((l: any) => l.unitPrice))
    expect(still.stockSource?.marker).toBeUndefined()
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()

    // The form of a bill not saved yet sends its currency, and the bill would have dropped it.
    const fresh = await w.fromReceipt([r._id], { currency: 'USD' })
    expect([fresh.status, fresh.json.code]).toEqual([422, 'bill_foreign_currency'])
    expect(await Invoice.countDocuments({ orgId: w.orgId, 'stockSource.movementIds': r._id }).exec()).toBe(0)
    expect((await w.fromReceipt([r._id], { currency: 'EUR' })).status).toBe(200)
  }, 60_000)

  it('in the org\'s currency the total in base is the total, whatever a stale rate says', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const typed = await w.typedBill([[w.bolt, 10, 6]], { currency: 'EUR', exchangeRate: 1.95583 })
    expect((await w.linkReceipts(typed, [r._id], { replaceLines: true })).status).toBe(200)
    const bill = await w.load(typed.id)
    expect([bill.total, bill.totalBase]).toEqual([60, 60])
  }, 60_000)

  it('a linked bill edited into another currency carries no price to the products', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const made = (await w.fromReceipt([r._id])).json.invoice
    const lines = made.lines.map((l: any) => ({ productId: String(l.productId), description: l.description, quantity: l.quantity, unitPrice: 7, taxRate: l.taxRate }))
    expect((await w.call('PUT', `/invoices/${made.id}`, { currency: 'USD', exchangeRate: 0.9, lines })).status).toBe(200)

    expect((await w.receiveBill(made)).status).toBe(200)
    expect(((await Product.findById(w.bolt._id).lean().exec()) as any).purchasePrice).toBe(5)
  }, 60_000)
})

describe('a receipt naming no supplier that says it is no delivery (FR-22.31a)', () => {
  const page = async (w: any, m: any) => (await w.call('GET', `/warehouse/movement/${m._id}`)).json.stockMovement
  /** Booked the way the importer books what it mapped. */
  const booked = async (w: any, mapped: any) => w.mv((await persistMovement(w.orgId, String(w.user._id), mapped)).id)

  /** No bill, in no list, and a bill for the same goods is asked nothing. */
  async function expectNoDelivery(w: any, m: any, product: any, quantity: number) {
    expect(m.type).toBe('receipt')
    expect(m.contactId).toBeUndefined()
    expect(await page(w, m)).toMatchObject({ billable: false, notBillable: { code: 'receipt_not_a_delivery' } })
    const refused = await w.fromReceipt([m._id], { contactId: String(w.supplier._id) })
    expect([refused.status, refused.json.code]).toEqual([422, 'receipt_not_a_delivery'])
    const listed = (await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts
    expect(listed.map((x: any) => x.id)).not.toContain(String(m._id))
    const typed = await w.typedBill([[product, quantity, 5]])
    const empty = await w.call('POST', '/invoices', { type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR', lines: [], subtotal: 0, total: 0 })
    expect((await w.linkReceipts(empty.json.invoice, [m._id])).json.code).toBe('receipt_not_a_delivery')
    expect((await w.receiveBill(typed)).status).toBe(200)
  }

  it('the positive half of a КОРЕКЦИЯ, as the import maps it', async () => {
    const w = await world()
    const { movements } = await mapMovementExtraction(w.orgId, {
      document_number: '3000000101', issue_date: '2026-10-20', supplier: { name: '2000 КОРЕКЦИЯ' },
      line_items: [{ description: w.bolt.name, quantity: 5, unit_price: 5 }, { description: w.nut.name, quantity: -2, unit_price: 2 }],
    } as any, 'correction', { warehouseId: String(w.warehouse._id), date: '2026-10-20' })
    const plus = movements.find(m => m.type === 'receipt')!
    await expectNoDelivery(w, await booked(w, plus), w.bolt, 5)
  }, 60_000)

  it('a КОРЕКЦИЯ the API scripts booked: their marker is an ordinary one, and only the partner says so', async () => {
    const w = await world()
    const created = await w.call('POST', '/warehouse/movement', {
      type: 'receipt', date: '2026-10-20', toWarehouseId: String(w.warehouse._id), totalAmount: 25,
      notes: deliveryNote('2026-10-20', movementMarker('goods_receipt', '3000000102'), '2000 КОРЕКЦИЯ'),
      lines: [{ productId: String(w.bolt._id), quantity: 5, unitCost: 5, totalCost: 25 }],
    })
    const id = created.json.stockMovement._id || created.json.stockMovement.id
    await w.call('POST', `/warehouse/movement/${id}/confirm`, {})
    await expectNoDelivery(w, await w.mv(id), w.bolt, 5)
  }, 60_000)

  it('a day\'s `Доставки`: several suppliers, and a bill takes a receipt whole', async () => {
    const w = await world()
    const { movements } = await mapStoreOperations(w.orgId, {
      warehouse: null, periodStart: '2026-10-20', rows: [{ name: w.bolt.name, unit: 'БР', qty: 5, price: 5 }],
    } as any, { date: '2026-10-20', warehouseId: String(w.warehouse._id) })
    await expectNoDelivery(w, await booked(w, movements[0]), w.bolt, 5)
  }, 60_000)

  it('the goods coming back on a negative line of a transfer note', async () => {
    const w = await world()
    const { movements } = await mapMovementExtraction(w.orgId, {
      document_number: '0000000103', issue_date: '2026-10-20', line_items: [{ description: w.bolt.name, quantity: -3, unit_price: 5 }],
    } as any, 'transfer_note', { warehouseId: String(w.warehouse._id), date: '2026-10-20' })
    const back = movements.find(m => m.type === 'receipt')!
    await expectNoDelivery(w, await booked(w, back), w.bolt, 3)
  }, 60_000)

  it('a plain разписка stays billable, and its row carries its notes for the person to read', async () => {
    const w = await world()
    // The document names another of the org's own stores: nothing marks that, so a person decides.
    const { movements } = await mapMovementExtraction(w.orgId, {
      document_number: '3000000104', issue_date: '2026-10-20', supplier: { name: 'МАГАЗИН ДРУГ ОБЕКТ' },
      line_items: [{ description: w.bolt.name, quantity: 5, unit_price: 5 }],
    } as any, 'goods_receipt', { warehouseId: String(w.warehouse._id), date: '2026-10-20' })
    const m = await booked(w, movements[0])
    expect(await page(w, m)).toMatchObject({ billable: true, needsSupplier: true })

    const listed = (await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts
    expect(listed.find((x: any) => x.id === String(m._id))).toMatchObject({ noSupplier: true, notes: movements[0].notes })
    const typed = await w.typedBill([[w.bolt, 5, 5]])
    const asked = await w.receiveBill(typed)
    expect(asked.json.receipts[0]).toMatchObject({ id: String(m._id), noSupplier: true, notes: movements[0].notes })
  }, 60_000)

  it('naming a supplier, the same notes behave as they always did, and carry none on the row', async () => {
    const w = await world()
    const { movements } = await mapStoreOperations(w.orgId, {
      warehouse: null, periodStart: '2026-10-20', rows: [{ name: w.bolt.name, unit: 'БР', qty: 5, price: 5 }],
    } as any, { date: '2026-10-20', warehouseId: String(w.warehouse._id) })
    const m = await booked(w, { ...movements[0], contactId: String(w.supplier._id) })
    expect((await page(w, m)).billable).toBe(true)
    const listed = (await w.call('GET', `/invoicing/bills/billable-receipts?contactId=${w.supplier._id}`)).json.receipts
    expect(listed.find((x: any) => x.id === String(m._id)).notes).toBeUndefined()
    expect((await w.fromReceipt([m._id])).status).toBe(200)
  }, 60_000)
})

describe('a typed draft bill takes a delivery (FR-22.32a)', () => {
  it('replaces the typed lines when told to; the bill keeps its own number, dates and payment method', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5], [w.nut, 4, 2]])
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([10, 4])
    const movements = await w.movementCount()
    const typed = await w.typedBill([[w.bolt, 10, 5.4]], { reference: 'F-77', dueDate: '2026-12-01', paymentMethod: 'bank_transfer', notes: 'по договор' })
    const before = await w.load(typed.id)

    const refused = await w.linkReceipts(typed, [r._id])
    expect([refused.status, refused.json.code]).toEqual([422, 'bill_not_empty'])
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()

    const linked = await w.linkReceipts(typed, [r._id], { replaceLines: true })
    expect(linked.status).toBe(200)
    const bill = await w.load(typed.id)
    expect(bill.lines.map((l: any) => [l.description, l.quantity, l.unitPrice])).toEqual([['Болт М8', 10, 5], ['Гайка М8', 4, 2]])
    expect([bill.subtotal, bill.taxTotal, bill.total, bill.amountDue]).toEqual([58, 11.6, 69.6, 69.6])
    expect(bill.stockSource.marker).toBe(`movement:${r._id}`)
    expect(bill.status).toBe('draft')
    expect(bill.invoiceNumber).toBe(before.invoiceNumber)
    expect(bill.reference).toBe('F-77')
    expect(bill.paymentMethod).toBe('bank_transfer')
    expect(bill.notes).toBe('по договор')
    expect(bill.issueDate).toEqual(before.issueDate)
    expect(bill.dueDate).toEqual(before.dueDate)
    expect(String((await w.mv(r._id)).invoiceId)).toBe(String(bill._id))
    expect((await w.call('GET', `/warehouse/movement/${r._id}`)).json.stockMovement.bill.id).toBe(String(bill._id))

    const received = await w.receiveBill(typed)
    expect(received.status).toBe(200)
    expect(received.json.invoice.status).toBe('received')
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([10, 4])
    expect(await w.movementCount()).toBe(movements)
  }, 60_000)

  it('asking on a bill with no lines changes nothing, and a received bill stays refused', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 2, 5]])
    const empty = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-23', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    expect((await w.linkReceipts(empty.json.invoice, [r._id], { replaceLines: true })).status).toBe(200)

    const r2 = await w.receipt([[w.nut, 1, 2]])
    const received = await w.typedBill([[w.bolt, 1, 5]])
    expect((await w.receiveBill(received, { acknowledgeOverlap: true })).status).toBe(200)
    const late = await w.linkReceipts(received, [r2._id], { replaceLines: true })
    expect([late.status, late.json.code]).toEqual([422, 'bill_not_draft'])
    expect((await w.mv(r2._id)).invoiceId).toBeUndefined()
  }, 60_000)

  it('keeps the lines of a bill written against a supplier order: they book the delivery onto it', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 2, 5]])
    const onOrder = await w.typedBill([[w.bolt, 2, 5]])
    await Invoice.updateOne({ _id: onOrder.id }, { $set: { 'lines.0.orderRef': { orderId: new Invoice()._id } } }).exec()
    const refused = await w.linkReceipts(onOrder, [r._id], { replaceLines: true })
    expect([refused.status, refused.json.code]).toEqual([422, 'bill_on_order'])
    expect((await w.load(onOrder.id)).lines).toHaveLength(1)
    expect((await w.load(onOrder.id)).stockSource?.marker).toBeUndefined()
    expect((await w.mv(r._id)).invoiceId).toBeUndefined()
  }, 60_000)

  it('the undo after a lost claim touches only the draft it wrote: a bill received meanwhile stays as it stands', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 2, 5]])
    const typed = await w.typedBill([[w.nut, 3, 2.5]], { reference: 'F-79' })
    const spy = beforeClaimOf(r, async () => {
      // Another request sees the link just written, and receives the bill.
      await Invoice.updateOne({ _id: typed.id }, { $set: { status: 'received', invoiceNumber: 'BILL-RIVAL-1' } }).exec()
      await StockMovement.collection.updateOne({ _id: r._id }, { $set: { invoiceId: new Invoice()._id } })
    })
    try {
      const lost = await w.linkReceipts(typed, [r._id], { replaceLines: true })
      expect([lost.status, lost.json.code]).toEqual([409, 'receipt_already_billed'])
    } finally {
      spy.mockRestore()
    }
    const bill = await w.load(typed.id)
    expect([bill.status, bill.invoiceNumber]).toEqual(['received', 'BILL-RIVAL-1'])
    expect(bill.stockSource?.marker).toBe(`movement:${r._id}`)
    expect(bill.lines.map((l: any) => [l.description, l.quantity])).toEqual([[w.bolt.name, 2]])
  }, 60_000)

  it('…and one whose link another request replaced stays as that request left it', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 2, 5]])
    const typed = await w.typedBill([[w.nut, 3, 2.5]], { reference: 'F-80' })
    const spy = beforeClaimOf(r, async () => {
      await Invoice.updateOne({ _id: typed.id }, { $set: { 'stockSource.marker': 'movement:another' } }).exec()
      await StockMovement.collection.updateOne({ _id: r._id }, { $set: { invoiceId: new Invoice()._id } })
    })
    try {
      await w.linkReceipts(typed, [r._id], { replaceLines: true })
    } finally {
      spy.mockRestore()
    }
    expect((await w.load(typed.id)).stockSource?.marker).toBe('movement:another')
  }, 60_000)

  it('the audit trail keeps what the bill no longer holds: the typed lines, the old totals, a supplier it wrote', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]], { contactId: null })
    const created = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', issueDate: '2026-10-21', currency: 'EUR', subtotal: 54, taxTotal: 10.8, total: 64.8,
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: w.bolt.name, quantity: 10, unitPrice: 5.4, taxRate: 20 }],
    })
    const id = created.json.invoice.id
    const linked = await w.linkReceipts(created.json.invoice, [r._id], { replaceLines: true, contactId: String(w.supplier._id) })
    expect(linked.status).toBe(200)

    const audit = await auditRow({ orgId: w.org._id, module: 'invoicing', entityType: 'invoice', action: 'update', entityId: (await w.load(id))._id })
    const field = (name: string) => audit.changes.find((c: any) => c.field === name)
    expect(field('receipts').newValue).toBe(r.movementNumber)
    expect(field('lines').oldValue).toEqual([{ productId: String(w.bolt._id), description: w.bolt.name, quantity: 10, unitPrice: 5.4 }])
    expect(field('lines').newValue).toEqual([{ productId: String(w.bolt._id), description: w.bolt.name, quantity: 10, unitPrice: 5 }])
    expect([field('subtotal').oldValue, field('subtotal').newValue]).toEqual([54, 50])
    expect([field('taxTotal').oldValue, field('taxTotal').newValue]).toEqual([10.8, 10])
    expect([field('total').oldValue, field('total').newValue]).toEqual([64.8, 60])
    expect([field('contactId').oldValue, String(field('contactId').newValue)]).toEqual([null, String(w.supplier._id)])
  }, 60_000)

  it('a bill that had no lines and kept its supplier has nothing more to record', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const empty = await w.call('POST', '/invoices', { type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR', lines: [], subtotal: 0, total: 0 })
    expect((await w.linkReceipts(empty.json.invoice, [r._id])).status).toBe(200)
    const audit = await auditRow({ orgId: w.org._id, module: 'invoicing', entityType: 'invoice', action: 'update', entityId: (await w.load(empty.json.invoice.id))._id })
    expect(audit.changes.map((c: any) => c.field)).toEqual(['receipts'])
  }, 60_000)

  it('a claim lost after the lines were replaced puts the typed lines back', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 2, 5]])
    const typed = await w.typedBill([[w.nut, 3, 2.5]], { reference: 'F-78' })
    const spy = beforeClaimOf(r, () => StockMovement.collection.updateOne({ _id: r._id }, { $set: { invoiceId: new Invoice()._id } }))
    try {
      const lost = await w.linkReceipts(typed, [r._id], { replaceLines: true })
      expect([lost.status, lost.json.code]).toEqual([409, 'receipt_already_billed'])
    } finally {
      spy.mockRestore()
    }
    const bill = await w.load(typed.id)
    expect(bill.lines.map((l: any) => [l.description, l.quantity, l.unitPrice])).toEqual([['Гайка М8', 3, 2.5]])
    expect([bill.subtotal, bill.total]).toEqual([typed.subtotal, typed.total])
    expect(bill.stockSource?.marker).toBeUndefined()
  }, 60_000)
})

describe('receiving a bill warns before it double-books (FR-22.31c)', () => {
  it('names the receipts, books nothing, draws no number, and receives when told to', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]])
    const typed = await w.typedBill([[w.bolt, 10, 5], [w.nut, 1, 2]])
    const number = (await w.load(typed.id)).invoiceNumber
    const movements = await w.movementCount()

    const asked = await w.receiveBill(typed)
    expect([asked.status, asked.json.code]).toEqual([409, 'receipt_overlap'])
    expect(asked.json.message).toContain(r.movementNumber)
    expect(asked.json.typedLines).toBe(2)
    expect(asked.json.receipts).toEqual([expect.objectContaining({ id: String(r._id), number: r.movementNumber, lineCount: 1, total: 50 })])
    expect(asked.json.receipts[0].noSupplier).toBeUndefined()
    expect(await w.stock(w.bolt)).toBe(10)
    expect(await w.movementCount()).toBe(movements)
    const still = await w.load(typed.id)
    expect([still.status, still.invoiceNumber]).toEqual(['draft', number])

    // The first number of the series: the refusal above drew none.
    const received = await w.receiveBill(typed, { acknowledgeOverlap: true })
    expect(received.status).toBe(200)
    expect(received.json.invoice.status).toBe('received')
    expect(received.json.invoice.invoiceNumber).toMatch(/^BILL-\d{4}-0*1$/)
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([20, 1])

    const audit = await auditRow({ orgId: w.org._id, action: 'receive_overlap_acknowledged', entityId: (await w.load(typed.id))._id })
    expect(audit?.changes?.[0]).toMatchObject({ field: 'receipts', newValue: r.movementNumber })
  }, 60_000)

  it('takes no body when there is nothing to ask, and records no acknowledgement for nothing', async () => {
    const w = await world()
    const quiet = await w.typedBill([[w.bolt, 1, 5]])
    expect((await w.receiveBill(quiet)).status).toBe(200)
    const told = await w.typedBill([[w.nut, 1, 2]])
    expect((await w.receiveBill(told, { acknowledgeOverlap: true })).status).toBe(200)
    const empty = await w.typedBill([[w.nut, 2, 2]], { reference: 'F-3' })
    expect((await w.receiveBill(empty, {})).status).toBe(200)
    await Bun.sleep(100)
    expect(await AuditLog.countDocuments({ orgId: w.org._id, action: 'receive_overlap_acknowledged' }).exec()).toBe(0)
  }, 60_000)

  it('with no supplier on the receipt, only the same article at the same quantity on one line', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5], [w.nut, 3, 2]], { contactId: null })

    const differs = await w.typedBill([[w.bolt, 9, 5]])
    expect((await w.receiveBill(differs)).status).toBe(200)

    const same = await w.typedBill([[w.bolt, 10, 5.5]])
    const asked = await w.receiveBill(same)
    expect([asked.status, asked.json.code]).toEqual([409, 'receipt_overlap'])
    expect(asked.json.receipts).toEqual([expect.objectContaining({ number: r.movementNumber, noSupplier: true })])

    // Summed quantities are no match: 4 + 6 is two lines of 10 only by accident.
    const split = await w.typedBill([[w.bolt, 4, 5], [w.bolt, 6, 5]], { reference: 'F-4' })
    expect((await w.receiveBill(split)).status).toBe(200)
  }, 60_000)

  it('puts the supplier\'s own receipts first, and a bill with no supplier sees only unnamed ones', async () => {
    const w = await world()
    const unnamed = await w.receipt([[w.bolt, 5, 5]], { contactId: null, date: '2026-10-21' })
    const own = await w.receipt([[w.bolt, 2, 5]], { date: '2026-10-02' })

    const typed = await w.typedBill([[w.bolt, 5, 5]])
    expect((await w.receiveBill(typed)).json.receipts.map((x: any) => x.number)).toEqual([own.movementNumber, unnamed.movementNumber])

    const nobody = await w.typedBill([[w.bolt, 5, 5]], { contactId: null, reference: 'F-5' })
    const asked = await w.receiveBill(nobody)
    expect(asked.json.receipts.map((x: any) => x.number)).toEqual([unnamed.movementNumber])

    // Linking it needs a supplier the bill does not have, so the question says so.
    expect(asked.json.needsSupplier).toBe(true)
    expect((await w.linkReceipts(nobody, [unnamed._id], { replaceLines: true })).json.code).toBe('receipt_without_supplier')
    expect((await w.linkReceipts(nobody, [unnamed._id], { replaceLines: true, contactId: String(w.supplier._id) })).status).toBe(200)
    expect(String((await w.load(nobody.id)).contactId)).toBe(String(w.supplier._id))
    expect(String((await w.mv(unnamed._id)).contactId)).toBe(String(w.supplier._id))

    expect((await w.receiveBill(typed)).json.needsSupplier).toBeUndefined()
  }, 60_000)

  it('counts a window of a named constant around the issue date, both ways, ends included', async () => {
    const w = await world()
    expect(RECEIPT_OVERLAP_WINDOW_DAYS).toBe(60)
    const inBefore = await w.receipt([[w.bolt, 1, 5]], { date: '2026-08-22' }) // 60 days before 10-21
    const inAfter = await w.receipt([[w.bolt, 1, 5]], { date: '2026-12-20' }) // 60 days after
    await w.receipt([[w.bolt, 1, 5]], { date: '2026-08-21' }) // 61
    await w.receipt([[w.bolt, 1, 5]], { date: '2026-12-21' }) // 61
    const typed = await w.typedBill([[w.bolt, 1, 5]])
    const asked = await w.receiveBill(typed)
    expect(asked.json.receipts.map((x: any) => x.number).sort()).toEqual([inBefore.movementNumber, inAfter.movementNumber].sort())

    const lonely = await world()
    await lonely.receipt([[lonely.bolt, 1, 5]], { date: '2026-08-21' })
    await lonely.receipt([[lonely.bolt, 1, 5]], { date: '2026-12-21' })
    expect((await lonely.receiveBill(await lonely.typedBill([[lonely.bolt, 1, 5]]))).status).toBe(200)
  }, 60_000)

  describe('its false friends', () => {
    it('a receipt claimed by another bill', async () => {
      const w = await world()
      const r = await w.receipt([[w.bolt, 10, 5]])
      expect((await w.fromReceipt([r._id])).status).toBe(200)
      const typed = await w.typedBill([[w.bolt, 10, 5]])
      expect((await w.receiveBill(typed)).status).toBe(200)
      expect(await w.stock(w.bolt)).toBe(20)
    }, 60_000)

    it('the receipt a received bill booked for itself, and the same receipt once that bill is voided', async () => {
      const w = await world()
      const first = await w.typedBill([[w.bolt, 10, 5]])
      expect((await w.receiveBill(first)).status).toBe(200)
      const second = await w.typedBill([[w.bolt, 10, 5]])
      expect((await w.receiveBill(second)).status).toBe(200)
      expect(await w.stock(w.bolt)).toBe(20)

      expect((await w.call('POST', `/invoices/${first.id}/void`)).status).toBe(200)
      expect(await w.stock(w.bolt)).toBe(10)
      const third = await w.typedBill([[w.bolt, 10, 5]])
      expect((await w.receiveBill(third)).status).toBe(200)
    }, 60_000)

    it('…while a receipt a voided bill gave back is free again, and is named', async () => {
      const w = await world()
      const r = await w.receipt([[w.bolt, 10, 5]])
      const linked = (await w.fromReceipt([r._id])).json.invoice
      expect((await w.call('POST', `/invoices/${linked.id}/void`)).status).toBe(200)
      const typed = await w.typedBill([[w.bolt, 10, 5]])
      const asked = await w.receiveBill(typed)
      expect([asked.status, asked.json.receipts?.map((x: any) => x.number)]).toEqual([409, [r.movementNumber]])
    }, 60_000)

    it('an article that holds no stock', async () => {
      const w = await world()
      const service = await createTestProduct(w.org._id, { sku: 'SRV-1', name: 'Монтаж', purchasePrice: 5, sellingPrice: 9, taxRate: 20, trackInventory: false } as any)
      await w.receipt([[service, 1, 5]])
      const typed = await w.typedBill([[service, 1, 5]])
      expect((await w.receiveBill(typed)).status).toBe(200)
      expect(await StockMovement.countDocuments({ orgId: w.orgId, invoiceId: typed.id }).exec()).toBe(0)
    }, 60_000)

    it('another supplier\'s receipt, and a draft one', async () => {
      const w = await world()
      await w.receipt([[w.bolt, 10, 5]], { contactId: String(w.other._id) })
      await w.receipt([[w.bolt, 10, 5]], { confirm: false })
      const typed = await w.typedBill([[w.bolt, 10, 5]])
      expect((await w.receiveBill(typed)).status).toBe(200)
    }, 60_000)

    it('a receipt that put nothing in stock: no warehouse, or a price-only line', async () => {
      const w = await world()
      await w.receipt([[w.bolt, 10, 5]], { noWarehouse: true })
      await w.receipt([[w.nut, 0, 2], [w.bolt, 0, 5]])
      const typed = await w.typedBill([[w.bolt, 10, 5], [w.nut, 1, 2]])
      expect((await w.receiveBill(typed)).status).toBe(200)
    }, 60_000)

    it('a bill line that will not book: no warehouse on it', async () => {
      const w = await world()
      await w.receipt([[w.nut, 10, 2]])
      const typed = await w.typedBill([[w.bolt, 1, 5]])
      await Invoice.updateOne({ _id: typed.id }, {
        $push: { lines: { productId: w.nut._id, description: 'Гайка М8', quantity: 10, unitPrice: 2, taxRate: 20 } },
      }).exec()
      expect((await w.receiveBill(typed)).status).toBe(200)
    }, 60_000)

    it('anything but an unlinked supplier bill', async () => {
      const w = await world()
      await w.receipt([[w.bolt, 10, 5]])
      const typed = await w.load((await w.typedBill([[w.bolt, 10, 5]])).id)
      expect(await receiptsOverlapping(w.orgId, typed)).toMatchObject({ typedLines: 1 })
      expect(await receiptsOverlapping(w.orgId, { ...typed, type: 'credit_note' })).toBeNull()
      expect(await receiptsOverlapping(w.orgId, { ...typed, type: 'debit_note' })).toBeNull()
      expect(await receiptsOverlapping(w.orgId, { ...typed, direction: 'outgoing' })).toBeNull()
      expect(await receiptsOverlapping(w.orgId, { ...typed, status: 'received' })).toBeNull()
      expect(await receiptsOverlapping(w.orgId, { ...typed, stockSource: { marker: 'stokrazp:1' } })).toBeNull()
    }, 60_000)
  })

  it('stands at `/send` too: a bill issued there books its goods all the same', async () => {
    const w = await world()
    await w.receipt([[w.bolt, 10, 5]])
    const typed = await w.typedBill([[w.bolt, 10, 5]])
    const asked = await w.call('POST', `/invoices/${typed.id}/send`, {})
    expect([asked.status, asked.json.code]).toEqual([409, 'receipt_overlap'])
    expect((await w.load(typed.id)).status).toBe('draft')
    expect(await w.stock(w.bolt)).toBe(10)
    // The route has no schema: something merely truthy is no answer.
    for (const answer of ['true', 1, {}]) {
      const notAnAnswer = await w.call('POST', `/invoices/${typed.id}/send`, { acknowledgeOverlap: answer })
      expect([notAnAnswer.status, notAnAnswer.json.code]).toEqual([409, 'receipt_overlap'])
    }
    expect(await w.stock(w.bolt)).toBe(10)

    const sent = await w.call('POST', `/invoices/${typed.id}/send`, { acknowledgeOverlap: true })
    expect(sent.status).toBe(200)
    expect(sent.json.invoice.status).toBe('received')
    expect(await w.stock(w.bolt)).toBe(20)
    expect(await auditRow({ orgId: w.org._id, action: 'receive_overlap_acknowledged', entityId: (await w.load(typed.id))._id })).toBeTruthy()
  }, 60_000)

  it('the way out it offers: linked to the delivery, the same bill receives and moves nothing', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5]], { contactId: null })
    const typed = await w.typedBill([[w.bolt, 10, 5.5]], { reference: 'F-9' })
    const asked = await w.receiveBill(typed)
    expect(asked.json.code).toBe('receipt_overlap')
    const movements = await w.movementCount()

    expect((await w.linkReceipts(typed, asked.json.receipts.map((x: any) => x.id), { replaceLines: true })).status).toBe(200)
    expect(String((await w.mv(r._id)).contactId)).toBe(String(w.supplier._id))
    const received = await w.receiveBill(typed)
    expect(received.status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(10)
    expect(await w.movementCount()).toBe(movements)
  }, 60_000)
})

describe('a bill is received once, whoever else asks at the same moment', () => {
  /** Run `meanwhile` after the next `Product.find`'s query is built and before it runs: inside `/receive`'s window. */
  function beforeTheNextProductRead(meanwhile: () => Promise<unknown>) {
    const real = Product.find.bind(Product)
    let fired = false
    return spyOn(Product, 'find').mockImplementation(((...args: any[]) => {
      const query: any = (real as any)(...args)
      if (fired) return query
      fired = true
      const exec = query.exec.bind(query)
      query.exec = async () => {
        await meanwhile()
        return exec()
      }
      return query
    }) as any)
  }

  it('two at once: one receives, the other answers 409 and books nothing', async () => {
    const w = await world()
    const typed = await w.typedBill([[w.bolt, 10, 5]])
    const movements = await w.movementCount()
    let rival: any
    // The second read a draft too, and takes the bill before this one writes.
    const spy = beforeTheNextProductRead(async () => { rival = await w.receiveBill(typed) })
    let late: any
    try {
      late = await w.receiveBill(typed)
    } finally {
      spy.mockRestore()
    }

    expect(rival.status).toBe(200)
    expect([late.status, late.json.code]).toEqual([409, 'bill_not_draft'])
    expect(await w.stock(w.bolt)).toBe(10)
    expect(await w.movementCount()).toBe(movements + 1)
    const bill = await w.load(typed.id)
    expect(bill.status).toBe('received')
    expect(bill.invoiceNumber).toBe(rival.json.invoice.invoiceNumber)
    expect(bill.numberHistory.filter((n: any) => n.status === 'received')).toHaveLength(1)
    expect(bill.statusHistory.filter((h: any) => h.status === 'received')).toHaveLength(1)
  }, 60_000)

  it('really at once, too: the goods are counted once', async () => {
    const w = await world()
    const typed = await w.typedBill([[w.nut, 4, 2]])
    const answers = await Promise.all([w.receiveBill(typed), w.receiveBill(typed), w.receiveBill(typed)])
    expect(answers.filter(a => a.status === 200)).toHaveLength(1)
    for (const a of answers.filter(a => a.status !== 200)) expect([400, 409]).toContain(a.status)
    expect(await w.stock(w.nut)).toBe(4)
  }, 60_000)

  it('an issue under way on `/send` holds the draft too', async () => {
    const w = await world()
    const typed = await w.typedBill([[w.bolt, 3, 5]])
    const number = (await w.load(typed.id)).invoiceNumber
    await Invoice.collection.updateOne({ _id: (await w.load(typed.id))._id }, { $set: { issue: { leaseUntil: new Date(Date.now() + 60_000) } } })

    const held = await w.receiveBill(typed)
    expect([held.status, held.json.code]).toEqual([409, 'bill_not_draft'])
    const still = await w.load(typed.id)
    expect([still.status, still.invoiceNumber]).toEqual(['draft', number])
    expect(await w.stock(w.bolt)).toBe(0)

    // A lease that lapsed is a crash: it holds nothing.
    await Invoice.collection.updateOne({ _id: still._id }, { $set: { 'issue.leaseUntil': new Date(Date.now() - 1000) } })
    expect((await w.receiveBill(typed)).status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(3)
  }, 60_000)
})

describe('a bill that cannot book its goods is refused before it is received', () => {
  it('no warehouse on its stock lines: 422, still the draft it was, no number drawn, and it receives once one is chosen', async () => {
    const w = await world()
    const typed = await w.typedBill([[w.bolt, 5, 5]], { noWarehouse: true })
    const draft = await w.load(typed.id)

    const refused = await w.receiveBill(typed)
    expect([refused.status, refused.json.code]).toEqual([422, 'stock_line_without_warehouse'])
    const still = await w.load(typed.id)
    expect([still.status, still.invoiceNumber, still.draftNumber]).toEqual(['draft', draft.invoiceNumber, draft.draftNumber])
    expect(await w.stock(w.bolt)).toBe(0)
    expect(await w.movementCount()).toBe(0)

    const lines = still.lines.map((l: any) => ({
      productId: String(l.productId), description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, warehouseId: String(w.warehouse._id),
    }))
    expect((await w.call('PUT', `/invoices/${typed.id}`, { lines })).status).toBe(200)
    const received = await w.receiveBill(typed)
    expect(received.status).toBe(200)
    // The first number of the series: the refusal above drew none.
    expect(received.json.invoice.invoiceNumber).toMatch(/^BILL-\d{4}-0*1$/)
    expect(await w.stock(w.bolt)).toBe(5)
  }, 60_000)

  it('a quantity read off paper with no article behind it: 422, whatever else the bill would book', async () => {
    const w = await world()
    const created = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR', subtotal: 60, total: 72,
      lines: [
        { productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: w.bolt.name, quantity: 2, unitPrice: 5, taxRate: 20 },
        { description: 'Гайка неразпозната', sourceText: 'Гайка неразпозната', quantity: 10, unitPrice: 5, taxRate: 20 },
      ],
    })
    expect(created.status).toBe(200)
    const refused = await w.receiveBill(created.json.invoice, { acknowledgeOverlap: true })
    expect([refused.status, refused.json.code]).toEqual([422, 'stock_line_without_product'])
    expect((await w.load(created.json.invoice.id)).status).toBe('draft')
    expect(await w.stock(w.bolt)).toBe(0)
  }, 60_000)

  it('asks nothing of a bill made from a receipt, or of one with only services: they book no stock', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 2, 5]], { noWarehouse: true })
    const made = await w.fromReceipt([r._id])
    expect(made.json.invoice.lines[0].warehouseId).toBeFalsy()
    expect((await w.receiveBill(made.json.invoice)).status).toBe(200)

    const service = await createTestProduct(w.org._id, { sku: 'SRV-1', name: 'Транспорт', trackInventory: false, taxRate: 20 } as any)
    const typed = await w.typedBill([[service, 1, 50]], { noWarehouse: true })
    expect((await w.receiveBill(typed)).status).toBe(200)
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
