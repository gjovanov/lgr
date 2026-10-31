import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestWarehouse,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { invoiceExportController, aggregateCashSales } from 'invoicing-api/src/controllers/invoice-export.controller'
import { stornoRefOf } from 'invoicing-api/src/lib/invoice-pdf'
import { reportsController, withValueLabels } from '../../../reports-api/src/controllers/report.controller'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { computeAggregates } from 'reporting/excel/invoicing-list.excel'
import { sanitizeSelection } from 'ui-shared/composables/useListQueryState'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Org } from 'db/models'
import type { Types } from 'mongoose'

/**
 * The cash-register documents and their stornos, where people read them:
 *  - Reports → Export → Cash register lists the stornos, the voided ones too, and a voided
 *    document counts nothing in what it adds up;
 *  - a till document belongs to the org's day (Sofia), not to its UTC date;
 *  - a storno prints as a storno, naming the sale it reverses and why, with no companion papers;
 *  - a report row carries its registry drill-down, and a storno opens on the journal's page.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(invoiceController).use(invoiceExportController).use(reportsController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() })

/** Sofia is UTC+3 on this day. */
const DAY = '2026-10-21'
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const tokenFor = (userId: string, orgId: string) => (signer as any).decorator.jwt.sign({
  id: userId, orgId, role: 'admin', email: 'a@test.com', username: 'admin', firstName: 'A', lastName: 'B',
  permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
})

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }))
  const type = res.headers.get('content-type') || ''
  return { status: res.status, json: type.includes('json') ? await res.json() as any : null, buffer: type.includes('json') ? null : await res.arrayBuffer() }
}

async function seed() {
  const org = await createTestOrg()
  const orgId = org._id as Types.ObjectId
  const user = await createTestUser(orgId)
  const wh = await createTestWarehouse(orgId)
  const product = await createTestProduct(orgId, { name: 'Bolt M8', unit: 'бр.' } as any)
  const contact = await createTestContact(orgId, { companyName: 'Client Ltd' })
  const token = await tokenFor(String(user._id), String(orgId))
  return { orgId, user, wh, product, contact, token }
}
type S = Awaited<ReturnType<typeof seed>>

/** A sale of 120; a storno of 48 against it; a storno of 24 whose receipt failed, so voided. */
async function documents(s: S) {
  const cid = s.contact._id as Types.ObjectId
  const line = { productId: s.product._id, description: 'Bolt M8', quantity: 10, unit: 'бр.', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 20, lineTotal: 120, warehouseId: s.wh._id }
  const common = { direction: 'outgoing', issueDate: new Date(`${DAY}T11:00:00.000Z`), currency: 'EUR', paymentMethod: 'cash' }
  const sale = await createTestInvoice(s.orgId, cid, {
    ...common, type: 'cash_sale', status: 'paid', invoiceNumber: 'CS-2026-00001', lines: [line],
    subtotal: 100, taxTotal: 20, total: 120, amountPaid: 120, amountDue: 0,
  } as any)
  const storno = await createTestInvoice(s.orgId, cid, {
    ...common, type: 'cash_storno', status: 'paid', invoiceNumber: 'CS-2026-00002', relatedInvoiceId: sale._id,
    register: { storno: { originalId: sale._id, originalUnp: 'ED399266-0001-0000001', originalReceiptNumber: '0000001', originalDate: sale.issueDate, reason: 'customer_return' } },
    lines: [{ ...line, quantity: 4, taxAmount: 8, lineTotal: 48 }],
    subtotal: 40, taxTotal: 8, total: 48, amountPaid: 48, amountDue: 0,
  } as any)
  const voided = await createTestInvoice(s.orgId, cid, {
    ...common, type: 'cash_storno', status: 'voided', invoiceNumber: 'CS-2026-00003', relatedInvoiceId: sale._id,
    lines: [{ ...line, quantity: 2, taxAmount: 4, lineTotal: 24 }],
    subtotal: 20, taxTotal: 4, total: 24, amountPaid: 24, amountDue: 0,
  } as any)
  return { sale, storno, voided }
}

const numbers = (r: { json: any }) => (r.json.invoices as any[]).map((i) => i.invoiceNumber).sort()

describe('Reports → Export → Cash register lists the stornos', () => {
  it('lists the sale and both its stornos, the voided one too, and a storno names its sale', async () => {
    const s = await seed()
    await documents(s)
    const all = await call('GET', `/org/${s.orgId}/invoices?types=cash_sale,cash_storno&size=50`, s.token)
    expect(all.status).toBe(200)
    expect(numbers(all)).toEqual(['CS-2026-00001', 'CS-2026-00002', 'CS-2026-00003'])
    expect(all.json.invoices.find((i: any) => i.invoiceNumber === 'CS-2026-00002').relatedInvoiceNumber).toBe('CS-2026-00001')

    const voided = await call('GET', `/org/${s.orgId}/invoices?types=cash_sale,cash_storno&status=voided`, s.token)
    expect(numbers(voided)).toEqual(['CS-2026-00003'])
  })

  it('a voided document counts nothing: the per-product aggregate and the list totals', async () => {
    const s = await seed()
    await documents(s)
    const { sections, docCount } = await aggregateCashSales({ orgId: s.orgId, type: { $in: ['cash_sale', 'cash_storno'] } })
    // 10 sold, 4 given back; the voided storno's 2 never came back.
    expect(sections[0].rows[0]).toMatchObject({ totalQuantity: 6, grossTotal: 72, netTotal: 60 })
    expect(docCount).toBe(2)

    const row = (status: string, total: number) => ({
      status, currency: 'EUR', subtotal: total, taxTotal: 0, total, amountPaid: total, amountDue: 0, paymentsByMethod: { cash: total },
    })
    const agg = computeAggregates([row('paid', 120), row('paid', -48), row('voided', -24)] as any)
    expect(agg.total).toBe(72)
    expect(agg.byMethod.cash).toBe(72)
  })

  it('reads a link made when the tab still offered Чернова as asking for everything', () => {
    expect(sanitizeSelection(['draft', 'stornoed', 'paid'], ['paid', 'voided'], ['draft'])).toEqual(['paid', 'voided'])
    expect(sanitizeSelection(['paid'], ['paid', 'voided'], ['draft'])).toEqual(['paid'])
  })
})

