import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { StockLevel, StockMovement, CostLayer, Org } from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose
import { confirmMovement, adjustStock } from 'services/biz/warehouse.service'
import { getEffectiveCostingMethod, consumeCostLayers, createCostLayers, getInventoryValuation, initializeCostLayers } from 'services/biz/costing.service'
import { createMongoRepositories } from 'dal-mongo'

let repos: Awaited<ReturnType<typeof createMongoRepositories>>

beforeAll(async () => {
  await setupTestDB()
  repos = await createMongoRepositories({ backend: 'mongo' })
})

afterAll(async () => {
  await teardownTestDB()
})

describe('getEffectiveCostingMethod', () => {
  it('returns product costingMethod when set', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'fifo' })
    const method = await getEffectiveCostingMethod(String(org._id), String(product._id), repos)
    expect(method).toBe('fifo')
  })

  it('falls back to org default when product has no override', async () => {
    const org = await createTestOrg()
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.inventory.defaultCostingMethod': 'lifo' } })
    const product = await createTestProduct(org._id)
    const method = await getEffectiveCostingMethod(String(org._id), String(product._id), repos)
    expect(method).toBe('lifo')
  })

  it('falls back to wac when neither product nor org specifies', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const method = await getEffectiveCostingMethod(String(org._id), String(product._id), repos)
    expect(method).toBe('wac')
  })
})

describe('FIFO costing flow', () => {
  it('creates layers on receipt and consumes oldest first on dispatch', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'fifo' })
    const warehouse = await createTestWarehouse(org._id)
    const orgId = String(org._id)
    const productId = String(product._id)
    const warehouseId = String(warehouse._id)
    const userId = new Types.ObjectId()

    // Receipt 1: 100 @ $10
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FIFO-1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 10, totalCost: 1000 }],
      totalAmount: 1000, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Receipt 2: 50 @ $15
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FIFO-2', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 15, totalCost: 750 }],
      totalAmount: 750, createdBy: userId,
    })
    await confirmMovement(String(m2._id), repos)

    // Verify 2 cost layers created
    const layers = await CostLayer.find({ orgId: org._id, productId: product._id }).sort({ receivedAt: 1 })
    expect(layers).toHaveLength(2)
    expect(layers[0].remainingQuantity).toBe(100)
    expect(layers[0].unitCost).toBe(10)
    expect(layers[1].remainingQuantity).toBe(50)
    expect(layers[1].unitCost).toBe(15)

    // Dispatch: 80 units (should consume from oldest layer first)
    const m3 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FIFO-3', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 80, unitCost: 10, totalCost: 800 }],
      totalAmount: 800, createdBy: userId,
    })
    const confirmed = await confirmMovement(String(m3._id), repos)

    // Verify layer consumption: oldest consumed first
    const updatedLayers = await CostLayer.find({ orgId: org._id, productId: product._id }).sort({ receivedAt: 1 })
    expect(updatedLayers[0].remainingQuantity).toBe(20) // 100 - 80
    expect(updatedLayers[0].isExhausted).toBe(false)
    expect(updatedLayers[1].remainingQuantity).toBe(50) // untouched
    expect(updatedLayers[1].isExhausted).toBe(false)

    // Verify cost allocations on confirmed movement
    const confirmedMovement = await StockMovement.findById(m3._id)
    expect(confirmedMovement!.lines[0].resolvedUnitCost).toBe(10)
    expect(confirmedMovement!.lines[0].costingMethod).toBe('fifo')
    expect(confirmedMovement!.lines[0].costAllocations).toHaveLength(1)
    expect(confirmedMovement!.lines[0].costAllocations![0].quantity).toBe(80)
  })

  it('consumes across multiple layers when dispatch exceeds first layer', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'fifo' })
    const warehouse = await createTestWarehouse(org._id)
    const userId = new Types.ObjectId()

    // Receipt 1: 30 @ $10
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FIFO-X1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 10, totalCost: 300 }],
      totalAmount: 300, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Receipt 2: 40 @ $20
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FIFO-X2', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 40, unitCost: 20, totalCost: 800 }],
      totalAmount: 800, createdBy: userId,
    })
    await confirmMovement(String(m2._id), repos)

    // Dispatch: 50 units (30 from layer1 @ $10 + 20 from layer2 @ $20)
    const m3 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FIFO-X3', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 10, totalCost: 500 }],
      totalAmount: 500, createdBy: userId,
    })
    const confirmed = await confirmMovement(String(m3._id), repos)

    // Verify: layer 1 exhausted, layer 2 partially consumed
    const layers = await CostLayer.find({ orgId: org._id, productId: product._id }).sort({ receivedAt: 1 })
    expect(layers[0].remainingQuantity).toBe(0)
    expect(layers[0].isExhausted).toBe(true)
    expect(layers[1].remainingQuantity).toBe(20)

    // Verify weighted COGS: (30*10 + 20*20) / 50 = 700/50 = 14
    const confirmedMovement = await StockMovement.findById(m3._id)
    expect(confirmedMovement!.lines[0].resolvedUnitCost).toBe(14)
    expect(confirmedMovement!.lines[0].costAllocations).toHaveLength(2)
  })
})

