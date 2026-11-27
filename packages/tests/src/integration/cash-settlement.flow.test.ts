import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { allowSalesWithoutPrinter, createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { invoiceController } from 'api/src/invoicing/controllers/invoice.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { convertDraftInvoice } from 'services/biz/doc-import/persist'
import { CASH_ON_ISSUE, syncCashSettlement } from 'services/biz/cash-settlement.service'
import { unsettledInvoices } from 'services/biz/settlement-backlog'

/** FR-22.19 (D-3): what a card payment taken at the counter is marked with. A literal, not an
 *  import: the code this test is written against before the rule existed had no such export. */
const CARD_ON_ISSUE = 'card_on_issue'
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
  // This rule is for an org where LGR prints nothing: where it prints, the receipt settles (FR-23).
  await allowSalesWithoutPrinter(org._id)
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
    const id = await w.draft('cash', 80, { reference: '3000704999' })
    const res = await convertDraftInvoice(w.orgId, id, w.userId, { adjustStock: false })
    expect(res.ok).toBe(true)
    const inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin])).toEqual([[80, 'cash', CASH_ON_ISSUE]])
  })

  it('only outgoing documents: a supplier bill paid in cash stays as it was', async () => {
    const w = await world()
    const bill = await w.draft('cash', 120, { direction: 'incoming' })
    await call('POST', `/org/${w.orgId}/invoices/${bill}/receive`, w.token, {})
    expect((await w.load(bill)).status).toBe('received')
    expect((await w.load(bill)).payments).toHaveLength(0)
  })
})

/**
 * FR-25 R3 (the owner's decision of 2026-11-27): a credit note refunded at the counter gives its money back as it is
 * issued, the invoice's rule the other way round. Where nothing prints it used to stay `sent` with its whole total due:
 * the customer had their money back, yet aging took the note off what they owe, and the books' `501` showed a refund
 * LGR never recorded.
 */
