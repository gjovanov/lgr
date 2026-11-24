import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import { createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { movementController } from 'api/src/warehouse/controllers/movement.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { confirmMovement, announceMovementConfirmed, StockBookingRefusedError } from 'services/biz/warehouse.service'
import { checkCrossWarehouseAvailability } from 'services/biz/stock-transfer.service'
import { eventBus } from 'services/events/event-bus'
import { getRepos } from 'services/context'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { mongoose } from 'db/connection'
import { CostLayer, Product, StockLevel, StockMovement } from 'db/models'

/**
 * FR-29 slice A (#794): a stock booking is stored whole or not at all.
 *
 * `confirmMovement` used to claim the draft, move each line's level and layers, and write `completed`
 * after the loop, with nothing joining the writes: a line that failed kept what the lines before it had
 * moved, the claim held the draft for ten minutes, and each retry after it moved the goods again
 * (FR-29 §1.1, reproduced on the demo org). Now the booking is one transaction.
 *
 * - FR-29.1 all or nothing, FR-29.2 the claim is released, FR-29.7 the event after the commit:
 *   §1.1's sequence, and a repository that throws on its Nth write.
 * - FR-29.3 every write carries the session (the driver's own record of each call), and an outer
 *   transaction is joined.
 * - FR-29.4 a large movement books in one transaction (the size production holds is the owner's
 *   read: see the PR).
 * - FR-29.5 the reads of a booking, of the transfer pre-flight, do not grow with the lines.
 * - FR-29.6 the refusal is a 422 with a code that names the article and the warehouse, no id.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
const confirmed: string[] = []
let stopListening: () => void

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(movementController)
  stopListening = eventBus.on('stock.movement.confirmed', p => { confirmed.push(String(p.movementId)) })
}, 60_000)
afterAll(async () => {
  stopListening()
  await teardownTestDB()
}, 60_000)
afterEach(async () => {
  confirmed.length = 0
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const OBJECT_ID = /\b[0-9a-f]{24}\b/i

/** Two articles at 100 in one warehouse: a nut on average cost, a bolt on FIFO with stock and no layer (§1.1). */
async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const main = await createTestWarehouse(org._id, { name: 'Main store', isDefault: true } as any)
  const nut = await createTestProduct(org._id, { sku: 'NUT-01', name: 'Nut M8', purchasePrice: 2 } as any)
  const bolt = await createTestProduct(org._id, { sku: 'BOLT-01', name: 'Bolt M8', purchasePrice: 5 } as any)
  await createTestStockLevel(org._id, nut._id, main._id, { quantity: 100, availableQuantity: 100, avgCost: 2 })
  await createTestStockLevel(org._id, bolt._id, main._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })
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

  /** A draft movement written straight to the store, as any creator leaves one. */
  const draft = async (m: Record<string, any>) => {
    const lines = m.lines.map((l: any) => ({ unitCost: 1, totalCost: l.quantity, ...l }))
    const doc = await StockMovement.create({
      orgId: org._id, movementNumber: `SM-T-${Math.random().toString(36).slice(2, 10)}`, status: 'draft',
      date: new Date('2026-11-16'), totalAmount: 0, createdBy: user._id, ...m, lines,
    })
    return String(doc._id)
  }
  const level = async (product: any, warehouse: any = main) =>
    Number(((await StockLevel.findOne({ orgId, productId: product._id, warehouseId: warehouse._id }).lean().exec()) as any)?.quantity ?? 0)
  const load = (id: string) => StockMovement.findById(id).lean().exec() as Promise<any>
  const layers = () => CostLayer.find({ orgId }).lean().exec() as Promise<any[]>

  return { org, orgId, user, main, nut, bolt, call, draft, level, load, layers }
}

/** §1.1: the bolt goes FIFO with stock on hand and no layer, set directly in the database. */
async function boltWithoutLayers(w: Awaited<ReturnType<typeof world>>) {
  await Product.updateOne({ _id: w.bolt._id }, { $set: { costingMethod: 'fifo' } }).exec()
}

