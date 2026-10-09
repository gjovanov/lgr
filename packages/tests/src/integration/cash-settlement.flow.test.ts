import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { convertDraftInvoice } from 'services/biz/doc-import/persist'
import { CASH_ON_ISSUE } from 'services/biz/cash-settlement.service'
import { eventBus } from 'services/events/event-bus'
import { Invoice } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * A sales invoice paid in cash is paid the moment it is issued.
 *
 * Until 2026-10 every cash invoice stayed `sent` with its whole total due — 501 on prod — so the
 * aging report and every client's open balance carried money nobody owed. The rule lives in
 * `services/biz/cash-settlement.service.ts`; these drive it through the paths that issue or edit
 * an invoice: `/send`, `PUT`, and the import conversion that most invoices arrive by.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
const recorded: any[] = []
let unsubscribe: () => void = () => {}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
  unsubscribe = eventBus.on('payment.recorded', (p: any) => { recorded.push(p) })
}, 60_000)

afterAll(async () => {
  unsubscribe()
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  recorded.length = 0
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function call(method: string, path: string, token: string, body?: any) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const ISSUE_DATE = '2026-10-05'

async function world() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const orgId = String(org._id)
  // A free-text line moves no stock, so issuing needs no warehouse set-up.
  async function draft(paymentMethod?: string, total = 120, extra: Record<string, any> = {}) {
    const res = await call('POST', `/org/${orgId}/invoices`, token, {
      type: 'invoice', direction: 'outgoing', contactId: String(contact._id), issueDate: ISSUE_DATE, currency: 'EUR',
      lines: [{ description: 'Монтаж', quantity: 1, unitPrice: total, taxRate: 0 }],
      subtotal: total, total, ...(paymentMethod ? { paymentMethod } : {}), ...extra,
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id || res.json.invoice._id)
  }
  const send = (id: string) => call('POST', `/org/${orgId}/invoices/${id}/send`, token, {})
  const put = (id: string, body: any) => call('PUT', `/org/${orgId}/invoices/${id}`, token, body)
  const pay = (id: string, body: any) => call('POST', `/org/${orgId}/invoices/${id}/payments`, token, body)
  const load = async (id: string) => (await Invoice.findById(id).lean()) as any
  return { orgId, userId: String(user._id), token, draft, send, put, pay, load }
}

describe('a cash invoice is paid on issue', () => {
  it('issuing it records the whole total as one cash payment, dated the issue date', async () => {
    const w = await world()
    const id = await w.draft('cash')
    const res = await w.send(id)
    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('paid')
    const inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.amountPaid).toBe(120)
    expect(inv.amountDue).toBe(0)
    expect(inv.payments).toHaveLength(1)
    expect(inv.payments[0]).toMatchObject({ amount: 120, method: 'cash', origin: CASH_ON_ISSUE })
    expect(new Date(inv.payments[0].date).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(new Date(inv.paidAt).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(inv.invoiceNumber).not.toMatch(/^DRF/)
    // The same event a hand-recorded payment emits, so a ledger that is kept gets its entry.
    expect(recorded).toEqual([expect.objectContaining({ invoiceId: id, amount: 120, method: 'cash' })])
  })

  it('a draft saved with cash stays a draft — it is not an invoice until it is issued', async () => {
    const w = await world()
    const id = await w.draft('bank_transfer')
    const res = await w.put(id, { paymentMethod: 'cash' })
    expect(res.status).toBe(200)
    const inv = await w.load(id)
    expect(inv.status).toBe('draft')
    expect(inv.payments).toHaveLength(0)
    expect(inv.amountDue).toBe(120)
  })

  it('bank transfer and cash on delivery are issued unpaid, as before', async () => {
    const w = await world()
    for (const method of ['bank_transfer', 'cash_on_delivery', undefined]) {
      const id = await w.draft(method)
      await w.send(id)
      const inv = await w.load(id)
      expect({ method, status: inv.status, due: inv.amountDue, payments: inv.payments.length })
        .toEqual({ method, status: 'sent', due: 120, payments: 0 })
    }
    expect(recorded).toHaveLength(0)
  })
})

describe('editing an issued invoice', () => {
  it('switching it to cash pays it; switching it away takes that payment back', async () => {
    const w = await world()
    const id = await w.draft('bank_transfer')
    await w.send(id)

    const toCash = await w.put(id, { paymentMethod: 'cash' })
    expect(toCash.json.invoice.status).toBe('paid')
    let inv = await w.load(id)
    expect(inv.payments.map((p: any) => [p.amount, p.origin])).toEqual([[120, CASH_ON_ISSUE]])

    const back = await w.put(id, { paymentMethod: 'bank_transfer' })
    expect(back.json.invoice.status).toBe('sent')
    inv = await w.load(id)
    expect(inv.payments).toHaveLength(0)
    expect(inv.amountPaid).toBe(0)
    expect(inv.amountDue).toBe(120)
    expect(inv.paidAt).toBeNull()
  })

  it('a payment someone recorded by hand is never taken back', async () => {
    const w = await world()
    const id = await w.draft('bank_transfer')
    await w.send(id)
    expect((await w.pay(id, { date: '2026-10-06', amount: 50, method: 'bank_transfer' })).status).toBe(200)

    await w.put(id, { paymentMethod: 'cash' })
    let inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin ?? null])).toEqual([
      [50, 'bank_transfer', null],
      [70, 'cash', CASH_ON_ISSUE],
    ])

    await w.put(id, { paymentMethod: 'bank_transfer' })
    inv = await w.load(id)
    expect(inv.status).toBe('partially_paid')
    expect(inv.payments.map((p: any) => p.amount)).toEqual([50])
    expect(inv.amountDue).toBe(70)
  })

  it('a paid cash invoice follows its total up and down', async () => {
    const w = await world()
    const id = await w.draft('cash')
    await w.send(id)

    await w.put(id, { lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 150, taxRate: 0 }], subtotal: 150, total: 150 })
    let inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.amountPaid).toBe(150)
    expect(inv.payments.map((p: any) => p.amount)).toEqual([120, 30])

    await w.put(id, { lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 100, taxRate: 0 }], subtotal: 100, total: 100 })
    inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.amountPaid).toBe(100)
    expect(inv.amountDue).toBe(0)
    expect(inv.payments.map((p: any) => [p.amount, p.origin])).toEqual([[100, CASH_ON_ISSUE]])
  })
})

