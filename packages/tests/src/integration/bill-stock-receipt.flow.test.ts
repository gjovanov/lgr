import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct } from '../helpers/factories'
import { invoiceController } from 'api/src/invoicing/controllers/invoice.controller'
import { buildStockReceiptData, invoiceExportController } from 'api/src/invoicing/controllers/invoice-export.controller'
import { receiptBillController } from 'api/src/invoicing/controllers/receipt-bill.controller'
import { movementController } from 'api/src/warehouse/controllers/movement.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { billStockReceiptSections, stockReceiptCurrency } from 'services/biz/bill-stock-receipt.service'
import { tokenize } from 'services/biz/auth.service'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { buildStockReceiptHtml } from 'reporting/pdf/stock-receipt.pdf'
import { Invoice, Org, Product, Role, StockMovement, User } from 'db/models'
import { config } from 'config'
import { withImplied } from 'config/access'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { stockReceiptLevelOf, type StockReceiptPriceLevel } from 'config/stock-receipt-price'

/**
 * „Складова разписка" printed from a supplier bill: `GET /invoicing/export/:id?doc=stock_receipt`.
 *
 * It prints the goods the bill booked — the completed receipts whose `invoiceId` is the bill: the
 * ones a bill makes when it is received (one per warehouse), or the receipts a bill was made from,
 * which it claims while still a draft. Refused for anything but a supplier bill (422), for a voided
 * one (422), and when nothing is booked (404). `GET /invoices/:id` names the receipts, so the form
 * offers the print only when there is something to print.
 *
 * Owner, 2026-11-15: it is the sheet the warehouse prices the goods from. `?priceLevel=` says which
 * price its lines carry (`config/stock-receipt-price`): a level of the catalogue as it stands today,
 * or `booked`, what the receipt was booked at. Without one it prints „Цена на едро". A level the
 * caller's role does not see is refused (403), a name that is no level too (422).
 *
 * Driven over HTTP through the real controllers. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows
 * deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(invoiceController).use(invoiceExportController).use(receiptBillController).use(movementController)
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

/** A level by the key a request names it with. */
const level = (key: string): StockReceiptPriceLevel => {
  const found = stockReceiptLevelOf(key)
  if (!found) throw new Error(`no such level: ${key}`)
  return found
}
const BOOKED = level('booked')
const tier = (name: string, finalPrice: number) => ({ name, percent: 0, finalPrice, manualOverride: true })

