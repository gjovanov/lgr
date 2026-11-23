import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel } from '../helpers/factories'
import { invoiceController } from 'api/src/invoicing/controllers/invoice.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { confirmMovement } from 'services/biz/warehouse.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Invoice, Product, Sequence, StockLevel, StockMovement } from 'db/models'
import { countIssueLeftovers } from '../../../../scripts/count-issue-leftovers'

/**
 * FR-29 slice B (#794): one issue service behind `/send` and `/receive` (`issueDocument`).
 *
 * The stock, the issued number and the status are one transaction. Before:
 * - `/send` booked, drew and wrote one after the other, and a retry skipped the booking whenever a
 *   movement carrying the invoice's id existed, draft or not. §1.2: Issue answers an error, the levels
 *   are already at 97 / 96 and a draft movement is left; Issue again answers 200 with the movement
 *   still a draft; that draft, confirmed later, takes the levels to 94 / 92.
 * - `/receive` wrote the bill as received first and booked after, so a booking that failed left a
 *   received bill with none or part of its stock, and no route retried it.
 *
 * FR-29.8 one service; FR-29.9 a retry finishes what an earlier attempt left; FR-29.10 a failed
 * receive is the draft it was; FR-29.11 the number is drawn last, and two issues at once both get
 * one; FR-29.12 the read-only count of what production holds (`scripts/count-issue-leftovers.ts`).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(invoiceController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const OBJECT_ID = /\b[0-9a-f]{24}\b/i

/** Two articles at 100 in a store (§1.1's): a nut and a bolt, both on average cost to begin with. */
async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const customer = await createTestContact(org._id, { companyName: 'Customer Ltd', type: 'customer' } as any)
  const supplier = await createTestContact(org._id, { companyName: 'Supplier Ltd', type: 'supplier' } as any)
  const main = await createTestWarehouse(org._id, { name: 'Main store', isDefault: true } as any)
  const back = await createTestWarehouse(org._id, { name: 'Back store' } as any)
  const nut = await createTestProduct(org._id, { sku: 'NUT-01', name: 'Nut M8', purchasePrice: 2, sellingPrice: 4, taxRate: 20 } as any)
  const bolt = await createTestProduct(org._id, { sku: 'BOLT-01', name: 'Bolt M8', purchasePrice: 5, sellingPrice: 9, taxRate: 20 } as any)
  for (const p of [nut, bolt]) for (const w of [main, back]) {
    await createTestStockLevel(org._id, p._id, w._id, { quantity: 100, availableQuantity: 100, avgCost: Number(p.purchasePrice) })
  }
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** A draft document, as the form saves one: `[product, warehouse, quantity]` per line. */
  async function draft(direction: 'outgoing' | 'incoming', lines: Array<[any, any, number]>) {
    const ls = lines.map(([p, wh, quantity]) => ({
      productId: String(p._id), warehouseId: String(wh._id), description: p.name, quantity, unit: 'pcs', unitPrice: 10, taxRate: 20,
    }))
    const subtotal = ls.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
    const res = await call('POST', '/invoices', {
      type: 'invoice', direction, contactId: String(direction === 'outgoing' ? customer._id : supplier._id),
      issueDate: '2026-11-16', currency: 'EUR', lines: ls, subtotal, total: +(subtotal * 1.2).toFixed(2),
    })
    expect(res.status).toBe(200)
    return String(res.json.invoice.id || res.json.invoice._id)
  }

  /** A movement carrying the document's id, as an earlier attempt of an older release left it. */
  async function leftover(invoiceId: string, type: 'dispatch' | 'receipt', warehouse: any, lines: Array<[any, number]>, opts: { confirm?: boolean; claimed?: boolean } = {}) {
    const m = await StockMovement.create({
      orgId: org._id, movementNumber: `SM-OLD-${Math.random().toString(36).slice(2, 8)}`, type, status: 'draft',
      date: new Date('2026-11-16'), invoiceId: new mongoose.Types.ObjectId(invoiceId), createdBy: user._id,
      ...(type === 'dispatch' ? { fromWarehouseId: warehouse._id } : { toWarehouseId: warehouse._id }),
      lines: lines.map(([p, quantity]) => ({ productId: p._id, quantity, unitCost: 10, totalCost: quantity * 10 })),
      totalAmount: 0,
      ...(opts.claimed ? { claimedUntil: new Date(Date.now() + 60_000) } : {}),
    })
    if (opts.confirm) await confirmMovement(String(m._id))
    return String(m._id)
  }

  const level = async (p: any, w: any = main) =>
    Number(((await StockLevel.findOne({ orgId, productId: p._id, warehouseId: w._id }).lean().exec()) as any)?.quantity)
  const doc = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>
  const movementsOf = (id: string) => StockMovement.find({ orgId, invoiceId: id }).lean().exec() as Promise<any[]>

  return { org, orgId, user, main, back, nut, bolt, call, draft, leftover, level, doc, movementsOf }
}

