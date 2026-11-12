import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { inventoryCountController } from 'warehouse-api/src/controllers/inventory-count.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { persistMovement } from 'services/biz/doc-import/persist-movement'
import { createTransferMovements } from 'services/biz/stock-transfer.service'
import { MOVEMENT_NUMBER_ATTEMPTS, isMovementNumberTaken, nextMovementNumber, withMovementNumber } from 'services/biz/movement-number'
import { stockMovementDao } from 'services/dao/warehouse/stock-movement.dao'
import { captureRejection } from '../helpers/capture-rejection'
import { getRepos } from 'services/context'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { Product, StockMovement } from 'db/models'

/**
 * A stock movement's number is the org's latest + 1, which is read and then written: two creators at the same
 * moment read the same latest. The unique index lets one of them save, and the other used to be answered a 500
 * ("already exists") by every door but the sale's. Now each of them saves, under its own number.
 *
 * ⚠ Never more creators at once in one test than the helper has attempts: a creator can lose a number once to each
 * of the others, so that many is the most it can need, whatever the timing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(movementController).use(inventoryCountController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const year = new Date().getFullYear()
const numbered = (n: number) => `SM-${year}-${String(n).padStart(5, '0')}`
const firstNumbers = (count: number) => Array.from({ length: count }, (_, i) => numbered(i + 1))

async function world(products = 8) {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const main = await createTestWarehouse(org._id, { isDefault: true } as any)
  const second = await createTestWarehouse(org._id, { name: 'Втори склад', code: `W2-${Date.now() % 100000}` } as any)
  const goods: any[] = []
  for (let i = 0; i < products; i++) {
    const p = await createTestProduct(org._id, { sku: `PRD-${String(i + 1).padStart(4, '0')}`, name: `Болт М${i + 6}`, purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
    await createTestStockLevel(org._id, p._id, main._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })
    goods.push(p)
  }
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
  const line = (p: any, quantity = 2) => ({ productId: String(p._id), quantity, unitCost: 5, totalCost: quantity * 5 })
  const receipt = (p: any, more: Record<string, unknown> = {}) => ({
    type: 'receipt', date: `${year}-10-20`, toWarehouseId: String(main._id), lines: [line(p)], totalAmount: 10, ...more,
  })
  const numbers = async () => ((await StockMovement.find({ orgId }, { movementNumber: 1 }).lean().exec()) as any[]).map(m => m.movementNumber).sort()
  return { org, orgId, user, main, second, goods, call, line, receipt, numbers }
}

describe('two movements numbered at the same moment', () => {
  it('eight creates through the route at once: each saves, under its own number, none skipped', async () => {
    const w = await world()
    const answers = await Promise.all(w.goods.map(p => w.call('POST', '/warehouse/movement', w.receipt(p))))
    expect(answers.map(a => a.status)).toEqual(Array(8).fill(200))
    expect(answers.map(a => a.json.stockMovement.movementNumber).sort()).toEqual(firstNumbers(8))
    expect(await w.numbers()).toEqual(firstNumbers(8))
  }, 60_000)

  it('six goods receipts that also change their product, at once: each saves with its product update', async () => {
    const w = await world(6)
    const answers = await Promise.all(w.goods.map((p, i) => w.call('POST', '/warehouse/movement/with-update', w.receipt(p, {
      productUpdates: [{ productId: String(p._id), sellingPrice: 20 + i }],
    }))))
    expect(answers.map(a => a.status)).toEqual(Array(6).fill(200))
    expect(answers.map(a => a.json.stockMovement.movementNumber).sort()).toEqual(firstNumbers(6))
    expect(await w.numbers()).toEqual(firstNumbers(6))
    // The update of a receipt that had to take another number is there once, as asked.
    const prices = ((await Product.find({ orgId: w.orgId }, { sku: 1, sellingPrice: 1 }).sort({ sku: 1 }).lean().exec()) as any[]).map(p => p.sellingPrice)
    expect(prices).toEqual([20, 21, 22, 23, 24, 25])
  }, 60_000)

  it('every door at once (the form, a goods receipt, an import, a transfer, a count): no number twice, none skipped', async () => {
    const w = await world(11)
    const [a, b, c, d, e, f, g, h, i, j, k] = w.goods
    const mapped = (p: any, marker: string) => ({
      type: 'receipt' as const, date: `${year}-10-21`, toWarehouseId: String(w.main._id), notes: `Доставки (${marker})`, marker,
      lines: [{ productId: String(p._id), productName: p.name, quantity: 3, unitCost: 5 }], totalAmount: 15, newProducts: [],
    })
    const proposal = (p: any) => [{
      productId: String(p._id), productName: p.name, toWarehouseId: String(w.second._id), toWarehouseName: 'Втори склад',
      sources: [{ fromWarehouseId: String(w.main._id), fromWarehouseName: 'Основен', availableQuantity: 100, transferQuantity: 4 }],
      totalTransfer: 4, deficit: 0,
    }]
    const count = async (p: any) => {
      const made = await w.call('POST', '/warehouse/inventory-count', {
        warehouseId: String(w.main._id), date: `${year}-10-21`, type: 'partial',
        lines: [{ productId: String(p._id), systemQuantity: 100, countedQuantity: 97, variance: -3 }],
      })
      expect(made.status).toBe(200)
      return made.json.inventoryCount.id || made.json.inventoryCount._id
    }
    const [countOne, countTwo] = [await count(j), await count(k)]

    // Settled, never `all`: one refusal would end the test while the others still write, into a database the
    // next test has cleared.
    const done = await Promise.allSettled([
      w.call('POST', '/warehouse/movement', w.receipt(a)),
      w.call('POST', '/warehouse/movement', w.receipt(b)),
      w.call('POST', '/warehouse/movement', w.receipt(c)),
      w.call('POST', '/warehouse/movement/with-update', w.receipt(d, { productUpdates: [{ productId: String(d._id), sellingPrice: 31 }] })),
      w.call('POST', '/warehouse/movement/with-update', w.receipt(e, { productUpdates: [{ productId: String(e._id), sellingPrice: 32 }] })),
      persistMovement(w.orgId, String(w.user._id), mapped(f, 'stokrazp:9000000001') as any),
      persistMovement(w.orgId, String(w.user._id), mapped(g, 'stokrazp:9000000002') as any),
      createTransferMovements(w.orgId, proposal(h) as any, String(w.user._id)),
      createTransferMovements(w.orgId, proposal(i) as any, String(w.user._id)),
      w.call('POST', `/warehouse/inventory-count/${countOne}/complete`, {}),
      w.call('POST', `/warehouse/inventory-count/${countTwo}/complete`, {}),
    ])
    expect(done.map(d => (d.status === 'fulfilled' ? 'saved' : String((d as PromiseRejectedResult).reason?.message)))).toEqual(Array(11).fill('saved'))
    // The five route answers and the two completions.
    expect([0, 1, 2, 3, 4, 9, 10].map(n => (done[n] as any).value.status)).toEqual(Array(7).fill(200))
    expect(await w.numbers()).toEqual(firstNumbers(11))
    // Each count names the adjustment it booked.
    const counts = await getRepos().inventoryCounts.findMany({ orgId: w.orgId } as any)
    expect(counts.map((x: any) => x.status)).toEqual(['completed', 'completed'])
    expect(new Set(counts.map((x: any) => String(x.adjustmentMovementId))).size).toBe(2)
  }, 60_000)

  it('a number the caller chose is taken as it is: when another movement has it, the second is refused and none is renumbered', async () => {
    const w = await world(2)
    const mine = numbered(41)
    const first = await w.call('POST', '/warehouse/movement', w.receipt(w.goods[0], { movementNumber: mine }))
    expect([first.status, first.json.stockMovement.movementNumber]).toEqual([200, mine])
    const second = await w.call('POST', '/warehouse/movement', w.receipt(w.goods[1], { movementNumber: mine }))
    expect(second.status).toBeGreaterThanOrEqual(400)
    expect(await w.numbers()).toEqual([mine])
    // The next one the server numbers follows the latest, as ever.
    const next = await w.call('POST', '/warehouse/movement', w.receipt(w.goods[1]))
    expect(next.json.stockMovement.movementNumber).toBe(numbered(42))
  }, 60_000)
})

describe('the one place a movement is numbered', () => {
  const draft = (w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) => ({
    orgId: w.orgId, type: 'receipt', status: 'draft', date: new Date(), toWarehouseId: w.main._id,
    lines: [w.line(w.goods[0])], totalAmount: 10, createdBy: w.user._id, ...over,
  })

  it('the first of a year is 00001, the next follows the latest, and another year or another org does not count', async () => {
    const w = await world(1)
    expect(await nextMovementNumber(w.orgId)).toBe(numbered(1))
    await StockMovement.create(draft(w, { movementNumber: `SM-${year - 1}-00777` }) as any)
    expect(await nextMovementNumber(w.orgId)).toBe(numbered(1))
    await StockMovement.create(draft(w, { movementNumber: numbered(7) }) as any)
    await StockMovement.create(draft(w, { movementNumber: numbered(3) }) as any)
    expect(await nextMovementNumber(w.orgId)).toBe(numbered(8))
    // A number of another shape, a test's or a caller's, is not the latest of the year.
    await StockMovement.create(draft(w, { movementNumber: 'SM-OLD-1' }) as any)
    expect(await nextMovementNumber(w.orgId)).toBe(numbered(8))
    const other = await world(1)
    expect(await nextMovementNumber(other.orgId)).toBe(numbered(1))
    // The old DAO's reader, which the tests' fixtures number by, is the same one.
    expect(await stockMovementDao.getNextMovementNumber(w.orgId)).toBe(numbered(8))
  }, 60_000)

  it('past 99 999 in a year the numbers go on: a wider number is later than any of five digits (#714)', async () => {
    const w = await world(1)
    const sm = (n: number) => `SM-${year}-${String(n).padStart(5, '0')}`
    const put = (n: number) => StockMovement.create(draft(w, { movementNumber: sm(n) }) as any)
    await put(99_998)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-99999`)
    await put(99_999)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-100000`)
    // The one that used to be offered for ever: in text order `…-99999` is still the last.
    await put(100_000)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-100001`)
    await put(100_001)
    await put(250_000)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-250001`)
    // And through the door every creator uses: two at once, past the edge.
    const made = await Promise.allSettled([1, 2].map(() =>
      withMovementNumber(w.orgId, movementNumber => StockMovement.create(draft(w, { movementNumber }) as any))))
    expect(made.map(m => m.status)).toEqual(['fulfilled', 'fulfilled'])
    expect((await w.numbers()).map(n => Number(n.split('-').pop())).filter(n => n >= 250_000).sort((a, b) => a - b)).toEqual([250_000, 250_001, 250_002])
    // The same again at the next edge.
    await put(999_999)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-1000000`)
    await put(1_000_000)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-1000001`)
  }, 60_000)

  it('a number freed below the edge is given again before the wider ones go on', async () => {
    const w = await world(1)
    const put = (n: number) => StockMovement.create(draft(w, { movementNumber: `SM-${year}-${n}` }) as any)
    // 99999 was a draft, deleted since: the latest of five digits is 99998 again, and wider numbers exist.
    await put(99_998)
    await put(100_000)
    await put(100_001)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-99999`)
    await put(99_999)
    expect(await nextMovementNumber(w.orgId)).toBe(`SM-${year}-100002`)
  }, 60_000)

  it('a write by the model (the driver\'s own refusal) is tried again the same way: eight at once, eight numbers', async () => {
    const w = await world(1)
    const made = await Promise.allSettled(Array.from({ length: 8 }, () =>
      withMovementNumber(w.orgId, movementNumber => StockMovement.create(draft(w, { movementNumber }) as any))))
    expect(made.map(m => m.status)).toEqual(Array(8).fill('fulfilled'))
    expect(await w.numbers()).toEqual(firstNumbers(8))
  }, 60_000)

  it('what the write does is done again, so only what fails with the insert belongs in it; any other refusal passes at once', async () => {
    const w = await world(1)
    await StockMovement.create(draft(w, { movementNumber: numbered(1) }) as any)
    // Someone takes each number this creator reads, three times over.
    const tried: string[] = []
    const mine: any = await withMovementNumber(w.orgId, async (movementNumber) => {
      tried.push(movementNumber)
      if (tried.length <= 3) await StockMovement.create(draft(w, { movementNumber }) as any)
      return getRepos().stockMovements.create(draft(w, { movementNumber }) as any)
    })
    expect(tried).toEqual([numbered(2), numbered(3), numbered(4), numbered(5)])
    expect(mine.movementNumber).toBe(numbered(5))

    // A refusal that is not the number's is nobody's to try again.
    let calls = 0
    const other = await captureRejection(withMovementNumber(w.orgId, async () => { calls++; throw new Error('the warehouse is closed') }))
    expect([calls, other?.message]).toEqual([1, 'the warehouse is closed'])

    // A number that stays taken gives the refusal back after the last attempt, and writes nothing.
    const before = await StockMovement.countDocuments({ orgId: w.orgId })
    let attempts = 0
    const stuck = await captureRejection(withMovementNumber(w.orgId, async () => {
      attempts++
      return getRepos().stockMovements.create(draft(w, { movementNumber: numbered(1) }) as any)
    }))
    expect([attempts, stuck?.code]).toEqual([MOVEMENT_NUMBER_ATTEMPTS, 'DUPLICATE'])
    expect(await StockMovement.countDocuments({ orgId: w.orgId })).toBe(before)
  }, 60_000)

  it('only a refusal over the number counts as the number taken', async () => {
    const w = await world(1)
    await StockMovement.create(draft(w, { movementNumber: numbered(1) }) as any)
    // The DAL's refusal and the driver's, for the same number.
    const byDal = await captureRejection(getRepos().stockMovements.create(draft(w, { movementNumber: numbered(1) }) as any))
    const byModel = await captureRejection(StockMovement.create(draft(w, { movementNumber: numbered(1) }) as any))
    expect([byDal?.code, isMovementNumberTaken(byDal), byModel?.code, isMovementNumberTaken(byModel)]).toEqual(['DUPLICATE', true, 11000, true])
    // The same id inserted twice is a duplicate too, and not this one.
    const there: any = await StockMovement.findOne({ orgId: w.orgId }).lean().exec()
    const sameId = await captureRejection(StockMovement.collection.insertOne({ ...there, movementNumber: numbered(2) } as any))
    expect([sameId?.code, isMovementNumberTaken(sameId)]).toEqual([11000, false])
    expect([
      isMovementNumberTaken(new Error('E11000 somewhere in a message')),
      isMovementNumberTaken({ code: 'DUPLICATE', fields: { orgId: 'x', sku: 'PRD-1' } }),
      isMovementNumberTaken({ code: 'DUPLICATE', fields: { unknown: 'unknown' } }),
      isMovementNumberTaken(null),
    ]).toEqual([false, false, true, false])
  }, 60_000)
})
