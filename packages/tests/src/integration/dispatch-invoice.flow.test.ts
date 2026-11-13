import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { dispatchInvoiceController } from 'invoicing-api/src/controllers/dispatch-invoice.controller'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { DISPATCH_OVERLAP_WINDOW_DAYS, dispatchesOverlapping } from 'services/biz/dispatch-invoice.service'
import { AuditLog, Invoice, Product, StockLevel, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.61 / #725: the customer's invoice for goods a stock note already delivered, the sales twin of
 * `receipt-bill.flow.test.ts`.
 *
 * Goods leave before their invoice: a dispatch that names the customer books them out, and the invoice is entered
 * later. An invoice dispatches its own goods, so the invoice typed in for them used to take them out of stock a
 * second time. Made FROM the note, the invoice is linked to it (`stockSource`, marker `dispatch:`) and moves no stock
 * on any path; the note is invoiced once, a void gives it back, and an invoice typed anyway is asked first.
 *
 * Driven over HTTP through the real controllers: the guards live on the routes.
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(invoiceController).use(dispatchInvoiceController).use(movementController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }, role: keyof typeof DEFAULT_ROLE_PERMISSIONS = 'admin') {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role, email: `${role}@test.com`, username: role,
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
  })
}

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
 * Run `meanwhile` just before a write reaches the database: what a concurrent request would have done between the
 * read and the write, without leaving it to timing. `which` picks the write by its filter.
 */
function before(model: any, method: 'updateOne' | 'findOneAndUpdate', which: (filter: any) => boolean, meanwhile: () => Promise<unknown>) {
  const real = model[method].bind(model)
  let fired = false
  return spyOn(model, method).mockImplementation(((filter: any, ...rest: any[]) => {
    const query: any = real(filter, ...rest)
    if (fired || !which(filter)) return query
    fired = true
    const exec = query.exec.bind(query)
    query.exec = async () => {
      await meanwhile()
      return exec()
    }
    return query
  }) as any)
}

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const customer = await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
  const other = await createTestContact(org._id, { companyName: 'Друг клиент ЕООД', type: 'customer' } as any)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const warehouse = await createTestWarehouse(org._id, { isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { sku: 'PRD-0002', name: 'Гайка М8', purchasePrice: 2, sellingPrice: 4, taxRate: 20 } as any)
  const fee = await createTestProduct(org._id, { sku: 'SRV-0001', name: 'Доставка', purchasePrice: 0, sellingPrice: 30, taxRate: 20, trackInventory: false, type: 'service' } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any, as: string = token) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  async function movement(type: 'receipt' | 'dispatch', lines: Array<[any, number]>, opts: { contactId?: string | null; date?: string; confirm?: boolean; notes?: string } = {}) {
    const ls = lines.map(([p, q]) => ({ productId: String(p._id), quantity: q, unitCost: p.purchasePrice, totalCost: q * p.purchasePrice }))
    const contactId = opts.contactId === null ? undefined : opts.contactId
    const created = await call('POST', '/warehouse/movement', {
      type, date: opts.date || '2026-10-20',
      ...(type === 'receipt' ? { toWarehouseId: String(warehouse._id) } : { fromWarehouseId: String(warehouse._id) }),
      ...(contactId ? { contactId } : {}), ...(opts.notes ? { notes: opts.notes } : {}),
      lines: ls, totalAmount: ls.reduce((s, l) => s + l.totalCost, 0),
    })
    expect(created.status).toBe(200)
    const id = created.json.stockMovement._id || created.json.stockMovement.id
    if (opts.confirm !== false) expect((await call('POST', `/warehouse/movement/${id}/confirm`, {})).status).toBe(200)
    return StockMovement.findById(id).lean().exec() as Promise<any>
  }
  // Goods to sell: 100 of each article, delivered by nobody in particular.
  await movement('receipt', [[bolt, 100], [nut, 100]], { date: '2026-10-01' })

  /** A stock note: a completed dispatch out of the warehouse that names the customer, as the movement form books it. */
  const note = (lines: Array<[any, number]>, opts: { contactId?: string | null; date?: string; confirm?: boolean; notes?: string } = {}) =>
    movement('dispatch', lines, { ...opts, contactId: opts.contactId === undefined ? String(customer._id) : opts.contactId })

  /** A sales invoice typed by hand: it dispatches its own goods unless it is linked. */
  async function typed(lines: Array<[any, number, number, number?]>, opts: Record<string, any> = {}) {
    const ls = lines.map(([p, q, price, discount]) => ({
      productId: String(p._id), warehouseId: String(warehouse._id), description: p.name, quantity: q, unit: 'pcs', unitPrice: price, taxRate: 20,
      ...(discount ? { discount } : {}),
    }))
    const net = ls.reduce((s, l) => s + l.quantity * l.unitPrice * (1 - ((l as any).discount || 0) / 100), 0)
    const { contactId, ...rest } = opts
    const created = await call('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: contactId ?? String(customer._id),
      issueDate: '2026-10-21', dueDate: '2026-11-21', currency: 'EUR', lines: ls,
      subtotal: +ls.reduce((s, l) => s + l.quantity * l.unitPrice, 0).toFixed(2), total: +(net * 1.2).toFixed(2), ...rest,
    })
    expect([created.status, created.json?.message]).toEqual([200, undefined])
    return created.json.invoice
  }
  const send = (invoice: any, body?: any) => call('POST', `/invoices/${invoice.id || invoice._id}/send`, body)
  const fromDispatch = (movementIds: unknown[], extra: Record<string, any> = {}) =>
    call('POST', '/invoicing/sales/from-dispatch', { movementIds: movementIds.map(String), ...extra })
  const link = (invoice: any, movementIds: unknown[], extra: Record<string, any> = {}) =>
    call('POST', `/invoicing/sales/${invoice.id || invoice._id}/link-dispatches`, { movementIds: movementIds.map(String), ...extra })
  const question = (invoice: any) => call('GET', `/invoicing/sales/${invoice.id || invoice._id}/dispatch-overlap`)
  const stock = async (product: any) =>
    Number(((await StockLevel.findOne({ orgId, productId: product._id, warehouseId: warehouse._id }).lean().exec()) as any)?.quantity ?? 0)
  const load = (id: unknown) => Invoice.findById(id).lean().exec() as Promise<any>
  const mv = (id: unknown) => StockMovement.findById(id).lean().exec() as Promise<any>
  const movementCount = () => StockMovement.countDocuments({ orgId }).exec()

  return { org, orgId, user, customer, other, supplier, warehouse, bolt, nut, fee, token, call, movement, note, typed, send, fromDispatch, link, question, stock, load, mv, movementCount }
}

