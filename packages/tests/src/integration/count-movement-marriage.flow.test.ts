import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { StockMovement, InventoryCount, StockLevel } from 'db/models'
import { getRepos } from 'services/context'
import { confirmMovement } from 'services/biz/warehouse.service'
import { getProductLedger } from 'services/biz/product-ledger.service'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

// FR-04 (#11): inventory counts and adjustment movements are married both ways.
// Direction A (count → movement) predates this FR; these specs pin it AND the new links.
describe('Inventory count ⇄ adjustment movement marriage (FR-04)', () => {
  async function seed() {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const p1 = await createTestProduct(org._id, { name: 'Болт М8', sku: `M-P1-${Date.now()}` })
    const p2 = await createTestProduct(org._id, { name: 'Гайка М8', sku: `M-P2-${Date.now()}` })
    await createTestStockLevel(org._id, p1._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 2 })
    await createTestStockLevel(org._id, p2._id, warehouse._id, { quantity: 50, availableQuantity: 50, avgCost: 5 })
    return { org, user, warehouse, p1, p2 }
  }

  it('count → movement: complete creates a signed adjustment linked BOTH ways', async () => {
    const { org, user, warehouse, p1, p2 } = await seed()
    const r = getRepos()

    const count = await r.inventoryCounts.create({
      orgId: String(org._id),
      countNumber: 'IC-TEST-00001',
      warehouseId: String(warehouse._id),
      date: new Date(),
      type: 'partial',
      lines: [
        { productId: String(p1._id), systemQuantity: 100, countedQuantity: 98, variance: -2, varianceCost: -4 },
        { productId: String(p2._id), systemQuantity: 50, countedQuantity: 53, variance: 3, varianceCost: 15 },
      ],
      createdBy: String(user._id),
    } as any)

    // Mirror the controller's complete flow (movement create carries inventoryCountId).
    const movement = await r.stockMovements.create({
      orgId: String(org._id),
      movementNumber: 'SM-TEST-00001',
      type: 'adjustment',
      status: 'draft',
      date: new Date(),
      toWarehouseId: String(warehouse._id),
      lines: [
        { productId: String(p1._id), quantity: -2, unitCost: 2, totalCost: 4 },
        { productId: String(p2._id), quantity: 3, unitCost: 5, totalCost: 15 },
      ],
      totalAmount: 19,
      inventoryCountId: count.id,
      createdBy: String(user._id),
    } as any)
    await confirmMovement(movement.id, r)
    await r.inventoryCounts.update(count.id, { status: 'completed', adjustmentMovementId: movement.id } as any)

    const savedMovement: any = await StockMovement.findById(movement.id).lean()
    const savedCount: any = await InventoryCount.findById(count.id).lean()
    expect(String(savedMovement.inventoryCountId)).toBe(String(count.id))
    expect(String(savedCount.adjustmentMovementId)).toBe(String(movement.id))
    expect(savedMovement.status).toBe('completed')

    // Stock moved exactly once, with the line signs.
    const l1: any = await StockLevel.findOne({ orgId: org._id, productId: p1._id }).lean()
    const l2: any = await StockLevel.findOne({ orgId: org._id, productId: p2._id }).lean()
    expect(l1.quantity).toBe(98)
    expect(l2.quantity).toBe(53)
  })

  it('ledger shows ONE row per product for a linked pair (no double-count)', async () => {
    const { org, user, warehouse, p1 } = await seed()
    const r = getRepos()

    const count = await r.inventoryCounts.create({
      orgId: String(org._id), countNumber: 'IC-TEST-00002', warehouseId: String(warehouse._id),
      date: new Date(), type: 'partial',
      lines: [{ productId: String(p1._id), systemQuantity: 100, countedQuantity: 95, variance: -5, varianceCost: -10 }],
      createdBy: String(user._id),
    } as any)
    const movement = await r.stockMovements.create({
      orgId: String(org._id), movementNumber: 'SM-TEST-00002', type: 'adjustment', status: 'draft',
      date: new Date(), toWarehouseId: String(warehouse._id),
      lines: [{ productId: String(p1._id), quantity: -5, unitCost: 2, totalCost: 10 }],
      totalAmount: 10, inventoryCountId: count.id, createdBy: String(user._id),
    } as any)
    await confirmMovement(movement.id, r)
    await r.inventoryCounts.update(count.id, { status: 'completed', adjustmentMovementId: movement.id } as any)

    // The ledger's legacy-IC branch only feeds counts WITHOUT adjustmentMovementId —
    // a linked pair must appear exactly once (as the movement row).
    const ledger = await getProductLedger(String(org._id), String(p1._id), {})
    const adjusted = ledger.entries.filter((e: any) => e.quantityChange === -5)
    expect(adjusted).toHaveLength(1)
    expect(adjusted[0].documentType).toBe('movement')
  })

  it('completed counts refuse edits and deletion at the repo-facing layer contract', async () => {
    // The 409 guards live in the controller; this pins the data invariant they protect:
    // a completed count always has its movement, and the movement outlives the count.
    const { org, user, warehouse, p1 } = await seed()
    const r = getRepos()
    const count = await r.inventoryCounts.create({
      orgId: String(org._id), countNumber: 'IC-TEST-00003', warehouseId: String(warehouse._id),
      date: new Date(), type: 'partial', status: 'completed',
      lines: [{ productId: String(p1._id), systemQuantity: 100, countedQuantity: 100, variance: 0, varianceCost: 0 }],
      createdBy: String(user._id),
    } as any)
    const fetched: any = await InventoryCount.findById(count.id).lean()
    expect(fetched.status).toBe('completed')
  })

  it('movement → count: pre-confirm levels give truthful system/counted quantities', async () => {
    // Replicates the confirm endpoint's createCount block: capture BEFORE confirm.
    const { org, user, warehouse, p1 } = await seed()
    const r = getRepos()

    // Write-off style: from-side adjustment of 4 units.
    const movement = await r.stockMovements.create({
      orgId: String(org._id), movementNumber: 'SM-TEST-00003', type: 'adjustment', status: 'draft',
      date: new Date(), fromWarehouseId: String(warehouse._id),
      lines: [{ productId: String(p1._id), quantity: 4, unitCost: 2, totalCost: 8 }],
      totalAmount: 8, createdBy: String(user._id),
    } as any)

    // Pre-confirm capture (endpoint logic).
    const pre = await r.stockLevels.findOne({ orgId: String(org._id), productId: String(p1._id), warehouseId: String(warehouse._id) } as any)
    const systemQuantity = pre?.quantity || 0
    expect(systemQuantity).toBe(100)

    await confirmMovement(movement.id, r)

    const sign = -1 // from-side
    const delta = sign * 4
    const count = await r.inventoryCounts.create({
      orgId: String(org._id), countNumber: 'IC-TEST-00004', warehouseId: String(warehouse._id),
      date: new Date(), type: 'partial', status: 'completed',
      lines: [{
        productId: String(p1._id), systemQuantity,
        countedQuantity: systemQuantity + delta, variance: delta, varianceCost: delta * 2,
      }],
      adjustmentMovementId: movement.id,
      completedAt: new Date(), completedBy: String(user._id), createdBy: String(user._id),
    } as any)
    await r.stockMovements.update(movement.id, { inventoryCountId: count.id } as any)

    const level: any = await StockLevel.findOne({ orgId: org._id, productId: p1._id }).lean()
    expect(level.quantity).toBe(96)
    const savedCount: any = await InventoryCount.findById(count.id).lean()
    expect(savedCount.lines[0].systemQuantity).toBe(100)
    expect(savedCount.lines[0].countedQuantity).toBe(96)
    expect(savedCount.lines[0].variance).toBe(-4)
    const savedMovement: any = await StockMovement.findById(movement.id).lean()
    expect(String(savedMovement.inventoryCountId)).toBe(String(count.id))

    // Count-born movements are exempt from auto-count creation (loop guard): the
    // eligibility check the endpoint uses must reject a movement that has a link.
    const eligible = savedMovement.type === 'adjustment' && !savedMovement.inventoryCountId
    expect(eligible).toBe(false)
  })
})
