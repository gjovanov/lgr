import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestContact, createTestOrg, createTestProduct, createTestUser, createTestWarehouse } from '../helpers/factories'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { docImportController } from 'invoicing-api/src/controllers/doc-import.controller'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { receiptBillController } from 'invoicing-api/src/controllers/receipt-bill.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { confirmMovement } from 'services/biz/warehouse.service'
import { createInvoiceStockMovement, reverseInvoiceStockMovement } from 'services/biz/invoicing.service'
import { importMovement } from 'services/biz/move/fenced-import.service'
import { getRepos } from 'services/context'
import { movementWarehouseRefusal, unusedWarehouseSide } from 'config/movement-warehouses'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { Invoice, StockLevel, StockMovement } from 'db/models'

/**
 * A movement's warehouses must fit its type (#168).
 *
 * `confirmMovement` ignores `type`: it subtracts from `fromWarehouseId` and adds to `toWarehouseId`.
 * So a `dispatch` naming only a To warehouse ADDED stock, and the form made that easy: a new movement
 * starts as a receipt with its To warehouse filled, and changing the type left it there.
 *
 * The rule stands at the doors a user comes through. It is deliberately not inside `confirmMovement`,
 * which also replays what a site already booked: the last block here pins that.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(movementController).use(docImportController).use(invoiceController).use(receiptBillController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const oid = () => new mongoose.Types.ObjectId()

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const main = await createTestWarehouse(org._id, { isDefault: true } as any)
  const second = await createTestWarehouse(org._id, { name: 'Втори склад', code: `W2-${Date.now() % 100000}` } as any)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  const lines = (quantity = 4) => [{ productId: String(bolt._id), quantity, unitCost: 5, totalCost: quantity * 5 }]
  const movement = (type: string, sides: Record<string, unknown> = {}, quantity = 4) => ({
    type, date: '2026-10-20', ...sides, lines: lines(quantity), totalAmount: quantity * 5,
  })
  const create = (type: string, sides: Record<string, unknown> = {}) => call('POST', '/warehouse/movement', movement(type, sides))
  const idOf = (res: any) => res.json.stockMovement._id || res.json.stockMovement.id
  /** A draft as it stands in the database: one saved before the rule, which no door would take now. */
  const oldDraft = async (type: string, sides: Record<string, unknown>) => {
    const doc = await StockMovement.create({
      orgId, movementNumber: `SM-OLD-${oid()}`, status: 'draft', createdBy: user._id, ...movement(type, sides),
    } as any)
    return String(doc._id)
  }
  const stock = async (warehouse: any = main) =>
    Number(((await StockLevel.findOne({ orgId, productId: bolt._id, warehouseId: warehouse._id }).lean().exec()) as any)?.quantity ?? 0)
  const load = (id: string) => StockMovement.findById(id).lean().exec() as Promise<any>
  /** Goods on the shelf, so a dispatch has something to take. */
  const stocked = async (quantity: number) => {
    const res = await call('POST', '/warehouse/movement', movement('receipt', { toWarehouseId: String(main._id) }, quantity))
    expect((await call('POST', `/warehouse/movement/${idOf(res)}/confirm`, {})).status).toBe(200)
  }

  return { org, orgId, user, main, second, supplier, bolt, token, call, lines, movement, create, idOf, oldDraft, stock, load, stocked }
}