describe('an invoice made from a stock note (FR-22.61)', () => {
  it('is a draft sales invoice of the customer, with the note\'s lines at the customer\'s prices, linked to it', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10], [w.nut, 4]])
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([90, 96])

    const res = await w.fromDispatch([n._id], { locale: 'bg' })
    expect([res.status, res.json?.message]).toEqual([200, undefined])
    const invoice = await w.load(res.json.invoice.id)

    expect([invoice.type, invoice.direction, invoice.status]).toEqual(['invoice', 'outgoing', 'draft'])
    expect(invoice.invoiceNumber).toMatch(/^DRF-/)
    expect(String(invoice.contactId)).toBe(String(w.customer._id))
    // The selling prices (10 and 4), never the costs the note carries (5 and 2).
    expect(invoice.lines.map((l: any) => [String(l.productId), l.quantity, l.unitPrice, l.taxRate, String(l.warehouseId), l.description, l.unit])).toEqual([
      [String(w.bolt._id), 10, 10, 20, String(w.warehouse._id), 'Болт М8', 'pcs'],
      [String(w.nut._id), 4, 4, 20, String(w.warehouse._id), 'Гайка М8', 'pcs'],
    ])
    expect(invoice.lines.map((l: any) => [l.taxAmount, l.lineTotal])).toEqual([[20, 120], [3.2, 19.2]])
    expect(invoice.lines[0].priceExplanation.map((s: any) => [s.type, s.price])).toEqual([['base', 10]])
    // 100 + 16 = 116 net, 20 % VAT.
    expect([invoice.subtotal, invoice.discountTotal, invoice.taxTotal, invoice.total, invoice.amountDue, invoice.totalBase]).toEqual([116, 0, 23.2, 139.2, 139.2, 139.2])
    expect(invoice.billingAddress).toMatchObject({ street: '123 Main St', city: 'Berlin' })
    expect(invoice.preparedBy).toBe('Мария Иванова')
    // Every outgoing document carries „Словом".
    expect(invoice.notes).toContain('Словом')

    expect(invoice.stockSource).toMatchObject({ marker: `dispatch:${n._id}`, docNumber: n.movementNumber, detectedBy: 'manual' })
    expect(invoice.stockSource.movementIds.map(String)).toEqual([String(n._id)])
    expect(invoice.stockSource.customerGivenTo).toBeUndefined()

    // The note is claimed by the invoice: the product ledger names it beside the note.
    expect(String((await w.mv(n._id)).invoiceId)).toBe(String(invoice._id))
    const ledger = await getProductLedger(w.orgId, String(w.bolt._id))
    expect(ledger.entries.find((e: any) => e.documentRef === n.movementNumber)?.invoiceNumber).toBe(invoice.invoiceNumber)

    // Both pages name the other. The invoice's holds the note's quantities, and none of its costs.
    const page = await w.call('GET', `/invoices/${invoice._id}`)
    expect(page.json.invoice.dispatches).toEqual([{
      id: String(n._id), number: n.movementNumber, date: n.date.toISOString(), status: 'completed', held: true,
      lines: [{ productId: String(w.bolt._id), quantity: 10 }, { productId: String(w.nut._id), quantity: 4 }],
    }])
    expect(page.json.invoice.receipts).toBeUndefined()
    const nPage = await w.call('GET', `/warehouse/movement/${n._id}`)
    expect(nPage.json.stockMovement).toMatchObject({ number: n.movementNumber, invoiceable: false, sale: { id: String(invoice._id), number: invoice.invoiceNumber } })
    const list = await w.call('GET', '/warehouse/movement?type=dispatch')
    expect(list.json.stockMovements.find((m: any) => m.number === n.movementNumber)?.sale).toEqual({ id: String(invoice._id), number: invoice.invoiceNumber })

    const audit = await auditRow({ orgId: w.org._id, action: 'invoiced', entityId: n._id })
    expect(audit?.changes?.[0]).toMatchObject({ field: 'invoice', newValue: invoice.invoiceNumber })
  }, 60_000)

  it('charges the price the engine resolves for that customer', async () => {
    const w = await world()
    await Product.updateOne({ _id: w.bolt._id }, { $set: { customPrices: [{ name: 'Договорена', contactId: w.customer._id, price: 8.5 }] } })
    const n = await w.note([[w.bolt, 6]])

    const res = await w.fromDispatch([n._id])
    const invoice = await w.load(res.json.invoice.id)
    expect(invoice.lines.map((l: any) => [l.quantity, l.unitPrice, l.lineTotal])).toEqual([[6, 8.5, 61.2]])
    expect(invoice.lines[0].priceExplanation.map((s: any) => s.type)).toEqual(['base', 'contact'])
    expect([invoice.subtotal, invoice.total]).toEqual([51, 61.2])
  }, 60_000)

  it('moves no stock when it is issued: the note already did, and it is asked nothing', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const made = await w.fromDispatch([n._id])
    const before = await w.movementCount()

    const issued = await w.send(made.json.invoice)
    expect([issued.status, issued.json?.code]).toEqual([200, undefined])
    const invoice = await w.load(made.json.invoice.id)
    expect(invoice.status).toBe('sent')
    expect(invoice.invoiceNumber).not.toMatch(/^DRF-/)
    expect(await w.stock(w.bolt)).toBe(90)
    expect(await w.movementCount()).toBe(before)

    // The customer's ledger: the note in the invoice's row, and no row of its own.
    const ledger = await getContactLedger(w.orgId, String(w.customer._id))
    expect(ledger.entries.map((e: any) => [e.documentNumber, e.documentType, e.movements.map((m: any) => m.number)])).toEqual([
      [invoice.invoiceNumber, 'invoice', [n.movementNumber]],
    ])
  }, 60_000)

  it('while the invoice is a draft, the ledger still lists the note as a row of its own, and offers it to nobody', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const free = await getContactLedger(w.orgId, String(w.customer._id))
    expect(free.entries.map((e: any) => [e.documentType, e.movementType, e.invoiceable])).toEqual([['stock_movement', 'dispatch', true]])

    await w.fromDispatch([n._id])
    const held = await getContactLedger(w.orgId, String(w.customer._id))
    expect(held.entries.map((e: any) => [e.documentType, e.movements.map((m: any) => m.number), e.invoiceable])).toEqual([['stock_movement', [n.movementNumber], undefined]])
  }, 60_000)

  it('is invoiced once: a second invoice cannot take the same note', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const first = await w.fromDispatch([n._id])
    expect(first.status).toBe(200)

    const second = await w.fromDispatch([n._id])
    expect([second.status, second.json.code]).toEqual([409, 'dispatch_already_invoiced'])
    expect(second.json).toMatchObject({ movementNumber: n.movementNumber, invoiceId: first.json.invoice.id })
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
  }, 60_000)

  it('of two requests for one note at the same moment, one makes the invoice and the other leaves nothing behind', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])

    const results = await Promise.allSettled([w.fromDispatch([n._id]), w.fromDispatch([n._id])])
    const statuses = results.map(r => (r.status === 'fulfilled' ? r.value.status : 0)).sort()
    expect(statuses).toEqual([200, 409])
    const invoices = await Invoice.find({ orgId: w.orgId }).lean().exec()
    expect(invoices.length).toBe(1)
    expect(String((await w.mv(n._id)).invoiceId)).toBe(String(invoices[0]._id))
  }, 60_000)

  it('covers several notes of one customer, and refuses the notes of two', async () => {
    const w = await world()
    const a = await w.note([[w.bolt, 10]], { date: '2026-10-18' })
    const b = await w.note([[w.bolt, 5], [w.nut, 2]], { date: '2026-10-19' })
    const theirs = await w.note([[w.nut, 1]], { contactId: String(w.other._id) })

    const mixed = await w.fromDispatch([a._id, theirs._id])
    expect([mixed.status, mixed.json.code]).toEqual([422, 'mixed_customers'])
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(0)

    const res = await w.fromDispatch([a._id, b._id])
    expect(res.status).toBe(200)
    const invoice = await w.load(res.json.invoice.id)
    expect(invoice.lines.map((l: any) => [l.description, l.quantity])).toEqual([['Болт М8', 10], ['Болт М8', 5], ['Гайка М8', 2]])
    expect(invoice.stockSource.docNumber).toBe(`${a.movementNumber}, ${b.movementNumber}`)
    expect(invoice.stockSource.marker).toBe(`dispatch:${a._id},${b._id}`)
  }, 60_000)

  it('a void gives the note back and moves nothing; the note can be invoiced again', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const made = await w.fromDispatch([n._id])
    expect((await w.send(made.json.invoice)).status).toBe(200)
    const before = await w.movementCount()

    const voided = await w.call('POST', `/invoices/${made.json.invoice.id}/void`, {})
    expect(voided.status).toBe(200)
    expect(await w.stock(w.bolt)).toBe(90)
    expect(await w.movementCount()).toBe(before)
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()

    const again = await w.fromDispatch([n._id])
    expect(again.status).toBe(200)
    expect(again.json.invoice.id).not.toBe(made.json.invoice.id)
  }, 60_000)

  it('deleting the draft gives the note back', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const made = await w.fromDispatch([n._id])

    expect((await w.call('DELETE', `/invoices/${made.json.invoice.id}`)).status).toBe(200)
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()
    const page = await w.call('GET', `/warehouse/movement/${n._id}`)
    expect(page.json.stockMovement).toMatchObject({ invoiceable: true })
    expect(page.json.stockMovement.sale).toBeUndefined()
  }, 60_000)

  it('a release a crash left unfinished is finished by the next touch of the note', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const made = await w.fromDispatch([n._id])
    expect((await w.send(made.json.invoice)).status).toBe(200)
    // The void wrote the invoice and died before it gave the note back.
    await Invoice.updateOne({ _id: made.json.invoice.id }, { $set: { status: 'voided' } }).exec()
    expect(String((await w.mv(n._id)).invoiceId)).toBe(made.json.invoice.id)

    // The picker still offers it, and the question still names it.
    const picker = await w.call('GET', `/invoicing/sales/invoiceable-dispatches?contactId=${w.customer._id}`)
    expect(picker.json.dispatches.map((d: any) => d.number)).toEqual([n.movementNumber])

    const page = await w.call('GET', `/warehouse/movement/${n._id}`)
    expect(page.json.stockMovement).toMatchObject({ invoiceable: true, invoiceId: null })
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()
  }, 60_000)

  it('refuses what is no stock note of its own, and says which', async () => {
    const w = await world()
    const draft = await w.note([[w.bolt, 1]], { confirm: false })
    const receipt = await w.movement('receipt', [[w.bolt, 1]], { contactId: String(w.customer._id) })
    // An invoice typed and issued books a dispatch of its own: that one is the invoice's, not a note.
    const sold = await w.typed([[w.nut, 3, 4]])
    expect((await w.send(sold)).status).toBe(200)
    const own = await StockMovement.findOne({ orgId: w.orgId, invoiceId: sold.id, type: 'dispatch' }).lean().exec() as any
    const record = await w.note([[w.bolt, 1]])
    await StockMovement.updateOne({ _id: record._id }, { $set: { recordOnly: true } }).exec()
    // A voided bill puts its goods back out on a dispatch of its own: a reversal, and nobody's stock note.
    const bill = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR',
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 2, unitPrice: 5, taxRate: 20 }], subtotal: 10, total: 12,
    })
    expect((await w.call('POST', `/invoices/${bill.json.invoice.id}/receive`, {})).status).toBe(200)
    expect((await w.call('POST', `/invoices/${bill.json.invoice.id}/void`, {})).status).toBe(200)
    const mirror = await StockMovement.findOne({ orgId: w.orgId, invoiceId: bill.json.invoice.id, type: 'dispatch' }).lean().exec() as any
    expect(mirror?.status).toBe('completed')

    const cases: Array<[any, number, string]> = [
      [draft._id, 422, 'dispatch_not_completed'],
      [receipt._id, 422, 'not_a_dispatch'],
      [own._id, 409, 'dispatch_already_invoiced'],
      [record._id, 422, 'dispatch_not_a_delivery'],
      [mirror._id, 422, 'dispatch_is_reversal'],
      ['000000000000000000000000', 404, 'dispatch_not_found'],
      ['not-an-id', 404, 'dispatch_not_found'],
    ]
    for (const [id, status, code] of cases) {
      const res = await w.fromDispatch([id])
      expect([String(id), res.status, res.json.code]).toEqual([String(id), status, code])
    }
    expect((await w.call('POST', '/invoicing/sales/from-dispatch', { movementIds: [] })).status).toBe(422)
    // Another org's note reads as one that does not exist.
    const elsewhere = await world()
    const theirs = await elsewhere.note([[elsewhere.bolt, 1]])
    expect((await w.fromDispatch([theirs._id])).json.code).toBe('dispatch_not_found')

    // The invoice's own dispatch names its invoice on its page, and offers nothing.
    const page = await w.call('GET', `/warehouse/movement/${own._id}`)
    expect(page.json.stockMovement).toMatchObject({ invoiceable: false, sale: { id: sold.id } })
    // The bill's mirror names no document: a session that makes sales invoices need not read the purchases.
    const refusedMirror = await w.fromDispatch([mirror._id])
    expect([refusedMirror.json.invoiceId, refusedMirror.json.invoiceNumber]).toEqual([undefined, undefined])
    expect(refusedMirror.json.message).not.toContain(bill.json.invoice.invoiceNumber)
    const mirrorPage = (await w.call('GET', `/warehouse/movement/${mirror._id}`)).json.stockMovement
    expect([mirrorPage.invoiceable, mirrorPage.sale, mirrorPage.notInvoiceable]).toEqual([false, undefined, { code: 'dispatch_is_reversal' }])
  }, 60_000)

  it('an invoice in another currency than the org\'s is not made from a note', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 2]])
    const res = await w.fromDispatch([n._id], { currency: 'USD' })
    expect([res.status, res.json.code]).toEqual([422, 'invoice_foreign_currency'])
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()
  }, 60_000)
})

