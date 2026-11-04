import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvite, createTestInvoice, createTestOrg, createTestStockMovement, createTestUser, createTestWarehouse } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { APP_IDS, DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Identity, PermissionSet, User, type IUser } from 'db/models'
import { sessionFor, tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { createPermissionSet, updatePermissionSet } from 'services/biz/permission-set.service'
import { getAvailableApps } from 'services/biz/app-hub.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { joinOrgByInvite } from 'services/biz/identity/account.service'
import { sellerPermissionSets } from '../../../migrations/src/migrations/0014-seller-permission-sets.js'
import { captureRejection } from '../helpers/capture-rejection'

/**
 * FR-26: the Seller and the Sales Consultant, end to end over the real route table.
 *
 * The roles' permissions are per module (invoicing, the till, inventory read and transfer), and
 * their areas carve Orders, bills, payments, prices, stock control and the Portal out of those
 * modules. What no route prefix can say is the controllers': an incoming document under
 * `/invoices`, an order link on an invoice, a movement that is not a transfer.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const sign = (claims: object): Promise<string> => (signer as any).decorator.jwt.sign(claims)

let app: Elysia
let orgId: string
let org: any
let warehouseA: string
let warehouseB: string
let contactId: string
let billId: string
let saleId: string
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}

async function request(method: string, path: string, token: string, body?: unknown) {
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
async function member(role: string, setName?: string): Promise<{ user: IUser; token: string }> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@fr26.test`
  const identity = await Identity.create({ email, firstName: 'F', lastName: role, isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
  const set = setName ? await PermissionSet.findOne({ orgId, name: setName }).lean() : null
  const user = await createTestUser(org._id, { role, email, identityId: identity._id, ...(set ? { permissionSetIds: [set._id] } : {}) } as any)
  const token = await sign(await sessionFor(user, identity))
  return { user, token }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg()
  orgId = String(org._id)
  await seedDefaultPermissionSets(orgId)
  warehouseA = String((await createTestWarehouse(org._id, { name: 'A', code: 'A' } as any))._id)
  warehouseB = String((await createTestWarehouse(org._id, { name: 'B', code: 'B' } as any))._id)
  contactId = String((await createTestContact(org._id))._id)
  billId = String((await createTestInvoice(org._id, contactId as any, { direction: 'incoming', status: 'received', invoiceNumber: 'BILL-1' } as any))._id)
  saleId = String((await createTestInvoice(org._id, contactId as any, { direction: 'outgoing', status: 'sent', invoiceNumber: 'INV-1' } as any))._id)
  for (const [role, set] of [['seller', 'Seller'], ['sales_consultant', 'Sales Consultant'], ['admin', 'Administrator'], ['sales', undefined]] as const) {
    const m = await member(role, set)
    people[role] = m.user
    tokens[role] = m.token
  }
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('the claim (tokenize)', () => {
  it('a role without sets: the Seller none, the Sales Consultant orders, every other role no claim', async () => {
    const plain = async (role: string) => tokenize(await createTestUser(org._id, { role } as any))
    expect((await plain('seller')).areas).toEqual([])
    expect((await plain('sales_consultant')).areas).toEqual(['orders'])
    for (const role of ['admin', 'manager', 'sales', 'member', 'warehouse_manager']) {
      expect('areas' in (await plain(role))).toBe(false)
    }
  })

  it('sets: absent is unrestricted, [] is none, several are their union, and an unrestricted or admin set wins', async () => {
    const ids = async (...names: string[]) => (await PermissionSet.find({ orgId, name: { $in: names } }).lean()).map(s => s._id)
    const on = async (...names: string[]) => tokenize(await createTestUser(org._id, { role: 'member', permissionSetIds: await ids(...names) } as any))
    expect((await on('Seller')).areas).toEqual([])
    expect((await on('Sales Consultant')).areas).toEqual(['orders'])
    expect((await on('Seller', 'Sales Consultant')).areas).toEqual(['orders'])
    expect('areas' in (await on('Seller', 'Manager'))).toBe(false)
    expect('areas' in (await on('Seller', 'Administrator'))).toBe(false)
    expect('areas' in (await on('Manager'))).toBe(false)
    expect((await on('Seller')).permissions).toContain('inventory.transfer')
  })

  it('every session path carries it: the session a sign-in issues names the areas', async () => {
    const claims = await sessionFor(people.seller, await Identity.findById(people.seller.identityId))
    expect(claims.areas).toEqual([])
    expect(typeof claims.iid).toBe('string')
  })
})

describe('the model: absent and [] are opposites', () => {
  it('a set saved without areas reads back without the key', async () => {
    const created = await createPermissionSet(orgId, { name: `plain-${Date.now()}`, permissions: ['invoicing.read'] })
    const raw = await mongoose.connection.db!.collection('permissionsets').findOne({ _id: created._id as any })
    expect(raw && 'areas' in raw).toBe(false)
    // And a save through the document, which is where Mongoose would add `[]`.
    const doc = await PermissionSet.findById(created._id)
    doc!.description = 'touched'
    await doc!.save()
    const again = await mongoose.connection.db!.collection('permissionsets').findOne({ _id: created._id as any })
    expect(again && 'areas' in again).toBe(false)
  })

  it('null unsets it, a list stores it, and an unknown area is refused', async () => {
    const created = await createPermissionSet(orgId, { name: `held-${Date.now()}`, permissions: ['invoicing.read'], areas: ['orders'] })
    expect((created as any).areas).toEqual(['orders'])
    const none = await updatePermissionSet(String(created._id), orgId, { areas: [] })
    expect((none as any).areas).toEqual([])
    const all = await updatePermissionSet(String(created._id), orgId, { areas: null })
    expect('areas' in (all as any)).toBe(false)
    const refused = await captureRejection(updatePermissionSet(String(created._id), orgId, { areas: ['everything'] }))
    expect(String(refused)).toContain('Unknown area')
  })
})

describe('incoming documents (purchases)', () => {
  it('the list is outgoing only, whatever it asks for', async () => {
    const { status, json } = await request('GET', '/invoices?direction=incoming', tokens.seller)
    expect(status).toBe(200)
    expect(json.invoices.map((i: any) => i.direction)).not.toContain('incoming')
    const admin = await request('GET', '/invoices?direction=incoming', tokens.admin)
    expect(admin.json.invoices.map((i: any) => String(i._id ?? i.id))).toContain(billId)
  })

  it('by id, an incoming document is not found, on every route', async () => {
    expect((await request('GET', `/invoices/${billId}`, tokens.seller)).status).toBe(404)
    expect((await request('PUT', `/invoices/${billId}`, tokens.seller, { notes: 'x' })).status).toBe(404)
    expect((await request('DELETE', `/invoices/${billId}`, tokens.seller)).status).toBe(404)
    expect((await request('POST', `/invoices/${billId}/void`, tokens.seller)).status).toBe(404)
    expect((await request('GET', `/invoicing/export/${billId}`, tokens.seller)).status).toBe(404)
    // Its own documents it reads.
    expect((await request('GET', `/invoices/${saleId}`, tokens.seller)).status).toBe(200)
    expect((await request('GET', `/invoices/${billId}`, tokens.admin)).status).toBe(200)
  })

  it('it makes none, exports none, imports none', async () => {
    const create = await request('POST', '/invoices', tokens.seller, { type: 'invoice', direction: 'incoming', contactId, issueDate: '2026-11-03', currency: 'EUR', lines: [], subtotal: 0, total: 0 })
    expect(create.status).toBe(403)
    expect(create.json.code).toBe('area_required')
    expect((await request('POST', '/invoicing/export/kind/incoming', tokens.seller, { format: 'xlsx', mode: 'compact' })).status).toBe(403)
    expect((await request('POST', '/invoicing/export/list', tokens.seller, { docType: 'invoice', direction: 'incoming', format: 'xlsx', mode: 'compact' })).status).toBe(403)
    expect((await request('POST', '/invoicing/export/list', tokens.seller, { docType: 'bill', format: 'xlsx', mode: 'compact' })).status).toBe(403)
    expect((await request('POST', '/doc-import/convert', tokens.seller, { target: 'bill', ids: [] })).status).toBe(403)
    expect((await request('GET', '/invoicing/bills/billable-receipts', tokens.seller)).status).toBe(403)
  })

  it("a contact's ledger and summary leave the bills out", async () => {
    const ledger = await getContactLedger(orgId, contactId, { outgoingOnly: true })
    expect(JSON.stringify(ledger)).not.toContain('BILL-1')
    const summary = await request('GET', `/invoicing/contact/${contactId}/summary`, tokens.seller)
    expect(summary.status).toBe(200)
    expect(summary.json.invoiceCount).toBe(1)
  })
})

describe('order links (orders)', () => {
  it('without the area, an invoice adds or changes no link; one it has saves unchanged', async () => {
    const orderRef = { orderId: '6a00000000000000000000f1', lineId: '6a00000000000000000000f2' }
    const line = { description: 'Linked', quantity: 1, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 2, lineTotal: 12, orderRef }
    const draft = await createTestInvoice(org._id, contactId as any, { lines: [line], invoiceNumber: 'DRF-LINK' } as any)
    const keep = await request('PUT', `/invoices/${draft._id}`, tokens.seller, { notes: 'kept', lines: [line] })
    expect(keep.status).not.toBe(403)
    const change = await request('PUT', `/invoices/${draft._id}`, tokens.seller, { lines: [{ ...line, orderRef: { orderId: '6a00000000000000000000f9' } }] })
    expect(change.status).toBe(403)
    expect(change.json.area).toBe('orders')
    expect((await request('PUT', `/invoices/${draft._id}`, tokens.seller, { orderId: '6a00000000000000000000f9' })).status).toBe(403)
    expect((await request('POST', '/invoices', tokens.seller, { type: 'invoice', direction: 'outgoing', contactId, issueDate: '2026-11-03', currency: 'EUR', internalOrderId: '6a00000000000000000000f9', lines: [], subtotal: 0, total: 0 })).status).toBe(403)
    // The Sales Consultant links.
    expect((await request('PUT', `/invoices/${draft._id}`, tokens.sales_consultant, { orderId: '6a00000000000000000000f9' })).status).not.toBe(403)
  })

  it('the order routes are the Sales Consultant\'s, not the Seller\'s', async () => {
    for (const rest of ['/invoicing/orders', '/invoicing/internal-orders', '/invoicing/reservations']) {
      const seller = await request('GET', rest, tokens.seller)
      expect({ rest, status: seller.status, code: seller.json?.code }).toEqual({ rest, status: 403, code: 'area_required' })
      expect({ rest, status: (await request('GET', rest, tokens.sales_consultant)).status }).toEqual({ rest, status: 200 })
    }
    // `sales`, an existing role, is unchanged.
    expect((await request('GET', '/invoicing/orders', tokens.sales)).status).toBe(200)
  })
})

describe('transfers only (FR-26.7)', () => {
  const lines = [{ productId: '6a00000000000000000000c1', quantity: 1, unitCost: 0, totalCost: 0 }]

  it('creates a transfer between two warehouses, and nothing else', async () => {
    const receipt = await request('POST', '/warehouse/movement', tokens.seller, { type: 'receipt', date: '2026-11-03', toWarehouseId: warehouseA, lines, totalAmount: 0 })
    expect(receipt.status).toBe(403)
    expect(receipt.json.code).toBe('transfer_only')
    const oneSided = await request('POST', '/warehouse/movement', tokens.seller, { type: 'transfer', date: '2026-11-03', fromWarehouseId: warehouseA, lines, totalAmount: 0 })
    expect(oneSided.status).toBe(422)
    const transfer = await request('POST', '/warehouse/movement', tokens.seller, { type: 'transfer', date: '2026-11-03', fromWarehouseId: warehouseA, toWarehouseId: warehouseB, lines, totalAmount: 0 })
    expect(transfer.status).toBe(200)
    const id = transfer.json.stockMovement.id ?? transfer.json.stockMovement._id
    expect((await request('DELETE', `/warehouse/movement/${id}`, tokens.seller)).status).toBe(200)
    expect((await request('POST', '/warehouse/movement/with-update', tokens.seller, { type: 'receipt', date: '2026-11-03', toWarehouseId: warehouseA, lines, totalAmount: 0 })).status).toBe(403)
  })

  it('edits, confirms and deletes no movement that is not a transfer', async () => {
    const receipt = await createTestStockMovement(org._id, { type: 'receipt', toWarehouseId: warehouseA } as any)
    expect((await request('PUT', `/warehouse/movement/${receipt._id}`, tokens.seller, { notes: 'x' })).status).toBe(403)
    expect((await request('POST', `/warehouse/movement/${receipt._id}/confirm`, tokens.seller, {})).status).toBe(403)
    expect((await request('DELETE', `/warehouse/movement/${receipt._id}`, tokens.seller)).status).toBe(403)
    // Whoever holds inventory.write still does.
    expect((await request('DELETE', `/warehouse/movement/${receipt._id}`, tokens.admin)).status).toBe(200)
  })
})

describe('prices, stock control, the portal, payments', () => {
  it('are refused to the Seller and open to an admin', async () => {
    for (const rest of ['/warehouse/price-list', '/warehouse/inventory-count', '/warehouse/cost-layer/valuation', '/invoicing/payment-order', '/invoicing/cash-order', '/dashboard/summary']) {
      const r = await request('GET', rest, tokens.seller)
      expect({ rest, status: r.status }).toEqual({ rest, status: 403 })
    }
    expect((await request('GET', '/warehouse/price-list', tokens.admin)).status).toBe(200)
  })

  it('what the kept pages need stays open', async () => {
    for (const rest of ['/warehouse/stock-level', '/invoicing/contact', '/warehouse/product', '/apps', '/user', '']) {
      const r = await request('GET', rest, tokens.seller)
      expect({ rest, status: r.status }).toEqual({ rest, status: 200 })
    }
  })
})

describe('reports need reports.read (FR-26.6)', () => {
  it('the catalog, a run and an export', async () => {
    expect((await request('GET', '/reports/catalog', tokens.seller)).status).toBe(403)
    expect((await request('POST', '/reports/sales-documents/run', tokens.seller, { params: {} })).status).toBe(403)
    expect((await request('POST', '/reports/sales-documents/export', tokens.seller, { params: {}, format: 'xlsx' })).status).toBe(403)
    expect((await request('GET', '/reports/catalog', tokens.sales)).status).toBe(200)
    expect((await request('GET', '/reports/catalog', tokens.admin)).status).toBe(200)
  })

  it("the aging report, the Reports app's page, too (#493)", async () => {
    const seller = await request('GET', '/invoicing/reports/aging', tokens.seller)
    expect(seller.status).toBe(403)
    expect(seller.json.permissions).toEqual(['reports.read'])
    expect((await request('GET', '/invoicing/reports/aging', tokens.sales)).status).toBe(200)
    expect((await request('GET', '/invoicing/reports/aging', tokens.admin)).status).toBe(200)
  })
})

describe("a receipt's bill (purchases, #493)", () => {
  it('a movement names no bill to a session without the area, and keeps a link to a sales document', async () => {
    const billed = await createTestStockMovement(org._id, { type: 'receipt', toWarehouseId: warehouseA, invoiceId: billId } as any)
    const reversal = await createTestStockMovement(org._id, { type: 'receipt', toWarehouseId: warehouseA, invoiceId: saleId } as any)

    const one = await request('GET', `/warehouse/movement/${billed._id}`, tokens.seller)
    expect(one.status).toBe(200)
    expect(one.json.stockMovement.invoiceId).toBeUndefined()
    expect(one.json.stockMovement.bill).toBeUndefined()
    expect(one.json.stockMovement.billable).toBe(false)
    expect(String((await request('GET', `/warehouse/movement/${reversal._id}`, tokens.seller)).json.stockMovement.invoiceId)).toBe(saleId)

    const list = await request('GET', '/warehouse/movement?size=100', tokens.seller)
    expect(list.status).toBe(200)
    const row = list.json.stockMovements.find((m: any) => String(m.id ?? m._id) === String(billed._id))
    expect(row).toBeDefined()
    expect(row.invoiceId).toBeUndefined()
    expect(row.bill).toBeUndefined()

    // An admin still sees the link.
    expect(String((await request('GET', `/warehouse/movement/${billed._id}`, tokens.admin)).json.stockMovement.invoiceId)).toBe(billId)
  })
})

describe('tags (#493)', () => {
  it('a tag is written with its module\'s write permission: a Seller tags contacts, not the catalog', async () => {
    const product = await request('POST', '/tags', tokens.seller, { type: 'product', value: `p-${Date.now()}` })
    expect(product.status).toBe(403)
    expect(product.json.permissions).toEqual(['inventory.write'])
    const contact = await request('POST', '/tags', tokens.seller, { type: 'contact', value: `c-${Date.now()}` })
    expect(contact.status).toBe(200)

    const made = await request('POST', '/tags', tokens.admin, { type: 'product', value: `shared-${Date.now()}` })
    expect(made.status).toBe(200)
    const id = made.json.tag._id ?? made.json.tag.id
    expect((await request('PUT', `/tags/${id}`, tokens.seller, { value: 'renamed' })).status).toBe(403)
    expect((await request('DELETE', `/tags/${id}`, tokens.seller)).status).toBe(403)
    expect((await request('DELETE', `/tags/${id}`, tokens.admin)).status).toBe(200)
  })
})

describe('the App Hub', () => {
  it('an admin gets every app, whatever its set says (FR-26.2)', async () => {
    const apps = await getAvailableApps(orgId, ['invoicing.read'], undefined, undefined, { role: 'admin' })
    expect(apps.map(a => a.id).sort()).toEqual([...APP_IDS].sort())
  })

  it('a Seller gets Invoicing and Inventory', async () => {
    const { json } = await request('GET', '/apps', tokens.seller)
    expect(json.apps.map((a: any) => a.id).sort()).toEqual(['inventory', 'invoicing'])
  })
})

describe('assigning a role takes effect (FR-26.9)', () => {
  it('a role change replaces the system set, keeps custom sets, and ends the sessions', async () => {
    const custom = await createPermissionSet(orgId, { name: `custom-${Date.now()}`, permissions: ['invoicing.read'] })
    const admins = await PermissionSet.findOne({ orgId, name: 'Administrator' }).lean()
    const { user, token } = await member('manager')
    await User.updateOne({ _id: user._id }, { permissionSetIds: [admins!._id, custom._id] })
    expect((await request('GET', '/apps', token)).status).toBe(200)

    const changed = await request('PUT', `/user/${user._id}`, tokens.admin, { role: 'seller' })
    expect(changed.status).toBe(200)
    const after = await User.findById(user._id).lean()
    const seller = await PermissionSet.findOne({ orgId, name: 'Seller' }).lean()
    expect(after!.permissionSetIds!.map(String).sort()).toEqual([String(custom._id), String(seller!._id)].sort())
    // ⚠ The custom set has no areas, so it is unrestricted and wins (§2.5): the Users screen warns of it.
    expect('areas' in (await tokenize(after as any))).toBe(false)
    await User.updateOne({ _id: user._id }, { permissionSetIds: [seller!._id] })
    expect((await tokenize((await User.findById(user._id).lean()) as any)).areas).toEqual([])
    // The session issued before the change is over.
    expect((await request('GET', '/apps', token)).status).toBe(401)
  })

  it('an edit that changes nothing of the grant leaves the sessions alone', async () => {
    const { user, token } = await member('seller', 'Seller')
    expect((await request('PUT', `/user/${user._id}`, tokens.admin, { position: 'Counter' })).status).toBe(200)
    expect((await request('GET', '/apps', token)).status).toBe(200)
  })

  it("an accepted invite gets the role's set, not the org's default", async () => {
    const identity = await Identity.create({ email: `invitee-${Date.now()}@fr26.test`, firstName: 'I', lastName: 'N', isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
    const invite = await createTestInvite(org._id, people.admin._id as any, { assignRole: 'seller' } as any)
    const { member: joined } = await joinOrgByInvite(identity._id, invite.code)
    const seller = await PermissionSet.findOne({ orgId, name: 'Seller' }).lean()
    expect(joined.permissionSetIds!.map(String)).toEqual([String(seller!._id)])
  })

  it("an org without the role's set gives none: never the default set, which opens Accounting", async () => {
    const bare = await createTestOrg()
    await seedDefaultPermissionSets(String(bare._id))
    await PermissionSet.deleteMany({ orgId: bare._id, name: { $in: ['Seller', 'Sales Consultant'] } })
    const inviter = await createTestUser(bare._id, { role: 'admin' } as any)
    const identity = await Identity.create({ email: `bare-${Date.now()}@fr26.test`, firstName: 'B', lastName: 'R', isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
    const invite = await createTestInvite(bare._id, inviter._id as any, { assignRole: 'seller' } as any)
    const { member: joined } = await joinOrgByInvite(identity._id, invite.code)
    expect(joined.permissionSetIds ?? []).toEqual([])
    const claims = await tokenize(joined)
    expect(claims.areas).toEqual([])
    expect(claims.permissions).not.toContain('accounting.read')
  })

  it('a role with no system set (sales, hr_manager) is invited onto its own defaults, as a role change gives', async () => {
    for (const [role, needed] of [['sales', 'invoicing.write'], ['hr_manager', 'payroll.read']] as const) {
      const identity = await Identity.create({ email: `${role}-${Date.now()}@fr26.test`, firstName: 'I', lastName: 'N', isActive: true, passwordSetBy: 'self', password: await Bun.password.hash('test123') } as any)
      const invite = await createTestInvite(org._id, people.admin._id as any, { assignRole: role } as any)
      const { member: joined } = await joinOrgByInvite(identity._id, invite.code)
      expect(joined.permissionSetIds ?? []).toEqual([])
      const claims = await tokenize(joined)
      expect(claims.permissions).toContain(needed)
      expect([...claims.permissions].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS[role]].sort())
    }
  })
})

describe('the migration (0014)', () => {
  it('seeds both sets where they are missing, is idempotent, and reports a set somebody made', async () => {
    const db = mongoose.connection.db!
    const target = await createTestOrg()
    await createPermissionSet(String(target._id), { name: 'Seller', permissions: ['invoicing.read'] })
    const lines = await sellerPermissionSets.preview!({ db, log: () => {}, orgFilter: { orgId: target._id } })
    expect(lines.join('\n')).toContain('"Seller" exists and is not a system set')
    expect(lines.join('\n')).toContain('seed Sales Consultant')

    const log: string[] = []
    await sellerPermissionSets.up({ db, log: m => log.push(m), orgFilter: { orgId: target._id } })
    await sellerPermissionSets.up({ db, log: m => log.push(m), orgFilter: { orgId: target._id } })
    const sets = await PermissionSet.find({ orgId: target._id }).lean()
    const consultant = sets.find(s => s.name === 'Sales Consultant')!
    expect(consultant.isSystem).toBe(true)
    expect(consultant.areas).toEqual(['orders'])
    expect(consultant.permissions).toContain('inventory.transfer')
    // The one somebody made is left as it was.
    const theirs = sets.find(s => s.name === 'Seller')!
    expect(theirs.isSystem).toBe(false)
    expect(theirs.permissions).toEqual(['invoicing.read'])
    expect(sets.filter(s => s.name === 'Sales Consultant')).toHaveLength(1)
    expect(log.filter(l => l.startsWith('seeded'))).toEqual(['seeded 1 permission set(s)', 'seeded 0 permission set(s)'])
  })
})