describe('the other ways in', () => {
  it('an imported cash invoice is paid when the import issues it', async () => {
    const w = await world()
    const id = await w.draft('cash', 80, { reference: '3000101999' })
    const res = await convertDraftInvoice(w.orgId, id, w.userId, { adjustStock: false })
    expect(res.ok).toBe(true)
    const inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin])).toEqual([[80, 'cash', CASH_ON_ISSUE]])
  })

  it('only outgoing invoices: a supplier bill and a credit note paid in cash stay as they were', async () => {
    const w = await world()
    const bill = await w.draft('cash', 120, { direction: 'incoming' })
    await call('POST', `/org/${w.orgId}/invoices/${bill}/receive`, w.token, {})
    expect((await w.load(bill)).status).toBe('received')
    const inv = await w.draft('bank_transfer')
    await w.send(inv)
    const note = await w.draft('cash', 30, { type: 'credit_note', relatedInvoiceId: inv })
    await w.send(note)
    expect((await w.load(note)).status).toBe('sent')
  })
})

describe('payment methods', () => {
  it('a cheque is refused, cash on delivery is accepted', async () => {
    const w = await world()
    const id = await w.draft('bank_transfer')
    await w.send(id)
    const cheque = await w.pay(id, { date: '2026-10-06', amount: 10, method: 'check' })
    expect(cheque.status).toBe(422)
    expect(cheque.json.message).toStartWith('Invalid field "method"')
    const cod = await w.pay(id, { date: '2026-10-06', amount: 120, method: 'cash_on_delivery' })
    expect(cod.status).toBe(200)
    expect(cod.json.invoice.status).toBe('paid')
  })
})