describe('a credit note in cash or by card is refunded as it is issued (FR-25 R3)', () => {
  /** A credit note of `total` on an issued bank invoice of 120, as a draft. */
  async function noteOf(w: Awaited<ReturnType<typeof world>>, method: string, total = 30, extra: Record<string, any> = {}) {
    const inv = await w.draft('bank_transfer')
    expect((await w.send(inv)).status).toBe(200)
    return w.draft(method, total, { type: 'credit_note', relatedInvoiceId: inv, ...extra })
  }
  const rows = (n: any) => n.payments.map((p: any) => [p.amount, p.method, p.origin ?? null])

  it('in cash: its whole total goes back as one refund, dated the issue date, and nothing is left due', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')

    const res = await w.send(note)

    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('paid')
    const n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', total: 30, amountPaid: 30, amountDue: 0 })
    expect(rows(n)).toEqual([[30, 'cash', CASH_ON_ISSUE]])
    expect(new Date(n.payments[0].date).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(new Date(n.paidAt).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(n.statusHistory.at(-1)).toMatchObject({ fromStatus: 'sent', status: 'paid', reason: 'refunded in cash on issue' })
    // The event a refund recorded by hand emits: a ledger that is kept posts it as money out (FR-23 §2.5).
    expect(recorded).toEqual([expect.objectContaining({ invoiceId: note, amount: 30, method: 'cash' })])
  })

  it('by card: the same, by card', async () => {
    const w = await world()
    const note = await noteOf(w, 'card')
    expect((await w.send(note)).status).toBe(200)
    const n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', amountPaid: 30, amountDue: 0 })
    expect(rows(n)).toEqual([[30, 'card', CARD_ON_ISSUE]])
    expect(n.statusHistory.at(-1).reason).toBe('refunded by card on issue')
  })

  it('bank transfer and cash on delivery stay due: that money goes back later', async () => {
    const w = await world()
    for (const method of ['bank_transfer', 'cash_on_delivery']) {
      const note = await noteOf(w, method)
      expect((await w.send(note)).status).toBe(200)
      const n = await w.load(note)
      expect({ method, status: n.status, due: n.amountDue, payments: n.payments.length }).toEqual({ method, status: 'sent', due: 30, payments: 0 })
    }
    expect(recorded).toHaveLength(0)
  })

  it('a draft is left alone: it gives nothing back until it is issued', async () => {
    const w = await world()
    const note = await noteOf(w, 'bank_transfer')
    expect((await w.put(note, { paymentMethod: 'cash' })).status).toBe(200)
    const n = await w.load(note)
    expect([n.status, n.payments.length, n.amountDue]).toEqual(['draft', 0, 30])
  })

  it('an edit follows: another method takes the refund back, a refund recorded by hand stays, and a counter method gives the rest', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')
    await w.send(note)

    expect((await w.put(note, { paymentMethod: 'bank_transfer' })).json.invoice.status).toBe('sent')
    let n = await w.load(note)
    expect([n.amountPaid, n.amountDue, n.payments.length, n.paidAt]).toEqual([0, 30, 0, null])

    expect((await w.pay(note, { date: '2026-10-06', amount: 10, method: 'bank_transfer' })).status).toBe(200)
    await w.put(note, { paymentMethod: 'card' })
    n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', amountPaid: 30, amountDue: 0 })
    expect(rows(n)).toEqual([[10, 'bank_transfer', null], [20, 'card', CARD_ON_ISSUE]])
  })

  it('a lower total gives back less: the automatic refund shrinks to the new total', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')
    await w.send(note)

    await w.put(note, { lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 20, taxRate: 0 }], subtotal: 20, total: 20 })

    const n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', total: 20, amountPaid: 20, amountDue: 0 })
    expect(rows(n)).toEqual([[20, 'cash', CASH_ON_ISSUE]])
  })

  it('a note refunded as it was issued takes no second refund: it is paid, as an invoice paid at the counter is', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')
    await w.send(note)
    const again = await w.pay(note, { date: '2026-10-06', amount: 1, method: 'cash' })
    expect(again.status).toBe(400)
    expect(again.json.message).toBe('Cannot record payment on this invoice')
    expect((await w.load(note)).payments).toHaveLength(1)
  })

  it('the import conversion refunds an imported one as it issues it', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash', 30, { reference: '3000704998' })
    const res = await convertDraftInvoice(w.orgId, note, w.userId, { adjustStock: false })
    expect(res.ok).toBe(true)
    const n = await w.load(note)
    expect(n.status).toBe('paid')
    expect(rows(n)).toEqual([[30, 'cash', CASH_ON_ISSUE]])
  })

  it('a supplier\'s credit note in cash stays as it was: the rule gives back only what a customer paid us', async () => {
    const w = await world()
    const bill = await w.draft('bank_transfer', 120, { direction: 'incoming' })
    await call('POST', `/org/${w.orgId}/invoices/${bill}/receive`, w.token, {})
    const note = await w.draft('cash', 30, { type: 'credit_note', direction: 'incoming', relatedInvoiceId: bill })
    await call('POST', `/org/${w.orgId}/invoices/${note}/receive`, w.token, {})
    const n = await w.load(note)
    expect([n.status, n.payments.length]).toEqual(['received', 0])
  })

  it('the backlog: a note issued before the rule is found and refunded, and the next run finds none', async () => {
    const w = await world()
    const note = await noteOf(w, 'bank_transfer')
    await w.send(note)
    // As a note issued before 2026-11-27: cash, and nothing given back.
    await Invoice.updateOne({ _id: note }, { $set: { paymentMethod: 'cash' } })

    const due = await unsettledInvoices(w.orgId, ['cash', 'card'])
    expect(due.map(d => [d.id, d.type, d.outstanding])).toEqual([[note, 'credit_note', 30]])
    expect(await unsettledInvoices(w.orgId, ['cash', 'card'], ['invoice'])).toEqual([])

    expect(await syncCashSettlement(w.orgId, note, w.userId)).toEqual({ action: 'settled', amount: 30 })
    expect(await w.load(note)).toMatchObject({ status: 'paid', amountPaid: 30, amountDue: 0 })
    expect(await unsettledInvoices(w.orgId, ['cash', 'card'])).toEqual([])
  })
})

/**
 * FR-22.19 (D-3, #203.3): a card is paid at the counter as the invoice is written, exactly like
 * cash — so it settles on issue under the same rules. It used to stay `sent` with its whole total
 * due until someone found the list row and recorded the payment by hand: a second dialog, and the
 * method picked a second time. Bank transfer and cash on delivery stay open (the tests above).
 */
