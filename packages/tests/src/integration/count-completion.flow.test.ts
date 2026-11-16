import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { inventoryCountController } from 'warehouse-api/src/controllers/inventory-count.controller'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { nextCountNumber } from 'services/biz/count-number'
import { getRepos } from 'services/context'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { InventoryCount, StockLevel, StockMovement } from 'db/models'

/**
 * A count is completed once. Its completion reads "not completed", books the adjustment and only then writes
 * "completed": with nothing held between, a second request in that gap booked the adjustment again and the stock
 * was corrected twice. The list's Complete button could be clicked again while a large count was still being
 * booked, and until 2026-11 two requests at the very same moment were kept apart only by colliding on the
 * adjustment's number. The completion now takes a hold on its count (`leaseUntil`).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(inventoryCountController).use(movementController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const warehouse = await createTestWarehouse(org._id, { isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, bolt._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })
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
  /** A count of the bolt: 100 on the books, `counted` on the shelf. */
  const count = async (counted = 97) => {
    const made = await call('POST', '/warehouse/inventory-count', {
      warehouseId: String(warehouse._id), date: '2026-10-21', type: 'partial',
      lines: [{ productId: String(bolt._id), systemQuantity: 100, countedQuantity: counted, variance: counted - 100 }],
    })
    expect(made.status).toBe(200)
    return String(made.json.inventoryCount.id || made.json.inventoryCount._id)
  }
  const complete = (id: string) => call('POST', `/warehouse/inventory-count/${id}/complete`, {})
  const stock = async () => Number(((await StockLevel.findOne({ orgId, productId: bolt._id, warehouseId: warehouse._id }).lean().exec()) as any)?.quantity)
  const adjustments = (id: string) => StockMovement.find({ orgId, inventoryCountId: id }).lean().exec() as Promise<any[]>
  const stored = (id: string) => InventoryCount.findById(id).lean().exec() as Promise<any>
  return { orgId, user, warehouse, bolt, call, count, complete, stock, adjustments, stored }
}