describe('a stock note that names no customer (FR-22.61a)', () => {
  it('is invoiced once someone says whose goods they were, and takes that customer', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 3]], { contactId: null })
    const page = await w.call('GET', `/warehouse/movement/${n._id}`)
    expect(page.json.stockMovement).toMatchObject({ invoiceable: true, needsCustomer: true })

    const unnamed = await w.fromDispatch([n._id])
    expect([unnamed.status, unnamed.json.code, unnamed.json.movementNumber]).toEqual([422, 'dispatch_without_customer', n.movementNumber])
    const notOne = await w.fromDispatch([n._id], { contactId: String(w.supplier._id) })
    expect([notOne.status, notOne.json.code]).toEqual([422, 'customer_not_found'])

    const res = await w.fromDispatch([n._id], { contactId: String(w.customer._id) })
    expect(res.status).toBe(200)
    const invoice = await w.load(res.json.invoice.id)
    expect(String(invoice.contactId)).toBe(String(w.customer._id))
    expect(invoice.stockSource.customerGivenTo.map(String)).toEqual([String(n._id)])
    expect(String((await w.mv(n._id)).contactId)).toBe(String(w.customer._id))
    const audit = await auditRow({ orgId: w.org._id, action: 'update', entityId: n._id, 'changes.field': 'contactId' })
    expect(audit?.changes?.[0]).toMatchObject({ oldValue: null, newValue: String(w.customer._id) })

    // A wrong choice stays correctable: deleting the draft takes the customer off again.
    expect((await w.call('DELETE', `/invoices/${invoice._id}`)).status).toBe(200)
    const back = await w.mv(n._id)
    expect([back.invoiceId ?? null, back.contactId ?? null]).toEqual([null, null])
    expect((await w.fromDispatch([n._id], { contactId: String(w.other._id) })).status).toBe(200)
  }, 60_000)

  it('must not contradict a note that names another customer', async () => {
    const w = await world()
    const named = await w.note([[w.bolt, 3]])
    const res = await w.fromDispatch([named._id], { contactId: String(w.other._id) })
    expect([res.status, res.json.code]).toEqual([422, 'customer_mismatch'])
  }, 60_000)

  it('a dispatch whose notes mark a correction is nobody\'s delivery', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 3]], { contactId: null, notes: 'Reconcile doc.pdf v2 (reconcile:0001-v2)' })
    const res = await w.fromDispatch([n._id], { contactId: String(w.customer._id) })
    expect([res.status, res.json.code]).toEqual([422, 'dispatch_not_a_delivery'])
    const page = await w.call('GET', `/warehouse/movement/${n._id}`)
    expect(page.json.stockMovement).toMatchObject({ invoiceable: false, notInvoiceable: { code: 'dispatch_not_a_delivery' } })
  }, 60_000)
})

