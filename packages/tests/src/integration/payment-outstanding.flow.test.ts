import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Invoice } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.7: a payment is never more than the document still owes. `POST /invoices/:id/payments`
 * took any amount, and the record-payment dialog suggested the whole total even on a partly paid
 * invoice (it read a field the API does not return), so one click overpaid it and left a negative
 * amount due. Nothing posts an overpayment on purpose: no import records payments through this
 * route, and the cash-on-issue rule settles exactly the total through its own service.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
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

  /** An issued invoice for 120.00, to be paid by bank transfer (so nothing is settled on issue). */
  async function issued(): Promise<string> {
    const res = await call('POST', '', {
      type: 'invoice', direction: 'outgoing', contactId: String(contact._id), issueDate: '2026-10-20', currency: 'EUR',
      lines: [{ description: 'Монтаж', quantity: 1, unitPrice: 120, taxRate: 0 }],
      subtotal: 120, total: 120, paymentMethod: 'bank_transfer',
    })
    expect(res.status).toBe(200)
    const id = String(res.json.invoice.id)
    expect((await call('POST', `/${id}/send`, {})).status).toBe(200)
    return id
  }

  const pay = (id: string, amount: number, key?: string) =>
    call('POST', `/${id}/payments`, { date: '2026-10-21', amount, method: 'bank_transfer' }, key)
  const load = async (id: string) => (await Invoice.findById(id).lean().exec()) as any
  return { issued, pay, load }
}

describe('a payment is never more than is still due (FR-22.7)', () => {
  it('refuses an amount above the total, and records nothing', async () => {
    const w = await world()
    const id = await w.issued()

    const res = await w.pay(id, 150)

    expect(res.status).toBe(422)
    expect(res.json).toMatchObject({ code: 'overpayment', outstanding: 120 })
    const doc = await w.load(id)
    expect(doc.payments).toHaveLength(0)
    expect(doc.amountPaid).toBe(0)
    expect(doc.status).toBe('sent')
  })

  it('measures against what is left after earlier payments, and takes exactly that', async () => {
    const w = await world()
    const id = await w.issued()
    expect((await w.pay(id, 50)).status).toBe(200)

    const over = await w.pay(id, 80)
    expect(over.status).toBe(422)
    expect(over.json.outstanding).toBe(70)

    const rest = await w.pay(id, 70)
    expect(rest.status).toBe(200)
    expect(rest.json.invoice.status).toBe('paid')
    const doc = await w.load(id)
    expect(doc.amountPaid).toBe(120)
    expect(doc.amountDue).toBe(0)
  })

  it('two payments recorded at once cannot overpay between them', async () => {
    const w = await world()
    const id = await w.issued()

    // Each fits what is owed on its own; together they are 20 too much.
    const answers = await Promise.all([w.pay(id, 70), w.pay(id, 70)])

    expect(answers.map((a) => a.status).sort()).toEqual([200, 422])
    const doc = await w.load(id)
    expect(doc.payments).toHaveLength(1)
    expect(doc.amountPaid).toBe(70)
    expect(doc.amountDue).toBe(50)
  })

  it('a retry of a payment that settled the invoice still gets the invoice back, not a refusal', async () => {
    const w = await world()
    const id = await w.issued()
    expect((await w.pay(id, 120, 'pay-key-full')).status).toBe(200)

    const retry = await w.pay(id, 120, 'pay-key-full')

    expect(retry.status).toBe(200)
    expect(retry.json.invoice.status).toBe('paid')
    expect((await w.load(id)).payments).toHaveLength(1)
  })
})