describe('FR-29.9: a failed issue moves nothing, and the retry issues it with the goods moved once (§1.2)', () => {
  it('Issue refused for its cost layers; fixed; Issue again: one completed movement, levels 97 / 96', async () => {
    const w = await world()
    const id = await w.draft('outgoing', [[w.nut, w.main, 3], [w.bolt, w.main, 4]])
    const drafted = (await w.doc(id)).invoiceNumber
    // §1.1's trigger: the bolt goes FIFO with stock on hand and no layer.
    await Product.updateOne({ _id: w.bolt._id }, { $set: { costingMethod: 'fifo' } }).exec()

    const refused = await w.call('POST', `/invoices/${id}/send`, {})
    // FR-29.32: a cost-layer refusal is the one answer that changes: a 422 with its code, naming the article.
    expect(refused.status).toBe(422)
    expect(refused.json).toMatchObject({ code: 'no_cost_layer', product: 'Bolt M8', sku: 'BOLT-01', warehouse: 'Main store' })
    expect(JSON.stringify(refused.json)).not.toMatch(OBJECT_ID)

    expect([await w.level(w.nut), await w.level(w.bolt)]).toEqual([100, 100])
    expect(await w.movementsOf(id)).toEqual([])
    const after = await w.doc(id)
    expect(after.status).toBe('draft')
    expect(after.invoiceNumber).toBe(drafted)
    expect(after.issue ?? null).toBeNull()

    await Product.updateOne({ _id: w.bolt._id }, { $set: { costingMethod: 'wac' } }).exec()
    const issued = await w.call('POST', `/invoices/${id}/send`, {})
    expect(issued.status).toBe(200)
    expect(issued.json.invoice.status).toBe('sent')
    expect(issued.json.invoice.invoiceNumber).not.toBe(drafted)

    const movements = await w.movementsOf(id)
    expect(movements.map(m => m.status)).toEqual(['completed'])
    expect([await w.level(w.nut), await w.level(w.bolt)]).toEqual([97, 96])
  })

  it('a draft movement an older release left is booked afresh, never skipped', async () => {
    const w = await world()
    const id = await w.draft('outgoing', [[w.nut, w.main, 3], [w.bolt, w.main, 4]])
    const old = await w.leftover(id, 'dispatch', w.main, [[w.nut, 3], [w.bolt, 4]])

    const issued = await w.call('POST', `/invoices/${id}/send`, {})
    expect(issued.status).toBe(200)

    const movements = await w.movementsOf(id)
    expect(movements.map(m => m.status)).toEqual(['completed'])
    expect(movements.some(m => String(m._id) === old)).toBe(false)
    expect([await w.level(w.nut), await w.level(w.bolt)]).toEqual([97, 96])
  })

  it('a warehouse an older attempt booked stands; only the other one books now', async () => {
    const w = await world()
    const id = await w.draft('outgoing', [[w.nut, w.main, 3], [w.bolt, w.back, 4]])
    await w.leftover(id, 'dispatch', w.main, [[w.nut, 3]], { confirm: true })
    expect(await w.level(w.nut)).toBe(97)

    const issued = await w.call('POST', `/invoices/${id}/send`, {})
    expect(issued.status).toBe(200)

    const movements = await w.movementsOf(id)
    expect(movements.map(m => m.status).sort()).toEqual(['completed', 'completed'])
    expect(await w.level(w.nut)).toBe(97) // not booked a second time
    expect(await w.level(w.bolt, w.back)).toBe(96)
  })

  it('a leftover draft somebody is confirming from the list right now: 409, and nothing is issued', async () => {
    const w = await world()
    const id = await w.draft('outgoing', [[w.nut, w.main, 3]])
    await w.leftover(id, 'dispatch', w.main, [[w.nut, 3]], { claimed: true })

    const res = await w.call('POST', `/invoices/${id}/send`, {})
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('movement_busy')
    expect((await w.doc(id)).status).toBe('draft')
    expect(await w.level(w.nut)).toBe(100)
  })
})