describe('editing an invoice made from a stock note', () => {
  it('keeps its prices free and its stock-held quantities the note\'s', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10], [w.nut, 4]])
    const made = await w.fromDispatch([n._id])
    const id = made.json.invoice.id
    const lines = (await w.load(id)).lines.map((l: any) => ({
      productId: String(l.productId), warehouseId: String(l.warehouseId), description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, taxRate: l.taxRate, discount: 0,
    }))
    const put = (ls: any[], extra: Record<string, any> = {}) => w.call('PUT', `/invoices/${id}`, { lines: ls, ...extra })

    // A price, a discount, and a line that holds no stock: all the person's own.
    const priced = lines.map((l: any, i: number) => (i === 0 ? { ...l, unitPrice: 9, discount: 5 } : l))
    const service = { productId: String(w.fee._id), description: 'Доставка', quantity: 1, unit: 'pcs', unitPrice: 30, taxRate: 20, discount: 0 }
    expect((await put([...priced, service])).status).toBe(200)

    const less = await put(lines.map((l: any, i: number) => (i === 0 ? { ...l, quantity: 9 } : l)))
    expect([less.status, less.json.code]).toEqual([422, 'dispatch_quantity_mismatch'])
    expect(less.json.lines).toEqual([{ productId: String(w.bolt._id), name: 'Болт М8', dispatched: 10, invoiced: 9 }])
    const dropped = await put([lines[0]])
    expect([dropped.status, dropped.json.code]).toEqual([422, 'dispatch_quantity_mismatch'])
    const added = await put([...lines, { ...lines[0], quantity: 1 }])
    expect([added.status, added.json.code]).toEqual([422, 'dispatch_quantity_mismatch'])

    const moved = await w.call('PUT', `/invoices/${id}`, { contactId: String(w.other._id) })
    expect([moved.status, moved.json.code]).toEqual([422, 'customer_mismatch'])

    // The same quantity split over two lines is still the note's.
    const split = [{ ...lines[0], quantity: 6 }, { ...lines[0], quantity: 4, unitPrice: 9.5 }, lines[1]]
    expect((await put(split)).status).toBe(200)
    // A plain edit can neither give a document a stock source nor take one away.
    expect((await w.call('PUT', `/invoices/${id}`, { stockSource: { marker: '', docNumber: '', movementIds: [] } })).status).toBe(200)
    expect((await w.load(id)).stockSource.marker).toBe(`dispatch:${n._id}`)
  }, 60_000)
})

