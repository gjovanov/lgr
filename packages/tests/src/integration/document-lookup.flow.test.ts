import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Contact, InternalOrder, Invoice, Order, Org, Reservation, Role, StockMovement, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'
import type { CapabilityId } from 'config/access'
import { LOOKUP_LIMIT, type LookupAnswer } from 'config/document-lookup'

/**
 * FR-31.22 (#796, slice B5) — jump to a document by its number: `GET /org/:orgId/lookup/documents?number=…`.
 *
 * The number matches exactly (the document's number, in any case, or the draft number an issued one had), then as a
 * prefix; over invoices of every type, supplier and customer orders, reservations and movements. Another org's number
 * is never found, nor a document of a family the caller may not open. And its explain: every query the lookup runs
 * reads through an index, never the collection (read off the database's profiler, as `list-plans.flow` does).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const oid = () => new mongoose.Types.ObjectId()
const db = () => mongoose.connection.db!

let app: Elysia
let org: any
let orgId: string
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

async function lookup(number: string, who = 'admin'): Promise<{ status: number; json: LookupAnswer }> {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/lookup/documents?number=${encodeURIComponent(number)}`, {
    headers: { authorization: `Bearer ${tokens[who]}` },
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const numbers = (a: LookupAnswer) => a.matches.map(m => m.number)

async function giveRole(key: string, name: string, caps: CapabilityId[]) {
  const role: any = await Role.create({ orgId: org._id, name, caps, isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: [] } } as any)
  await User.updateOne({ _id: people[key]._id }, { $set: { roleId: role._id } }).exec()
  forgetMember(people[key]._id)
  forgetRole(role._id)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'document-lookup' } as any)
  orgId = String(org._id)
  for (const key of ['admin', 'seller', 'storekeeper']) {
    people[key] = await createTestUser(org._id, { role: key === 'admin' ? 'admin' : 'member', username: `lookup-${key}`, email: `${key}@lookup.test` } as any)
  }
  // The indexes exist before the rows go in, as on a server.
  for (const m of [Invoice, Order, InternalOrder, Reservation, StockMovement, Contact] as any[]) await m.createIndexes()

  const other = oid()
  const contact = oid()
  await Contact.collection.insertMany([{ _id: contact, orgId: org._id, type: 'customer', companyName: 'Demo Customer Ltd', addresses: [], bankDetails: [] }] as any[])
  const day = (d: number) => new Date(Date.UTC(2026, 0, d))
  const invoice = (number: string, extra: Record<string, unknown> = {}) => ({
    _id: oid(), orgId: org._id, invoiceNumber: number, type: 'invoice', direction: 'outgoing', status: 'sent', contactId: contact,
    issueDate: day(5), dueDate: day(30), currency: 'EUR', lines: [], payments: [], tags: [], ...extra,
  })
  const docs = {
    sale: invoice('INV-2026-00001'),
    // Issued from a draft: found by the draft number it had too.
    issued: invoice('INV-2026-00002', { draftNumber: 'DRF-INV-2026-00007' }),
    draft: invoice('DRF-INV-2026-00008', { status: 'draft' }),
    note: invoice('INV-2026-00003', { type: 'credit_note' }),
    proforma: invoice('PRF-2026-00001', { type: 'proforma' }),
    bill: invoice('BILL-2026-00001', { direction: 'incoming' }),
    cash: invoice('CS-2026-00001', { type: 'cash_sale', register: { origin: 'pos' } }),
  }
  await Invoice.collection.insertMany([
    ...Object.values(docs),
    // Another org's documents, numbered as ours are not.
    { ...invoice('OTHER-2026-00001'), orgId: other },
  ] as any[])
  for (const [k, d] of Object.entries(docs)) ids[k] = String(d._id)

  const supplierOrder = { _id: oid(), orgId: org._id, orderNumber: 'SHARED-1', status: 'sent', issueDate: day(6), supplierGroups: [{ supplierId: contact, lines: [] }] }
  const issuedOrder = { _id: oid(), orgId: org._id, orderNumber: 'ORDO-2026-00002', draftNumber: 'DRF-ORDO-2026-00004', status: 'sent', issueDate: day(7), supplierGroups: [] }
  await Order.collection.insertMany([supplierOrder, issuedOrder] as any[])
  ids.supplierOrder = String(supplierOrder._id)
  const customerOrder = { _id: oid(), orgId: org._id, orderNumber: 'ORDI-2026-00001', status: 'confirmed', contactId: contact, issueDate: day(8), requestedDeliveryDate: day(9), lines: [] }
  await InternalOrder.collection.insertMany([customerOrder] as any[])
  ids.customerOrder = String(customerOrder._id)
  const reservation = { _id: oid(), orgId: org._id, reservationNumber: 'RES-2026-00001', status: 'active', contactId: contact, source: 'stock', quantity: 1, createdAt: day(10) }
  await Reservation.collection.insertMany([reservation] as any[])
  ids.reservation = String(reservation._id)
  // More movements than the lookup lists, one of them sharing a supplier order's number.
  const movements = Array.from({ length: LOOKUP_LIMIT + 5 }, (_, i) => ({
    _id: oid(), orgId: org._id, movementNumber: `SM-2026-${String(i + 1).padStart(5, '0')}`, type: 'receipt', status: 'confirmed', date: day(11), lines: [],
  }))
  const sharedMovement = { _id: oid(), orgId: org._id, movementNumber: 'SHARED-1', type: 'transfer', status: 'confirmed', date: day(12), lines: [] }
  await StockMovement.collection.insertMany([...movements, sharedMovement] as any[])
  ids.movement = String(movements[0]!._id)
  ids.sharedMovement = String(sharedMovement._id)

  await rolesFromSets.up({ db: db() as any, log: () => {}, orgFilter: {} })
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  // Sales documents only: no bills, no till documents, no orders, no movements.
  await giveRole('seller', 'Lookup seller', ['sales-docs.view', 'sales-docs.create'] as CapabilityId[])
  // Movements only.
  await giveRole('storekeeper', 'Lookup storekeeper', ['movements.view', 'movements.create'] as CapabilityId[])
  for (const key of Object.keys(people)) tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!))
}, 60_000)

/** The profiler off and its collection gone: the test database is the process's, and a later file sweeps every collection. */
async function profilerOff() {
  await db().command({ profile: 0 }).catch(() => { /* the profiler may never have been on */ })
  await db().collection('system.profile').drop().catch(() => { /* none */ })
}