/** Just the text of a page, for what it says rather than its markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const customer = await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
  const north = await createTestWarehouse(org._id, { name: 'Склад Север', isDefault: true } as any)
  const south = await createTestWarehouse(org._id, { name: 'Склад Юг' } as any)
  // The catalogue's prices, none of them a figure a bill below books at: a level is never mistaken for a cost.
  // The bolt has a „Цена 2" of nothing; the nut has no „Доставна цена", „Цена 1" or „Цена 2" slot at all.
  const bolt = await createTestProduct(org._id, {
    sku: 'PRD-0001', name: 'Болт М8', unit: 'pcs', purchasePrice: 5, sellingPrice: 0.09, taxRate: 20,
    priceTiers: [tier('Доставна цена', 0.0391), tier('Цена на едро', 0.0611), tier('Цена 1', 0.0724), tier('Цена 2', 0)],
  } as any)
  const nut = await createTestProduct(org._id, {
    sku: 'PRD-0002', name: 'Гайка М8', unit: 'kg', purchasePrice: 2, sellingPrice: 19.9, taxRate: 20,
    priceTiers: [tier('Цена на едро', 15.75)],
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function raw(method: string, path: string, body?: any, as: string = token) {
    return app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
  }
  async function call(method: string, path: string, body?: any) {
    const res = await raw(method, path, body)
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** A supplier bill, as the bill form saves one: a draft, its lines in the warehouses given. */
  async function bill(lines: Array<[any, any, number, number]>, extra: Record<string, any> = {}) {
    const ls = lines.map(([p, wh, quantity, unitPrice]) => ({
      productId: String(p._id), warehouseId: String(wh._id), description: `${p.name} (по фактура)`,
      quantity, unit: p.unit, unitPrice, taxRate: 20,
    }))
    const subtotal = ls.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
    const res = await call('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(supplier._id), issueDate: '2026-10-29', currency: 'EUR',
      reference: 'SUP-77', lines: ls, subtotal, total: +(subtotal * 1.2).toFixed(2), ...extra,
    })
    expect(res.status).toBe(200)
    return res.json.invoice
  }

  /** The bill every price test prints: a bolt into the north, a nut and more bolts into the south. Received. */
  async function receivedBill() {
    const b = await bill([[bolt, north, 100, 0.0472], [nut, south, 2.5, 12.5], [bolt, south, 10, 0.05]])
    expect((await call('POST', `/invoices/${b.id}/receive`)).status).toBe(200)
    return b
  }

  /** A completed goods receipt from the supplier, as the receipt form books it. */
  async function receipt(lines: Array<[any, number, number]>) {
    const ls = lines.map(([p, q, cost]) => ({ productId: String(p._id), quantity: q, unitCost: cost, totalCost: q * cost }))
    const created = await call('POST', '/warehouse/movement', {
      type: 'receipt', date: '2026-10-20', toWarehouseId: String(north._id), contactId: String(supplier._id),
      lines: ls, totalAmount: ls.reduce((s, l) => s + l.totalCost, 0),
    })
    expect(created.status).toBe(200)
    const id = created.json.stockMovement._id || created.json.stockMovement.id
    expect((await call('POST', `/warehouse/movement/${id}/confirm`, {})).status).toBe(200)
    return StockMovement.findById(id).lean().exec() as Promise<any>
  }

  /** What each line prints at a level, by warehouse: `[name, quantity, price]`. */
  async function printed(billId: string, at: StockReceiptPriceLevel) {
    const sections = await billStockReceiptSections(orgId, await Invoice.findById(billId).lean().exec(), at)
    return Object.fromEntries(sections.map(s => [s.warehouse, s.lines.map(l => [l.name, l.quantity, l.unitPrice])]))
  }

  const stockReceipt = (id: string, query = 'doc=stock_receipt&format=pdf&locale=bg', as?: string) =>
    raw('GET', `/invoicing/export/${id}?${query}`, undefined, as)
  /** The print at a level, as the dialog asks for it. */
  const stockReceiptAt = (id: string, key: string, as?: string) =>
    stockReceipt(id, `doc=stock_receipt&format=pdf&locale=bg&priceLevel=${encodeURIComponent(key)}`, as)

  return { org, orgId, supplier, customer, north, south, bolt, nut, call, bill, receivedBill, receipt, printed, stockReceipt, stockReceiptAt }
}

