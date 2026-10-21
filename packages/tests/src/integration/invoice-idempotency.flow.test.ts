import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestWarehouse,
  createTestProduct,
  createTestStockLevel,
} from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { createInvoiceStockMovement } from 'services/biz/invoicing.service'
import { requestHash } from 'services/biz/hot-path-key'
import { eventBus } from 'services/events/event-bus'
import { Invoice, StockMovement } from 'db/models'
import { getRepos } from 'services/context'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * A cash sale, an invoice issue and a payment record, retried with one `Idempotency-Key`,
 * happen once (FR-20.37, #155 part 2; AC 7).
 *
 * The two races that existed WITHOUT a key are asserted too: two Issue clicks dispatched and
 * numbered a draft twice, and two concurrent payments lost one of them.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const posted: any[] = []
const payments: any[] = []
const offs: Array<() => void> = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
  offs.push(eventBus.on('invoice.posted', (p: any) => { posted.push(p) }))
  offs.push(eventBus.on('payment.recorded', (p: any) => { payments.push(p) }))
}, 60_000)
afterAll(async () => {
  for (const off of offs) off()
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  posted.length = 0
  payments.length = 0
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const warehouse = await createTestWarehouse(org._id)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 0 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100 })
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any, key?: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  const line = (quantity = 2) => ({
    productId: String(product._id), warehouseId: String(warehouse._id),
    description: 'Болт М8', quantity, unitPrice: 10, taxRate: 0,
  })
  const cashSale = (quantity = 2) => ({
    type: 'cash_sale', direction: 'outgoing', issueDate: '2026-10-20', currency: 'EUR',
    lines: [line(quantity)], subtotal: 10 * quantity, total: 10 * quantity, paymentMethod: 'cash',
  })
  const draftBody = (quantity = 2) => ({
    type: 'invoice', direction: 'outgoing', contactId: String(contact._id), issueDate: '2026-10-20', currency: 'EUR',
    lines: [line(quantity)], subtotal: 10 * quantity, total: 10 * quantity, paymentMethod: 'bank_transfer',
  })
  async function draft(quantity = 2) {
    const res = await call('POST', '', draftBody(quantity))
    expect(res.status).toBe(200)
    return String(res.json.invoice.id)
  }
  const movements = (invoiceId?: string) =>
    StockMovement.countDocuments({ orgId, ...(invoiceId ? { invoiceId } : {}) }).exec()
  const load = async (id: string) => Invoice.findById(id).lean().exec() as Promise<any>

  return { orgId, user, call, cashSale, draftBody, draft, movements, load }
}

describe('a keyed cash sale happens once', () => {
  it('5 concurrent requests with one key: one document, one movement, and no gap in the CS numbers', async () => {
    const w = await world()
    const answers = await Promise.all(Array.from({ length: 5 }, () => w.call('POST', '', w.cashSale(), 'cs-key-0001')))

    expect(answers.map(a => a.status)).toEqual([200, 200, 200, 200, 200])
    expect(new Set(answers.map(a => a.json.invoice.id)).size).toBe(1)
    const number = answers[0].json.invoice.invoiceNumber
    expect(answers.every(a => a.json.invoice.invoiceNumber === number)).toBe(true)
    expect(number).not.toMatch(/pending/)
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
    expect(await w.movements()).toBe(1)

    // The next cash sale takes the very next number: the four losers burnt none.
    const next = await w.call('POST', '', w.cashSale(1))
    const suffix = (n: string) => Number(n.match(/(\d+)$/)![1])
    expect(suffix(next.json.invoice.invoiceNumber)).toBe(suffix(number) + 1)
  }, 60_000)

  it('a retry returns the same document; a different body with the key is 422', async () => {
    const w = await world()
    const first = await w.call('POST', '', w.cashSale(), 'cs-key-0002')
    const again = await w.call('POST', '', w.cashSale(), 'cs-key-0002')
    const other = await w.call('POST', '', w.cashSale(3), 'cs-key-0002')

    expect(again.status).toBe(200)
    expect(again.json.invoice.id).toBe(first.json.invoice.id)
    expect(other.status).toBe(422)
    expect(await w.movements()).toBe(1)
  }, 60_000)

  it('a create interrupted after its insert is finished by the retry: numbered, stock moved once', async () => {
    const w = await world()
    const body = w.cashSale()
    // What the route leaves when the process dies right after inserting a keyed cash sale.
    await Invoice.create({
      ...body, orgId: w.orgId, lines: body.lines.map(l => ({ ...l, unit: 'pcs', taxAmount: 0, lineTotal: 20 })),
      invoiceNumber: '~pending:cs-key-0003', status: 'paid', amountPaid: 20, amountDue: 0, paidAt: new Date(),
      dueDate: '2026-10-20', taxTotal: 0, totalBase: 20,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      clientKey: 'cs-key-0003', requestHash: requestHash('invoice.create', body),
      leaseUntil: new Date(Date.now() - 1000), createdBy: String(w.user._id),
    } as any)

    const res = await w.call('POST', '', body, 'cs-key-0003')

    expect(res.status).toBe(200)
    expect(res.json.invoice.invoiceNumber).not.toMatch(/pending/)
    expect(await w.movements(res.json.invoice.id)).toBe(1)
    const again = await w.call('POST', '', body, 'cs-key-0003')
    expect(again.json.invoice.invoiceNumber).toBe(res.json.invoice.invoiceNumber)
    expect(await w.movements()).toBe(1)
  }, 60_000)
})