describe('FR-29.1, .2, .6, .7: a booking that fails moves nothing, and says why', () => {
  it('§1.1 replayed: every confirm answers the same 422 naming the article, and the levels stay at 100 / 100', async () => {
    const w = await world()
    await boltWithoutLayers(w)
    const id = await w.draft({
      type: 'dispatch', fromWarehouseId: w.main._id,
      lines: [{ productId: w.nut._id, quantity: 3 }, { productId: w.bolt._id, quantity: 4 }],
    })

    for (let step = 1; step <= 4; step++) {
      if (step === 3) {
        // "after the claim lapsed": nothing holds it anyway now, but make sure no stale claim matters.
        await StockMovement.updateOne({ _id: id }, { $set: { claimedUntil: new Date(Date.now() - 1000) } }).exec()
      }
      const res = await w.call('POST', `/warehouse/movement/${id}/confirm`, {})
      expect([step, res.status]).toEqual([step, 422])
      expect(res.json.code).toBe('no_cost_layer')
      expect(res.json.product).toBe('Bolt M8')
      expect(res.json.sku).toBe('BOLT-01')
      expect(res.json.warehouse).toBe('Main store')
      expect(res.json.message).toContain('Bolt M8')
      expect(res.json.message).toContain('Main store')
      expect(JSON.stringify(res.json)).not.toMatch(OBJECT_ID)

      expect([step, await w.level(w.nut), await w.level(w.bolt)]).toEqual([step, 100, 100])
      const m = await w.load(id)
      expect(m.status).toBe('draft')
      expect(m.claimedUntil ?? null).toBeNull()
    }
    expect(await w.layers()).toHaveLength(0)
    expect(confirmed).toEqual([])
  })

  it('more than the layers hold: 422 insufficient_cost_layers with both quantities, nothing taken', async () => {
    const w = await world()
    await boltWithoutLayers(w)
    // A layer of 2 for the bolt: 4 are to leave.
    const receipt = await w.draft({ type: 'receipt', toWarehouseId: w.main._id, lines: [{ productId: w.bolt._id, quantity: 2, unitCost: 5 }] })
    await confirmMovement(receipt)
    confirmed.length = 0
    const id = await w.draft({
      type: 'dispatch', fromWarehouseId: w.main._id,
      lines: [{ productId: w.nut._id, quantity: 3 }, { productId: w.bolt._id, quantity: 4 }],
    })

    const res = await w.call('POST', `/warehouse/movement/${id}/confirm`, {})
    expect(res.status).toBe(422)
    expect(res.json).toMatchObject({ code: 'insufficient_cost_layers', product: 'Bolt M8', sku: 'BOLT-01', warehouse: 'Main store', needed: 4, available: 2 })
    expect(JSON.stringify(res.json)).not.toMatch(OBJECT_ID)
    expect(await w.level(w.nut)).toBe(100)
    expect(await w.level(w.bolt)).toBe(102)
    const [layer] = await w.layers()
    expect(layer.remainingQuantity).toBe(2)
    expect(confirmed).toEqual([])
  })

  it('the service throws the typed refusal, named, for a caller that is not the route', async () => {
    const w = await world()
    await boltWithoutLayers(w)
    const id = await w.draft({ type: 'dispatch', fromWarehouseId: w.main._id, lines: [{ productId: w.bolt._id, quantity: 1 }] })
    const err = await captureRejection(confirmMovement(id))
    expect(err).toBeInstanceOf(StockBookingRefusedError)
    expect(err.code).toBe('no_cost_layer')
    expect(err.message).not.toMatch(OBJECT_ID)
    expect(err.message).toContain('BOLT-01')
  })

  it('a store write that fails late (the status write) leaves levels, layers and the movement as they were', async () => {
    const w = await world()
    await Product.updateOne({ _id: w.bolt._id }, { $set: { costingMethod: 'fifo' } }).exec()
    const id = await w.draft({
      type: 'receipt', toWarehouseId: w.main._id,
      lines: [{ productId: w.nut._id, quantity: 5 }, { productId: w.bolt._id, quantity: 6, unitCost: 5 }],
    })
    const failing = withFailingWrite(getRepos(), 'stockMovements', 'update', 1)

    const err = await captureRejection(confirmMovement(id, failing))
    expect(String(err?.message)).toContain('planted failure')

    expect(await w.level(w.nut)).toBe(100)
    expect(await w.level(w.bolt)).toBe(100)
    expect(await w.layers()).toHaveLength(0) // the bolt's layer was created, and rolled back
    const m = await w.load(id)
    expect(m.status).toBe('draft')
    expect(m.claimedUntil ?? null).toBeNull()
    expect(confirmed).toEqual([])

    // And the same draft then books once, cleanly.
    await confirmMovement(id)
    expect(await w.level(w.nut)).toBe(105)
    expect(await w.level(w.bolt)).toBe(106)
    expect(confirmed).toEqual([id])
  })

  it('a store write that fails midway (the second line\'s cost layer) undoes the first line\'s', async () => {
    const w = await world()
    await Product.updateMany({ _id: { $in: [w.nut._id, w.bolt._id] } }, { $set: { costingMethod: 'fifo' } }).exec()
    const id = await w.draft({
      type: 'receipt', toWarehouseId: w.main._id,
      lines: [{ productId: w.nut._id, quantity: 5, unitCost: 2 }, { productId: w.bolt._id, quantity: 6, unitCost: 5 }],
    })
    const failing = withFailingWrite(getRepos(), 'costLayers', 'create', 2)

    const err = await captureRejection(confirmMovement(id, failing))
    expect(String(err?.message)).toContain('planted failure')
    expect([await w.level(w.nut), await w.level(w.bolt)]).toEqual([100, 100])
    expect(await w.layers()).toHaveLength(0)
    expect((await w.load(id)).status).toBe('draft')
    expect(confirmed).toEqual([])
  })
})

