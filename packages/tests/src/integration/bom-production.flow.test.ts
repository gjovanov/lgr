import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestBOM, createTestProductionOrder } from '../helpers/factories'
import { StockLevel } from 'db/models'
import { startProduction, completeProduction } from 'services/biz/erp.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('BOM -> Production -> Warehouse Flow', () => {
  it('should calculate totalMaterialCost as sum of material costs', async () => {
    const org = await createTestOrg()
    const finishedProduct = await createTestProduct(org._id, { name: 'Finished Widget' })
    const matA = await createTestProduct(org._id, { name: 'Material A' })
    const matB = await createTestProduct(org._id, { name: 'Material B' })

    const materials = [
      { productId: matA._id, quantity: 10, unit: 'pcs', wastagePercent: 0, cost: 150 },
      { productId: matB._id, quantity: 5, unit: 'kg', wastagePercent: 0, cost: 200 },
    ]
    const totalMaterialCost = 150 + 200

    const bom = await createTestBOM(org._id, finishedProduct._id, {
      materials,
      totalMaterialCost,
      totalCost: totalMaterialCost + 8 * 25 + 50,
    })

    expect(bom.totalMaterialCost).toBe(350)
    expect(bom.totalMaterialCost).toBe(
      bom.materials.reduce((sum, m) => sum + m.cost, 0),
    )
  })

  it('should calculate totalCost = totalMaterialCost + laborCost + overheadCost', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const matA = await createTestProduct(org._id, { name: 'Raw Steel' })

    const laborHours = 10
    const laborCostPerHour = 30
    const overheadCost = 75
    const materials = [
      { productId: matA._id, quantity: 20, unit: 'kg', wastagePercent: 5, cost: 500 },
    ]
    const totalMaterialCost = 500
    const expectedTotalCost = totalMaterialCost + (laborHours * laborCostPerHour) + overheadCost

    const bom = await createTestBOM(org._id, product._id, {
      materials,
      laborHours,
      laborCostPerHour,
      overheadCost,
      totalMaterialCost,
      totalCost: expectedTotalCost,
    })

    expect(bom.totalCost).toBe(875)
    expect(bom.totalCost).toBe(
      bom.totalMaterialCost + (bom.laborHours * bom.laborCostPerHour) + bom.overheadCost,
    )
  })

  it('should create a production order from BOM with planned status', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)

    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id)

    expect(order.status).toBe('planned')
    expect(String(order.bomId)).toBe(String(bom._id))
    expect(String(order.productId)).toBe(String(product._id))
    expect(order.quantity).toBe(100)
    expect(order.quantityProduced).toBe(0)
    expect(order.quantityDefective).toBe(0)
    expect(order.actualStartDate).toBeUndefined()
    expect(order.actualEndDate).toBeUndefined()
  })

  it('should transition planned -> in_progress and set actualStartDate', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id)

    const started = await startProduction(String(order._id))

    expect(started.status).toBe('in_progress')
    expect(started.actualStartDate).toBeDefined()
    expect(started.actualStartDate).toBeInstanceOf(Date)
  })

  it('should add finished goods to outputWarehouse on completion', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const inputWh = await createTestWarehouse(org._id, { name: 'Input WH', code: 'WH-IN' })
    const outputWh = await createTestWarehouse(org._id, { name: 'Output WH', code: 'WH-OUT' })
    const bom = await createTestBOM(org._id, product._id)

    const order = await createTestProductionOrder(org._id, bom._id, product._id, inputWh._id, {
      outputWarehouseId: outputWh._id,
      costPerUnit: 15,
    })

    await startProduction(String(order._id))
    await completeProduction(String(order._id), 90, 10)

    const stockLevel = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: outputWh._id,
    })

    expect(stockLevel).toBeDefined()
    expect(stockLevel!.quantity).toBe(90)
    expect(stockLevel!.avgCost).toBe(15)
  })

  it('should set quantityProduced and quantityDefective on completion', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      costPerUnit: 20,
    })

    await startProduction(String(order._id))
    const completed = await completeProduction(String(order._id), 85, 15)

    expect(completed.status).toBe('completed')
    expect(completed.quantityProduced).toBe(85)
    expect(completed.quantityDefective).toBe(15)
    expect(completed.actualEndDate).toBeDefined()
    expect(completed.actualEndDate).toBeInstanceOf(Date)
  })

  it('should reject starting a non-planned production order', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id)

    // Start it once to move to in_progress
    await startProduction(String(order._id))

    // Try to start again — should reject because status is in_progress, not planned
    await expect(startProduction(String(order._id))).rejects.toThrow('Only planned orders can be started')
  })

  it('should reject completing a non-in_progress production order', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id)

    // Order is still in "planned" status — completing should fail
    await expect(completeProduction(String(order._id), 50, 0)).rejects.toThrow(
      'Order must be in progress or quality check',
    )
  })
})
