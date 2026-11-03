import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { StockLevel, StockMovement, CostLayer, Org } from 'db/models'
import { mongoose } from 'db/connection'
const { Types } = mongoose
import { confirmMovement, adjustStock } from 'services/biz/warehouse.service'
import { getEffectiveCostingMethod, consumeCostLayers, createCostLayers, getInventoryValuation, initializeCostLayers, restoreCostLayers } from 'services/biz/costing.service'
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

describe('FEFO costing flow', () => {
  it('consumes earliest expiry layers first', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'fefo' })
    const warehouse = await createTestWarehouse(org._id)
    const userId = new Types.ObjectId()

    // Receipt 1: 50 @ $10, expires 2026-12-01 (later)
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FEFO-1', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 10, totalCost: 500, expiryDate: new Date('2026-12-01') }],
      totalAmount: 500, createdBy: userId,
    })
    await confirmMovement(String(m1._id), repos)

    // Receipt 2: 30 @ $20, expires 2026-06-01 (earlier — should be consumed first)
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FEFO-2', type: 'receipt',
      status: 'draft', toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 20, totalCost: 600, expiryDate: new Date('2026-06-01') }],
      totalAmount: 600, createdBy: userId,
    })
    await confirmMovement(String(m2._id), repos)

    // Dispatch 20 — should consume from layer2 (earlier expiry) first
    const m3 = await StockMovement.create({
      orgId: org._id, movementNumber: 'SM-FEFO-3', type: 'dispatch',
      status: 'draft', fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 20, unitCost: 10, totalCost: 200 }],
      totalAmount: 200, createdBy: userId,
    })
    await confirmMovement(String(m3._id), repos)

    const layers = await CostLayer.find({ orgId: org._id, productId: product._id }).sort({ expiryDate: 1 })
    // Layer with earlier expiry (2026-06-01) should be consumed first
    expect(layers[0].expiryDate!.toISOString().split('T')[0]).toBe('2026-06-01')
    expect(layers[0].remainingQuantity).toBe(10) // 30 - 20
    expect(layers[1].expiryDate!.toISOString().split('T')[0]).toBe('2026-12-01')
    expect(layers[1].remainingQuantity).toBe(50) // untouched

    const confirmed = await StockMovement.findById(m3._id)
    expect(confirmed!.lines[0].resolvedUnitCost).toBe(20) // consumed from $20 layer
    expect(confirmed!.lines[0].costingMethod).toBe('fefo')
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

describe('dispatches taking from one layer at once', () => {
  const setup = async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { costingMethod: 'fifo' })
    const warehouse = await createTestWarehouse(org._id)
    const ids = [String(org._id), String(product._id), String(warehouse._id)] as const
    const layer = (remainingQuantity: number, unitCost: number, receivedAt: string) =>
      CostLayer.create({
        orgId: org._id, productId: product._id, warehouseId: warehouse._id,
        unitCost, initialQuantity: remainingQuantity, remainingQuantity,
        sourceMovementId: new Types.ObjectId(), sourceMovementNumber: `SM-AT-ONCE-${receivedAt}`,
        receivedAt: new Date(receivedAt), isExhausted: false,
      })
    const take = (quantity: number) => consumeCostLayers(...ids, quantity, 'fifo', repos)
    const layerOf = async (id: unknown) => (await CostLayer.findById(id).lean().exec()) as any
    return { take, layer, layerOf }
  }

  it('loses none of them', async () => {
    const w = await setup()
    const made = await w.layer(100, 10, '2026-01-01')
    const before = new Date((made as any).updatedAt).getTime()
    await Bun.sleep(5)

    const results = await Promise.all(Array.from({ length: 20 }, () => w.take(3)))

    const layer = await w.layerOf(made._id)
    expect(layer.remainingQuantity).toBe(40)
    expect(layer.isExhausted).toBe(false)
    expect(results.every(r => r.allocations.length === 1 && r.allocations[0].quantity === 3)).toBe(true)
    expect(new Date(layer.updatedAt).getTime()).toBeGreaterThan(before)
  })

  it('one that loses the race for a layer takes the rest from the next, in order', async () => {
    const w = await setup()
    const older = await w.layer(10, 10, '2026-01-01')
    const newer = await w.layer(50, 15, '2026-02-01')

    const results = await Promise.all([w.take(8), w.take(8)])

    const first = await w.layerOf(older._id)
    expect(first.remainingQuantity).toBe(0)
    expect(first.isExhausted).toBe(true)
    expect((await w.layerOf(newer._id)).remainingQuantity).toBe(44)
    // Every unit is costed once: 10 at 10 from the older layer, 6 at 15 from the newer one.
    expect(results.reduce((s, r) => s + r.totalCost, 0)).toBe(10 * 10 + 6 * 15)
    expect(results.flatMap(r => r.allocations).reduce((s, a) => s + a.quantity, 0)).toBe(16)
  })

  it('more than the layers hold is still refused, and the refused one keeps nothing', async () => {
    const w = await setup()
    const made = await w.layer(10, 10, '2026-01-01')

    const outcomes = await Promise.all([captureRejection(w.take(6)), captureRejection(w.take(6))])

    // One of the two is covered; the other finds only 4 left, says so, and puts them back.
    const refused = outcomes.filter(Boolean)
    expect(refused).toHaveLength(1)
    expectRejection(refused[0], 'Insufficient cost layers')
    expect((await w.layerOf(made._id)).remainingQuantity).toBe(4)
  })

  it('goods put back by a void at the same time all come back', async () => {
    const w = await setup()
    const made = await w.layer(40, 10, '2026-01-01')
    const back = { costLayerId: String(made._id), quantity: 2, unitCost: 10, totalCost: 20 }

    await Promise.all([
      ...Array.from({ length: 10 }, () => restoreCostLayers([back], repos)),
      ...Array.from({ length: 10 }, () => w.take(1)),
    ])

    expect((await w.layerOf(made._id)).remainingQuantity).toBe(40 + 20 - 10)
  })

  it('a void reopens an exhausted layer', async () => {
    const w = await setup()
    const made = await w.layer(5, 10, '2026-01-01')
    await w.take(5)
    expect((await w.layerOf(made._id)).isExhausted).toBe(true)

    await restoreCostLayers([{ costLayerId: String(made._id), quantity: 2, unitCost: 10, totalCost: 20 }], repos)

    const layer = await w.layerOf(made._id)
    expect(layer.remainingQuantity).toBe(2)
    expect(layer.isExhausted).toBe(false)
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

    expectRejection(await captureRejection(confirmMovement(String(m2._id), repos)), 'Insufficient cost layers')
    // The refused dispatch took nothing from the layer it could not finish.
    const [layer] = await CostLayer.find({ orgId: org._id, productId: product._id }).lean()
    expect(layer.remainingQuantity).toBe(10)
    expect(layer.isExhausted).toBe(false)
  })
})
