import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { createMovementWithProductUpdates, updateMovementWithProductUpdates, GRValidationError } from 'services/biz/movement-with-update.service'
import { Product, StockMovement } from 'db/models'

/** try/catch capture instead of `expect(...).rejects` — on Windows, Bun 1.3.12's
 *  `.rejects` matcher deadlocks when the rejection follows MongoDB driver I/O. */
async function captureRejection(p: Promise<any>): Promise<any> {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Phase 4b — atomic GR-with-product-update.
 * Exercises the service directly (same path the controller uses).
 *
 * Requires replica set in the test environment (MongoMemoryReplSet in setup.ts).
 */
describe('GR-with-update (positive)', () => {
  it('applies both product updates and creates the movement', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p1 = await createTestProduct(org._id, { sku: 'SKU-A', sellingPrice: 100, purchasePrice: 50 } as any)
    const p2 = await createTestProduct(org._id, { sku: 'SKU-B', sellingPrice: 200, purchasePrice: 100 } as any)

    const { movementId, updatedProductIds } = await createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-00001',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [
          { productId: String(p1._id), quantity: 10, unitCost: 55, totalCost: 550 },
          { productId: String(p2._id), quantity: 5,  unitCost: 110, totalCost: 550 },
        ],
        totalAmount: 1100,
        createdBy: String(user._id),
      },
      [
        { productId: String(p1._id), purchasePrice: 55, priceTiers: [{ name: 'Price 1', percent: 20, finalPrice: 66, manualOverride: false }] },
        { productId: String(p2._id), purchasePrice: 110 },
      ],
    )

    expect(movementId).toBeTruthy()
    expect(updatedProductIds).toHaveLength(2)

    const movement = await StockMovement.findById(movementId).lean()
    expect(movement).toBeTruthy()
    expect(movement?.movementNumber).toBe('SM-2026-00001')
    expect(movement?.lines).toHaveLength(2)

    const p1After = await Product.findById(p1._id).lean()
    expect(p1After?.purchasePrice).toBe(55)
    expect(p1After?.priceTiers).toHaveLength(1)
    expect(p1After?.priceTiers[0].finalPrice).toBe(66)

    const p2After = await Product.findById(p2._id).lean()
    expect(p2After?.purchasePrice).toBe(110)
  })

  it('works with zero productUpdates (plain movement creation)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p = await createTestProduct(org._id)

    const { movementId, updatedProductIds } = await createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-00002',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(p._id), quantity: 1, unitCost: 1, totalCost: 1 }],
        totalAmount: 1,
        createdBy: String(user._id),
      },
      [],
    )
    expect(movementId).toBeTruthy()
    expect(updatedProductIds).toHaveLength(0)
  })
})