describe('the question before an invoice dispatches goods a note already delivered (FR-22.61b)', () => {
  it('asks, names the note, and leaves the draft as it was', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10], [w.nut, 4]])
    const invoice = await w.typed([[w.bolt, 10, 9]])
    const before = await w.movementCount()

    const asked = await w.send(invoice)
    expect([asked.status, asked.json.code]).toEqual([409, 'dispatch_overlap'])
    expect(asked.json.message).toContain(n.movementNumber)
    expect(asked.json.typedLines).toBe(1)
    expect(asked.json.notes).toEqual([{
      id: String(n._id), number: n.movementNumber, date: n.date.toISOString(), warehouseId: String(w.warehouse._id), lineCount: 2, quantity: 14,
    }])
    const still = await w.load(invoice.id)
    expect([still.status, still.invoiceNumber]).toEqual(['draft', invoice.invoiceNumber])
    expect(await w.stock(w.bolt)).toBe(90)
    expect(await w.movementCount()).toBe(before)

    // The form asks the same question before it checks any stock.
    expect((await w.question(invoice)).json.overlap).toMatchObject({ typedLines: 1, notes: [{ number: n.movementNumber }] })
  }, 60_000)

  it('"other goods" issues it and dispatches, and stays on the record', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const invoice = await w.typed([[w.bolt, 10, 9]])

    for (const answer of ['true', 1, {}]) {
      const notAnAnswer = await w.send(invoice, { acknowledgeOverlap: answer })
      expect([notAnAnswer.status, notAnAnswer.json.code]).toEqual([409, 'dispatch_overlap'])
    }
    const issued = await w.send(invoice, { acknowledgeOverlap: true })
    expect([issued.status, issued.json?.code]).toEqual([200, undefined])
    expect(await w.stock(w.bolt)).toBe(80)
    // The note is still nobody's: the next invoice is asked about it too.
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()
    const audit = await auditRow({ orgId: w.org._id, action: 'issue_overlap_acknowledged', entityId: (await w.load(invoice.id))._id })
    expect(audit?.changes?.[0]).toMatchObject({ field: 'stockNotes', newValue: n.movementNumber })
  }, 60_000)

  it('is not asked without evidence', async () => {
    const w = await world()
    const asked = async (invoice: any) => (await w.question(invoice)).json.overlap !== null

    // Another customer's note, and other articles.
    await w.note([[w.bolt, 10]], { contactId: String(w.other._id) })
    const theirs = await w.typed([[w.bolt, 10, 9]])
    expect(await asked(theirs)).toBe(false)
    const mine = await w.note([[w.nut, 4]])
    expect(await asked(theirs)).toBe(false)
    const nuts = await w.typed([[w.nut, 1, 4]])
    expect(await asked(nuts)).toBe(true)

    // A line that dispatches nothing: a service, and an article with no warehouse on its line.
    const service = await w.typed([[w.fee, 1, 30]])
    expect(await asked(service)).toBe(false)

    // A quote is no sale, and a document that is not a draft is past asking.
    const typedNuts = await w.load(nuts.id)
    expect(await dispatchesOverlapping(w.orgId, typedNuts)).toMatchObject({ typedLines: 1 })
    expect(await dispatchesOverlapping(w.orgId, { ...typedNuts, type: 'proforma' })).toBeNull()
    expect(await dispatchesOverlapping(w.orgId, { ...typedNuts, type: 'credit_note' })).toBeNull()
    expect(await dispatchesOverlapping(w.orgId, { ...typedNuts, type: 'cash_sale' })).toBeNull()
    expect(await dispatchesOverlapping(w.orgId, { ...typedNuts, direction: 'incoming' })).toBeNull()
    expect(await dispatchesOverlapping(w.orgId, { ...typedNuts, status: 'sent' })).toBeNull()
    expect(await dispatchesOverlapping(w.orgId, { ...typedNuts, stockSource: { marker: 'sklrazp:1' } })).toBeNull()

    // A note an invoice already carries.
    expect((await w.fromDispatch([mine._id])).status).toBe(200)
    expect(await asked(nuts)).toBe(false)
  }, 60_000)

  it('reaches as far as the receipts\' window either way, and no further', async () => {
    const w = await world()
    const day = (offset: number) => new Date(Date.parse('2026-10-21T00:00:00.000Z') + offset * 86_400_000).toISOString().slice(0, 10)
    const invoice = await w.typed([[w.bolt, 1, 10]])
    const asked = async () => (await w.question(invoice)).json.overlap !== null

    const early = await w.note([[w.bolt, 2]], { date: day(-DISPATCH_OVERLAP_WINDOW_DAYS - 1) })
    expect(await asked()).toBe(false)
    await StockMovement.updateOne({ _id: early._id }, { $set: { date: new Date(day(-DISPATCH_OVERLAP_WINDOW_DAYS)) } }).exec()
    expect(await asked()).toBe(true)
    await StockMovement.updateOne({ _id: early._id }, { $set: { date: new Date(day(DISPATCH_OVERLAP_WINDOW_DAYS + 1)) } }).exec()
    expect(await asked()).toBe(false)
  }, 60_000)

  it('with no customer on the note, only the same article at the same quantity on one line', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10], [w.nut, 3]], { contactId: null })

    const differs = await w.typed([[w.bolt, 9, 10]])
    expect((await w.question(differs)).json.overlap).toBeNull()
    const same = await w.typed([[w.bolt, 10, 9]])
    const asked = await w.send(same)
    expect([asked.status, asked.json.code]).toEqual([409, 'dispatch_overlap'])
    expect(asked.json.notes).toMatchObject([{ number: n.movementNumber, noCustomer: true }])
  }, 60_000)

  it('is asked once per note, however many of the customer\'s own dispatches stand before it', async () => {
    const w = await world()
    const n = await w.note([[w.nut, 4]], { date: '2026-10-02' })
    // Four invoices issued since: each booked a dispatch of its own that names the customer.
    for (let i = 0; i < 4; i++) {
      const sold = await w.typed([[w.bolt, 1, 10]], { issueDate: '2026-10-10' })
      expect((await w.send(sold)).status).toBe(200)
    }
    const picker = await w.call('GET', `/invoicing/sales/invoiceable-dispatches?contactId=${w.customer._id}`)
    expect(picker.json.dispatches.map((d: any) => d.number)).toEqual([n.movementNumber])
    const invoice = await w.typed([[w.nut, 4, 4]])
    expect((await w.question(invoice)).json.overlap.notes.map((x: any) => x.number)).toEqual([n.movementNumber])
  }, 60_000)

  it('takes no answer when there is nothing to ask, and records no acknowledgement for nothing', async () => {
    const w = await world()
    const quiet = await w.typed([[w.bolt, 1, 10]])
    expect((await w.send(quiet, { acknowledgeOverlap: true })).status).toBe(200)
    await Bun.sleep(100)
    expect(await AuditLog.countDocuments({ orgId: w.org._id, action: 'issue_overlap_acknowledged' }).exec()).toBe(0)
  }, 60_000)
})

