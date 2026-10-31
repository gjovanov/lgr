import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller'
import { receiptBillController } from 'invoicing-api/src/controllers/receipt-bill.controller'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { billStockReceiptSections } from 'services/biz/bill-stock-receipt.service'
import { Invoice, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * „Стокова разписка" printed from a supplier bill: `GET /invoicing/export/:id?doc=stock_receipt`.
 *
 * It prints the goods the bill booked — the completed receipts whose `invoiceId` is the bill: the
 * ones a bill makes when it is received (one per warehouse), or the receipts a bill was made from,
 * which it claims while still a draft. Refused for anything but a supplier bill (422), for a voided
 * one (422), and when nothing is booked (404). `GET /invoices/:id` names the receipts, so the form
 * offers the print only when there is something to print.
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

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const customer = await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
  const north = await createTestWarehouse(org._id, { name: 'Склад Север', isDefault: true } as any)
  const south = await createTestWarehouse(org._id, { name: 'Склад Юг' } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', unit: 'pcs', purchasePrice: 5, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { sku: 'PRD-0002', name: 'Гайка М8', unit: 'kg', purchasePrice: 2, taxRate: 20 } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function raw(method: string, path: string, body?: any) {
    return app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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

  const stockReceipt = (id: string, query = 'doc=stock_receipt&format=pdf&locale=bg') => raw('GET', `/invoicing/export/${id}?${query}`)

  return { org, orgId, supplier, customer, north, south, bolt, nut, call, bill, receipt, stockReceipt }
}

describe('„Стокова разписка" of a supplier bill', () => {
  it('a bill received into two warehouses: two receipts, named on the bill, printed one section each', async () => {
    const w = await world()
    const b = await w.bill([[w.bolt, w.north, 100, 0.0472], [w.nut, w.south, 2.5, 12.5], [w.bolt, w.south, 10, 0.05]])
    expect((await w.call('POST', `/invoices/${b.id}/receive`)).status).toBe(200)

    // The form learns there is something to print — by number, date and warehouse.
    const page = await w.call('GET', `/invoices/${b.id}`)
    const listed = page.json.invoice.stockMovements
    expect(listed.map((m: any) => m.warehouseName).sort()).toEqual(['Склад Север', 'Склад Юг'])
    expect(listed.every((m: any) => /^SM-/.test(m.number) && m.id && m.date)).toBe(true)

    // What the print is made of: the receipts' own lines, the catalog's names and units, the
    // bill's prices (what a bill that receives its own goods books them at).
    const inv = await Invoice.findById(b.id).lean().exec()
    const sections = await billStockReceiptSections(w.orgId, inv)
    const byWh = Object.fromEntries(sections.map(s => [s.warehouse, s]))
    expect(byWh['Склад Север'].lines).toEqual([{ name: 'Болт М8', unit: 'pcs', quantity: 100, unitPrice: 0.0472 }])
    expect(byWh['Склад Юг'].lines).toEqual([
      { name: 'Гайка М8', unit: 'kg', quantity: 2.5, unitPrice: 12.5 },
      { name: 'Болт М8', unit: 'pcs', quantity: 10, unitPrice: 0.05 },
    ])
    expect(sections.map(s => s.number).sort()).toEqual(listed.map((m: any) => m.number).sort())

    const res = await w.stockReceipt(b.id)
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

    const sections = await billStockReceiptSections(w.orgId, await Invoice.findById(draft.id).lean().exec())
    expect(sections).toHaveLength(1)
    // The receipt's own costs: it booked them, and the bill keeps the supplier's prices apart.
    expect(sections[0].lines.map(l => [l.name, l.quantity, l.unitPrice])).toEqual([['Болт М8', 10, 5.5], ['Гайка М8', 4, 2.25]])

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