describe('the rule', () => {
  const W = 'warehouse'
  const cases: Array<[string, unknown, unknown, string | null]> = [
    ['dispatch', W, undefined, null],
    ['dispatch', undefined, undefined, null],
    ['dispatch', undefined, W, 'dispatch_with_to_warehouse'],
    ['dispatch', W, W, 'dispatch_with_to_warehouse'],
    ['receipt', undefined, W, null],
    ['receipt', undefined, undefined, null],
    ['receipt', W, undefined, 'receipt_with_from_warehouse'],
    ['receipt', W, W, 'receipt_with_from_warehouse'],
    // `null` is how an edit clears a side; it is not a warehouse.
    ['dispatch', W, null, null],
    ['receipt', null, W, null],
    // A transfer takes goods out of a warehouse: To alone adds them from nowhere.
    ['transfer', W, W, null],
    ['transfer', W, undefined, null],
    ['transfer', undefined, undefined, null],
    ['transfer', undefined, W, 'transfer_without_from_warehouse'],
    ['transfer', null, W, 'transfer_without_from_warehouse'],
    // An adjustment changes one warehouse: both takes the goods out and puts them straight back.
    ['adjustment', W, undefined, null],
    ['adjustment', undefined, W, null],
    ['adjustment', undefined, undefined, null],
    ['adjustment', W, null, null],
    ['adjustment', W, W, 'adjustment_with_both_warehouses'],
  ]
  for (const [type, fromWarehouseId, toWarehouseId, code] of cases) {
    it(`${type} from ${fromWarehouseId ?? '—'} to ${toWarehouseId ?? '—'}: ${code ?? 'fits'}`, () => {
      expect(movementWarehouseRefusal({ type, fromWarehouseId, toWarehouseId })?.code ?? null).toBe(code)
    })
  }

  it('only a dispatch and a receipt have a side they never name', () => {
    for (const type of ['transfer', 'adjustment']) expect(unusedWarehouseSide(type)).toBeNull()
  })

  it('leaves every other type alone, whatever it names', () => {
    for (const type of ['return', 'production_in', 'production_out']) {
      expect(unusedWarehouseSide(type)).toBeNull()
      for (const sides of [{}, { fromWarehouseId: W }, { toWarehouseId: W }, { fromWarehouseId: W, toWarehouseId: W }]) {
        expect(movementWarehouseRefusal({ type, ...sides })).toBeNull()
      }
    }
  })

  it('says what to do in words a storekeeper can act on', () => {
    expect(movementWarehouseRefusal({ type: 'dispatch', toWarehouseId: W })?.message).toContain('From warehouse')
    expect(movementWarehouseRefusal({ type: 'receipt', fromWarehouseId: W })?.message).toContain('To warehouse')
    expect(movementWarehouseRefusal({ type: 'transfer', toWarehouseId: W })?.message).toContain('From warehouse')
    expect(movementWarehouseRefusal({ type: 'adjustment', fromWarehouseId: W, toWarehouseId: W })?.message).toContain('one warehouse')
  })
})

