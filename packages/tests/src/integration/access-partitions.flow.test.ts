import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestStockMovement, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Invoice, Org, Role, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'
import { kindOfDocument, partitionFilter, readableDirection, type CapabilityId } from 'config/access'

/**
 * FR-27.6 (#529) — partitions: sales documents, proforma and bills share `/invoices`. A role reads the kinds whose
 * `view` it holds and writes those whose work actions it holds; a document of another kind is 404 by id and absent
 * from the list, the summary and the export. FR-26.6's `purchases` table, as data.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
const docs: Record<string, string> = {}
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

async function giveRole(key: string, name: string, caps: CapabilityId[]) {
  const role: any = await Role.create({ orgId: org._id, name, caps, isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: [] } } as any)
  await User.updateOne({ _id: people[key]._id }, { $set: { roleId: role._id } }).exec()
  forgetMember(people[key]._id)
  forgetRole(role._id)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'access-partitions' } as any)
  orgId = String(org._id)
  await seedDefaultPermissionSets(orgId)
  for (const key of ['admin', 'billsClerk', 'counter', 'quoter']) {
    people[key] = await createTestUser(org._id, { role: key === 'admin' ? 'admin' : 'member', username: key, email: `${key}@partitions.test` } as any)
  }
  const contact = await createTestContact(org._id)
  docs.sale = String((await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'INV-P-1' } as any))._id)
  docs.proforma = String((await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'PRF-P-1', type: 'proforma' } as any))._id)
  // An offer is a quote, of the proforma kind: the proforma capabilities read and write it.
  docs.offer = String((await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'OFR-P-1', type: 'offer', status: 'sent' } as any))._id)
  docs.bill = String((await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'BILL-P-1', direction: 'incoming' } as any))._id)
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: {} })
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
  // Bills only, and they work on them.
  await giveRole('billsClerk', 'Bills clerk', ['bills.view', 'bills.create', 'bills.edit', 'contacts.lookup'] as CapabilityId[])
  // Sales documents to work on; bills to read, never to change.
  await giveRole('counter', 'Counter', ['sales-docs.view', 'sales-docs.create', 'sales-docs.edit', 'bills.view'] as CapabilityId[])
  // Quotes (proformas, offers) to work on, and no sales document of its own.
  await giveRole('quoter', 'Quoter', ['proforma.view', 'proforma.create', 'proforma.edit', 'contacts.lookup'] as CapabilityId[])
  for (const key of Object.keys(people)) tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!))
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

const numbers = (r: any) => (r.json.invoices ?? r.json.items ?? []).map((i: any) => i.invoiceNumber).sort()

describe('the rule (config/access/partition.ts)', () => {
  it('kinds, and the filter a list adds', () => {
    expect(kindOfDocument({ direction: 'incoming', type: 'invoice' })).toBe('bills')
    expect(kindOfDocument({ direction: 'outgoing', type: 'proforma' })).toBe('proforma')
    expect(kindOfDocument({ direction: 'outgoing', type: 'offer' })).toBe('proforma')
    expect(kindOfDocument({ direction: 'outgoing', type: 'credit_note' })).toBe('sales')
    // The quotes are one kind, and the sales kind leaves both out.
    expect(partitionFilter({ caps: new Set<CapabilityId>(['proforma.view']) })).toEqual({ $or: [{ direction: 'outgoing', type: { $in: ['proforma', 'offer'] } }] })
    expect(partitionFilter({ caps: new Set<CapabilityId>(['sales-docs.view', 'bills.view']) })).toEqual({
      $or: [{ direction: 'outgoing', type: { $nin: ['proforma', 'offer'] } }, { direction: 'incoming' }],
    })
    expect(partitionFilter({ all: true })).toBeNull()
    expect(partitionFilter({ caps: new Set<CapabilityId>(['sales-docs.view', 'proforma.view']) })).toEqual({ direction: 'outgoing' })
    expect(partitionFilter({ caps: new Set<CapabilityId>(['bills.view']) })).toEqual({ direction: 'incoming' })
    expect(readableDirection({ caps: new Set<CapabilityId>(['sales-docs.view', 'bills.view']) })).toBeUndefined()
  })
})

describe('FR-27.6: a role reads the kinds it holds', () => {
  it('the bills clerk lists only bills, and a sales document or a proforma is 404 by id', async () => {
    const list = await call('GET', '/invoices?size=50', tokens.billsClerk)
    expect(list.status).toBe(200)
    expect(numbers(list)).toEqual(['BILL-P-1'])
    expect((await call('GET', `/invoices/${docs.bill}`, tokens.billsClerk)).status).toBe(200)
    expect((await call('GET', `/invoices/${docs.sale}`, tokens.billsClerk)).status).toBe(404)
    expect((await call('GET', `/invoices/${docs.proforma}`, tokens.billsClerk)).status).toBe(404)
  })

  it('the counter lists sales documents and bills, not proforma, nor an offer', async () => {
    const list = await call('GET', '/invoices?size=50', tokens.counter)
    expect(numbers(list)).toEqual(['BILL-P-1', 'INV-P-1'])
    expect((await call('GET', `/invoices/${docs.proforma}`, tokens.counter)).status).toBe(404)
    expect((await call('GET', `/invoices/${docs.offer}`, tokens.counter)).status).toBe(404)
  })

  it('a role of the quotes lists the proforma and the offer, and nothing else', async () => {
    expect(numbers(await call('GET', '/invoices?size=50', tokens.quoter))).toEqual(['OFR-P-1', 'PRF-P-1'])
    expect((await call('GET', `/invoices/${docs.offer}`, tokens.quoter)).status).toBe(200)
    expect((await call('GET', `/invoices/${docs.sale}`, tokens.quoter)).status).toBe(404)
  })

  it('the Administrator reads every kind', async () => {
    expect(numbers(await call('GET', '/invoices?size=50', tokens.admin))).toEqual(['BILL-P-1', 'INV-P-1', 'OFR-P-1', 'PRF-P-1'])
  })
})

describe('converting a quote makes a document of another kind, which the role must make', () => {
  it('a role of the quotes turns an offer into a proforma, never into an invoice', async () => {
    const intoInvoice = await call('POST', `/invoices/${docs.offer}/convert`, tokens.quoter, { target: 'invoice' })
    expect(intoInvoice.status).toBe(403)
    expect(intoInvoice.json.capabilities).toEqual(['sales-docs.create'])
    // Refused before anything was written: the offer is still open.
    expect((await call('GET', `/invoices/${docs.offer}`, tokens.quoter)).json.invoice.status).toBe('sent')

    const intoProforma = await call('POST', `/invoices/${docs.offer}/convert`, tokens.quoter, { target: 'proforma' })
    expect(intoProforma.status).toBe(200)
    expect(intoProforma.json.invoice.type).toBe('proforma')
    expect(String(intoProforma.json.invoice.offerId)).toBe(docs.offer)
  })

  it('S-40: nor a proforma into an invoice, which the route did before: refused before anything is written', async () => {
    const invoicesBefore = await Invoice.countDocuments({ orgId: org._id, type: 'invoice' }).exec()
    const conv = await call('POST', `/invoices/${docs.proforma}/convert`, tokens.quoter, {})
    expect(conv.status).toBe(403)
    expect(conv.json.capabilities).toEqual(['sales-docs.create'])
    expect((await call('GET', `/invoices/${docs.proforma}`, tokens.quoter)).json.invoice.status).toBe('draft')
    expect(await Invoice.countDocuments({ orgId: org._id, type: 'invoice' }).exec()).toBe(invoicesBefore)
  })

  it('the counter, who reads no quote, converts none: a proforma is 404 to it', async () => {
    expect((await call('POST', `/invoices/${docs.proforma}/convert`, tokens.counter, {})).status).toBe(404)
  })
})

describe('FR-27.6: and writes the kinds it works on', () => {
  it('a bill the counter only reads is not changed or deleted by it', async () => {
    const put = await call('PUT', `/invoices/${docs.bill}`, tokens.counter, { notes: 'mine now' })
    expect(put.status).toBe(403)
    expect(put.json.capabilities).toEqual(['bills.edit'])
    expect((await call('DELETE', `/invoices/${docs.bill}`, tokens.counter)).status).toBe(403)
  })

  it('a sales document the bills clerk does not read is 404 to a write too', async () => {
    expect((await call('PUT', `/invoices/${docs.sale}`, tokens.billsClerk, { notes: 'x' })).status).toBe(404)
  })

  it('a create of a kind the role does not make is refused before anything is written', async () => {
    const outgoing = await call('POST', '/invoices', tokens.billsClerk, { type: 'invoice', direction: 'outgoing', contactId: String(new mongoose.Types.ObjectId()), issueDate: new Date().toISOString(), currency: 'EUR', subtotal: 0, taxTotal: 0, total: 0, lines: [] })
    expect(outgoing.status).toBe(403)
    expect(outgoing.json.capabilities).toEqual(['sales-docs.create'])
    const bill = await call('POST', '/invoices', tokens.counter, { type: 'invoice', direction: 'incoming', contactId: String(new mongoose.Types.ObjectId()), issueDate: new Date().toISOString(), currency: 'EUR', subtotal: 0, taxTotal: 0, total: 0, lines: [] })
    expect(bill.status).toBe(403)
    expect(bill.json.capabilities).toEqual(['bills.create'])
  })
})

describe("a contact's unpaid documents are theirs who read the documents (`GET /invoicing/contact/:id/unpaid`)", () => {
  it('a role that reads sales documents is given them, the bills only when it reads bills; any other role is refused', async () => {
    const contact = await createTestContact(org._id)
    await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'INV-U-1', status: 'sent' } as any)
    await createTestInvoice(org._id, contact._id as any, { invoiceNumber: 'BILL-U-1', direction: 'incoming', status: 'received' } as any)
    const join = async (key: string, name: string, caps: CapabilityId[]) => {
      people[key] = await createTestUser(org._id, { role: 'member', username: key, email: `${key}@partitions.test` } as any)
      await giveRole(key, name, caps)
      tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!))
    }
    const unpaid = (key: string) => call('GET', `/invoicing/contact/${contact._id}/unpaid`, tokens[key])
    const balance = async (key: string) => (await call('GET', `/invoicing/contact/${contact._id}/summary`, tokens[key])).json.openBalance

    // Sales documents and bills: both, and they add up to the figure of the contact's page.
    const counter = await unpaid('counter')
    expect(counter.status).toBe(200)
    expect(counter.json.documents.map((d: any) => d.invoiceNumber).sort()).toEqual(['BILL-U-1', 'INV-U-1'])
    expect(counter.json.openBalance).toBe(2360)

    // Sales documents alone: no bill, in the list or in the figure.
    await join('salesReader', 'Sales reader', ['sales-docs.view', 'contacts.view'] as CapabilityId[])
    const sales = await unpaid('salesReader')
    expect(sales.status).toBe(200)
    expect(sales.json.documents.map((d: any) => d.invoiceNumber)).toEqual(['INV-U-1'])
    expect([sales.json.openBalance, await balance('salesReader')]).toEqual([1180, 1180])
    expect(JSON.stringify(sales.json)).not.toContain('BILL-U-1')

    // The contact's page without the documents: its figure, and no list of the documents behind it.
    await join('contactsClerk', 'Contacts clerk', ['contacts.view'] as CapabilityId[])
    expect(await balance('contactsClerk')).toBe(1180)
    const refused = await unpaid('contactsClerk')
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.json)).not.toContain('INV-U-1')

    // Bills alone, and quotes alone: refused, as the ledger behind the Invoices button is.
    expect((await unpaid('billsClerk')).status).toBe(403)
    expect((await unpaid('quoter')).status).toBe(403)
    expect((await call('GET', `/invoicing/contact-ledger/${contact._id}`, tokens.billsClerk)).status).toBe(403)
  })
})

describe('FR-27.6 on the legacy model: the areas, for every session (`seesBills`)', () => {
  it("a warehouse manager, who holds no invoicing permission, is still told of the bill that holds a receipt; a Seller is not", async () => {
    const legacy: any = await createTestOrg({ slug: 'access-partitions-legacy' } as any)
    const contact = await createTestContact(legacy._id)
    const bill = await createTestInvoice(legacy._id, contact._id as any, { invoiceNumber: 'BILL-L-1', direction: 'incoming' } as any)
    const receipt: any = await createTestStockMovement(legacy._id, { type: 'receipt', invoiceId: bill._id } as any)
    const read = async (role: string) => {
      const u = await createTestUser(legacy._id, { role, username: role, email: `${role}@partitions-legacy.test` } as any)
      const token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(u._id).exec())!))
      const res = await app.handle(new Request(`http://localhost/api/org/${legacy._id}/warehouse/movement/${receipt._id}`, { headers: { authorization: `Bearer ${token}` } }))
      return { status: res.status, json: await res.json() as any }
    }
    const wm = await read('warehouse_manager')
    expect(wm.status).toBe(200)
    expect(String(wm.json.stockMovement.invoiceId)).toBe(String(bill._id))
    // FR-26.6: a Seller's areas leave `purchases` out, and the bill is not named.
    const seller = await read('seller')
    expect(seller.status).toBe(200)
    expect(seller.json.stockMovement.invoiceId).toBeUndefined()
  })
})
