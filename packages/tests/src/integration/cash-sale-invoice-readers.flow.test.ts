import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * #171: once a cash sale can be invoiced, every report must still count each sale ONCE.
 *
 *   - totals count the cash sale and leave its invoice out;
 *   - per customer, the invoice counts for its customer, and a cash sale that has one no longer
 *     counts for the cash sale's own contact.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const DAY = '2026-10-20'
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/**
 * One day of trading:
 *   CS1 — a walk-in cash sale (2 bolts, cash, 24.00), invoiced to Y as INV1;
 *   CS2 — a cash sale to X (4 nuts, card, 24.00), invoiced to X as INV2;
 *   INV3 — an ordinary invoice to Y (1 bolt, bank transfer, 12.00).
 */
async function day() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const y = await createTestContact(org._id, { companyName: 'Y ООД', type: 'customer' } as any)
  const x = await createTestContact(org._id, { companyName: 'X ЕООД', type: 'both' } as any)
  const wh = await createTestWarehouse(org._id)
  const bolt = await createTestProduct(org._id, { name: 'Болт М8', sellingPrice: 10, taxRate: 20 } as any)
  const nut = await createTestProduct(org._id, { name: 'Гайка М8', sellingPrice: 5, taxRate: 20 } as any)
  await createTestStockLevel(org._id, bolt._id, wh._id, { quantity: 100 })
  await createTestStockLevel(org._id, nut._id, wh._id, { quantity: 100 })
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@t.bg', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const call = async (method: string, path: string, body?: any) => {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const json: any = await res.json().catch(() => null)
    expect(res.status).toBe(200)
    return json
  }
  const line = (p: any, quantity: number, unitPrice: number) => ({
    productId: String(p._id), warehouseId: String(wh._id), description: p.name, quantity, unitPrice, taxRate: 20,
    taxAmount: +(quantity * unitPrice * 0.2).toFixed(2), lineTotal: +(quantity * unitPrice * 1.2).toFixed(2),
  })
  const doc = (type: string, l: any, extra: Record<string, any>) => ({
    type, direction: 'outgoing', issueDate: DAY, currency: 'EUR', lines: [l],
    subtotal: l.quantity * l.unitPrice, taxTotal: l.taxAmount, total: l.lineTotal, ...extra,
  })

  const cs1 = (await call('POST', '', doc('cash_sale', line(bolt, 2, 10), { paymentMethod: 'cash' }))).invoice
  const inv1 = (await call('POST', `/${cs1.id}/to-invoice`, { contactId: String(y._id), issueDate: DAY })).invoice
  const cs2 = (await call('POST', '', doc('cash_sale', line(nut, 4, 5), { paymentMethod: 'card', contactId: String(x._id) }))).invoice
  const inv2 = (await call('POST', `/${cs2.id}/to-invoice`, { contactId: String(x._id), issueDate: DAY })).invoice
  const draft = (await call('POST', '', doc('invoice', line(bolt, 1, 10), { paymentMethod: 'bank_transfer', contactId: String(y._id) }))).invoice
  const inv3 = (await call('POST', `/${draft.id}/send`, {})).invoice

  return { orgId, y, x, bolt, nut, cs1, cs2, inv1, inv2, inv3 }
}

const report = (id: string, orgId: string, params: Record<string, any>) => {
  const entry = reportById(id)!
  return entry.handler!({ orgId, params: validateParams(entry, params), output: 'table' }) as Promise<any>
}
const PERIOD = { preset: 'custom', from: DAY, to: DAY }

describe('every reader counts an invoiced cash sale once', () => {
  it('sales history: the cash sale counts, its invoice shows in „-ФЕ №"; per customer the invoice counts', async () => {
    const d = await day()

    const all = await report('sales-history', d.orgId, { period: PERIOD, includeNonRegister: true })
    const docs = all.rows.filter((r: any) => r.rowType === 'document')
    expect(docs.map((r: any) => r.number).sort()).toEqual([d.cs1.invoiceNumber, d.cs2.invoiceNumber, d.inv3.invoiceNumber].sort())
    expect(docs.find((r: any) => r.number === d.cs1.invoiceNumber).invoiceNumber).toBe(d.inv1.invoiceNumber)
    expect(docs.find((r: any) => r.number === d.cs2.invoiceNumber).invoiceNumber).toBe(d.inv2.invoiceNumber)

    const forY = await report('sales-history', d.orgId, { period: PERIOD, includeNonRegister: true, contactId: String(d.y._id) })
    expect(forY.rows.filter((r: any) => r.rowType === 'document').map((r: any) => r.number).sort())
      .toEqual([d.inv1.invoiceNumber, d.inv3.invoiceNumber].sort())

    const forX = await report('sales-history', d.orgId, { period: PERIOD, includeNonRegister: true, contactId: String(d.x._id) })
    expect(forX.rows.filter((r: any) => r.rowType === 'document').map((r: any) => r.number)).toEqual([d.inv2.invoiceNumber])
  }, 60_000)

  it('the daily digest: cash once, no invoice flagged as moving nothing or as a duplicate', async () => {
    const d = await day()
    const digest: any = await buildDailyDigest(d.orgId, DAY)
    expect(digest.kpis.cashTotal).toBe(48)
    expect(digest.kpis.cashCount).toBe(2)
    expect(digest.kpis.salesTotal).toBe(12)
    expect(digest.kpis.salesCount).toBe(1)
    expect(digest.undocumentedSales.count).toBe(0)
    expect(digest.duplicates.count).toBe(0)
    // The invoices still took their SALES_DOC numbers, so the register keeps them.
    const sales = (digest.documents as any).sales
    expect(JSON.stringify(sales)).toContain(d.inv1.invoiceNumber)
  }, 60_000)

  it('the product ledger: the bolt was sold three times, not four', async () => {
    const d = await day()
    const all: any = (await getProductLedger(d.orgId, String(d.bolt._id))).summary
    expect([all.totalCashRegisterSales, all.totalInvoiceSales, all.totalSales]).toEqual([24, 12, 36])
    const y: any = (await getProductLedger(d.orgId, String(d.bolt._id), { contactId: String(d.y._id) } as any)).summary
    expect([y.totalCashRegisterSales, y.totalInvoiceSales]).toEqual([0, 36])
  }, 60_000)

  it('the contact ledger: each customer sees the sale on the invoice issued to them', async () => {
    const d = await day()
    const y: any = (await getContactLedger(d.orgId, String(d.y._id))).summary
    expect(y.totalSalesGross).toBe(36)
    const x: any = (await getContactLedger(d.orgId, String(d.x._id))).summary
    expect(x.totalSalesGross).toBe(24)
  }, 60_000)

  it('the dashboard: paid in 30 days counts the cash sales, not their invoices', async () => {
    const d = await day()
    const s = await getInvoiceSummary(d.orgId)
    expect(s.paid30d).toEqual({ amount: 48, count: 2 })
  }, 60_000)

  it('the sales register keeps the invoices and names their cash sales', async () => {
    const d = await day()
    const res = await report('sales-documents', d.orgId, { period: PERIOD })
    const byNumber = new Map(res.rows.map((r: any) => [r.number, r]))
    expect((byNumber.get(d.inv1.invoiceNumber) as any).cashSale).toBe(d.cs1.invoiceNumber)
    expect((byNumber.get(d.inv2.invoiceNumber) as any).cashSale).toBe(d.cs2.invoiceNumber)
    expect((byNumber.get(d.inv3.invoiceNumber) as any).cashSale).toBe('')
    expect(res.meta.forCashSales).toEqual({ count: 2, total: 48 })
  }, 60_000)
})