describe('at the doors', () => {
  it('POST refuses a dispatch naming To and a receipt naming From, and writes nothing', async () => {
    const w = await world()
    const main = String(w.main._id)
    const second = String(w.second._id)

    for (const [type, sides, code] of [
      ['dispatch', { toWarehouseId: main }, 'dispatch_with_to_warehouse'],
      ['dispatch', { fromWarehouseId: main, toWarehouseId: second }, 'dispatch_with_to_warehouse'],
      ['receipt', { fromWarehouseId: main }, 'receipt_with_from_warehouse'],
      ['receipt', { fromWarehouseId: main, toWarehouseId: second }, 'receipt_with_from_warehouse'],
    ] as const) {
      const res = await w.create(type, sides)
      expect([res.status, res.json.code]).toEqual([422, code])
      expect(res.json.message).toBeTruthy()
    }
    expect(await StockMovement.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
  }, 60_000)

  it('POST refuses a transfer naming only To and an adjustment naming both: neither adds a thing to stock', async () => {
    const w = await world()
    const main = String(w.main._id)
    const second = String(w.second._id)
    const before = await StockMovement.countDocuments({ orgId: w.orgId }).exec()
    const transfer = await w.create('transfer', { toWarehouseId: main })
    expect([transfer.status, transfer.json.code]).toEqual([422, 'transfer_without_from_warehouse'])
    const adjustment = await w.create('adjustment', { fromWarehouseId: main, toWarehouseId: second })
    expect([adjustment.status, adjustment.json.code]).toEqual([422, 'adjustment_with_both_warehouses'])
    expect(await StockMovement.countDocuments({ orgId: w.orgId }).exec()).toBe(before)
  }, 60_000)

  it('PUT and /confirm hold them too, and an old draft can be repaired', async () => {
    const w = await world()
    const main = String(w.main._id)
    const second = String(w.second._id)
    await w.stocked(10)

    // PUT judges what the movement would be.
    const transfer = w.idOf(await w.create('transfer', { fromWarehouseId: main, toWarehouseId: second }))
    const cleared = await w.call('PUT', `/warehouse/movement/${transfer}`, { fromWarehouseId: null })
    expect([cleared.status, cleared.json.code]).toEqual([422, 'transfer_without_from_warehouse'])
    const adjustment = w.idOf(await w.create('adjustment', { fromWarehouseId: main }))
    const both = await w.call('PUT', `/warehouse/movement/${adjustment}`, { toWarehouseId: second })
    expect([both.status, both.json.code]).toEqual([422, 'adjustment_with_both_warehouses'])

    // The drafts a door would not take now: each moves nothing until corrected.
    const oldTransfer = await w.oldDraft('transfer', { toWarehouseId: main })
    const refused = await w.call('POST', `/warehouse/movement/${oldTransfer}/confirm`, {})
    expect([refused.status, refused.json.code]).toEqual([422, 'transfer_without_from_warehouse'])
    const oldAdjustment = await w.oldDraft('adjustment', { fromWarehouseId: main, toWarehouseId: second })
    const refusedToo = await w.call('POST', `/warehouse/movement/${oldAdjustment}/confirm`, {})
    expect([refusedToo.status, refusedToo.json.code]).toEqual([422, 'adjustment_with_both_warehouses'])
    expect([await w.stock(), await w.stock(w.second)]).toEqual([10, 0])

    expect((await w.call('PUT', `/warehouse/movement/${oldAdjustment}`, { toWarehouseId: null })).status).toBe(200)
    expect((await w.call('POST', `/warehouse/movement/${oldAdjustment}/confirm`, {})).status).toBe(200)
    expect([await w.stock(), await w.stock(w.second)]).toEqual([6, 0])
  }, 60_000)

  it('/doc-import/convert refuses them per id', async () => {
    const w = await world()
    const id = await w.oldDraft('adjustment', { fromWarehouseId: String(w.main._id), toWarehouseId: String(w.second._id) })
    const res = await w.call('POST', '/doc-import/convert', { target: 'movement', ids: [id] })
    expect(res.json.results[0]).toMatchObject({ id, ok: false, code: 'adjustment_with_both_warehouses' })
    expect((await w.load(id)).status).toBe('draft')
  }, 60_000)

  it('POST takes every shape that fits: one side, or neither, and the other types as they were', async () => {
    const w = await world()
    const main = String(w.main._id)
    const second = String(w.second._id)
    for (const [type, sides] of [
      ['dispatch', { fromWarehouseId: main }],
      ['dispatch', {}],
      ['receipt', { toWarehouseId: main }],
      ['receipt', {}],
      ['transfer', { fromWarehouseId: main }],
      ['transfer', { fromWarehouseId: main, toWarehouseId: second }],
      ['adjustment', { fromWarehouseId: main }],
      ['adjustment', { toWarehouseId: main }],
      ['adjustment', {}],
      ['return', { toWarehouseId: main }],
    ] as const) {
      expect((await w.create(type, sides)).status).toBe(200)
    }
  }, 60_000)

  it('/with-update refuses a receipt naming From', async () => {
    const w = await world()
    const refused = await w.call('POST', '/warehouse/movement/with-update', w.movement('receipt', { fromWarehouseId: String(w.main._id), toWarehouseId: String(w.second._id) }))
    expect([refused.status, refused.json.code]).toEqual([422, 'receipt_with_from_warehouse'])
    expect(await StockMovement.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    const fine = await w.call('POST', '/warehouse/movement/with-update', w.movement('receipt', { toWarehouseId: String(w.main._id) }))
    expect(fine.status).toBe(200)
  }, 60_000)

  it('PUT judges the movement as it would stand, and leaves it alone when refused', async () => {
    const w = await world()
    const main = String(w.main._id)
    const receipt = w.idOf(await w.create('receipt', { toWarehouseId: main }))
    const dispatch = w.idOf(await w.create('dispatch', { fromWarehouseId: main }))

    const addFrom = await w.call('PUT', `/warehouse/movement/${receipt}`, { fromWarehouseId: String(w.second._id) })
    expect([addFrom.status, addFrom.json.code]).toEqual([422, 'receipt_with_from_warehouse'])
    expect((await w.load(receipt)).fromWarehouseId).toBeUndefined()
    const addTo = await w.call('PUT', `/warehouse/movement/${dispatch}`, { toWarehouseId: String(w.second._id) })
    expect([addTo.status, addTo.json.code]).toEqual([422, 'dispatch_with_to_warehouse'])
    expect((await w.load(dispatch)).toWarehouseId).toBeUndefined()

    // Through the path that also updates products, the same.
    const withUpdates = await w.call('PUT', `/warehouse/movement/${receipt}`, {
      fromWarehouseId: String(w.second._id), productUpdates: [{ productId: String(w.bolt._id), sellingPrice: 11 }],
    })
    expect(withUpdates.json.code).toBe('receipt_with_from_warehouse')

    // An edit that leaves the warehouses out stays what it was, for the older clients.
    expect((await w.call('PUT', `/warehouse/movement/${receipt}`, { notes: 'бележка' })).status).toBe(200)
    expect(String((await w.load(receipt)).toWarehouseId)).toBe(main)
    expect((await w.call('PUT', `/warehouse/movement/${dispatch}`, { fromWarehouseId: String(w.second._id) })).status).toBe(200)
    expect(String((await w.load(dispatch)).fromWarehouseId)).toBe(String(w.second._id))
  }, 60_000)

  it('/confirm refuses an old draft that does not fit, and moves nothing', async () => {
    const w = await world()
    const main = String(w.main._id)
    await w.stocked(10)
    const toOnly = await w.oldDraft('dispatch', { toWarehouseId: main })
    const refused = await w.call('POST', `/warehouse/movement/${toOnly}/confirm`, {})
    expect([refused.status, refused.json.code]).toEqual([422, 'dispatch_with_to_warehouse'])
    expect((await w.load(toOnly)).status).toBe('draft')
    expect(await w.stock()).toBe(10)

    const fromAndTo = await w.oldDraft('receipt', { fromWarehouseId: main, toWarehouseId: String(w.second._id) })
    const refused2 = await w.call('POST', `/warehouse/movement/${fromAndTo}/confirm`, {})
    expect([refused2.status, refused2.json.code]).toEqual([422, 'receipt_with_from_warehouse'])
    expect([await w.stock(), await w.stock(w.second)]).toEqual([10, 0])
  }, 60_000)

  it('an old draft can be repaired: `null` clears the wrong side, and it then confirms as what it is', async () => {
    const w = await world()
    const main = String(w.main._id)
    await w.stocked(10)
    const draft = await w.oldDraft('dispatch', { toWarehouseId: main })

    const swapped = await w.call('PUT', `/warehouse/movement/${draft}`, { fromWarehouseId: main, toWarehouseId: null })
    expect(swapped.status).toBe(200)
    expect((await w.load(draft)).toWarehouseId ?? null).toBeNull()
    expect((await w.call('POST', `/warehouse/movement/${draft}/confirm`, {})).status).toBe(200)
    expect((await w.load(draft)).status).toBe('completed')
    expect(await w.stock()).toBe(6)

    // The same through the path that also updates products.
    const receipt = await w.oldDraft('receipt', { fromWarehouseId: String(w.second._id), toWarehouseId: main })
    const cleared = await w.call('PUT', `/warehouse/movement/${receipt}`, { fromWarehouseId: null, productUpdates: [{ productId: String(w.bolt._id), sellingPrice: 11 }] })
    expect(cleared.status).toBe(200)
    expect((await w.call('POST', `/warehouse/movement/${receipt}/confirm`, {})).status).toBe(200)
    expect([await w.stock(), await w.stock(w.second)]).toEqual([10, 0])
  }, 60_000)

  it('/doc-import/convert is the same door: it refuses per id, and confirms only a draft of this org', async () => {
    const w = await world()
    const main = String(w.main._id)
    await w.stocked(10)
    const misfit = await w.oldDraft('dispatch', { toWarehouseId: main })
    const fits = await w.oldDraft('receipt', { toWarehouseId: main })

    const res = await w.call('POST', '/doc-import/convert', { target: 'movement', ids: [misfit, fits] })
    expect(res.status).toBe(200)
    expect(res.json.results.map((x: any) => [x.id, x.ok, x.code])).toEqual([[misfit, false, 'dispatch_with_to_warehouse'], [fits, true, undefined]])
    expect((await w.load(misfit)).status).toBe('draft')
    expect(await w.stock()).toBe(14)

    const elsewhere = await world()
    const foreign = await elsewhere.oldDraft('receipt', { toWarehouseId: String(elsewhere.main._id) })
    const other = await w.call('POST', '/doc-import/convert', { target: 'movement', ids: [foreign] })
    expect(other.json.results[0]).toMatchObject({ id: foreign, ok: false })
    expect((await elsewhere.load(foreign)).status).toBe('draft')
    expect(await elsewhere.stock()).toBe(0)
  }, 60_000)

  it('a dispatch can no longer add stock, and takes it out as a dispatch should', async () => {
    const w = await world()
    await w.stocked(10)
    const main = String(w.main._id)
    expect((await w.create('dispatch', { toWarehouseId: main })).status).toBe(422)
    expect(await w.stock()).toBe(10)
    const dispatch = w.idOf(await w.create('dispatch', { fromWarehouseId: main }))
    expect((await w.call('POST', `/warehouse/movement/${dispatch}/confirm`, {})).status).toBe(200)
    expect(await w.stock()).toBe(6)
  }, 60_000)
})

describe('what stands already stays as it stands', () => {
  /** What the historic documents look like: booked, with a shape the doors no longer take. */
  async function booked(w: Awaited<ReturnType<typeof world>>, type: string, sides: Record<string, unknown>) {
    const doc = await StockMovement.create({
      orgId: w.orgId, movementNumber: `SM-HIST-${oid()}`, status: 'completed', createdBy: w.user._id, contactId: w.supplier._id, ...w.movement(type, sides),
    } as any)
    return String(doc._id)
  }

  it('a completed movement that does not fit reads as it was, and is not refused for it', async () => {
    const w = await world()
    const main = String(w.main._id)
    const dispatch = await booked(w, 'dispatch', { toWarehouseId: main })
    const receipt = await booked(w, 'receipt', { fromWarehouseId: main, toWarehouseId: String(w.second._id) })
    const before = await w.load(dispatch)

    const page = await w.call('GET', `/warehouse/movement/${dispatch}`)
    expect(page.status).toBe(200)
    expect(page.json.stockMovement.toWarehouseId).toBe(main)
    expect((await w.call('GET', `/warehouse/movement/${receipt}`)).json.stockMovement.fromWarehouseId).toBe(main)

    // The door it would be refused at turns it away for being booked, as it always has.
    const again = await w.call('POST', `/warehouse/movement/${dispatch}/confirm`, {})
    expect([again.status, again.json.code]).toEqual([400, undefined])
    const edit = await w.call('PUT', `/warehouse/movement/${dispatch}`, { notes: 'x' })
    expect([edit.status, edit.json.code]).toEqual([400, undefined])
    expect(await w.load(dispatch)).toEqual(before)
  }, 60_000)

  it('a historic receipt naming both warehouses can still be billed', async () => {
    const w = await world()
    const receipt = await booked(w, 'receipt', { fromWarehouseId: String(w.main._id), toWarehouseId: String(w.second._id) })
    expect((await w.call('POST', '/invoicing/bills/from-receipt', { movementIds: [receipt] })).status).toBe(200)
  }, 60_000)
})

describe('what the rule does not touch', () => {
  it('a movement a site already booked replays as it was: `confirmMovement` applies it', async () => {
    const w = await world()
    const doc = { ...w.movement('dispatch', { toWarehouseId: w.main._id }), _id: oid(), orgId: w.org._id, movementNumber: 'SM-SITE-1', status: 'completed', date: new Date(), createdBy: w.user._id }
    doc.lines = doc.lines.map(l => ({ ...l, productId: w.bolt._id })) as any
    const ctx = { orgId: w.orgId, org: w.org._id, runId: oid(), source: { kind: 'reseed_kept', moveId: oid(), nodeId: 'master-1' }, by: String(w.user._id), at: new Date() } as any
    const outcome = await importMovement(ctx, doc)
    expect(outcome.outcome).toBe('imported')
    expect((await w.load(String(doc._id))).status).toBe('completed')
    expect(await w.stock()).toBe(4)
  }, 60_000)

  it('`confirmMovement` itself books any draft: the rule is at the doors', async () => {
    const w = await world()
    const draft = await w.oldDraft('dispatch', { toWarehouseId: String(w.main._id) })
    const confirmed = await confirmMovement(draft)
    expect(confirmed.status).toBe('completed')
    expect(await w.stock()).toBe(4)
  }, 60_000)

  it('the invoice paths set the side from the document, and pass no door', async () => {
    const w = await world()
    await w.stocked(10)
    const main = String(w.main._id)
    const line = { productId: String(w.bolt._id), warehouseId: main, description: 'Болт М8', quantity: 3, unitPrice: 5, taxRate: 20 }
    const made = async (over: Record<string, unknown>) => {
      const created = await w.call('POST', '/invoices', { type: 'invoice', contactId: String(w.supplier._id), issueDate: '2026-10-21', currency: 'EUR', lines: [line], subtotal: 15, total: 18, ...over })
      expect(created.status).toBe(200)
      return getRepos().invoices.findOne({ id: created.json.invoice.id, orgId: w.orgId } as any) as Promise<any>
    }
    const sale = await made({ direction: 'outgoing' })
    await createInvoiceStockMovement(sale, String(w.user._id))
    expect(await w.stock()).toBe(7)
    await reverseInvoiceStockMovement(sale, String(w.user._id))
    expect(await w.stock()).toBe(10)
    const shapes = await StockMovement.find({ orgId: w.orgId, invoiceId: sale.id }, { type: 1, fromWarehouseId: 1, toWarehouseId: 1 }).lean().exec() as any[]
    expect(shapes.map(m => [m.type, !!m.fromWarehouseId, !!m.toWarehouseId]).sort()).toEqual([['dispatch', true, false], ['receipt', false, true]])
    for (const m of shapes) expect(movementWarehouseRefusal(m)).toBeNull()
    expect(await Invoice.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
  }, 60_000)
})
