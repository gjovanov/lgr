import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { UNPAID_LIST_MAX } from '../../../invoicing-api/src/controllers/contact.controller.js'
import { config } from 'config'
import { EXACT_READS, accessRuleFor } from 'config/access'
import { Identity, PermissionSet, type IUser } from 'db/models'
import { sessionFor } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { EXACT_READ_RULES } from 'services/biz/route-permission'

/**
 * The documents behind the contact form's Open Balance button (`GET /invoicing/contact/:id/unpaid`).
 *
 * The button shows what the contact still owes; the list is that figure document by document. Both are read by
 * one reader in the controller, and this holds them to each other over the real route table: the same documents,
 * the same sign for a credit note, the same side for a session without purchases, and the same refusal for a
 * role that only picks contacts.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: object): Promise<string> => (signer as any).decorator.jwt.sign(claims)

let app: Elysia
let org: any
let orgId: string
let contactId: string
const tokens: Record<string, string> = {}

async function request(path: string, token?: string) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** A member linked to a person, on the role's system set when it has one, and their session as sign-in issues it. */
async function member(role: string, setName?: string): Promise<string> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@unpaid.test`
  const identity = await Identity.create({ email, firstName: 'U', lastName: role, isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
  const set = setName ? await PermissionSet.findOne({ orgId, name: setName }).lean() : null
  const user: IUser = await createTestUser(org._id, { role, email, identityId: identity._id, ...(set ? { permissionSetIds: [set._id] } : {}) } as any)
  return sign(await sessionFor(user, identity))
}

/** A document of the contact: `total`, of which `paid`, due on `due`. */
function doc(contact: string, invoiceNumber: string, over: Record<string, unknown> & { total?: number; paid?: number; due?: string }) {
  const { total = 100, paid = 0, due = '2026-06-01', ...rest } = over
  return createTestInvoice(org._id, contact as any, {
    invoiceNumber, status: 'sent', total, amountPaid: paid, amountDue: total - paid, dueDate: new Date(`${due}T00:00:00Z`), ...rest,
  } as any)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg()
  orgId = String(org._id)
  await seedDefaultPermissionSets(orgId)
  contactId = String((await createTestContact(org._id))._id)

  // What owes, written in another order than it is due.
  await doc(contactId, 'INV-NEW', { due: '2026-04-01' })
  await doc(contactId, 'BILL-1', { direction: 'incoming', status: 'received', total: 50, due: '2026-03-01' })
  await doc(contactId, 'CN-1', { type: 'credit_note', total: 30, due: '2026-02-01' })
  await doc(contactId, 'INV-OLD', { status: 'partially_paid', paid: 60, due: '2026-01-10' })
  // What does not: not issued, paid, annulled, a quote, and an issued document with nothing to pay.
  await doc(contactId, 'DRF-1', { status: 'draft' })
  await doc(contactId, 'INV-PAID', { status: 'paid', paid: 100 })
  await doc(contactId, 'INV-VOID', { status: 'voided' })
  await doc(contactId, 'PRF-1', { type: 'proforma' })
  await doc(contactId, 'OFR-1', { type: 'offer' })
  await doc(contactId, 'INV-ZERO', { total: 0 })

  tokens.admin = await member('admin', 'Administrator')
  tokens.seller = await member('seller', 'Seller')
  tokens.warehouse_manager = await member('warehouse_manager')
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe("the documents behind a contact's Open Balance", () => {
  it("lists what still owes, the longest due first, and adds up to the button's figure", async () => {
    const res = await request(`/invoicing/contact/${contactId}/unpaid`, tokens.admin)
    expect(res.status).toBe(200)
    // A credit note's amounts are signed: owed TO the contact. A row reads total − paid = due.
    expect(res.json.documents.map((d: any) => [d.invoiceNumber, d.type, d.direction, d.total, d.amountPaid, d.due])).toEqual([
      ['INV-OLD', 'invoice', 'outgoing', 100, 60, 40],
      ['CN-1', 'credit_note', 'outgoing', -30, 0, -30],
      ['BILL-1', 'invoice', 'incoming', 50, 0, 50],
      ['INV-NEW', 'invoice', 'outgoing', 100, 0, 100],
    ])
    expect(res.json.documents.map((d: any) => String(d.dueDate).slice(0, 10))).toEqual(['2026-01-10', '2026-02-01', '2026-03-01', '2026-04-01'])
    expect(res.json.documents.every((d: any) => /^[0-9a-f]{24}$/.test(d._id) && d.currency === 'EUR')).toBe(true)
    expect([res.json.count, res.json.openBalance, res.json.currency, res.json.mixedCurrency]).toEqual([4, 160, 'EUR', false])
    expect(res.json.documents.reduce((sum: number, d: any) => sum + d.due, 0)).toBe(160)

    const summary = await request(`/invoicing/contact/${contactId}/summary`, tokens.admin)
    expect([summary.json.openBalance, summary.json.currency, summary.json.mixedCurrency]).toEqual([160, 'EUR', false])
    // The summary still answers what it always did.
    expect(Object.keys(summary.json).sort()).toEqual(['currency', 'invoiceCount', 'mixedCurrency', 'movementCount', 'openBalance'])
  })

  it("without the purchases side there is no bill in it, and it adds up to that session's figure", async () => {
    const res = await request(`/invoicing/contact/${contactId}/unpaid`, tokens.seller)
    expect(res.status).toBe(200)
    expect(res.json.documents.map((d: any) => d.invoiceNumber)).toEqual(['INV-OLD', 'CN-1', 'INV-NEW'])
    expect([res.json.count, res.json.openBalance]).toEqual([3, 110])
    expect(JSON.stringify(res.json)).not.toContain('BILL-1')
    expect((await request(`/invoicing/contact/${contactId}/summary`, tokens.seller)).json.openBalance).toBe(110)
  })

  it('documents in several currencies are listed, with no figure, as the button shows none', async () => {
    const other = String((await createTestContact(org._id))._id)
    await doc(other, 'INV-EUR', { due: '2026-01-01' })
    await doc(other, 'INV-USD', { currency: 'USD', total: 70, due: '2026-02-01' })
    const res = await request(`/invoicing/contact/${other}/unpaid`, tokens.admin)
    expect(res.json.documents.map((d: any) => [d.invoiceNumber, d.currency, d.due])).toEqual([['INV-EUR', 'EUR', 100], ['INV-USD', 'USD', 70]])
    expect([res.json.count, res.json.openBalance, res.json.currency, res.json.mixedCurrency]).toEqual([2, null, null, true])
    const summary = await request(`/invoicing/contact/${other}/summary`, tokens.admin)
    expect([summary.json.openBalance, summary.json.mixedCurrency]).toEqual([null, true])
  })

  it('a contact that owes nothing: an empty list and a figure of 0', async () => {
    const none = String((await createTestContact(org._id))._id)
    await doc(none, 'INV-DONE', { status: 'paid', paid: 100 })
    const res = await request(`/invoicing/contact/${none}/unpaid`, tokens.admin)
    expect(res.json).toEqual({ documents: [], count: 0, openBalance: 0, currency: null, mixedCurrency: false })
  })

  it('more documents than the list sends: the first of them, with the count and the figure of them all', async () => {
    const many = String((await createTestContact(org._id))._id)
    const n = UNPAID_LIST_MAX + 3
    for (let i = 0; i < n; i++) {
      // Due a day apart, the last made due first.
      await doc(many, `INV-M-${String(i).padStart(4, '0')}`, { total: 2, due: new Date(Date.UTC(2026, 0, 1) + (n - i) * 86_400_000).toISOString().slice(0, 10) })
    }
    const res = await request(`/invoicing/contact/${many}/unpaid`, tokens.admin)
    expect(res.json.documents.length).toBe(UNPAID_LIST_MAX)
    expect(res.json.documents[0].invoiceNumber).toBe(`INV-M-${String(n - 1).padStart(4, '0')}`)
    expect([res.json.count, res.json.openBalance]).toEqual([n, n * 2])
    expect((await request(`/invoicing/contact/${many}/summary`, tokens.admin)).json.openBalance).toBe(n * 2)
  }, 120_000)

  it("it is the invoicing app's: a role that only picks contacts is refused, and so is nobody", async () => {
    // The contact itself is every trade app's (the pickers read it); its amounts are not.
    expect((await request('/invoicing/contact', tokens.warehouse_manager)).status).toBe(200)
    expect((await request(`/invoicing/contact/${contactId}/summary`, tokens.warehouse_manager)).status).toBe(403)
    const refused = await request(`/invoicing/contact/${contactId}/unpaid`, tokens.warehouse_manager)
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.json)).not.toContain('INV-')
    expect((await request(`/invoicing/contact/${contactId}/unpaid`)).status).toBe(401)
    // Both tables name it: left to the contact routes' prefix, the pickers' roles would read it. By permissions it
    // is the summary's rule; by capabilities the documents' own, as the ledger behind the Invoices button asks.
    expect(EXACT_READ_RULES.get('invoicing/contact/:id/unpaid')).toBeDefined()
    expect(JSON.stringify(EXACT_READ_RULES.get('invoicing/contact/:id/unpaid'))).toBe(JSON.stringify(EXACT_READ_RULES.get('invoicing/contact/:id/summary')))
    expect(EXACT_READS.get('invoicing/contact/:id/unpaid')).toEqual({ anyOf: ['sales-docs.view'] })
    expect(accessRuleFor('GET', 'invoicing/contact-ledger/:contactId')).toEqual({ anyOf: ['sales-docs.view'] })
  })
})
