import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestWarehouse, createTestProduct, createTestContact,
  createTestPOSSession, createTestPOSTransaction, createTestInvoice,
} from '../helpers/factories'
import { Invoice, POSTransaction } from 'db/models'
import { fromPosTransaction } from 'services/biz/cash-register/mapping'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import {
  exportSummarizedSales, exportPaymentDetails, exportItemizedSales, exportReversedSales, exportCancelledSales, suptoPeriod,
} from 'services/biz/supto-export.service'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { aggregateCashSales } from 'invoicing-api/src/controllers/invoice-export.controller'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { cashRegisterController } from 'invoicing-api/src/controllers/cash-register.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * FR-21.8 / FR-21.9 — every reader counts a till sale exactly once, whichever store holds it.
 *
 * Until R4 a till sale is a POS row, a cash-register document (`register.origin: 'pos'`), or both
 * (R2's copy keeps the `_id`). Each union reader is held to "once" in all three states. The
 * readers that only ever read invoices learn the storno: it counts against its sale, and a
 * voided document counts nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(posController).use(cashRegisterController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

const DAY = '2026-10-21'
const AT = new Date('2026-10-21T11:00:00.000Z') // 14:00 in Sofia
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const tokenFor = (userId: string, orgId: string) => (signer as any).decorator.jwt.sign({
  id: userId, orgId, role: 'admin', email: 'a@test.com', username: 'admin', firstName: 'A', lastName: 'B',
  operatorCode: '0001', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
})
async function get(path: string, token: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId, { operatorCode: '0001' } as any)
  const wh = await createTestWarehouse(orgId)
  const product = await createTestProduct(orgId, { name: 'Bolt M8', unit: 'бр.' } as any)
  const contact = await createTestContact(orgId, { companyName: 'Client Ltd' })
  const session = await createTestPOSSession(orgId, wh._id as Types.ObjectId, user._id as Types.ObjectId, { status: 'closed' })
  const token = await tokenFor(String(user._id), String(orgId))
  return { orgId, user, wh, product, contact, session, token }
}
type S = Awaited<ReturnType<typeof seed>>

/** A till sale in one of the three states a reader can meet it in. */
async function tillSale(s: S, how: 'pos' | 'document' | 'both', over: Record<string, any> = {}) {
  const row = await createTestPOSTransaction(s.orgId, s.session._id as Types.ObjectId, s.user._id as Types.ObjectId, {
    transactionNumber: 'TXN-2026-0000001', createdAt: AT, status: 'completed',
    lines: [{ productId: s.product._id, name: 'Bolt M8', quantity: 3, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 6, lineTotal: 30 }] as any,
    subtotal: 30, discountTotal: 0, taxTotal: 6, total: 36,
    payments: [{ method: 'cash', amount: 36 }], changeDue: 0,
    fiscalDeviceNumber: 'ED399266', unpNumber: 'ED399266-0001-0000001', fiscalReceiptNumber: '0000001', isFiscal: true,
    ...over,
  } as any)
  if (how !== 'pos') {
    await Invoice.collection.insertOne(fromPosTransaction(row.toObject(), s.session.toObject(), { baseCurrency: 'EUR' }) as any)
  }
  if (how === 'document') await POSTransaction.deleteOne({ _id: row._id })
  return row
}

describe('FR-21.8 — a till sale counts once, whichever store holds it', () => {
  for (const how of ['pos', 'document', 'both'] as const) {
    describe(`held as: ${how}`, () => {
      it('SUPTO 18.1–18.3 list it once, and 18.1 does not list it again as a cash sale', async () => {
        const s = await seed()
        await tillSale(s, how)
        const period = { orgId: String(s.orgId), ...suptoPeriod(DAY, DAY) }
        const { transactions, cashSales } = await exportSummarizedSales(period)
        expect(transactions.map((t: any) => t.transactionNumber)).toEqual(['TXN-2026-0000001'])
        expect(cashSales).toHaveLength(0)
        expect(transactions[0].unpNumber).toBe('ED399266-0001-0000001')
        // As the DAL handed it out: string ids.
        expect(typeof transactions[0].sessionId).toBe('string')
        expect(await exportPaymentDetails(period)).toHaveLength(1)
        const itemized = await exportItemizedSales(period)
        expect(itemized).toHaveLength(1)
        // 18.3 prints the line's net, as a POS row always carried it.
        expect(itemized[0].lines[0].lineTotal).toBe(30)
      })

      it('sales history lists it once', async () => {
        const s = await seed()
        await tillSale(s, how)
        const entry = reportById('sales-history')!
        const res = await entry.handler!({
          orgId: String(s.orgId),
          params: validateParams(entry, { period: { preset: 'custom', from: DAY, to: DAY } }),
          output: 'table',
        })
        expect(res.rows.map(r => r.number)).toEqual(['TXN-2026-0000001'])
        expect(res.meta!.summary[0].cash).toBe(36)
      })

      it('the session journal entry reads it once', async () => {
        const s = await seed()
        await tillSale(s, how)
        const rows = await loadPosRows({ orgId: String(s.orgId), sessionId: String(s.session._id) })
        expect(rows.map(r => r.transactionNumber)).toEqual(['TXN-2026-0000001'])
      })

      it('/trade/pos/transactions and the journal list it once', async () => {
        const s = await seed()
        const row = await tillSale(s, how)
        const list = await get(`/org/${s.orgId}/trade/pos/transactions`, s.token)
        expect(list.status).toBe(200)
        expect(list.json.total).toBe(1)
        expect(list.json.transactions[0].transactionNumber).toBe('TXN-2026-0000001')
        const one = await get(`/org/${s.orgId}/trade/pos/transactions/${row._id}`, s.token)
        expect(one.status).toBe(200)
        expect(one.json.transaction.total).toBe(36)

        const journal = await get(`/org/${s.orgId}/cash-register/documents`, s.token)
        expect(journal.status).toBe(200)
        expect(journal.json.total).toBe(1)
        expect(journal.json.rows[0]).toMatchObject({
          number: 'TXN-2026-0000001', kind: 'sale', origin: 'pos', status: 'completed', total: 36,
          store: how === 'pos' ? 'pos' : 'invoice',
        })
      })
    })
  }

  it('a stornoed sale and its storno: 18.4 lists the storno, 18.5 the sale, and the day nets to nothing', async () => {
    const s = await seed()
    const sale = await tillSale(s, 'both', { status: 'cancelled' })
    await tillSale(s, 'document', {
      transactionNumber: 'TXN-2026-0000002', type: 'storno', createdAt: new Date(AT.getTime() + 60_000),
      originalTransactionId: sale._id, originalUNP: 'ED399266-0001-0000001', stornoReason: 'customer_return',
      unpNumber: 'ED399266-0001-0000002',
    })
    const period = { orgId: String(s.orgId), ...suptoPeriod(DAY, DAY) }
    expect((await exportReversedSales(period)).map((t: any) => t.transactionNumber)).toEqual(['TXN-2026-0000002'])
    expect((await exportCancelledSales(period)).map((t: any) => t.transactionNumber)).toEqual(['TXN-2026-0000001'])

    const entry = reportById('sales-history')!
    const res = await entry.handler!({
      orgId: String(s.orgId), params: validateParams(entry, { period: { preset: 'custom', from: DAY, to: DAY } }), output: 'table',
    })
    expect(res.meta!.summary[0].total).toBe(0)
  })
})

describe('FR-21.9 — the invoice readers count a storno against its sale, and a voided document not at all', () => {
  async function backOffice(s: S) {
    const cid = s.contact._id as Types.ObjectId
    const line = { productId: s.product._id, description: 'Bolt M8', quantity: 10, unit: 'бр.', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 20, lineTotal: 120, warehouseId: s.wh._id }
    const common = { direction: 'outgoing', issueDate: new Date(`${DAY}T00:00:00.000Z`), paidAt: new Date(), currency: 'EUR' }
    const sale = await createTestInvoice(s.orgId, cid, {
      ...common, type: 'cash_sale', status: 'paid', invoiceNumber: 'CS-2026-00001', lines: [line],
      subtotal: 100, taxTotal: 20, total: 120, amountPaid: 120, amountDue: 0, paymentMethod: 'cash',
    } as any)
    await createTestInvoice(s.orgId, cid, {
      ...common, type: 'cash_storno', status: 'paid', invoiceNumber: 'CS-2026-00002', relatedInvoiceId: sale._id,
      lines: [{ ...line, quantity: 4, taxAmount: 8, lineTotal: 48 }],
      subtotal: 40, taxTotal: 8, total: 48, amountPaid: 48, amountDue: 0, paymentMethod: 'cash',
    } as any)
    await createTestInvoice(s.orgId, cid, {
      ...common, type: 'cash_sale', status: 'voided', invoiceNumber: 'CS-2026-00003', lines: [{ ...line, quantity: 5, taxAmount: 10, lineTotal: 60 }],
      subtotal: 50, taxTotal: 10, total: 60, amountPaid: 60, amountDue: 0, paymentMethod: 'cash',
    } as any)
  }

  it('the digest: cash 72 from one sale; the register lists all three and totals 72', async () => {
    const s = await seed()
    await backOffice(s)
    const digest: any = await buildDailyDigest(String(s.orgId), DAY, { sections: { kpis: true, documents: true } })
    expect(digest.kpis.cashTotal).toBe(72)
    expect(digest.kpis.cashCount).toBe(1)
    expect(digest.documents.cash.count).toBe(3)
    expect(digest.documents.cash.total).toBe(72)
  })

  it('Reports → cash register: the storno is negative', async () => {
    const s = await seed()
    await backOffice(s)
    const entry = reportById('cash-register')!
    const res = await entry.handler!({
      orgId: String(s.orgId),
      params: validateParams(entry, { period: { preset: 'custom', from: DAY, to: DAY }, statuses: ['paid'] }),
      output: 'table',
    })
    const storno = res.rows.find(r => r.number === 'CS-2026-00002')!
    expect(storno.total).toBe(-48)
    expect(res.rows.reduce((t, r) => t + r.total, 0)).toBe(72)
  })

  it('the FR-03 aggregate, the product ledger, the contact ledger and the dashboard net the storno out', async () => {
    const s = await seed()
    await backOffice(s)
    const { sections } = await aggregateCashSales({ orgId: s.orgId, type: { $in: ['cash_sale', 'cash_storno'] }, status: 'paid' })
    expect(sections[0].rows[0]).toMatchObject({ totalQuantity: 6, grossTotal: 72, netTotal: 60 })

    const ledger: any = await getProductLedger(String(s.orgId), String(s.product._id))
    expect(ledger.summary.totalCashRegisterSales).toBe(72)

    const contact: any = await getContactLedger(String(s.orgId), String(s.contact._id))
    const storno = contact.entries.find((e: any) => e.documentNumber === 'CS-2026-00002')!
    expect(storno.lineTotal).toBe(-48)
    // The summary takes the storno off the sales; the voided sale is not in it at all.
    expect(contact.summary.totalSalesGross).toBe(72)

    const summary: any = await getInvoiceSummary(String(s.orgId))
    expect(summary.paid30d.amount).toBe(72)
  })
})
