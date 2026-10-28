import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { mongoose } from 'db/connection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestInvoice } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { emailRequestBlock } from 'invoicing-api/src/lib/email-guards'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
// The rules the document lists offer their row actions by (`invoicing-ui` is a private app package).
import {
  canConvert, canCopy, canCorrect, canDelete, canEmail, canIssue, canRecordPayment, canVoid,
} from '../../../invoicing-ui/src/composables/document-row-actions'

/**
 * FR-22.23: a document list row offers an action exactly when the API allows it. The sales list
 * offered „Анулирай" on drafts only and Delete on every row — where the API deletes drafts alone —
 * and voiding a draft put back stock it never took (fixed in 8a8583ea).
 *
 * Every status a list shows, against the real routes: what the rule offers, the API takes; what
 * the API refuses, the rule does not offer. Where the rule offers less on purpose, the test says so.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const { Types } = mongoose
type ObjectId = InstanceType<typeof Types.ObjectId>

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
const SALES = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided']
const BILLS = ['draft', 'received', 'partially_paid', 'paid', 'overdue', 'voided']
const PROFORMAS = ['draft', 'sent', 'converted', 'voided']

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const contact = await createTestContact(org._id)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoices${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  /** A document in `status`, stored as it would be: amounts that match the status, no stock. */
  async function doc(type: string, direction: string, status: string, extra: Record<string, any> = {}) {
    const paid = status === 'paid' ? 1180 : status === 'partially_paid' ? 500 : 0
    const d: any = await createTestInvoice(org._id, contact._id as ObjectId, {
      type, direction, status, amountPaid: paid, amountDue: 1180 - paid, ...extra,
    } as any)
    return { id: String(d._id), row: { type, direction, status, ...(extra.cashSaleRef ? { cashSaleId: String(extra.cashSaleRef.cashSaleId) } : {}) } }
  }
  return { orgId, contactId: String(contact._id), call, doc }
}

const ok = (status: number) => status === 200

describe('a row offers exactly what the API allows (FR-22.23)', () => {
  it('void: issued documents only — never a draft (that one is deleted)', async () => {
    const w = await world()
    for (const [type, direction, statuses] of [['invoice', 'outgoing', SALES], ['invoice', 'incoming', BILLS], ['proforma', 'outgoing', PROFORMAS]] as const) {
      for (const status of statuses) {
        const d = await w.doc(type, direction, status)
        const api = ok((await w.call('POST', `/${d.id}/void`, {})).status)
        // The API voids a draft too; the list deletes it instead. Everything else agrees exactly.
        expect({ type, direction, status, offered: canVoid(d.row) }).toEqual({ type, direction, status, offered: api && status !== 'draft' })
      }
    }
    // An invoice for a cash sale is born paid, and voiding it releases the sale's quantities (#171).
    const cs = await w.doc('invoice', 'outgoing', 'paid', { cashSaleRef: { cashSaleId: new Types.ObjectId(), number: 'CS-1', issueDate: new Date() } })
    expect(canVoid(cs.row)).toBe(true)
    expect((await w.call('POST', `/${cs.id}/void`, {})).status).toBe(200)
  })

  it('delete: drafts only', async () => {
    const w = await world()
    for (const status of SALES) {
      const d = await w.doc('invoice', 'outgoing', status)
      expect({ status, offered: canDelete(d.row) }).toEqual({ status, offered: ok((await w.call('DELETE', `/${d.id}`)).status) })
    }
  })

  it('issue: drafts only', async () => {
    const w = await world()
    for (const status of SALES) {
      const d = await w.doc('invoice', 'outgoing', status)
      expect({ status, offered: canIssue(d.row) }).toEqual({ status, offered: ok((await w.call('POST', `/${d.id}/send`, {})).status) })
    }
  })

  it('record a payment: what is offered, the API takes; what it refuses, is not offered', async () => {
    const w = await world()
    for (const [direction, statuses] of [['outgoing', SALES], ['incoming', BILLS]] as const) {
      for (const status of statuses) {
        const d = await w.doc('invoice', direction, status)
        const api = ok((await w.call('POST', `/${d.id}/payments`, { date: '2026-10-26', amount: 1, method: 'bank_transfer' })).status)
        if (canRecordPayment(d.row)) expect({ direction, status, api }).toEqual({ direction, status, api: true })
        if (!api) expect({ direction, status, offered: canRecordPayment(d.row) }).toEqual({ direction, status, offered: false })
      }
    }
    // A sales draft owes nothing yet: the API would take it, the list does not offer it.
    expect(canRecordPayment({ type: 'invoice', direction: 'outgoing', status: 'draft' })).toBe(false)
  })

  it('credit and debit notes: an issued invoice, exactly as the API takes a note for it', async () => {
    const w = await world()
    for (const status of SALES) {
      const d = await w.doc('invoice', 'outgoing', status)
      const res = await w.call('POST', '', {
        type: 'credit_note', direction: 'outgoing', contactId: w.contactId, relatedInvoiceId: d.id, issueDate: '2026-10-26',
        currency: 'EUR', lines: [{ description: 'Връщане', quantity: 1, unitPrice: 10, taxRate: 0 }], subtotal: 10, total: 10,
      })
      expect({ status, offered: canCorrect(d.row) }).toEqual({ status, offered: ok(res.status) })
    }
    // A proforma is corrected by no note.
    const prf = await w.doc('proforma', 'outgoing', 'sent')
    expect(canCorrect(prf.row)).toBe(false)
  })

  it('convert: a proforma not converted yet', async () => {
    const w = await world()
    for (const status of ['draft', 'sent', 'converted']) {
      const d = await w.doc('proforma', 'outgoing', status)
      expect({ status, offered: canConvert(d.row) }).toEqual({ status, offered: ok((await w.call('POST', `/${d.id}/convert`, {})).status) })
    }
    // The API would convert a voided proforma; an offer withdrawn is not offered for conversion.
    expect(canConvert({ type: 'proforma', status: 'voided' })).toBe(false)
  })

  it('email: an issued outgoing document, as the email gate decides', () => {
    const user = { role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin }
    for (const [direction, statuses] of [['outgoing', SALES], ['incoming', BILLS]] as const) {
      for (const status of statuses) {
        const row = { type: 'invoice', direction, status }
        expect({ direction, status, offered: canEmail(row) })
          .toEqual({ direction, status, offered: emailRequestBlock({ user, to: 'client@example.com', invoice: row }) === null })
      }
    }
  })

  it('copy: anything but an invoice for a cash sale', () => {
    expect(canCopy({ status: 'sent' })).toBe(true)
    expect(canCopy({ status: 'paid', cashSaleId: 'x' })).toBe(false)
  })
})
