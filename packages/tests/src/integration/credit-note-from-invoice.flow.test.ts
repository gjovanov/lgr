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
// The form's own code, reached by path (`invoicing-ui` is a private app package): the note is
// built exactly as the credit-note form builds it once the user picks the invoice.
import { buildPayload, linesFromRelatedInvoice } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * FR-22.4 (B-6): a credit note made from a discounted invoice credited the undiscounted price
 * and lost the unit. The form copied every line with `discount: 0` and no unit, and the
 * credit-note configuration had no discount at all, so its totals could not honour one: three
 * boxes sold at 10 % off (183.60 net) were credited at 204.00.
 *
 * What is asserted is what the note BOOKS: the copy and the payload come from the form's own
 * modules and go through the real route, then the note is issued.
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
  const contactId = String(contact._id)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** The invoice the customer brings goods back from: three boxes at 10 % off, and a service. */
  async function issuedInvoice() {
    const created = await call('POST', '', buildPayload({
      contactId, issueDate: '2026-10-20', dueDate: '2026-11-19', currency: 'EUR', exchangeRate: 1, tags: [],
      // Free-text lines move no stock, so issuing either document needs no warehouse.
      lines: [
        { description: 'Кутия болтове М8', quantity: 3, unit: 'box', unitPrice: 68, discount: 10, taxRate: 20 },
        { description: 'Монтаж', quantity: 1, unit: 'pcs', unitPrice: 50, discount: 0, taxRate: 20 },
      ],
    }, DOCUMENT_CONFIGS.invoice))
    expect(created.status).toBe(200)
    const sent = await call('POST', `/${created.json.invoice.id}/send`, {})
    expect(sent.status).toBe(200)
    // The form reads the invoice back through the API before it copies its lines.
    return (await call('GET', `/${created.json.invoice.id}`)).json.invoice
  }

  /** A credit note made the way the form makes one, then issued. */
  async function issuedCreditNote(invoice: any, pick: (lines: any[]) => any[]) {
    const created = await call('POST', '', buildPayload({
      contactId, relatedInvoiceId: invoice.id || invoice._id, issueDate: '2026-10-25', dueDate: '2026-11-24',
      paymentMethod: '', currency: 'EUR', exchangeRate: 1, reason: 'Върната стока', tags: [],
      lines: pick(linesFromRelatedInvoice(invoice.lines)),
    }, DOCUMENT_CONFIGS.credit_note))
    expect(created.status).toBe(200)
    const sent = await call('POST', `/${created.json.invoice.id}/send`, {})
    expect(sent.status).toBe(200)
    return (await Invoice.findById(created.json.invoice.id).lean().exec()) as any
  }

  return { issuedInvoice, issuedCreditNote }
}

describe('a credit note made from an invoice credits what was charged (FR-22.4)', () => {
  it('one returned box of three, sold at 10 % off: the discount and the unit come along', async () => {
    const w = await world()
    const invoice = await w.issuedInvoice()

    const note = await w.issuedCreditNote(invoice, (lines) => [{ ...lines[0], quantity: 1 }])

    expect(note.status).toBe('sent')
    expect(note.lines).toHaveLength(1)
    expect(note.lines[0]).toMatchObject({ quantity: 1, unit: 'box', unitPrice: 68, discount: 10, taxRate: 20 })
    // 68 less 10 % = 61.20 net, + 20 % VAT. Without the discount it credited 68 + VAT = 81.60.
    expect(note.lines[0].lineTotal).toBe(73.44)
    expect(note.subtotal).toBe(68)
    expect(note.discountTotal).toBe(6.8)
    expect(note.taxTotal).toBe(12.24)
    expect(note.total).toBe(73.44)
  })

  it('a note for everything that was sold credits exactly the invoice total', async () => {
    const w = await world()
    const invoice = await w.issuedInvoice()
    expect(invoice.total).toBe(280.32) // 183.60 + 50.00 net, + 20 %

    const note = await w.issuedCreditNote(invoice, (lines) => lines)

    expect(note.total).toBe(invoice.total)
    expect(note.discountTotal).toBe(invoice.discountTotal)
    expect(note.lines.map((l: any) => [l.unit, l.discount, l.lineTotal]))
      .toEqual(invoice.lines.map((l: any) => [l.unit, l.discount, l.lineTotal]))
  })
})