describe('issuing a draft happens once', () => {
  it('3 concurrent Issue requests with one key: one dispatch, one issued number, one journal event', async () => {
    const w = await world()
    const id = await w.draft()
    const answers = await Promise.all([1, 2, 3].map(() => w.call('POST', `/${id}/send`, {}, 'send-key-0001')))

    expect(answers.map(a => a.status)).toEqual([200, 200, 200])
    expect(new Set(answers.map(a => a.json.invoice.invoiceNumber)).size).toBe(1)
    expect(await w.movements(id)).toBe(1)
    expect(posted.filter(p => p.invoiceId === id)).toHaveLength(1)
    expect((await w.load(id)).numberHistory.filter((h: any) => h.status === 'sent')).toHaveLength(1)
  }, 60_000)

  it('WITHOUT a key, two concurrent Issue clicks no longer both go through', async () => {
    const w = await world()
    const id = await w.draft()
    const answers = await Promise.all([w.call('POST', `/${id}/send`, {}), w.call('POST', `/${id}/send`, {})])

    expect(answers.filter(a => a.status === 200)).toHaveLength(1)
    expect(answers.find(a => a.status !== 200)!.status).toBeOneOf([400, 409])
    expect(await w.movements(id)).toBe(1)
    expect(posted.filter(p => p.invoiceId === id)).toHaveLength(1)
  }, 60_000)

  it('an issue that crashed after dispatching is finished without a second dispatch', async () => {
    const w = await world()
    const id = await w.draft()
    // The crashed request had claimed the draft and moved the stock, then died.
    await Invoice.updateOne({ _id: id }, { $set: { issue: { leaseUntil: new Date(Date.now() - 1000) } } }).exec()
    await createInvoiceStockMovement(await getRepos().invoices.findOne({ id, orgId: w.orgId } as any) as any, String(w.user._id))
    expect(await w.movements(id)).toBe(1)

    const res = await w.call('POST', `/${id}/send`, {})

    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('sent')
    expect(await w.movements(id)).toBe(1)
  }, 60_000)

  it('a failed issue gives the draft back, so it can be issued again', async () => {
    const w = await world()
    const id = await w.draft(500) // more than the 100 in stock
    const failed = await w.call('POST', `/${id}/send`, {})
    expect(failed.status).toBe(400)
    const doc = await w.load(id)
    expect(doc.status).toBe('draft')
    expect(doc.issue).toBeUndefined()
  }, 60_000)
})

describe('a payment is recorded once', () => {
  async function issued(w: Awaited<ReturnType<typeof world>>) {
    const id = await w.draft()
    expect((await w.call('POST', `/${id}/send`, {})).status).toBe(200)
    return id
  }
  const pay = (amount: number, reference?: string) => ({ date: '2026-10-21', amount, method: 'bank_transfer', ...(reference ? { reference } : {}) })

  it('3 concurrent requests with one key: one payment, one event', async () => {
    const w = await world()
    const id = await issued(w)
    const answers = await Promise.all([1, 2, 3].map(() => w.call('POST', `/${id}/payments`, pay(5), 'pay-key-0001')))

    expect(answers.map(a => a.status)).toEqual([200, 200, 200])
    const doc = await w.load(id)
    expect(doc.payments).toHaveLength(1)
    expect(doc.amountPaid).toBe(5)
    expect(doc.amountDue).toBe(15)
    expect(doc.status).toBe('partially_paid')
    expect(payments.filter(p => p.invoiceId === id)).toHaveLength(1)

    const other = await w.call('POST', `/${id}/payments`, pay(6), 'pay-key-0001')
    expect(other.status).toBe(422)
  }, 60_000)

  it('two DIFFERENT payments at once are both kept — none is lost — and the status follows', async () => {
    const w = await world()
    const id = await issued(w)
    const answers = await Promise.all([
      w.call('POST', `/${id}/payments`, pay(5, 'A')),
      w.call('POST', `/${id}/payments`, pay(15, 'B')),
    ])

    expect(answers.map(a => a.status)).toEqual([200, 200])
    const doc = await w.load(id)
    expect(doc.payments.map((p: any) => p.reference).sort()).toEqual(['A', 'B'])
    expect(doc.amountPaid).toBe(20)
    expect(doc.amountDue).toBe(0)
    expect(doc.status).toBe('paid')
    expect(doc.paidAt).toBeTruthy()
    expect(doc.statusHistory.map((h: any) => h.status)).toContain('paid')
    // Every payment keeps an _id, as the form-recorded ones always had.
    expect(doc.payments.every((p: any) => p._id)).toBe(true)
  }, 60_000)

  it('a reference that looks like a field path is stored as text', async () => {
    const w = await world()
    const id = await issued(w)
    const res = await w.call('POST', `/${id}/payments`, pay(5, '$total'))
    expect(res.status).toBe(200)
    expect((await w.load(id)).payments[0].reference).toBe('$total')
  }, 60_000)
})
