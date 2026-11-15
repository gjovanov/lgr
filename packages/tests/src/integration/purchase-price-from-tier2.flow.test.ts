import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { Product, StockLevel } from 'db/models'
import { restorePurchasePrices, setPurchasePricesFromTier2 } from 'services/biz/purchase-price-from-tier2'

/**
 * The one-time correction of an org's purchase prices (owner, 2026-11-15): „Покупна цена" = „Цена 2" / 1.2, run by
 * `scripts/set-purchase-price-from-tier2.ts`. Held to a real database: a dry run writes nothing; a run moves the
 * purchase price and the margins over it and NO price; a second run is a no-op; a restore puts it back; a product
 * without „Цена 2" and another org's products are untouched.
 *
 * NOTE: no `.rejects` / `.resolves` (they deadlock Bun on Windows): `captureRejection`.
 */

let orgId: string
let otherOrgId: string
let warehouseId: string
let dir: string

/** A slot as an import writes one: priced, fixed by hand, its margin to one decimal over the delivery price. */
const pinned = (name: string, finalPrice: number, percent: number) => ({ name, percent, finalPrice, manualOverride: finalPrice > 0, contactIds: [], tags: [] })

/** An article as the daily import left it until 2026-11-15: the delivery price as its purchase price. */
function imported(delivery: number, price2: number) {
  return {
    purchasePrice: delivery,
    sellingPrice: 3,
    priceTiers: [
      pinned('Доставна цена', delivery, 0),
      pinned('Цена на едро', 1.5, 50),
      pinned('Цена 2', price2, +(((price2 - delivery) / delivery) * 100).toFixed(1)),
      pinned('Цена 3', 0, 0),
    ],
  }
}

const prices = async (id: unknown) => {
  const p: any = await Product.findById(id).lean().exec()
  return {
    purchase: p.purchasePrice,
    selling: p.sellingPrice,
    finals: p.priceTiers.map((t: any) => t.finalPrice),
    percents: p.priceTiers.map((t: any) => t.percent),
    pins: p.priceTiers.map((t: any) => t.manualOverride),
  }
}

beforeAll(async () => {
  await setupTestDB()
  dir = mkdtempSync(join(tmpdir(), 'lgr-purchase-price-'))
})

afterAll(async () => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  await teardownTestDB()
})

beforeEach(async () => {
  await Promise.all([Product.deleteMany({}), StockLevel.deleteMany({})])
  const [org, other] = await Promise.all([createTestOrg({ slug: `pp-${Date.now()}` }), createTestOrg({ slug: `pp-other-${Date.now()}` })])
  orgId = String(org._id)
  otherOrgId = String(other._id)
  warehouseId = String((await createTestWarehouse(org._id))._id)
})