describe('a till document belongs to the org\'s day', () => {
  /** On a Sofia org, as the shops' are (an org that never set one runs on the model's default). */
  async function lateAndNext(s: S) {
    await Org.updateOne({ _id: s.orgId }, { $set: { 'settings.timezone': 'Europe/Sofia' } })
    const cid = s.contact._id as Types.ObjectId
    const base = { type: 'cash_sale', direction: 'outgoing', status: 'paid', currency: 'EUR', subtotal: 10, taxTotal: 2, total: 12, amountPaid: 12, amountDue: 0, paymentMethod: 'cash' }
    // 23:30 in Sofia on the 21st, and 00:30 on the 22nd — the same UTC date.
    await createTestInvoice(s.orgId, cid, { ...base, invoiceNumber: 'CS-LATE', issueDate: new Date('2026-10-21T20:30:00.000Z') } as any)
    await createTestInvoice(s.orgId, cid, { ...base, invoiceNumber: 'CS-NEXT', issueDate: new Date('2026-10-21T21:30:00.000Z') } as any)
  }

  it('the list: a sale rung at 23:30 is in its day, one at 00:30 is in the next', async () => {
    const s = await seed()
    await lateAndNext(s)
    const day = await call('GET', `/org/${s.orgId}/invoices?types=cash_sale,cash_storno&startDate=${DAY}&endDate=${DAY}`, s.token)
    expect(numbers(day)).toEqual(['CS-LATE'])
    const next = await call('GET', `/org/${s.orgId}/invoices?type=cash_sale&startDate=2026-10-22&endDate=2026-10-22`, s.token)
    expect(numbers(next)).toEqual(['CS-NEXT'])
  })

  it('the export: the same day, the same sale', async () => {
    const s = await seed()
    await lateAndNext(s)
    const res = await call('POST', `/org/${s.orgId}/invoicing/export/kind/cash_register`, s.token, {
      format: 'xlsx', mode: 'compact', startDate: DAY, endDate: DAY, locale: 'en',
    })
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.buffer as ArrayBuffer)
    const cells: string[] = []
    wb.eachSheet((ws) => ws.eachRow((r) => r.eachCell((c) => { cells.push(String(c.value ?? '')) })))
    expect(cells).toContain('CS-LATE')
    expect(cells).not.toContain('CS-NEXT')
  })
})

describe('a storno prints as a storno', () => {
  it('titled as one, naming the sale it reverses — number, date, УНП, receipt — and why', async () => {
    const s = await seed()
    const d = await documents(s)
    const stornoRef = await stornoRefOf(String(s.orgId), (d.storno as any).toObject())
    expect(stornoRef).toMatchObject({ number: 'CS-2026-00001', unp: 'ED399266-0001-0000001', receiptNumber: '0000001', reason: 'customer_return' })

    const { html } = buildInvoiceHtml({ ...(d.storno as any).toObject(), stornoRef }, { name: 'Org' } as any, (s.contact as any).toObject(), undefined, { locale: 'bg' })
    expect(html).toContain('СТОРНО НА КАСОВА ПРОДАЖБА')
    expect(html).toContain('Сторно на')
    expect(html).toContain('CS-2026-00001')
    expect(html).toContain('ED399266-0001-0000001')
    expect(html).toContain('Връщане / рекламация')
  })

  it('gets no companion papers: there is nothing to declare or hand over', async () => {
    const s = await seed()
    const d = await documents(s)
    const res = await call('GET', `/org/${s.orgId}/invoicing/export/${d.storno._id}?format=pdf&doc=certificate`, s.token)
    expect(res.status).toBe(400)
  })
})

describe('a report row opens where it is read', () => {
  it('the run carries the registry\'s drill-down per row; a storno opens on the journal\'s page', async () => {
    const s = await seed()
    const d = await documents(s)
    const res = await call('POST', `/org/${s.orgId}/reports/cash-register/run`, s.token, {
      params: { period: { preset: 'custom', from: DAY, to: DAY } },
    })
    expect(res.status).toBe(200)
    const href = (n: string) => (res.json.rows as any[]).find((r) => r.number === n)?._href
    expect(href('CS-2026-00001')).toBe(`/invoicing/cash-sales/${d.sale._id}/edit`)
    expect(href('CS-2026-00002')).toBe(`/invoicing/cash-sales/${d.storno._id}/view`)
  })

  it('an export prints a status in the words the UI sent, and an unknown one as it is', () => {
    const rows = [{ status: 'paid', n: 1 }, { status: 'voided', n: 2 }, { status: 'other', n: 3 }]
    const out = withValueLabels(rows, [{ key: 'status', type: 'status' }, { key: 'n' }], { status: { paid: 'Платена', voided: 'Анулирана' } })
    expect(out.map((r) => r.status)).toEqual(['Платена', 'Анулирана', 'other'])
    // Only a `status` column is relabelled.
    expect(withValueLabels(rows, [{ key: 'status' }], { status: { paid: 'Платена' } })).toBe(rows)
  })
})