describe('the happy paths are unchanged', () => {
  it('a receipt, a dispatch, a transfer and an adjustment book their lines, and announce once each', async () => {
    const w = await world()
    const other = await createTestWarehouse(w.org._id, { name: 'Back store' } as any)
    const receipt = await w.draft({ type: 'receipt', toWarehouseId: w.main._id, lines: [{ productId: w.nut._id, quantity: 10, unitCost: 2 }] })
    const dispatch = await w.draft({ type: 'dispatch', fromWarehouseId: w.main._id, lines: [{ productId: w.nut._id, quantity: 4 }, { productId: w.bolt._id, quantity: 7 }] })
    const transfer = await w.draft({ type: 'transfer', fromWarehouseId: w.main._id, toWarehouseId: other._id, lines: [{ productId: w.bolt._id, quantity: 3 }] })
    const adjustment = await w.draft({ type: 'adjustment', toWarehouseId: other._id, lines: [{ productId: w.nut._id, quantity: 2, unitCost: 2 }] })

    for (const id of [receipt, dispatch, transfer, adjustment]) {
      const done = await confirmMovement(id)
      expect(done.status).toBe('completed')
    }

    expect(await w.level(w.nut)).toBe(106)
    expect(await w.level(w.bolt)).toBe(90)
    expect(await w.level(w.bolt, other)).toBe(3)
    expect(await w.level(w.nut, other)).toBe(2)
    expect(confirmed).toEqual([receipt, dispatch, transfer, adjustment])
    // The transfer's goods arrive at what they cost where they left (#778).
    const t = await w.load(transfer)
    expect(t.lines[0].resolvedUnitCost).toBe(5)
  })

  it('two bookings that both open the same new level at once both land on it', async () => {
    const w = await world()
    const other = await createTestWarehouse(w.org._id, { name: 'Back store' } as any)
    const ids = await Promise.all(Array.from({ length: 4 }, () =>
      w.draft({ type: 'receipt', toWarehouseId: other._id, lines: [{ productId: w.nut._id, quantity: 5, unitCost: 2 }] })))

    const outcomes = await Promise.all(ids.map(id => captureRejection(confirmMovement(id))))
    expect(outcomes).toEqual([null, null, null, null])
    expect(await w.level(w.nut, other)).toBe(20)
    expect(await StockLevel.countDocuments({ orgId: w.orgId, productId: w.nut._id, warehouseId: other._id })).toBe(1)
  })
})