describe('a card invoice is paid on issue, like cash (FR-22.19)', () => {
  it('issuing it records the whole total as one card payment, dated the issue date', async () => {
    const w = await world()
    const id = await w.draft('card')
    const res = await w.send(id)
    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('paid')
    const inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.amountPaid).toBe(120)
    expect(inv.amountDue).toBe(0)
    expect(inv.payments).toHaveLength(1)
    expect(inv.payments[0]).toMatchObject({ amount: 120, method: 'card', origin: CARD_ON_ISSUE })
    expect(new Date(inv.payments[0].date).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(new Date(inv.paidAt).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(recorded).toEqual([expect.objectContaining({ invoiceId: id, amount: 120, method: 'card' })])
  })

  it('a draft saved with card stays a draft', async () => {
    const w = await world()
    const id = await w.draft('bank_transfer')
    await w.put(id, { paymentMethod: 'card' })
    const inv = await w.load(id)
    expect(inv.status).toBe('draft')
    expect(inv.payments).toHaveLength(0)
  })

  it('a paid card invoice follows its total up and down', async () => {
    const w = await world()
    const id = await w.draft('card')
    await w.send(id)

    await w.put(id, { lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 150, taxRate: 0 }], subtotal: 150, total: 150 })
    let inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin])).toEqual([[120, 'card', CARD_ON_ISSUE], [30, 'card', CARD_ON_ISSUE]])

    await w.put(id, { lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 100, taxRate: 0 }], subtotal: 100, total: 100 })
    inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.amountDue).toBe(0)
    expect(inv.payments.map((p: any) => [p.amount, p.origin])).toEqual([[100, CARD_ON_ISSUE]])
  })

  it('switching it to bank transfer takes the card payment back', async () => {
    const w = await world()
    const id = await w.draft('card')
    await w.send(id)

    const res = await w.put(id, { paymentMethod: 'bank_transfer' })
    expect(res.json.invoice.status).toBe('sent')
    const inv = await w.load(id)
    expect(inv.payments).toHaveLength(0)
    expect(inv.amountDue).toBe(120)
    expect(inv.paidAt).toBeNull()
  })

  it('switching between card and cash moves the automatic payment to the other method', async () => {
    const w = await world()
    const id = await w.draft('card')
    await w.send(id)

    await w.put(id, { paymentMethod: 'cash' })
    let inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin])).toEqual([[120, 'cash', CASH_ON_ISSUE]])

    await w.put(id, { paymentMethod: 'card' })
    inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin])).toEqual([[120, 'card', CARD_ON_ISSUE]])
    expect(inv.amountPaid).toBe(120)
  })

  it('a payment someone recorded by hand is never taken back', async () => {
    const w = await world()
    const id = await w.draft('bank_transfer')
    await w.send(id)
    expect((await w.pay(id, { date: '2026-10-06', amount: 50, method: 'bank_transfer' })).status).toBe(200)

    await w.put(id, { paymentMethod: 'card' })
    let inv = await w.load(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments.map((p: any) => [p.amount, p.method, p.origin ?? null])).toEqual([
      [50, 'bank_transfer', null],
      [70, 'card', CARD_ON_ISSUE],
    ])

    await w.put(id, { paymentMethod: 'cash_on_delivery' })
    inv = await w.load(id)
    expect(inv.status).toBe('partially_paid')
    expect(inv.payments.map((p: any) => p.amount)).toEqual([50])
  })
})

/**
 * The owner's decision of 2026-11-27: a debit note charged at the counter is paid as it is issued, as an invoice is.
 * It charges the client more, and in cash or by card that money changed hands as it was written. Until then it stayed
 * `sent` with its whole total due (none did on production that day).
 */
