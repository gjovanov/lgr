import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Identity, Invoice, InternalOrder, Org, PermissionSet, POSTransaction, Role, User, type IUser } from 'db/models'
import { sessionFor, tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'
import { typedPriceRefusal, withArticleUnits } from 'services/biz/sales-lines'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { CapabilityId } from 'config/access'
import { forgetDevices, tillApp, tillWorld } from '../helpers/till-world'

/**
 * #724 — the two rules the sales documents' forms hold, held by the routes (`services/biz/sales-lines.ts`):
 *
 * 1. A line price TYPED is the role's to give (FR-27 `sales-docs.manual-price`; owner, 2026-11-12: "Manual price,
 *    unavailable for Seller, but available for Sales Consultant"). Without it, a line's price must be one the form
 *    could have given: offered for the line, already on the document, or already charged to the client.
 * 2. An outgoing article line's unit is its article's.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: object): Promise<string> => (signer as any).decorator.jwt.sign(claims)

let app: Elysia
let shop: any
let shopId: string
let bolt: string
let wire: string
const tokens: Record<string, string> = {}
const users: Record<string, IUser> = {}

async function call(orgId: string, method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

/** A member linked to a person, on the role's system set, and their session as sign-in issues it. */
async function member(org: any, role: string, setName?: string): Promise<{ user: IUser; token: string }> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@lines724.test`
  const identity = await Identity.create({ email, firstName: 'F', lastName: role, isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
  const set = setName ? await PermissionSet.findOne({ orgId: org._id, name: setName }).lean() : null
  const user = await createTestUser(org._id, { role, email, identityId: identity._id, ...(set ? { permissionSetIds: [set._id] } : {}) } as any)
  return { user, token: await sign(await sessionFor(user, identity)) }
}

type LineIn = { productId?: string; unitPrice: number; quantity?: number; unit?: string; description?: string; orderRef?: Record<string, string> }

function invoiceBody(contactId: string, lines: LineIn[], extra: Record<string, unknown> = {}) {
  const full = lines.map(l => ({ description: 'Line', quantity: 1, taxRate: 20, discount: 0, ...l }))
  const subtotal = full.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  return { type: 'invoice', direction: 'outgoing', contactId, issueDate: '2026-11-12', currency: 'EUR', lines: full, subtotal, total: +(subtotal * 1.2).toFixed(2), ...extra }
}

const customer = async (org: any) => String((await createTestContact(org._id, { type: 'customer' } as any))._id)

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  shop = await createTestOrg({ slug: 'lines-724' } as any)
  shopId = String(shop._id)
  await seedDefaultPermissionSets(shopId)
  // `Цена 2` is a filterless slot: offered in the price menu (`all`), never by resolution.
  bolt = String((await createTestProduct(shop._id, {
    name: 'Bolt', sellingPrice: 10, unit: 'pcs', taxRate: 20,
    priceTiers: [{ name: 'Цена 2', percent: 0, finalPrice: 8, manualOverride: true }],
  } as any))._id)
  wire = String((await createTestProduct(shop._id, { name: 'Wire', sellingPrice: 5, unit: 'm', taxRate: 20 } as any))._id)
  for (const [role, set] of [['seller', 'Seller'], ['sales_consultant', 'Sales Consultant'], ['admin', 'Administrator']] as const) {
    const m = await member(shop, role, set)
    users[role] = m.user
    tokens[role] = m.token
  }
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('rule 1 on a sales document: the Seller saves a price the form could have given', () => {
  it('a typed price is refused, naming its line, and nothing is written', async () => {
    const contactId = await customer(shop)
    const before = await Invoice.countDocuments({ orgId: shopId })
    const r = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ productId: bolt, unitPrice: 10 }, { productId: bolt, unitPrice: 7.5 }]))
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('price_not_offered')
    expect(r.json.capabilities).toEqual(['sales-docs.manual-price'])
    expect(r.json.lines).toEqual([{ line: 2, productId: bolt, unitPrice: 7.5 }])
    expect(r.json.message).toContain('line 2')
    expect(await Invoice.countDocuments({ orgId: shopId })).toBe(before)
  })

  it('what the form offers goes through: the selling price, a named slot of the price menu, another article', async () => {
    const contactId = await customer(shop)
    const r = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [
      { productId: bolt, unitPrice: 10 }, { productId: bolt, unitPrice: 8 }, { productId: wire, unitPrice: 5, unit: 'm' },
    ]))
    expect(r.status).toBe(200)
    expect(r.json.invoice.lines.map((l: any) => l.unitPrice)).toEqual([10, 8, 5])
  })

  it('a price rounded on its way (under half the fourth decimal) is the same price; one beyond it is not', async () => {
    const contactId = await customer(shop)
    expect((await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ productId: bolt, unitPrice: 8.00004 }]))).status).toBe(200)
    const off = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ productId: bolt, unitPrice: 8.0002 }]))
    expect({ status: off.status, code: off.json?.code }).toEqual({ status: 403, code: 'price_not_offered' })
  })

  it('the Sales Consultant and the Administrator type what they like', async () => {
    const contactId = await customer(shop)
    for (const role of ['sales_consultant', 'admin']) {
      const r = await call(shopId, 'POST', '/invoices', tokens[role], invoiceBody(contactId, [{ productId: bolt, unitPrice: 7.25 }]))
      expect({ role, status: r.status }).toEqual({ role, status: 200 })
    }
  })

  it('a price already on the document is not this save\'s: an unchanged line saves back, a changed one is refused', async () => {
    const contactId = await customer(shop)
    const made = await call(shopId, 'POST', '/invoices', tokens.sales_consultant, invoiceBody(contactId, [{ productId: bolt, unitPrice: 7.3 }]))
    expect(made.status).toBe(200)
    const id = String(made.json.invoice._id ?? made.json.invoice.id)
    const same = await call(shopId, 'PUT', `/invoices/${id}`, tokens.seller, { lines: [{ productId: bolt, description: 'Line', quantity: 3, unitPrice: 7.3, taxRate: 20, unit: 'pcs' }] })
    expect(same.status).toBe(200)
    const changed = await call(shopId, 'PUT', `/invoices/${id}`, tokens.seller, { lines: [{ productId: bolt, description: 'Line', quantity: 3, unitPrice: 7.2, taxRate: 20, unit: 'pcs' }] })
    expect({ status: changed.status, code: changed.json?.code, lines: changed.json?.lines }).toEqual({ status: 403, code: 'price_not_offered', lines: [{ line: 1, productId: bolt, unitPrice: 7.2 }] })
    const stored: any = await Invoice.findById(id).lean()
    expect(stored.lines.map((l: any) => [l.quantity, l.unitPrice])).toEqual([[3, 7.3]])
  })

  it('a price the client was already charged for the article (Last price, a copy) goes through for that client only', async () => {
    const charged = await customer(shop)
    const other = await customer(shop)
    await createTestInvoice(shop._id, charged as any, {
      invoiceNumber: 'INV-724-HIST', status: 'sent',
      lines: [{ productId: bolt, description: 'Bolt', quantity: 1, unit: 'pcs', unitPrice: 6.9, discount: 0, taxRate: 20, taxAmount: 1.38, lineTotal: 6.9 }],
    } as any)
    expect((await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(charged, [{ productId: bolt, unitPrice: 6.9 }]))).status).toBe(200)
    const elsewhere = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(other, [{ productId: bolt, unitPrice: 6.9 }]))
    expect({ status: elsewhere.status, code: elsewhere.json?.code }).toEqual({ status: 403, code: 'price_not_offered' })
  })

  it('a voided document charged nothing: its price is no precedent', async () => {
    const contactId = await customer(shop)
    await createTestInvoice(shop._id, contactId as any, {
      invoiceNumber: 'INV-724-VOID', status: 'voided',
      lines: [{ productId: bolt, description: 'Bolt', quantity: 1, unit: 'pcs', unitPrice: 6.4, discount: 0, taxRate: 20, taxAmount: 1.28, lineTotal: 6.4 }],
    } as any)
    const r = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ productId: bolt, unitPrice: 6.4 }]))
    expect({ status: r.status, code: r.json?.code }).toEqual({ status: 403, code: 'price_not_offered' })
  })

  it('a credit note takes its invoice\'s prices', async () => {
    const contactId = await customer(shop)
    const invoice = await createTestInvoice(shop._id, contactId as any, {
      invoiceNumber: 'INV-724-CN', status: 'sent',
      lines: [{ productId: bolt, description: 'Bolt', quantity: 2, unit: 'pcs', unitPrice: 6.6, discount: 0, taxRate: 20, taxAmount: 2.64, lineTotal: 13.2 }],
    } as any)
    const note = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ productId: bolt, unitPrice: 6.6 }], { type: 'credit_note', relatedInvoiceId: String(invoice._id) }))
    expect(note.status).toBe(200)
  })

  it('a typed line (no article) is offered nothing: 0 goes through, a figure does not', async () => {
    const contactId = await customer(shop)
    expect((await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ description: 'Delivery', unitPrice: 0, unit: 'pcs' }]))).status).toBe(200)
    const r = await call(shopId, 'POST', '/invoices', tokens.seller, invoiceBody(contactId, [{ description: 'Delivery', unitPrice: 15, unit: 'pcs' }]))
    expect({ status: r.status, code: r.json?.code, lines: r.json?.lines }).toEqual({ status: 403, code: 'price_not_offered', lines: [{ line: 1, unitPrice: 15 }] })
  })

  it('the rule asks nothing of a bill, of a save without lines, or of a session that may type', async () => {
    const seller = { id: String(users.seller._id), orgId: shopId, role: 'seller', permissions: [...DEFAULT_ROLE_PERMISSIONS.seller] }
    const lines = [{ productId: bolt, unitPrice: 1.23, quantity: 1 }]
    expect(await typedPriceRefusal(shopId, seller as any, { direction: 'incoming', lines })).toBeNull()
    expect(await typedPriceRefusal(shopId, seller as any, { direction: 'outgoing', lines: [] })).toBeNull()
    expect(await typedPriceRefusal(shopId, { ...seller, role: 'sales_consultant' } as any, { direction: 'outgoing', lines })).toBeNull()
    expect((await typedPriceRefusal(shopId, seller as any, { direction: 'outgoing', lines }))?.code).toBe('price_not_offered')
    // Another organization's article offers nothing here.
    const elsewhere = await createTestOrg()
    const foreign = String((await createTestProduct(elsewhere._id, { sellingPrice: 1.23 } as any))._id)
    expect((await typedPriceRefusal(shopId, seller as any, { direction: 'outgoing', lines: [{ productId: foreign, unitPrice: 1.23 }] }))?.code).toBe('price_not_offered')
  })
})

describe('rule 2: an outgoing article line carries its article\'s unit', () => {
  it('a create writes the article\'s unit over another, and fills a missing one', async () => {
    const contactId = await customer(shop)
    const r = await call(shopId, 'POST', '/invoices', tokens.admin, invoiceBody(contactId, [
      { productId: bolt, unitPrice: 10, unit: 'kg' }, { productId: wire, unitPrice: 5 }, { description: 'Delivery', unitPrice: 3, unit: 'hr' },
    ]))
    expect(r.status).toBe(200)
    const stored: any = await Invoice.findById(r.json.invoice._id ?? r.json.invoice.id).lean()
    expect(stored.lines.map((l: any) => l.unit)).toEqual(['pcs', 'm', 'hr'])
  })

  it('an edit cannot change it, and a line the document already holds at another unit keeps that unit', async () => {
    const contactId = await customer(shop)
    const doc = await createTestInvoice(shop._id, contactId as any, {
      invoiceNumber: 'DRF-724-UNIT',
      lines: [{ productId: bolt, description: 'Bolt', quantity: 1, unit: 'box', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 10 }],
    } as any)
    const id = String(doc._id)
    const kept = await call(shopId, 'PUT', `/invoices/${id}`, tokens.admin, { lines: [{ productId: bolt, description: 'Bolt', quantity: 2, unit: 'box', unitPrice: 10, taxRate: 20 }] })
    expect(kept.status).toBe(200)
    expect(((await Invoice.findById(id).lean()) as any).lines.map((l: any) => l.unit)).toEqual(['box'])
    const changed = await call(shopId, 'PUT', `/invoices/${id}`, tokens.admin, { lines: [{ productId: bolt, description: 'Bolt', quantity: 2, unit: 'kg', unitPrice: 10, taxRate: 20 }] })
    expect(changed.status).toBe(200)
    expect(((await Invoice.findById(id).lean()) as any).lines.map((l: any) => l.unit)).toEqual(['pcs'])
  })

  it('a bill keeps the supplier\'s unit', async () => {
    const lines = [{ productId: bolt, unit: 'kg', unitPrice: 4 }]
    expect(await withArticleUnits(shopId, 'incoming', lines)).toBe(lines)
    expect((await withArticleUnits(shopId, 'outgoing', lines))![0].unit).toBe('pcs')
  })
})

describe('on the roles model: a role without the capability, a customer order\'s chosen price', () => {
  let org: any
  let orgId: string
  let clerkToken: string
  let typistToken: string
  let adminToken: string
  let product: string

  async function roleFor(user: IUser, name: string, caps: string[]): Promise<string> {
    const role: any = await Role.create({ orgId: org._id, name, caps, isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: [] } } as any)
    await User.updateOne({ _id: user._id }, { $set: { roleId: role._id } }).exec()
    forgetMember(user._id)
    forgetRole(role._id)
    return sign(await tokenize((await User.findById(user._id).exec())!))
  }

  const WORKS = ['sales-docs.view', 'sales-docs.create', 'sales-docs.edit', 'orders.view', 'orders.create', 'orders.edit', 'contacts.lookup', 'contacts.view', 'products.lookup', 'pricing.read']

  beforeAll(async () => {
    org = await createTestOrg({ slug: 'lines-724-roles' } as any)
    orgId = String(org._id)
    await seedDefaultPermissionSets(orgId)
    product = String((await createTestProduct(org._id, { name: 'Nut', sellingPrice: 2, unit: 'pcs', taxRate: 20, priceTiers: [{ name: 'Цена 3', percent: 0, finalPrice: 1.5, manualOverride: true }] } as any))._id)
    const clerk = await createTestUser(org._id, { role: 'member', username: 'clerk724' } as any)
    const typist = await createTestUser(org._id, { role: 'member', username: 'typist724' } as any)
    const admin = await createTestUser(org._id, { role: 'admin', username: 'admin724' } as any)
    await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: { orgId: org._id } })
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
    forgetAccessModel(orgId)
    clerkToken = await roleFor(clerk, 'Counter without typing', WORKS)
    typistToken = await roleFor(typist, 'Counter that types', [...WORKS, 'sales-docs.manual-price'])
    adminToken = await sign(await tokenize((await User.findById(admin._id).exec())!))
  }, 60_000)

  it('the role without it is refused a typed price; the same role with it is not', async () => {
    const contactId = await customer(org)
    const refused = await call(orgId, 'POST', '/invoices', clerkToken, invoiceBody(contactId, [{ productId: product, unitPrice: 1.7 }]))
    expect({ status: refused.status, code: refused.json?.code }).toEqual({ status: 403, code: 'price_not_offered' })
    expect((await call(orgId, 'POST', '/invoices', clerkToken, invoiceBody(contactId, [{ productId: product, unitPrice: 1.5 }]))).status).toBe(200)
    expect((await call(orgId, 'POST', '/invoices', typistToken, invoiceBody(contactId, [{ productId: product, unitPrice: 1.7 }]))).status).toBe(200)
  })

  const orderBody = (contactId: string, lines: Array<Record<string, unknown>>) => ({
    contactId, issueDate: '2026-11-12', requestedDeliveryDate: '2026-11-20',
    lines: lines.map(l => ({ productId: product, description: 'Nut', quantity: 4, ...l })),
  })

  it('a customer order: a CHOSEN price must be offered, an indication is not asked about', async () => {
    const contactId = await customer(org)
    const before = await InternalOrder.countDocuments({ orgId })
    const refused = await call(orgId, 'POST', '/invoicing/internal-orders', clerkToken, orderBody(contactId, [{ expectedUnitPrice: 1.7, pricePinned: true }]))
    expect({ status: refused.status, code: refused.json?.code, lines: refused.json?.lines }).toEqual({ status: 403, code: 'price_not_offered', lines: [{ line: 1, productId: product, unitPrice: 1.7 }] })
    expect(await InternalOrder.countDocuments({ orgId })).toBe(before)
    expect((await call(orgId, 'POST', '/invoicing/internal-orders', clerkToken, orderBody(contactId, [{ expectedUnitPrice: 1.5, pricePinned: true }]))).status).toBe(200)
    // Not pinned: the invoice is priced for the client when it is made, so the figure charges nothing.
    expect((await call(orgId, 'POST', '/invoicing/internal-orders', clerkToken, orderBody(contactId, [{ expectedUnitPrice: 1.7 }]))).status).toBe(200)
    expect((await call(orgId, 'POST', '/invoicing/internal-orders', typistToken, orderBody(contactId, [{ expectedUnitPrice: 1.7, pricePinned: true }]))).status).toBe(200)
  })

  it('a customer order saved back keeps a price somebody else chose; a new choice of it is held', async () => {
    const contactId = await customer(org)
    const made = await call(orgId, 'POST', '/invoicing/internal-orders', adminToken, orderBody(contactId, [{ expectedUnitPrice: 1.66, pricePinned: true }]))
    expect(made.status).toBe(200)
    const order = made.json.internalOrder
    const id = String(order._id)
    const line = order.lines[0]
    const back = await call(orgId, 'PUT', `/invoicing/internal-orders/${id}`, clerkToken, orderBody(contactId, [{ _id: String(line._id), expectedUnitPrice: 1.66, pricePinned: true, quantity: 6 }]))
    expect(back.status).toBe(200)
    const moved = await call(orgId, 'PUT', `/invoicing/internal-orders/${id}`, clerkToken, orderBody(contactId, [{ _id: String(line._id), expectedUnitPrice: 1.61, pricePinned: true }]))
    expect({ status: moved.status, code: moved.json?.code }).toEqual({ status: 403, code: 'price_not_offered' })

    // The invoice converted from it charges the order's price: that is no typed figure either.
    const invoice = await call(orgId, 'POST', '/invoices', clerkToken, invoiceBody(contactId, [
      { productId: product, unitPrice: 1.66, orderRef: { internalOrderId: id, internalOrderLineId: String(line._id) } },
    ], { internalOrderId: id }))
    expect(invoice.status).toBe(200)
  })
})

describe('at the till: no price is typed there, so a figure none of its prices is refused', () => {
  afterEach(() => forgetDevices())

  it('the Seller sells at the catalogue\'s price and at a price of the menu; another figure is refused before anything is drawn', async () => {
    const w = await tillWorld(tillApp(), { role: 'seller', device: false })
    const body = (unitPrice: number) => ({
      type: 'sale',
      lines: [{ productId: String(w.product._id), name: 'Bolt', quantity: 1, unitPrice, discount: 0, taxRate: 20, taxAmount: +(unitPrice * 0.2).toFixed(2), lineTotal: unitPrice }],
      subtotal: unitPrice, discountTotal: 0, taxTotal: +(unitPrice * 0.2).toFixed(2), total: +(unitPrice * 1.2).toFixed(2),
      payments: [{ method: 'cash', amount: +(unitPrice * 1.2).toFixed(2) }], changeDue: 0,
    })
    const sessionId = String(w.session.id ?? w.session._id)
    const before = await POSTransaction.countDocuments({ orgId: w.orgId })
    const refused = await w.call('POST', `/trade/pos/session/${sessionId}/transaction`, body(7))
    expect({ status: refused.status, code: refused.json?.code }).toEqual({ status: 403, code: 'price_not_offered' })
    expect(await POSTransaction.countDocuments({ orgId: w.orgId })).toBe(before)
    expect(await Invoice.countDocuments({ orgId: w.orgId, type: 'cash_sale' })).toBe(0)
    const sold = await w.call('POST', `/trade/pos/session/${sessionId}/transaction`, body(10))
    expect(sold.json?.code).not.toBe('price_not_offered')
    expect(sold.status).toBe(200)
  })

  it('a role that may type is not asked', async () => {
    const w = await tillWorld(tillApp(), { role: 'sales_consultant', device: false })
    const sessionId = String(w.session.id ?? w.session._id)
    const r = await w.call('POST', `/trade/pos/session/${sessionId}/transaction`, {
      type: 'sale',
      lines: [{ productId: String(w.product._id), name: 'Bolt', quantity: 1, unitPrice: 7, discount: 0, taxRate: 20, taxAmount: 1.4, lineTotal: 7 }],
      subtotal: 7, discountTotal: 0, taxTotal: 1.4, total: 8.4, payments: [{ method: 'cash', amount: 8.4 }], changeDue: 0,
    })
    expect(r.json?.code).not.toBe('price_not_offered')
    expect(r.status).toBe(200)
  })
})