describe('linking a typed invoice to its stock note (FR-22.62)', () => {
  it('keeps every line as typed when they already say what the note delivered', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10], [w.nut, 4]])
    // Negotiated: 9.20 with 5 % off, the same ten bolts over two lines, and a delivery fee.
    const invoice = await w.typed([[w.bolt, 6, 9.2, 5], [w.bolt, 4, 9.2, 5], [w.nut, 4, 3.8], [w.fee, 1, 30]])
    const typedLines = (await w.load(invoice.id)).lines.map((l: any) => [String(l.productId), l.quantity, l.unitPrice, l.discount ?? 0, l.lineTotal])
    const totals = (i: any) => [i.subtotal, i.discountTotal, i.taxTotal, i.total, i.notes]
    const typedTotals = totals(await w.load(invoice.id))

    const linked = await w.link(invoice, [n._id])
    expect([linked.status, linked.json?.code]).toEqual([200, undefined])
    const now = await w.load(invoice.id)
    expect(now.lines.map((l: any) => [String(l.productId), l.quantity, l.unitPrice, l.discount ?? 0, l.lineTotal])).toEqual(typedLines)
    expect(totals(now)).toEqual(typedTotals)
    expect(now.stockSource).toMatchObject({ marker: `dispatch:${n._id}`, detectedBy: 'manual' })
    expect(String((await w.mv(n._id)).invoiceId)).toBe(String(now._id))

    // Linked, it is asked nothing and takes nothing.
    const before = await w.movementCount()
    expect((await w.send(invoice)).status).toBe(200)
    expect([await w.stock(w.bolt), await w.stock(w.nut)]).toEqual([90, 96])
    expect(await w.movementCount()).toBe(before)
  }, 60_000)

  it('names the differences, and replaces the stock-held lines only when told to', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10], [w.nut, 4]])
    const invoice = await w.typed([[w.bolt, 8, 9.2], [w.fee, 1, 30]])

    const differs = await w.link(invoice, [n._id])
    expect([differs.status, differs.json.code, differs.json.typedLines]).toEqual([422, 'invoice_lines_differ', 2])
    expect(differs.json.lines).toEqual([
      { productId: String(w.bolt._id), name: 'Болт М8', dispatched: 10, invoiced: 8 },
      { productId: String(w.nut._id), name: 'Гайка М8', dispatched: 4, invoiced: 0 },
    ])
    expect((await w.load(invoice.id)).stockSource?.marker).toBeFalsy()
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()

    const replaced = await w.link(invoice, [n._id], { replaceLines: true })
    expect(replaced.status).toBe(200)
    const now = await w.load(invoice.id)
    // The note's lines at the customer's prices, and the fee, which holds no stock, as it was typed.
    expect(now.lines.map((l: any) => [l.description, l.quantity, l.unitPrice])).toEqual([['Болт М8', 10, 10], ['Гайка М8', 4, 4], ['Доставка', 1, 30]])
    expect([now.subtotal, now.taxTotal, now.total, now.amountDue]).toEqual([146, 29.2, 175.2, 175.2])
    expect(now.invoiceNumber).toBe(invoice.invoiceNumber)
    const audit = await auditRow({ orgId: w.org._id, action: 'update', entityId: now._id, 'changes.field': 'stockNotes' })
    expect(audit.changes.find((c: any) => c.field === 'lines').oldValue).toEqual([
      { productId: String(w.bolt._id), description: 'Болт М8', quantity: 8, unitPrice: 9.2 },
      { productId: String(w.fee._id), description: 'Доставка', quantity: 1, unitPrice: 30 },
    ])
    expect(audit.changes.find((c: any) => c.field === 'total')).toMatchObject({ newValue: 175.2 })
  }, 60_000)

  it('„Словом" follows a total the link moved, in the language it was written in', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const invoice = await w.typed([[w.bolt, 1, 10]], { notes: 'Словом : дванадесет евро и 00 цента, Данъчна основа 10.00 €' })
    expect((await w.link(invoice, [n._id], { replaceLines: true })).status).toBe(200)
    const now = await w.load(invoice.id)
    expect(now.total).toBe(120)
    expect(now.notes).toBe('Словом : сто двадесет евро и нула цента, Данъчна основа 100.00 €')
  }, 60_000)

  it('an empty draft takes the note\'s lines', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const created = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: String(w.customer._id), issueDate: '2026-10-21', dueDate: '2026-11-21', currency: 'EUR', lines: [], subtotal: 0, total: 0,
    })
    expect(created.status).toBe(200)
    expect((await w.link(created.json.invoice, [n._id])).status).toBe(200)
    const now = await w.load(created.json.invoice.id)
    expect(now.lines.map((l: any) => [l.description, l.quantity, l.unitPrice])).toEqual([['Болт М8', 10, 10]])
    expect(now.total).toBe(120)
  }, 60_000)

  it('refuses what cannot be linked, and leaves it as it was', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])

    const issued = await w.typed([[w.nut, 1, 4]])
    expect((await w.send(issued)).status).toBe(200)
    expect((await w.link(issued, [n._id])).json.code).toBe('invoice_not_draft')

    const bill = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR',
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.warehouse._id), description: 'Болт М8', quantity: 10, unitPrice: 5, taxRate: 20 }], subtotal: 50, total: 60,
    })
    expect((await w.link(bill.json.invoice, [n._id])).json.code).toBe('not_a_sales_invoice')

    const theirs = await w.typed([[w.bolt, 10, 9]], { contactId: String(w.other._id) })
    expect((await w.link(theirs, [n._id])).json.code).toBe('customer_mismatch')

    const onOrder = await w.typed([[w.bolt, 10, 9]])
    await Invoice.updateOne({ _id: onOrder.id }, { $set: { 'lines.0.orderRef': { reservationId: w.org._id } } }).exec()
    expect((await w.link(onOrder, [n._id])).json.code).toBe('invoice_on_order')

    const foreign = await w.typed([[w.bolt, 8, 9]], { currency: 'USD', exchangeRate: 0.9 })
    expect((await w.link(foreign, [n._id], { replaceLines: true })).json.code).toBe('invoice_foreign_currency')

    expect((await w.link({ id: '000000000000000000000000' }, [n._id])).status).toBe(404)
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()

    const linked = await w.typed([[w.bolt, 10, 9]])
    expect((await w.link(linked, [n._id])).status).toBe(200)
    const second = await w.note([[w.bolt, 10]])
    expect((await w.link(linked, [second._id])).json.code).toBe('invoice_already_linked')
    const late = await w.typed([[w.bolt, 10, 9]])
    expect((await w.link(late, [n._id])).json.code).toBe('dispatch_already_invoiced')
    expect((await w.load(late.id)).stockSource?.marker).toBeFalsy()
  }, 60_000)

  it('an invoice edited between the read and the link is not linked: its lines were judged as they were read', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const invoice = await w.typed([[w.bolt, 10, 9]])
    const stored = (await w.load(invoice.id)).lines[0]
    const edited = { productId: String(stored.productId), warehouseId: String(stored.warehouseId), description: stored.description, quantity: 12, unit: 'pcs', unitPrice: 9, taxRate: 20 }

    const spy = before(Invoice, 'findOneAndUpdate', f => String(f?._id) === invoice.id && 'stockSource.marker' in (f || {}),
      async () => { expect((await w.call('PUT', `/invoices/${invoice.id}`, { lines: [edited] })).status).toBe(200) })
    let linked: any
    try {
      linked = await w.link(invoice, [n._id])
    } finally {
      spy.mockRestore()
    }
    expect([linked.status, linked.json.code]).toEqual([409, 'invoice_already_linked'])
    const now = await w.load(invoice.id)
    expect([now.stockSource?.marker || null, now.lines[0].quantity]).toEqual([null, 12])
    expect((await w.mv(n._id)).invoiceId ?? null).toBeNull()
    // Read again, it says something other than the note delivered, and is told so.
    expect((await w.link(invoice, [n._id])).json.code).toBe('invoice_lines_differ')
  }, 60_000)

  it('a claim lost to another invoice puts the typed lines back', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const invoice = await w.typed([[w.bolt, 8, 9.2], [w.fee, 1, 30]], { notes: 'както се разбрахме' })
    const typed = await w.load(invoice.id)
    const shape = (i: any) => [i.lines.map((l: any) => [l.description, l.quantity, l.unitPrice]), i.subtotal, i.taxTotal, i.total, i.amountDue, i.notes, i.stockSource?.marker || null]

    let winner: any
    const spy = before(StockMovement, 'updateOne', f => String(f?._id) === String(n._id), async () => { winner = await w.fromDispatch([n._id]) })
    let lost: any
    try {
      lost = await w.link(invoice, [n._id], { replaceLines: true })
    } finally {
      spy.mockRestore()
    }
    expect(winner.status).toBe(200)
    expect([lost.status, lost.json.code]).toEqual([409, 'dispatch_already_invoiced'])
    expect(shape(await w.load(invoice.id))).toEqual(shape(typed))
    expect(String((await w.mv(n._id)).invoiceId)).toBe(winner.json.invoice.id)
  }, 60_000)

  it('the picker lists the customer\'s uninvoiced notes, newest first, then the ones that name nobody', async () => {
    const w = await world()
    const older = await w.note([[w.bolt, 1]], { date: '2026-10-10' })
    const newer = await w.note([[w.bolt, 2], [w.nut, 5]], { date: '2026-10-12' })
    const nobody = await w.note([[w.nut, 1]], { contactId: null, notes: 'за склада' })
    await w.note([[w.nut, 1]], { contactId: String(w.other._id) })
    const invoiced = await w.note([[w.bolt, 3]], { date: '2026-10-15' })
    expect((await w.fromDispatch([invoiced._id])).status).toBe(200)

    const res = await w.call('GET', `/invoicing/sales/invoiceable-dispatches?contactId=${w.customer._id}`)
    expect(res.status).toBe(200)
    expect(res.json.dispatches.map((d: any) => [d.number, d.lineCount, d.quantity, d.noCustomer ?? false, d.notes])).toEqual([
      [newer.movementNumber, 2, 7, false, undefined],
      [older.movementNumber, 1, 1, false, undefined],
      [nobody.movementNumber, 1, 1, true, 'за склада'],
    ])
    // No cost reaches the picker: a note's amounts are what the goods cost.
    expect(Object.keys(res.json.dispatches[0]).sort()).toEqual(['date', 'id', 'lineCount', 'number', 'quantity', 'warehouseId'])
    expect((await w.call('GET', '/invoicing/sales/invoiceable-dispatches')).status).toBe(422)
  }, 60_000)
})