describe('a debit note in cash or by card is paid as it is issued', () => {
  /** A debit note of `total` on an issued bank invoice of 120, as a draft. */
  async function noteOf(w: Awaited<ReturnType<typeof world>>, method: string, total = 30, extra: Record<string, any> = {}) {
    const inv = await w.draft('bank_transfer')
    expect((await w.send(inv)).status).toBe(200)
    return w.draft(method, total, { type: 'debit_note', relatedInvoiceId: inv, ...extra })
  }
  const rows = (n: any) => n.payments.map((p: any) => [p.amount, p.method, p.origin ?? null])

  it('in cash: its whole total is one payment, dated the issue date, and nothing is left due', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')

    const res = await w.send(note)

    expect(res.status).toBe(200)
    expect(res.json.invoice.status).toBe('paid')
    const n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', total: 30, amountPaid: 30, amountDue: 0 })
    expect(rows(n)).toEqual([[30, 'cash', CASH_ON_ISSUE]])
    expect(new Date(n.payments[0].date).toISOString().slice(0, 10)).toBe(ISSUE_DATE)
    expect(n.statusHistory.at(-1)).toMatchObject({ fromStatus: 'sent', status: 'paid', reason: 'paid in cash on issue' })
    // The event a payment recorded by hand emits: a ledger that is kept posts it as money in, as an invoice's.
    expect(recorded).toEqual([expect.objectContaining({ invoiceId: note, amount: 30, method: 'cash' })])
  })

  it('by card: the same, by card', async () => {
    const w = await world()
    const note = await noteOf(w, 'card')
    expect((await w.send(note)).status).toBe(200)
    const n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', amountPaid: 30, amountDue: 0 })
    expect(rows(n)).toEqual([[30, 'card', CARD_ON_ISSUE]])
    expect(n.statusHistory.at(-1).reason).toBe('paid by card on issue')
  })

  it('bank transfer and cash on delivery stay due: that money comes later', async () => {
    const w = await world()
    for (const method of ['bank_transfer', 'cash_on_delivery']) {
      const note = await noteOf(w, method)
      expect((await w.send(note)).status).toBe(200)
      const n = await w.load(note)
      expect({ method, status: n.status, due: n.amountDue, payments: n.payments.length }).toEqual({ method, status: 'sent', due: 30, payments: 0 })
    }
    expect(recorded).toHaveLength(0)
  })

  it('a draft is left alone until it is issued', async () => {
    const w = await world()
    const note = await noteOf(w, 'bank_transfer')
    expect((await w.put(note, { paymentMethod: 'cash' })).status).toBe(200)
    const n = await w.load(note)
    expect([n.status, n.payments.length, n.amountDue]).toEqual(['draft', 0, 30])
  })

  it('an edit follows: another method takes the payment back, one recorded by hand stays, and a lower total takes less', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')
    await w.send(note)

    expect((await w.put(note, { paymentMethod: 'bank_transfer' })).json.invoice.status).toBe('sent')
    let n = await w.load(note)
    expect([n.amountPaid, n.amountDue, n.payments.length]).toEqual([0, 30, 0])

    expect((await w.pay(note, { date: '2026-10-06', amount: 10, method: 'bank_transfer' })).status).toBe(200)
    await w.put(note, { paymentMethod: 'card' })
    n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', amountPaid: 30, amountDue: 0 })
    expect(rows(n)).toEqual([[10, 'bank_transfer', null], [20, 'card', CARD_ON_ISSUE]])

    await w.put(note, { lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 25, taxRate: 0 }], subtotal: 25, total: 25 })
    n = await w.load(note)
    expect(n).toMatchObject({ status: 'paid', total: 25, amountPaid: 25, amountDue: 0 })
    expect(rows(n)).toEqual([[10, 'bank_transfer', null], [15, 'card', CARD_ON_ISSUE]])
  })

  it('a note paid as it was issued takes no second payment, as an invoice paid at the counter does not', async () => {
    const w = await world()
    const note = await noteOf(w, 'cash')
    await w.send(note)
    const again = await w.pay(note, { date: '2026-10-06', amount: 1, method: 'cash' })
    expect(again.status).toBe(400)
    expect(again.json.message).toBe('Cannot record payment on this invoice')
    expect((await w.load(note)).payments).toHaveLength(1)
  })

  it('the import conversion pays an imported one as it issues it', async () => {
    const w = await world()
    const note = await noteOf(w, 'card', 30, { reference: '3000704997' })
    const res = await convertDraftInvoice(w.orgId, note, w.userId, { adjustStock: false })
    expect(res.ok).toBe(true)
    const n = await w.load(note)
    expect(n.status).toBe('paid')
    expect(rows(n)).toEqual([[30, 'card', CARD_ON_ISSUE]])
  })

  it('the backlog: a note issued before the rule is found and paid, and the next run finds none', async () => {
    const w = await world()
    const note = await noteOf(w, 'bank_transfer')
    await w.send(note)
    // As a note issued before 2026-11-27: cash, and nothing recorded.
    await Invoice.updateOne({ _id: note }, { $set: { paymentMethod: 'cash' } })

    expect((await unsettledInvoices(w.orgId, ['cash', 'card'])).map(d => [d.id, d.type, d.outstanding])).toEqual([[note, 'debit_note', 30]])
    expect(await unsettledInvoices(w.orgId, ['cash', 'card'], ['credit_note'])).toEqual([])

    expect(await syncCashSettlement(w.orgId, note, w.userId)).toEqual({ action: 'settled', amount: 30 })
    expect(await w.load(note)).toMatchObject({ status: 'paid', amountPaid: 30, amountDue: 0 })
    expect(await unsettledInvoices(w.orgId, ['cash', 'card'])).toEqual([])
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