describe('GR-with-update (negative)', () => {
  it('rejects movement without lines', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    expectRejection(await captureRejection(createMovementWithProductUpdates(
      { orgId: String(org._id), movementNumber: 'SM-2026-X', type: 'receipt', date: new Date(), toWarehouseId: String(wh._id), lines: [], totalAmount: 0, createdBy: String(user._id) },
      [])), GRValidationError)
  })

  it('rejects productUpdate for a product not in any line', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const pInLine = await createTestProduct(org._id)
    const pRogue = await createTestProduct(org._id, { sku: 'ROGUE' } as any)

    expectRejection(await captureRejection(createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-Y',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(pInLine._id), quantity: 1, unitCost: 1, totalCost: 1 }],
        totalAmount: 1,
        createdBy: String(user._id),
      },
      [{ productId: String(pRogue._id), purchasePrice: 999 }])), /not in any movement line/i)
  })

  it('aborts whole transaction when a product update violates schema (rollback)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p = await createTestProduct(org._id, { purchasePrice: 50, sellingPrice: 100 } as any)

    // 11 tiers → validator rejects, transaction aborts, movement NOT created.
    const elevenTiers = Array.from({ length: 11 }, (_, i) => ({ name: `T${i}`, percent: 0, finalPrice: 100, manualOverride: false }))
    expectRejection(await captureRejection(createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-Z',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(p._id), quantity: 1, unitCost: 1, totalCost: 1 }],
        totalAmount: 1,
        createdBy: String(user._id),
      },
      [{ productId: String(p._id), priceTiers: elevenTiers }])))

    // Verify rollback — product unchanged + no movement persisted.
    const pAfter = await Product.findById(p._id).lean()
    expect(pAfter?.purchasePrice).toBe(50)
    expect((pAfter?.priceTiers || []).length).toBe(0)
    const movements = await StockMovement.find({ orgId: org._id, movementNumber: 'SM-2026-Z' }).lean()
    expect(movements).toHaveLength(0)
  })

  it('rejects productUpdate targeting a different org', async () => {
    const orgA = await createTestOrg({ slug: 'gr-upd-a' })
    const orgB = await createTestOrg({ slug: 'gr-upd-b' })
    const user = await createTestUser(orgA._id)
    const wh = await createTestWarehouse(orgA._id)
    const pA = await createTestProduct(orgA._id)
    const pB = await createTestProduct(orgB._id)

    // line references pA (orgA), productUpdate references pB (orgB) — but since pB isn't in any line,
    // it trips the "not in any movement line" guard first. Good: either guard works.
    expectRejection(await captureRejection(createMovementWithProductUpdates(
      {
        orgId: String(orgA._id),
        movementNumber: 'SM-2026-XO',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(pA._id), quantity: 1, unitCost: 1, totalCost: 1 }],
        totalAmount: 1,
        createdBy: String(user._id),
      },
      [{ productId: String(pB._id), purchasePrice: 1 }])))
  })

  it('drops unknown productUpdate fields silently (type safety at the edge)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p = await createTestProduct(org._id, { sellingPrice: 100 } as any)

    const { movementId } = await createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-DROP',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(p._id), quantity: 1, unitCost: 1, totalCost: 1 }],
        totalAmount: 1,
        createdBy: String(user._id),
      },
      [{ productId: String(p._id), purchasePrice: 77, evilField: 'haxxor', __proto__: 'nope' } as any],
    )
    expect(movementId).toBeTruthy()
    const pAfter = await Product.findById(p._id).lean() as any
    expect(pAfter.purchasePrice).toBe(77)
    expect(pAfter.evilField).toBeUndefined()
  })
})

describe('GR-with-update edit (draft movements)', () => {
  it('updates a draft movement and its products atomically', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p = await createTestProduct(org._id, { purchasePrice: 50, sellingPrice: 100 } as any)

    const { movementId } = await createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-EDIT1',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(p._id), quantity: 2, unitCost: 50, totalCost: 100 }],
        totalAmount: 100,
        createdBy: String(user._id),
      },
      [],
    )

    const { updatedProductIds } = await updateMovementWithProductUpdates({
      orgId: String(org._id),
      movementId,
      update: {
        notes: 'edited draft receipt',
        lines: [{ productId: String(p._id), quantity: 3, unitCost: 55, totalCost: 165 }],
        totalAmount: 165,
      },
      productUpdates: [{ productId: String(p._id), purchasePrice: 55 }],
    })

    expect(updatedProductIds).toEqual([String(p._id)])
    const mAfter: any = await StockMovement.findById(movementId).lean()
    expect(mAfter.notes).toBe('edited draft receipt')
    expect(mAfter.lines[0].quantity).toBe(3)
    expect(mAfter.totalAmount).toBe(165)
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(55)
  })

  it('refuses to edit a confirmed movement — nothing changes', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const wh = await createTestWarehouse(org._id)
    const p = await createTestProduct(org._id, { purchasePrice: 50 } as any)

    const { movementId } = await createMovementWithProductUpdates(
      {
        orgId: String(org._id),
        movementNumber: 'SM-2026-EDIT2',
        type: 'receipt',
        date: new Date(),
        toWarehouseId: String(wh._id),
        lines: [{ productId: String(p._id), quantity: 1, unitCost: 50, totalCost: 50 }],
        totalAmount: 50,
        createdBy: String(user._id),
      },
      [],
    )
    await StockMovement.updateOne({ _id: movementId }, { $set: { status: 'confirmed' } })

    const err = await captureRejection(updateMovementWithProductUpdates({
      orgId: String(org._id),
      movementId,
      update: { notes: 'should not apply' },
      productUpdates: [{ productId: String(p._id), purchasePrice: 999 }],
    }))
    expect(err).toBeInstanceOf(GRValidationError)
    expect(String(err?.message)).toMatch(/only edit draft/i)

    const mAfter: any = await StockMovement.findById(movementId).lean()
    expect(mAfter.notes).not.toBe('should not apply')
    const pAfter: any = await Product.findById(p._id).lean()
    expect(pAfter.purchasePrice).toBe(50)
  })
})