describe('„Складова разписка" of a supplier bill', () => {
  it('a bill received into two warehouses: two receipts, named on the bill, printed one section each', async () => {
    const w = await world()
    const b = await w.receivedBill()

    // The form learns there is something to print — by number, date and warehouse.
    const page = await w.call('GET', `/invoices/${b.id}`)
    const listed = page.json.invoice.stockMovements
    expect(listed.map((m: any) => m.warehouseName).sort()).toEqual(['Склад Север', 'Склад Юг'])
    expect(listed.every((m: any) => /^SM-/.test(m.number) && m.id && m.date)).toBe(true)

    // What the print is made of: the receipts' own lines, the catalog's names and units, and, as
    // booked, the bill's prices (what a bill that receives its own goods books them at).
    const inv = await Invoice.findById(b.id).lean().exec()
    const sections = await billStockReceiptSections(w.orgId, inv, BOOKED)
    const byWh = Object.fromEntries(sections.map(s => [s.warehouse, s]))
    expect(byWh['Склад Север'].lines).toEqual([{ name: 'Болт М8', unit: 'pcs', quantity: 100, unitPrice: 0.0472 }])
    expect(byWh['Склад Юг'].lines).toEqual([
      { name: 'Гайка М8', unit: 'kg', quantity: 2.5, unitPrice: 12.5 },
      { name: 'Болт М8', unit: 'pcs', quantity: 10, unitPrice: 0.05 },
    ])
    expect(sections.map(s => s.number).sort()).toEqual(listed.map((m: any) => m.number).sort())

    const res = await w.stockReceiptAt(b.id, 'booked')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain(`${page.json.invoice.invoiceNumber}-stock-receipt.pdf`)
    const pdf = Buffer.from(await res.arrayBuffer())
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
  }, 120_000)

  it('a DRAFT bill made from receipts prints them: its receipts are booked, whatever the bill', async () => {
    const w = await world()
    const r = await w.receipt([[w.bolt, 10, 5.5], [w.nut, 4, 2.25]])
    const made = await w.call('POST', '/invoicing/bills/from-receipt', { movementIds: [String(r._id)] })
    expect(made.status).toBe(200)
    const draft = made.json.invoice
    expect(draft.status).toBe('draft')

    const page = await w.call('GET', `/invoices/${draft.id}`)
    expect(page.json.invoice.stockMovements.map((m: any) => [m.number, m.warehouseName])).toEqual([[r.movementNumber, 'Склад Север']])

    // As booked, the receipt's own costs: it booked them, and the bill keeps the supplier's prices apart.
    expect(await w.printed(draft.id, BOOKED)).toEqual({ 'Склад Север': [['Болт М8', 10, 5.5], ['Гайка М8', 4, 2.25]] })
    // At a level, the catalogue's figures: where the receipt came from changes nothing.
    expect(await w.printed(draft.id, level('Цена на едро'))).toEqual({ 'Склад Север': [['Болт М8', 10, 0.0611], ['Гайка М8', 4, 15.75]] })

    const res = await w.stockReceipt(draft.id)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF')
  }, 120_000)

  it('a bill that booked nothing: nothing named, and 404', async () => {
    const w = await world()
    const b = await w.bill([[w.bolt, w.north, 5, 5]])
    expect((await w.call('GET', `/invoices/${b.id}`)).json.invoice.stockMovements).toEqual([])
    const res = await w.stockReceipt(b.id)
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('no_goods_booked')
  }, 60_000)

  it('a voided bill: its goods were reversed — nothing named, and 422', async () => {
    const w = await world()
    const b = await w.bill([[w.bolt, w.north, 5, 5]])
    expect((await w.call('POST', `/invoices/${b.id}/receive`)).status).toBe(200)
    expect((await w.call('POST', `/invoices/${b.id}/void`)).status).toBe(200)
    // The receipt is still there, completed, with the bill's id — the print must not offer it.
    expect(await StockMovement.countDocuments({ orgId: w.orgId, invoiceId: b.id, type: 'receipt', status: 'completed' }).exec()).toBe(1)

    expect((await w.call('GET', `/invoices/${b.id}`)).json.invoice.stockMovements).toEqual([])
    const res = await w.stockReceipt(b.id)
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('bill_voided')
  }, 60_000)

  it('a sales invoice is no supplier bill: 422, and its page names no receipts', async () => {
    const w = await world()
    const res0 = await w.call('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: String(w.customer._id), issueDate: '2026-10-29', currency: 'EUR',
      lines: [{ productId: String(w.bolt._id), warehouseId: String(w.north._id), description: 'Болт М8', quantity: 1, unitPrice: 9, taxRate: 20 }],
      subtotal: 9, total: 10.8,
    })
    expect(res0.status).toBe(200)
    const id = res0.json.invoice.id
    expect((await w.call('GET', `/invoices/${id}`)).json.invoice).not.toHaveProperty('stockMovements')
    const res = await w.stockReceipt(id)
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('not_a_bill')
  }, 60_000)

  it('prints as PDF only', async () => {
    const w = await world()
    const b = await w.bill([[w.bolt, w.north, 5, 5]])
    expect((await w.call('POST', `/invoices/${b.id}/receive`)).status).toBe(200)
    expect((await w.stockReceipt(b.id, 'doc=stock_receipt&format=xlsx')).status).toBe(400)
  }, 60_000)
})