describe('FR-29.10: a receive whose booking fails is the draft bill it was', () => {
  it('no number drawn, its draft number kept, and Receive works again', async () => {
    const w = await world()
    const id = await w.draft('incoming', [[w.nut, w.main, 5]])
    const drafted = (await w.doc(id)).invoiceNumber
    // An older attempt's draft receipt that somebody is confirming from the list: the booking fails.
    const old = await w.leftover(id, 'receipt', w.main, [[w.nut, 5]], { claimed: true })
    const countersBefore = await Sequence.find({ orgId: w.orgId }).lean().exec()

    const refused = await w.call('POST', `/invoices/${id}/receive`, {})
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('movement_busy')
    const after = await w.doc(id)
    expect(after.status).toBe('draft')
    expect(after.invoiceNumber).toBe(drafted)
    expect(after.issue ?? null).toBeNull()
    expect(await w.level(w.nut)).toBe(100)
    // FR-29.11: a failed issue draws no number.
    const countersAfter = await Sequence.find({ orgId: w.orgId }).lean().exec()
    expect(countersAfter.map((s: any) => [s.prefix, s.year, s.lastNumber])).toEqual(countersBefore.map((s: any) => [s.prefix, s.year, s.lastNumber]))

    // The confirm from the list went away without finishing: its claim is released.
    await StockMovement.updateOne({ _id: old }, { $set: { claimedUntil: null } }).exec()
    const received = await w.call('POST', `/invoices/${id}/receive`, {})
    expect(received.status).toBe(200)
    expect(received.json.invoice.status).toBe('received')
    expect((await w.movementsOf(id)).map(m => m.status)).toEqual(['completed'])
    expect(await w.level(w.nut)).toBe(105)
  })

  it('two Receives at once: one receives, the other is told, and the goods arrive once', async () => {
    const w = await world()
    const id = await w.draft('incoming', [[w.nut, w.main, 5]])
    const answers = await Promise.all([w.call('POST', `/invoices/${id}/receive`, {}), w.call('POST', `/invoices/${id}/receive`, {})])
    expect(answers.map(a => a.status).sort()).toEqual([200, 409])
    expect(answers.find(a => a.status === 409)!.json.code).toBe('bill_not_draft')
    expect(await w.level(w.nut)).toBe(105)
    expect((await w.movementsOf(id)).map(m => m.status)).toEqual(['completed'])
  })
})

describe('FR-29.8: a document into two warehouses is one transaction with two movements', () => {
  it('a bill received into two warehouses, and an invoice issued out of two: a movement each, each its own number', async () => {
    const w = await world()
    const bill = await w.draft('incoming', [[w.nut, w.main, 5], [w.bolt, w.back, 2]])
    const received = await w.call('POST', `/invoices/${bill}/receive`, {})
    expect(received.status).toBe(200)
    const sale = await w.draft('outgoing', [[w.nut, w.main, 3], [w.bolt, w.back, 1]])
    const sent = await w.call('POST', `/invoices/${sale}/send`, {})
    expect(sent.status).toBe(200)

    for (const id of [bill, sale]) {
      const movements = await w.movementsOf(id)
      expect(movements.map(m => m.status)).toEqual(['completed', 'completed'])
      expect(new Set(movements.map(m => m.movementNumber)).size).toBe(2)
    }
    expect(await w.level(w.nut)).toBe(102)
    expect(await w.level(w.bolt, w.back)).toBe(101)
  })
})

describe('FR-29.11: the number is drawn last', () => {
  it('two issues at once in one org both succeed, each with its own number', async () => {
    const w = await world()
    const a = await w.draft('outgoing', [[w.nut, w.main, 3]])
    const b = await w.draft('outgoing', [[w.nut, w.main, 4], [w.bolt, w.main, 1]])

    const answers = await Promise.all([w.call('POST', `/invoices/${a}/send`, {}), w.call('POST', `/invoices/${b}/send`, {})])
    expect(answers.map(x => x.status)).toEqual([200, 200])
    const numbers = answers.map(x => x.json.invoice.invoiceNumber)
    expect(new Set(numbers).size).toBe(2)
    expect(await w.level(w.nut)).toBe(93)
    expect(await w.level(w.bolt)).toBe(99)
    for (const id of [a, b]) expect((await w.movementsOf(id)).map(m => m.status)).toEqual(['completed'])
  })
})

describe('FR-29.12: the read-only count of what an older release left', () => {
  it('counts an issued document with a draft movement, and a draft with a booked one', async () => {
    const w = await world()
    const issued = await w.draft('outgoing', [[w.nut, w.main, 1]])
    await Invoice.updateOne({ _id: issued }, { $set: { status: 'sent' } }).exec()
    await w.leftover(issued, 'dispatch', w.main, [[w.nut, 1]])
    const half = await w.draft('outgoing', [[w.bolt, w.main, 2]])
    await w.leftover(half, 'dispatch', w.main, [[w.bolt, 2]], { confirm: true })
    await w.draft('outgoing', [[w.nut, w.main, 1]]) // an ordinary draft: nothing to count

    const before = await StockMovement.countDocuments({ orgId: w.orgId })
    const found = await countIssueLeftovers(mongoose.connection.db as any)
    expect(found).toHaveLength(1)
    expect(found[0].slug).toBe(String(w.org.slug))
    expect(found[0].issuedWithDraftMovement.map(r => r.documentId)).toEqual([issued])
    expect(found[0].draftWithBookedMovement.map(r => r.documentId)).toEqual([half])
    // It wrote nothing.
    expect(await StockMovement.countDocuments({ orgId: w.orgId })).toBe(before)
  })
})
