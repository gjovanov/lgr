import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { inventoryCountController } from 'warehouse-api/src/controllers/inventory-count.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
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
  app = new Elysia().onError(spaErrorHandler({}) as any).use(inventoryCountController)
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
    // A save while a completion holds the count leaves the hold where it is.
    await InventoryCount.updateOne({ _id: id }, { $set: { leaseUntil: new Date(until) } })
    const saved = await w.call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'counted twice' })
    expect(saved.status).toBe(200)
    expect(new Date((await w.stored(id)).leaseUntil).toISOString()).toBe(until)
  }, 60_000)
})