afterAll(async () => {
  await profilerOff()
  await teardownTestDB()
}, 60_000)

describe('FR-31.22: a number finds its document', () => {
  it('exactly, whatever its case, with the date and the contact', async () => {
    const r = await lookup('INV-2026-00001')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ number: 'INV-2026-00001', exact: true, more: false })
    expect(r.json.matches).toEqual([
      { family: 'sales', id: ids.sale, number: 'INV-2026-00001', type: 'invoice', status: 'sent', date: new Date(Date.UTC(2026, 0, 5)).toISOString(), contactName: 'Demo Customer Ltd' },
    ])
    expect(numbers((await lookup('  inv-2026-00001 ')).json)).toEqual(['INV-2026-00001'])
  })

  it('an exact match wins over the numbers it begins', async () => {
    // SM-2026-00001 is also the start of nothing longer, and SM-2026-0001 begins ten numbers: an exact one is one.
    const r = (await lookup('SM-2026-00001')).json
    expect(r.exact).toBe(true)
    expect(numbers(r)).toEqual(['SM-2026-00001'])
    expect((await lookup('SM-2026-0001')).json.matches.length).toBe(10)
  })

  it('an issued document by the draft number it had; a draft by its own', async () => {
    const issued = (await lookup('DRF-INV-2026-00007')).json
    expect(issued.exact).toBe(true)
    expect(issued.matches).toHaveLength(1)
    expect(issued.matches[0]).toMatchObject({ family: 'sales', id: ids.issued, number: 'INV-2026-00002', draftNumber: 'DRF-INV-2026-00007' })
    expect(numbers((await lookup('DRF-INV-2026-00008')).json)).toEqual(['DRF-INV-2026-00008'])
    // An order too.
    expect((await lookup('drf-ordo-2026-00004')).json.matches[0]).toMatchObject({ family: 'supplierOrder', number: 'ORDO-2026-00002', draftNumber: 'DRF-ORDO-2026-00004' })
  })

  it('every family, each with what opens it', async () => {
    const one = async (n: string) => (await lookup(n)).json.matches
    expect(await one('INV-2026-00003')).toMatchObject([{ family: 'sales', type: 'credit_note' }])
    expect(await one('PRF-2026-00001')).toMatchObject([{ family: 'proforma', type: 'proforma' }])
    expect(await one('BILL-2026-00001')).toMatchObject([{ family: 'bill' }])
    expect(await one('CS-2026-00001')).toMatchObject([{ family: 'cash', type: 'cash_sale', origin: 'pos' }])
    expect(await one('ORDI-2026-00001')).toMatchObject([{ family: 'customerOrder', id: ids.customerOrder, contactName: 'Demo Customer Ltd' }])
    expect(await one('RES-2026-00001')).toMatchObject([{ family: 'reservation', id: ids.reservation }])
    expect(await one('SM-2026-00001')).toMatchObject([{ family: 'movement', id: ids.movement, type: 'receipt' }])
  })

  it('a number several documents carry lists them all', async () => {
    const r = (await lookup('SHARED-1')).json
    expect(r.exact).toBe(true)
    expect(r.matches.map(m => `${m.family}:${m.id}`).sort()).toEqual([`movement:${ids.sharedMovement}`, `supplierOrder:${ids.supplierOrder}`].sort())
    expect(r.matches.find(m => m.family === 'supplierOrder')?.contactName).toBe('Demo Customer Ltd')
  })

  it('as a prefix when nothing matches exactly, at most the limit, saying there are more', async () => {
    const few = (await lookup('inv-2026-0000')).json
    expect(few.exact).toBe(false)
    expect(numbers(few)).toEqual(['INV-2026-00001', 'INV-2026-00002', 'INV-2026-00003'])
    const many = (await lookup('SM-2026')).json
    expect(many.exact).toBe(false)
    expect(many.matches).toHaveLength(LOOKUP_LIMIT)
    expect(many.more).toBe(true)
    expect(numbers(many)[0]).toBe('SM-2026-00001')
    // A pattern's own characters are only characters.
    expect((await lookup('SM-.*')).json.matches).toEqual([])
  })

  it('a number nothing carries, an empty one, and another org\'s', async () => {
    expect((await lookup('NOPE-1')).json).toEqual({ number: 'NOPE-1', exact: false, matches: [], more: false })
    expect((await lookup('   ')).json.matches).toEqual([])
    expect((await lookup('OTHER-2026-00001')).json.matches).toEqual([])
    expect((await lookup('OTHER')).json.matches).toEqual([])
  })
})