describe('who may make an invoice from a stock note', () => {
  it('a session without sales documents is told of no invoice, offered none, and makes none', async () => {
    const w = await world()
    const n = await w.note([[w.bolt, 10]])
    const made = await w.fromDispatch([n._id])
    const keeper = await createTestUser(w.org._id, { role: 'warehouse_manager' } as any)
    const asKeeper = await tokenFor({ id: String(keeper._id), orgId: w.orgId }, 'warehouse_manager')
    const free = await w.note([[w.nut, 1]])

    const page = await w.call('GET', `/warehouse/movement/${n._id}`, undefined, asKeeper)
    expect(page.status).toBe(200)
    expect(page.json.stockMovement.sale).toBeUndefined()
    expect(page.json.stockMovement.invoiceable).toBeUndefined()
    const list = await w.call('GET', '/warehouse/movement?type=dispatch', undefined, asKeeper)
    expect(list.json.stockMovements.some((m: any) => m.sale)).toBe(false)

    const refused = await w.call('POST', '/invoicing/sales/from-dispatch', { movementIds: [String(free._id)] }, asKeeper)
    expect(refused.status).toBe(403)
    expect((await w.call('POST', `/invoicing/sales/${made.json.invoice.id}/link-dispatches`, { movementIds: [String(free._id)] }, asKeeper)).status).toBeGreaterThanOrEqual(403)
    expect((await w.mv(free._id)).invoiceId ?? null).toBeNull()
  }, 60_000)
})