describe('a count is completed once', () => {
  it('five completions of one count at the same moment: its adjustment is booked once', async () => {
    const w = await world()
    const id = await w.count(97)
    const answers = await Promise.all(Array.from({ length: 5 }, () => w.complete(id)))

    const statuses = answers.map(a => a.status)
    expect(statuses.filter(s => s === 200).length).toBe(1)
    // The others are told the count is busy, or (once the first has finished) that it is completed.
    expect(statuses.filter(s => s !== 200).every(s => s === 409 || s === 400)).toBe(true)
    expect(answers.filter(a => a.status === 409).every(a => a.json?.code === 'count_busy')).toBe(true)

    const booked = await w.adjustments(id)
    expect(booked.map(m => m.status)).toEqual(['completed'])
    expect(await w.stock()).toBe(97)
    const count = await w.stored(id)
    expect([count.status, String(count.adjustmentMovementId), 'leaseUntil' in count]).toEqual(['completed', String(booked[0]._id), false])
    // What the one that completed was answered carries no hold either.
    const done = answers.find(a => a.status === 200)!.json.inventoryCount
    expect([done.status, 'leaseUntil' in done]).toEqual(['completed', false])
  }, 60_000)

  it('a count with nothing to correct is completed once too, and books nothing', async () => {
    const w = await world()
    const id = await w.count(100)
    const answers = await Promise.all(Array.from({ length: 3 }, () => w.complete(id)))
    expect(answers.filter(a => a.status === 200).length).toBe(1)
    expect(await w.adjustments(id)).toEqual([])
    expect([await w.stock(), (await w.stored(id)).status]).toEqual([100, 'completed'])
  }, 60_000)

  it('a count another completion holds is refused; a hold that lapsed (a completion that died) is taken over', async () => {
    const w = await world()
    const id = await w.count(97)
    await InventoryCount.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() + 60_000) } })
    const busy = await w.complete(id)
    expect([busy.status, busy.json?.code]).toEqual([409, 'count_busy'])
    expect(busy.json.message).toContain('IC-')
    expect([await w.stock(), (await w.adjustments(id)).length, (await w.stored(id)).status]).toEqual([100, 0, 'in_progress'])

    await InventoryCount.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1_000) } })
    const taken = await w.complete(id)
    expect(taken.status).toBe(200)
    expect([await w.stock(), (await w.adjustments(id)).length]).toEqual([97, 1])
    // And completed, it stays so.
    const again = await w.complete(id)
    expect([again.status, again.json?.message]).toEqual([400, 'Already completed'])
    expect([await w.stock(), (await w.adjustments(id)).length]).toEqual([97, 1])
  }, 60_000)

  it('a completion that fails gives the count back at once', async () => {
    const w = await world()
    const id = await w.count(97)
    const repo = getRepos().stockMovements as any
    repo.create = async () => { throw new Error('write concern timeout') }
    let failed: Awaited<ReturnType<typeof w.complete>>
    try {
      failed = await w.complete(id)
    } finally {
      delete repo.create
    }
    expect(failed.status).toBe(500)
    const left = await w.stored(id)
    expect([left.status, 'leaseUntil' in left, await w.stock()]).toEqual(['in_progress', false, 100])

    const second = await w.complete(id)
    expect(second.status).toBe(200)
    expect([await w.stock(), (await w.adjustments(id)).length]).toEqual([97, 1])
  }, 60_000)

  it('a body neither takes the hold nor drops it', async () => {
    const w = await world()
    const id = await w.count(97)
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const taken = await w.call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'x', leaseUntil: until })
    expect([taken.status, taken.json?.code]).toEqual([422, 'server_owned_field'])
    const born = await w.call('POST', '/warehouse/inventory-count', {
      warehouseId: String(w.warehouse._id), date: '2026-10-21', type: 'partial', leaseUntil: until,
      lines: [{ productId: String(w.bolt._id), systemQuantity: 100, countedQuantity: 99, variance: -1 }],
    })
    expect([born.status, born.json?.code]).toEqual([422, 'server_owned_field'])
  }, 60_000)

  it('while a completion holds the count, an edit and a delete wait: neither is overwritten by it, nor leaves its adjustment alone (#713)', async () => {
    const w = await world()
    const id = await w.count(97)
    const until = new Date(Date.now() + 3_600_000)
    await InventoryCount.updateOne({ _id: id }, { $set: { leaseUntil: until } })
    const edit = await w.call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'counted twice' })
    expect([edit.status, edit.json?.code]).toEqual([409, 'count_busy'])
    const remove = await w.call('DELETE', `/warehouse/inventory-count/${id}`)
    expect([remove.status, remove.json?.code]).toEqual([409, 'count_busy'])
    const held = await w.stored(id)
    expect([held.notes ?? null, held.status, new Date(held.leaseUntil).getTime()]).toEqual([null, 'in_progress', until.getTime()])

    // The completion took the count between the edit's read and its write: the write finds nothing.
    const repo = getRepos().inventoryCounts as any
    const real = Object.getPrototypeOf(repo).findByIdInOrg
    await InventoryCount.updateOne({ _id: id }, { $unset: { leaseUntil: 1 } })
    let reads = 0
    repo.findByIdInOrg = async function (...args: any[]) {
      const found = await real.apply(repo, args)
      if (reads++ === 0) await InventoryCount.updateOne({ _id: id }, { $set: { leaseUntil: until } })
      return found
    }
    try {
      const late = await w.call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'too late' })
      expect([late.status, late.json?.code]).toEqual([409, 'count_busy'])
      reads = 0
      await InventoryCount.updateOne({ _id: id }, { $unset: { leaseUntil: 1 } })
      const lateRemove = await w.call('DELETE', `/warehouse/inventory-count/${id}`)
      expect([lateRemove.status, lateRemove.json?.code]).toEqual([409, 'count_busy'])
    } finally {
      delete repo.findByIdInOrg
    }
    expect([(await w.stored(id))?.notes ?? null, (await w.stored(id))?.status]).toEqual([null, 'in_progress'])

    // A hold that lapsed holds nothing back; a completed count is refused as it always was.
    await InventoryCount.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1_000) } })
    const after = await w.call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'counted twice' })
    expect([after.status, after.json?.inventoryCount?.notes]).toEqual([200, 'counted twice'])
    expect((await w.complete(id)).status).toBe(200)
    const done = await w.call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'after the fact' })
    expect([done.status, done.json?.code ?? null, /is completed/.test(done.json?.message)]).toEqual([409, null, true])
    expect((await w.call('DELETE', `/warehouse/inventory-count/${id}`)).status).toBe(409)
    const second = await w.count(96)
    expect((await w.call('DELETE', `/warehouse/inventory-count/${second}`)).status).toBe(200)
    expect(await w.stored(second)).toBeNull()
  }, 60_000)
})