describe('setPurchasePricesFromTier2', () => {
  it('a dry run counts and writes nothing', async () => {
    const a = await createTestProduct(orgId as any, imported(1, 2.4))
    const before = await prices(a._id)

    const res = await setPurchasePricesFromTier2(orgId)
    expect([res.products, res.changed, res.alreadyRight, res.noTier2, res.written]).toEqual([1, 1, 0, 0, 0])
    expect(res.samples).toEqual([{ sku: a.sku, tier2: 2.4, from: 1, to: 2, margins: 3 }])
    expect(await prices(a._id)).toEqual(before)
  })

  it('a run that writes needs a backup file, and never writes over one', async () => {
    await createTestProduct(orgId as any, imported(1, 2.4))
    const none = await captureRejection(setPurchasePricesFromTier2(orgId, { execute: true }))
    expect(String(none?.message)).toContain('backup')

    const taken = join(dir, 'taken.ndjson')
    writeFileSync(taken, 'an earlier backup\n')
    const over = await captureRejection(setPurchasePricesFromTier2(orgId, { execute: true, backupPath: taken }))
    expect(String((over as any)?.code)).toBe('EEXIST')
    expect(readFileSync(taken, 'utf8')).toBe('an earlier backup\n')
  })

  it('sets the purchase price and the margins over it, and moves no price', async () => {
    const a = await createTestProduct(orgId as any, imported(1, 2.4))
    await StockLevel.create({ orgId, productId: a._id, warehouseId, quantity: 7, reservedQuantity: 0, availableQuantity: 7, avgCost: 1 })
    const before = await prices(a._id)
    const backupPath = join(dir, 'run.ndjson')

    const res = await setPurchasePricesFromTier2(orgId, { execute: true, backupPath })
    expect([res.changed, res.written]).toEqual([1, 1])

    const after = await prices(a._id)
    expect(after.purchase).toBe(2)
    // No price moved: not a slot's, not the selling price, and the slots stay fixed as they were.
    expect([after.finals, after.selling, after.pins]).toEqual([before.finals, before.selling, before.pins])
    // The margins are over the new purchase price: the delivery slot stands under it, „Цена 2" exactly 20 % over.
    expect(after.percents).toEqual([-50, -25, 20, 0])
    const level: any = await StockLevel.findOne({ orgId, productId: a._id }).lean().exec()
    expect([level.quantity, level.avgCost]).toEqual([7, 1])

    const lines = readFileSync(backupPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([{
      _id: String(a._id), sku: a.sku, purchasePrice: { from: 1, to: 2 },
      percents: [
        { index: 0, name: 'Доставна цена', from: 0, to: -50 },
        { index: 1, name: 'Цена на едро', from: 50, to: -25 },
        { index: 2, name: 'Цена 2', from: 140, to: 20 },
      ],
    }])
  })

  it('a second run changes nothing', async () => {
    const a = await createTestProduct(orgId as any, imported(0.9, 1.2))
    await setPurchasePricesFromTier2(orgId, { execute: true, backupPath: join(dir, 'first.ndjson') })
    const once = await prices(a._id)

    const second = join(dir, 'second.ndjson')
    const res = await setPurchasePricesFromTier2(orgId, { execute: true, backupPath: second })
    expect([res.changed, res.alreadyRight, res.written]).toEqual([0, 1, 0])
    expect(await prices(a._id)).toEqual(once)
    expect(readFileSync(second, 'utf8')).toBe('')
  })

  it('leaves a product without „Цена 2" alone, corrects a deactivated one, and never reaches another org', async () => {
    const none = await createTestProduct(orgId as any, { purchasePrice: 4, sellingPrice: 6, priceTiers: [pinned('Доставна цена', 4, 0), pinned('Цена 2', 0, 0)] })
    const bare = await createTestProduct(orgId as any, { purchasePrice: 5, sellingPrice: 6, priceTiers: [] })
    const off = await createTestProduct(orgId as any, { ...imported(1, 2.4), isActive: false, deactivatedAt: new Date() })
    const theirs = await createTestProduct(otherOrgId as any, imported(1, 2.4))
    const [noneBefore, bareBefore, theirsBefore] = await Promise.all([prices(none._id), prices(bare._id), prices(theirs._id)])

    const res = await setPurchasePricesFromTier2(orgId, { execute: true, backupPath: join(dir, 'mixed.ndjson') })
    expect([res.products, res.changed, res.inactiveChanged, res.noTier2, res.written]).toEqual([3, 1, 1, 2, 1])
    expect(await prices(none._id)).toEqual(noneBefore)
    expect(await prices(bare._id)).toEqual(bareBefore)
    expect((await prices(off._id)).purchase).toBe(2)
    expect(await prices(theirs._id)).toEqual(theirsBefore)
  })

  it('keeps each kind of slot what it was: a follower follows, a backfilled slot stays out of it', async () => {
    const a = await createTestProduct(orgId as any, {
      purchasePrice: 1, sellingPrice: 3,
      priceTiers: [
        { name: 'Цена 2', percent: 140, finalPrice: 2.4, manualOverride: true },
        // Priced from the purchase price by its margin, in the product form: it follows the purchase price.
        { name: 'Цена 4', percent: 50, finalPrice: 1.5, manualOverride: false },
        // A backfilled slot: the selling price at 0 %. It never followed, and a true margin would make it follow.
        { name: 'Цена 5', percent: 0, finalPrice: 3, manualOverride: false },
      ],
    })
    await setPurchasePricesFromTier2(orgId, { execute: true, backupPath: join(dir, 'kinds.ndjson') })
    const after = await prices(a._id)
    expect(after.purchase).toBe(2)
    expect(after.finals).toEqual([2.4, 1.5, 3])
    expect(after.percents).toEqual([20, -25, 0])
    expect(after.pins).toEqual([true, false, false])
  })
})

describe('restorePurchasePrices', () => {
  it('puts the before-values back, and leaves a product edited since the run as it is', async () => {
    const a = await createTestProduct(orgId as any, imported(1, 2.4))
    const edited = await createTestProduct(orgId as any, imported(1, 3.6))
    const [aBefore, editedBefore] = await Promise.all([prices(a._id), prices(edited._id)])
    const backupPath = join(dir, 'restore.ndjson')
    await setPurchasePricesFromTier2(orgId, { execute: true, backupPath })
    expect(existsSync(backupPath)).toBe(true)
    // Somebody set this one's purchase price after the run: that is theirs.
    await Product.updateOne({ _id: edited._id }, { $set: { purchasePrice: 2.75 } }).exec()

    const dry = await restorePurchasePrices(orgId, backupPath)
    expect([dry.lines, dry.restored, dry.skipped]).toEqual([2, 1, 1])
    expect((await prices(a._id)).purchase).toBe(2)

    const res = await restorePurchasePrices(orgId, backupPath, { execute: true })
    expect([res.lines, res.restored, res.skipped]).toEqual([2, 1, 1])
    expect(await prices(a._id)).toEqual(aBefore)
    const kept = await prices(edited._id)
    expect(kept.purchase).toBe(2.75)
    expect(kept.finals).toEqual(editedBefore.finals)
  })
})