describe('the price a stock receipt prints', () => {
  it('each level prints the catalogue\'s own figure for it, line by line', async () => {
    const w = await world()
    const b = await w.receivedBill()

    expect(await w.printed(b.id, level('Цена на едро'))).toEqual({
      'Склад Север': [['Болт М8', 100, 0.0611]],
      'Склад Юг': [['Гайка М8', 2.5, 15.75], ['Болт М8', 10, 0.0611]],
    })
    expect(await w.printed(b.id, level('selling'))).toEqual({
      'Склад Север': [['Болт М8', 100, 0.09]],
      'Склад Юг': [['Гайка М8', 2.5, 19.9], ['Болт М8', 10, 0.09]],
    })
    // The slot drawn as „Цена с ТО", by the name it is stored under and by its label alike.
    for (const key of ['Доставна цена', 'Цена с ТО']) {
      expect(await w.printed(b.id, level(key))).toEqual({
        'Склад Север': [['Болт М8', 100, 0.0391]],
        'Склад Юг': [['Гайка М8', 2.5, null], ['Болт М8', 10, 0.0391]],
      })
    }
    // As booked: what the receipts hold, which is no level of the catalogue.
    expect(await w.printed(b.id, BOOKED)).toEqual({
      'Склад Север': [['Болт М8', 100, 0.0472]],
      'Склад Юг': [['Гайка М8', 2.5, 12.5], ['Болт М8', 10, 0.05]],
    })
  }, 60_000)

  it('an article with no price at the level has none: no slot, a slot of nothing; never another level\'s figure', async () => {
    const w = await world()
    const b = await w.receivedBill()
    // „Цена 1": the nut has no such slot.
    expect(await w.printed(b.id, level('Цена 1'))).toEqual({
      'Склад Север': [['Болт М8', 100, 0.0724]],
      'Склад Юг': [['Гайка М8', 2.5, null], ['Болт М8', 10, 0.0724]],
    })
    // „Цена 2": the bolt's is zero, the nut has none.
    expect(await w.printed(b.id, level('Цена 2'))).toEqual({
      'Склад Север': [['Болт М8', 100, null]],
      'Склад Юг': [['Гайка М8', 2.5, null], ['Болт М8', 10, null]],
    })
    // „Цена 9": nobody has it.
    expect(await w.printed(b.id, level('Цена 9'))).toEqual({
      'Склад Север': [['Болт М8', 100, null]],
      'Склад Юг': [['Гайка М8', 2.5, null], ['Болт М8', 10, null]],
    })
    // A selling price of nothing is no price either.
    await Product.updateOne({ _id: w.nut._id }, { $set: { sellingPrice: 0 } }).exec()
    expect((await w.printed(b.id, level('selling')))['Склад Юг']).toEqual([['Гайка М8', 2.5, null], ['Болт М8', 10, 0.09]])
  }, 60_000)

  it('the catalogue\'s figure of the day it is printed, not of the day the goods came', async () => {
    const w = await world()
    const b = await w.receivedBill()
    await Product.updateOne({ _id: w.bolt._id, 'priceTiers.name': 'Цена на едро' }, { $set: { 'priceTiers.$.finalPrice': 0.0688 } }).exec()
    expect((await w.printed(b.id, level('Цена на едро')))['Склад Север']).toEqual([['Болт М8', 100, 0.0688]])
    // What was booked is what was booked.
    expect((await w.printed(b.id, BOOKED))['Склад Север']).toEqual([['Болт М8', 100, 0.0472]])
  }, 60_000)

  it('an article the catalogue no longer has: the bill line\'s wording, no price at a level, its booked price as booked', async () => {
    const w = await world()
    const b = await w.receivedBill()
    await Product.deleteOne({ _id: w.nut._id }).exec()
    expect((await w.printed(b.id, level('Цена на едро')))['Склад Юг']).toEqual([['Гайка М8 (по фактура)', 2.5, null], ['Болт М8', 10, 0.0611]])
    expect((await w.printed(b.id, level('selling')))['Склад Юг']).toEqual([['Гайка М8 (по фактура)', 2.5, null], ['Болт М8', 10, 0.09]])
    expect((await w.printed(b.id, BOOKED))['Склад Юг']).toEqual([['Гайка М8 (по фактура)', 2.5, 12.5], ['Болт М8', 10, 0.05]])
  }, 60_000)

  it('the page: the level by name, each line at it, a dash where there is none, and no total', async () => {
    const w = await world()
    const b = await w.receivedBill()
    const inv = await Invoice.findById(b.id).lean().exec()

    const data = (await buildStockReceiptData(w.orgId, inv, 'bg', level('Цена 1')))!
    expect(data.price).toEqual({ key: 'Цена 1', kind: 'tier', tier: 'Цена 1' })
    expect(data.currency).toBe('EUR')
    const { html } = buildStockReceiptHtml(data)
    const page = text(html)
    expect(page.match(/СКЛАДОВА РАЗПИСКА/g)).toHaveLength(2)
    expect(page.match(/Цена: Цена 1 \(€\)/g)).toHaveLength(2)
    // 100 × 0.0724 = 7.24 and 10 × 0.0724 = 0.72 to the cent; the nut has no „Цена 1".
    expect(html).toContain('<td class="c-price fit">0.0724</td>')
    expect(html).toContain('<td class="c-amount fit">7.24</td>')
    expect(html).toContain('<td class="c-amount fit">0.72</td>')
    expect(html.match(/<td class="c-price fit">—<\/td>/g)).toHaveLength(1)
    expect(html.match(/<td class="c-amount fit">—<\/td>/g)).toHaveLength(1)
    // Not the booked figures, and nothing added up.
    for (const booked of ['0.0472', '12.50', '31.25']) expect({ booked, printed: page.includes(booked) }).toEqual({ booked, printed: false })
    expect(page).not.toMatch(/Общо|ДДС/)

    // The other names a sheet can carry, from the same bill.
    const named = async (key: string) => text(buildStockReceiptHtml((await buildStockReceiptData(w.orgId, inv, 'bg', level(key)))!).html)
    expect(await named('Цена на едро')).toContain('Цена: Цена на едро (€)')
    expect(await named('selling')).toContain('Цена: Продажна цена (€)')
    expect(await named('Доставна цена')).toContain('Цена: Цена с ТО (€)')
    const asBooked = await named('booked')
    expect(asBooked).toContain('Цена: Цена на заприходяване (€)')
    expect(asBooked).toContain('0.0472')
    expect(asBooked).not.toMatch(/Общо|ДДС/)
  }, 60_000)
})