describe('a count has a number of its own (#713)', () => {
  const year = new Date().getFullYear()
  const ic = (n: number) => `IC-${year}-${String(n).padStart(5, '0')}`
  const numbers = async (orgId: string) => ((await InventoryCount.find({ orgId }, { countNumber: 1 }).lean().exec()) as any[]).map(c => c.countNumber).sort()

  it('five counts made at the same moment: five numbers, none twice, none skipped', async () => {
    const w = await world()
    const made = await Promise.all(Array.from({ length: 5 }, () => w.call('POST', '/warehouse/inventory-count', {
      warehouseId: String(w.warehouse._id), date: '2026-10-21', type: 'partial',
      lines: [{ productId: String(w.bolt._id), systemQuantity: 100, countedQuantity: 99, variance: -1 }],
    })))
    expect(made.map(m => m.status)).toEqual(Array(5).fill(200))
    expect(made.map(m => m.json.inventoryCount.countNumber).sort()).toEqual([1, 2, 3, 4, 5].map(ic))
    expect(await numbers(w.orgId)).toEqual([1, 2, 3, 4, 5].map(ic))
  }, 60_000)

  it('the counter starts after the counts numbered before it, follows one put in beside it, and is the org\'s own', async () => {
    const w = await world()
    const old = (countNumber: string) => InventoryCount.create({
      orgId: w.orgId, countNumber, warehouseId: w.warehouse._id, date: new Date(), type: 'partial', status: 'completed',
      completedAt: new Date(), lines: [], createdBy: w.user._id,
    } as any)
    // Seven counts from before the counter, one of last year's, one named by hand.
    await old(ic(7))
    await old(ic(3))
    await old(`IC-${year - 1}-00042`)
    await old('IC-TEST-00001')
    expect(await nextCountNumber(w.orgId)).toBe(ic(8))
    expect(await nextCountNumber(w.orgId)).toBe(ic(9))
    // A restored or an imported count above the counter: the next one goes past it.
    await old(ic(20))
    expect(await nextCountNumber(w.orgId)).toBe(ic(21))
    const other = await world()
    expect(await nextCountNumber(other.orgId)).toBe(ic(1))
  }, 60_000)

  it('the count a manual adjustment makes for itself: two confirmed at the same moment, two numbers', async () => {
    const w = await world()
    await w.count(99) // IC-…-00001, made the ordinary way
    const adjustment = async (quantity: number) => {
      const made = await w.call('POST', '/warehouse/movement', {
        type: 'adjustment', date: '2026-10-21', toWarehouseId: String(w.warehouse._id),
        lines: [{ productId: String(w.bolt._id), quantity, unitCost: 5, totalCost: quantity * 5 }], totalAmount: quantity * 5,
      })
      expect(made.status).toBe(200)
      return String(made.json.stockMovement.id || made.json.stockMovement._id)
    }
    const [one, two] = [await adjustment(2), await adjustment(3)]
    const confirmed = await Promise.all([one, two].map(id => w.call('POST', `/warehouse/movement/${id}/confirm`, { createCount: true })))
    expect(confirmed.map(c => c.status)).toEqual([200, 200])
    expect(await numbers(w.orgId)).toEqual([1, 2, 3].map(ic))
    // Each adjustment names its own count.
    const linked = await Promise.all([one, two].map(async id => String(((await StockMovement.findById(id).lean().exec()) as any).inventoryCountId)))
    expect(new Set(linked).size).toBe(2)
    expect(await w.stock()).toBe(105)
  }, 60_000)
})