describe('FR-29.3: the session reaches every write, and an outer transaction is joined', () => {
  it('every write of a booking carries the transaction, except the claim taken before it', async () => {
    const w = await world()
    await Product.updateOne({ _id: w.bolt._id }, { $set: { costingMethod: 'fifo' } }).exec()
    const other = await createTestWarehouse(w.org._id, { name: 'Back store' } as any)
    // Layers to take from, so the dispatch and the transfer below consume and open layers.
    await confirmMovement(await w.draft({ type: 'receipt', toWarehouseId: w.main._id, lines: [{ productId: w.bolt._id, quantity: 20, unitCost: 5 }] }))

    const ids = [
      await w.draft({ type: 'receipt', toWarehouseId: other._id, lines: [{ productId: w.nut._id, quantity: 5, unitCost: 2 }, { productId: w.bolt._id, quantity: 2, unitCost: 6 }] }),
      await w.draft({ type: 'dispatch', fromWarehouseId: w.main._id, lines: [{ productId: w.nut._id, quantity: 1 }, { productId: w.bolt._id, quantity: 3 }] }),
      await w.draft({ type: 'transfer', fromWarehouseId: w.main._id, toWarehouseId: other._id, lines: [{ productId: w.bolt._id, quantity: 4 }] }),
    ]
    for (const id of ids) {
      const ops = await recordOps(() => confirmMovement(id))
      const writes = ops.filter(o => WRITES.has(o.method) && BOOKING_COLLECTIONS.has(o.collection))
      expect(writes.length).toBeGreaterThan(2)
      const outside = writes.filter(o => !o.session)
      // The claim, and nothing else, is written outside: it is what tells a second confirm to wait.
      expect(outside.map(o => `${o.collection}.${o.method}`)).toEqual(['stockmovements.findOneAndUpdate'])
      expect(JSON.stringify(outside[0].args)).toContain('claimedUntil')
      // The layers were touched inside the transaction too.
      expect(writes.some(o => o.collection === 'costlayers' && o.session)).toBe(true)
    }
  })

  it('joined: the caller\'s abort undoes the booking and the claim, and nothing is announced', async () => {
    const w = await world()
    const id = await w.draft({ type: 'dispatch', fromWarehouseId: w.main._id, lines: [{ productId: w.nut._id, quantity: 3 }] })

    const session = await mongoose.startSession()
    try {
      session.startTransaction()
      const done = await confirmMovement(id, undefined, { session })
      expect(done.status).toBe('completed')
      // Not visible outside the caller's transaction yet.
      expect(await w.level(w.nut)).toBe(100)
      expect((await w.load(id)).status).toBe('draft')
      await session.abortTransaction()
    } finally {
      await session.endSession()
    }

    expect(await w.level(w.nut)).toBe(100)
    const m = await w.load(id)
    expect(m.status).toBe('draft')
    expect(m.claimedUntil ?? null).toBeNull()
    expect(confirmed).toEqual([])
  })

  it('joined: the caller\'s commit keeps it, and the caller announces it after', async () => {
    const w = await world()
    const id = await w.draft({ type: 'dispatch', fromWarehouseId: w.main._id, lines: [{ productId: w.nut._id, quantity: 3 }] })

    const session = await mongoose.startSession()
    let done: any
    try {
      await session.withTransaction(async () => { done = await confirmMovement(id, undefined, { session }) })
    } finally {
      await session.endSession()
    }
    expect(confirmed).toEqual([])
    announceMovementConfirmed(done)

    expect(await w.level(w.nut)).toBe(97)
    expect((await w.load(id)).status).toBe('completed')
    expect(confirmed).toEqual([id])
  })
})

describe('FR-29.4: a large movement books in one transaction', () => {
  it('a receipt of 1000 lines', async () => {
    const w = await world()
    const products = await articles(w.org._id, `BULK-`, 1000)
    const id = await w.draft({ type: 'receipt', toWarehouseId: w.main._id, lines: products.map(p => ({ productId: p._id, quantity: 3, unitCost: 1 })) })

    const started = performance.now()
    const done = await confirmMovement(id)
    const ms = Math.round(performance.now() - started)
    console.log(`[FR-29.4] a 1000-line receipt booked in ${ms} ms, in one transaction`)

    expect(done.status).toBe('completed')
    expect(await StockLevel.countDocuments({ orgId: w.orgId, warehouseId: w.main._id, quantity: 3 })).toBe(1000)
  })
})