describe('asking the route for a level', () => {
  it('prints the level asked for, and „Цена на едро" when none is', async () => {
    const w = await world()
    const b = await w.receivedBill()
    for (const res of [await w.stockReceipt(b.id), await w.stockReceiptAt(b.id, 'Цена 1')]) {
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF')
    }
  }, 120_000)

  it('a name that is no level: 422, and not the default in its place', async () => {
    const w = await world()
    const b = await w.receivedBill()
    for (const junk of ['Цена 11', 'wholesale', 'total']) {
      const res = await w.stockReceiptAt(b.id, junk)
      expect({ junk, status: res.status }).toEqual({ junk, status: 422 })
      const body = await res.json()
      expect(body.code).toBe('unknown_price_level')
      expect(body.message).toContain(junk)
    }
  }, 60_000)

  it('a level the caller\'s role does not see: 403, whatever the request says; the levels it sees print', async () => {
    const w = await world()
    const b = await w.receivedBill()

    // The org's people get a role each (FR-27), and this one reads bills and prints them but was not
    // given „Цена на едро" or „Цена 3": as the role editor would save it, with what its pages imply.
    await Org.updateOne({ _id: w.org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
    const role: any = await Role.create({
      orgId: w.org._id, name: 'Склад', isBuiltin: false, edited: true, version: 1,
      legacy: { role: 'member', permissions: ['invoicing.read', 'inventory.read'] },
      caps: withImplied(['bills.view', 'sales-docs.view', 'sales-docs.export', 'products.view', 'products.price:selling', 'products.price:1', 'products.price:2']),
    } as any)
    const member = await createTestUser(w.org._id, { role: 'member', username: 'sklad', email: 'sklad@stock-receipt.test' } as any)
    await User.updateOne({ _id: member._id }, { $set: { roleId: role._id } }).exec()
    forgetMember(member._id)
    forgetRole(role._id)
    const asMember = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(member._id).exec())!))

    for (const [key, capability] of [['Цена на едро', 'products.price:wholesale'], ['Цена 3', 'products.price:3']]) {
      const res = await w.stockReceiptAt(b.id, key, asMember)
      expect({ key, status: res.status }).toEqual({ key, status: 403 })
      expect(await res.json()).toMatchObject({ code: 'capability_required', capabilities: [capability] })
    }
    // What it does see prints: a level of its own, the booked price, and, with no level named, the
    // first level it sees in place of the „Цена на едро" it does not.
    for (const res of [await w.stockReceiptAt(b.id, 'Цена 1', asMember), await w.stockReceiptAt(b.id, 'booked', asMember), await w.stockReceipt(b.id, undefined, asMember)]) {
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF')
    }
    // The Administrator of the same org still prints every level.
    expect((await w.stockReceiptAt(b.id, 'Цена на едро')).status).toBe(200)
  }, 180_000)
})