describe('FR-31.22: a document the caller may not open is not found', () => {
  it('a role of the sales documents finds them, and no bill, till document, order, reservation or movement', async () => {
    expect(numbers((await lookup('INV-2026-00001', 'seller')).json)).toEqual(['INV-2026-00001'])
    expect(numbers((await lookup('DRF-INV-2026-00007', 'seller')).json)).toEqual(['INV-2026-00002'])
    for (const n of ['BILL-2026-00001', 'CS-2026-00001', 'PRF-2026-00001', 'SHARED-1', 'ORDI-2026-00001', 'RES-2026-00001', 'SM-2026-00001', 'SM-2026']) {
      expect({ n, matches: (await lookup(n, 'seller')).json.matches }).toEqual({ n, matches: [] })
    }
  })

  it('a role of the movements finds only movements', async () => {
    expect((await lookup('SHARED-1', 'storekeeper')).json.matches.map(m => m.family)).toEqual(['movement'])
    expect((await lookup('INV-2026-00001', 'storekeeper')).json.matches).toEqual([])
    expect((await lookup('INV', 'storekeeper')).json.matches).toEqual([])
  })

  it('an anonymous caller is refused', async () => {
    const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/lookup/documents?number=INV`))
    expect(res.status).toBe(401)
  })
})

describe('FR-31.22: the lookup reads through the numbers\' indexes', () => {
  it('no query of any lookup scans a collection', async () => {
    const collections = [Invoice, Order, InternalOrder, Reservation, StockMovement, Contact].map(m => m.collection.collectionName)
    await db().command({ profile: 0 })
    await db().collection('system.profile').drop().catch(() => { /* none yet */ })
    await db().command({ profile: 2 })
    try {
      // Exact, by a draft number, several, a prefix, none, and for a role of one family.
      for (const n of ['INV-2026-00001', 'DRF-INV-2026-00007', 'SHARED-1', 'inv-2026-0000', 'SM-2026', 'NOPE-1']) await lookup(n)
      await lookup('INV-2026', 'seller')
    } finally {
      await db().command({ profile: 0 })
    }
    const ops = (await db().collection('system.profile').find({ op: 'query', ns: { $in: collections.map(c => `${db().databaseName}.${c}`) } }).toArray()) as any[]
    await profilerOff()
    // The lookup did ask every family (and the contacts).
    const asked = new Set(ops.map(o => String(o.ns).split('.').slice(1).join('.')))
    expect([...asked].sort()).toEqual([...collections].sort())
    const scans = ops.filter(o => !o.planSummary || /COLLSCAN/.test(o.planSummary)).map(o => `${o.ns}: ${o.planSummary} ${JSON.stringify(o.command?.filter)}`)
    expect(scans).toEqual([])
    // The draft numbers went through their own index.
    expect(ops.some(o => /IXSCAN \{ orgId: 1, draftNumber: 1 \}/.test(o.planSummary ?? ''))).toBe(true)
  })
})