describe('LIFO costing flow', () => {
  it('consumes newest layers first', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'lifo' })
    const warehouse = await createTestWarehouse(org._id)
    const userId = new Types.ObjectId()

    // Receipt 1: 50 @ $10 (older)
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-LIFO-1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id, date: new Date('2026-01-01'),
      lines: [{ productId: product._id, quantity: 50, unitCost: 10, totalCost: 500 }],
      totalAmount: 500, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Receipt 2: 30 @ $20 (newer)
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-LIFO-2', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id, date: new Date('2026-02-01'),
      lines: [{ productId: product._id, quantity: 30, unitCost: 20, totalCost: 600 }],
      totalAmount: 600, createdBy: userId,
    })
    await confirmMovement(String(m2._id), repos)

    // Dispatch: 40 (should consume newest first: 30@$20 + 10@$10)
    const m3 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-LIFO-3', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 40, unitCost: 10, totalCost: 400 }],
      totalAmount: 400, createdBy: userId,
    })
    await confirmMovement(String(m3._id), repos)

    const layers = await CostLayer.find({ orgId: org._id, productId: product._id }).sort({ receivedAt: 1 })
    expect(layers[0].remainingQuantity).toBe(40) // older layer: 50-10=40
    expect(layers[1].remainingQuantity).toBe(0)  // newer layer: fully consumed
    expect(layers[1].isExhausted).toBe(true)

    // COGS: (30*20 + 10*10) / 40 = 700/40 = 17.5
    const confirmedMovement = await StockMovement.findById(m3._id)
    expect(confirmedMovement!.lines[0].resolvedUnitCost).toBe(17.5)
    expect(confirmedMovement!.lines[0].costingMethod).toBe('lifo')
  })
})

describe('WAC backward compatibility', () => {
  it('does not create or consume cost layers for WAC products', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id) // no costingMethod = WAC default
    const warehouse = await createTestWarehouse(org._id)
    const userId = new Types.ObjectId()

    // Receipt
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-WAC-1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 10, totalCost: 1000 }],
      totalAmount: 1000, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Verify NO cost layers created
    const layers = await CostLayer.find({ orgId: org._id, productId: product._id })
    expect(layers).toHaveLength(0)

    // Verify stock level uses avgCost
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id })
    expect(level!.quantity).toBe(100)
    expect(level!.avgCost).toBe(10)

    // Receipt 2 at different cost
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-WAC-2', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 14, totalCost: 1400 }],
      totalAmount: 1400, createdBy: userId,
    })
    await confirmMovement(String(m2._id), repos)

    const level2 = await StockLevel.findOne({ orgId: org._id, productId: product._id })
    expect(level2!.quantity).toBe(200)
    expect(level2!.avgCost).toBe(12) // (100*10 + 100*14) / 200 = 12

    // Dispatch
    const m3 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-WAC-3', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 12, totalCost: 600 }],
      totalAmount: 600, createdBy: userId,
    })
    await confirmMovement(String(m3._id), repos)

    // Still no cost layers
    const layersAfter = await CostLayer.find({ orgId: org._id, productId: product._id })
    expect(layersAfter).toHaveLength(0)

    // WAC dispatch: resolvedUnitCost should be avgCost
    const confirmedMovement = await StockMovement.findById(m3._id)
    expect(confirmedMovement!.lines[0].costingMethod).toBe('wac')
    expect(confirmedMovement!.lines[0].resolvedUnitCost).toBe(12)
  })
})

describe('Standard Cost', () => {
  it('uses product standardCost regardless of receipt price', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'standard', standardCost: 15 })
    const warehouse = await createTestWarehouse(org._id)
    const userId = new Types.ObjectId()

    // Receipt at actual $12 (differs from standard $15)
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-STD-1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 12, totalCost: 1200 }],
      totalAmount: 1200, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Dispatch: COGS should use standardCost ($15), not actual ($12)
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-STD-2', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 15, totalCost: 750 }],
      totalAmount: 750, createdBy: userId,
    })
    await confirmMovement(String(m2._id), repos)

    const confirmed = await StockMovement.findById(m2._id)
    expect(confirmed!.lines[0].resolvedUnitCost).toBe(15)
    expect(confirmed!.lines[0].costingMethod).toBe('standard')
    expect(confirmed!.lines[0].costAllocations).toHaveLength(0) // no layer consumption
  })
})

describe('initializeCostLayers', () => {
  it('creates baseline layers from existing WAC stock levels', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    // Create stock level manually (simulating existing WAC data)
    await StockLevel.create({
      orgId: org._id, productId: product._id, warehouseId: warehouse._id,
      quantity: 200, reservedQuantity: 0, availableQuantity: 200, avgCost: 8,
    })

    const created = await initializeCostLayers(String(org._id), String(product._id), repos)
    expect(created).toBe(1)

    const layers = await CostLayer.find({ orgId: org._id, productId: product._id })
    expect(layers).toHaveLength(1)
    expect(layers[0].remainingQuantity).toBe(200)
    expect(layers[0].unitCost).toBe(8)
    expect(layers[0].sourceMovementNumber).toBe('INIT')
  })
})

describe('Insufficient layers', () => {
  it('throws when dispatching more than available layers', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'fifo' })
    const warehouse = await createTestWarehouse(org._id)
    const userId = new Types.ObjectId()

    // Receipt: only 10 units
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-INSUF-1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 10, totalCost: 100 }],
      totalAmount: 100, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Dispatch: 15 units (insufficient)
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-INSUF-2', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 15, unitCost: 10, totalCost: 150 }],
      totalAmount: 150, createdBy: userId,
    })

    await expect(confirmMovement(String(m2._id), repos)).rejects.toThrow('Insufficient cost layers')
  })
})