describe('the currency a stock receipt prints in', () => {
  it('as booked, a bill that received its own goods booked them at its own prices: the bill\'s', () => {
    expect(stockReceiptCurrency({ currency: 'USD' }, 'EUR', BOOKED)).toBe('USD')
  })

  it('as booked, a bill made from receipts prints what they booked: the org\'s, whatever the bill says', () => {
    expect(stockReceiptCurrency({ currency: 'USD', stockSource: { marker: 'movement:6ae61ec7' } }, 'EUR', BOOKED)).toBe('EUR')
  })

  it('as booked, a marker that is not a receipt link changes nothing, and neither does an org with no currency', () => {
    expect(stockReceiptCurrency({ currency: 'USD', stockSource: { marker: 'cash_sale:CS-1' } }, 'EUR', BOOKED)).toBe('USD')
    expect(stockReceiptCurrency({ currency: 'USD', stockSource: { marker: 'movement:6ae61ec7' } }, undefined, BOOKED)).toBe('USD')
  })

  it('at a price level, the org\'s: the catalogue is priced in it, whatever the bill was written in', () => {
    for (const key of ['Цена на едро', 'selling', 'Доставна цена', 'Цена 4']) {
      expect({ key, currency: stockReceiptCurrency({ currency: 'USD' }, 'EUR', level(key)) }).toEqual({ key, currency: 'EUR' })
      expect(stockReceiptCurrency({ currency: 'USD', stockSource: { marker: 'movement:6ae61ec7' } }, 'EUR', level(key))).toBe('EUR')
    }
    // An org that names no currency: the bill's, rather than none.
    expect(stockReceiptCurrency({ currency: 'USD' }, undefined, level('Цена на едро'))).toBe('USD')
  })
})