describe('FR-29.5: the reads of a booking do not grow with the lines', () => {
  async function readsOfReceipt(lines: number) {
    const w = await world()
    const products = await articles(w.org._id, `R${lines}-`, lines)
    await StockLevel.insertMany(products.map(p => ({ orgId: w.org._id, productId: p._id, warehouseId: w.main._id, quantity: 1, availableQuantity: 1, avgCost: 1 })))
    const id = await w.draft({ type: 'receipt', toWarehouseId: w.main._id, lines: products.map(p => ({ productId: p._id, quantity: 2, unitCost: 1 })) })
    const ops = await recordOps(() => confirmMovement(id))
    return bookingReads(ops)
  }

  it('a 10-line and a 100-line receipt read the same number of times', async () => {
    const ten = await readsOfReceipt(10)
    const hundred = await readsOfReceipt(100)
    expect(hundred).toBe(ten)
    // The draft, the external flags, the articles' costing and the org's default. More means a read per
    // line came back, or the transaction ran its body again (two operations at once on its session).
    expect(ten).toBeLessThanOrEqual(5)
  })

  it('so does the transfer pre-flight of an invoice', async () => {
    async function readsOfPreflight(lines: number) {
      const w = await world()
      const other = await createTestWarehouse(w.org._id, { name: 'Back store' } as any)
      const products = await articles(w.org._id, `P${lines}-`, lines)
      // Each article is short in the main store and held in the back store: a proposal per line.
      await StockLevel.insertMany(products.map(p => ({ orgId: w.org._id, productId: p._id, warehouseId: other._id, quantity: 9, availableQuantity: 9, avgCost: 1 })))
      let result: any
      const ops = await recordOps(async () => {
        result = await checkCrossWarehouseAvailability(w.orgId, products.map(p => ({ productId: String(p._id), warehouseId: String(w.main._id), quantity: 4 })))
      })
      expect(result.proposals).toHaveLength(lines)
      expect(result.proposals[0]).toMatchObject({ toWarehouseName: 'Main store', totalTransfer: 4 })
      expect(result.proposals[0].sources[0]).toMatchObject({ fromWarehouseName: 'Back store', available: 9, transferQuantity: 4 })
      return bookingReads(ops)
    }
    const ten = await readsOfPreflight(10)
    const hundred = await readsOfPreflight(100)
    expect(hundred).toBe(ten)
  })
})

// ── helpers ──

/** `n` plain articles on average cost, in one write. */
function articles(orgId: unknown, prefix: string, n: number): Promise<any[]> {
  return Product.insertMany(Array.from({ length: n }, (_, i) => ({
    orgId, sku: `${prefix}${i}`, name: `Article ${prefix}${i}`, category: 'General', type: 'goods', unit: 'pcs',
    purchasePrice: 1, sellingPrice: 2, currency: 'EUR', taxRate: 20, isActive: true,
  })))
}

const WRITES = new Set(['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'bulkWrite'])
const READS = new Set(['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'aggregate', 'distinct'])
const BOOKING_COLLECTIONS = new Set(['stocklevels', 'costlayers', 'stockmovements'])

interface Op { collection: string; method: string; session: boolean; args: unknown[] }

/**
 * The reads an operation makes, less the home guard's (`db/home`: whether any org lives elsewhere),
 * which it caches for 5 s and so makes or not depending on when the last one was.
 */
function bookingReads(ops: Op[]): number {
  return ops.filter(o => READS.has(o.method))
    .filter(o => o.collection !== 'org_homes' && !JSON.stringify(o.args[0] ?? null).includes('homeEpochHighWater'))
    .length
}

/**
 * Every call Mongoose makes to the driver while `fn` runs, and whether it carried a session: the
 * record FR-29.3's test reads, so a write added to the booking without the session fails it.
 */
async function recordOps(fn: () => Promise<unknown>): Promise<Op[]> {
  const ops: Op[] = []
  mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
    const session = args.some(a => !!a && typeof a === 'object' && !!(a as any).session)
    ops.push({ collection, method, session, args })
  })
  try {
    await fn()
  } finally {
    mongoose.set('debug', false)
  }
  return ops
}

/** The registry, with one repository method that throws on its `nth` call (a store that fails midway). */
function withFailingWrite(repos: any, repo: string, method: string, nth: number): any {
  let calls = 0
  const inner = repos[repo]
  const failing = new Proxy(inner, {
    get(target, prop) {
      const value = (target as any)[prop]
      if (prop !== method) return typeof value === 'function' ? value.bind(target) : value
      return async (...args: unknown[]) => {
        if (++calls === nth) throw new Error(`planted failure on ${repo}.${method} #${nth}`)
        return value.apply(target, args)
      }
    },
  })
  return { ...repos, [repo]: failing }
}
