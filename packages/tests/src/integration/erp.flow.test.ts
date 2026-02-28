import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse, createTestStockLevel, createTestBOM, createTestProductionOrder, createTestConstructionProject, createTestPOSSession } from '../helpers/factories'
import { ProductionOrder, BillOfMaterials, StockLevel, POSSession, POSTransaction, ConstructionProject } from 'db/models'
import { Types } from 'mongoose'
import { startProduction, completeProduction, openPOSSession, closePOSSession, createPOSTransaction } from 'services/biz/erp.service'
import { paginateQuery } from 'services/utils/pagination'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('ERP Flow: Production', () => {
  it('should start a planned production order', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const bom = await BillOfMaterials.create({
      orgId: org._id,
      productId: product._id,
      name: 'Widget BOM',
      version: '1.0',
      status: 'active',
      materials: [],
      laborHours: 2,
      laborCostPerHour: 25,
      overheadCost: 10,
      totalMaterialCost: 0,
      totalCost: 60,
    })

    const order = await ProductionOrder.create({
      orgId: org._id,
      orderNumber: 'PO-001',
      bomId: bom._id,
      productId: product._id,
      quantity: 100,
      warehouseId: warehouse._id,
      outputWarehouseId: warehouse._id,
      status: 'planned',
      priority: 'normal',
      plannedStartDate: new Date(),
      plannedEndDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      stages: [],
      materialsConsumed: [],
      costPerUnit: 60,
      createdBy: user._id,
    })

    const started = await startProduction(String(order._id))
    expect(started.status).toBe('in_progress')
    expect(started.actualStartDate).toBeDefined()
  })

  it('should complete production and add finished goods to stock', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const bom = await BillOfMaterials.create({
      orgId: org._id,
      productId: product._id,
      name: 'Gadget BOM',
      version: '1.0',
      status: 'active',
      materials: [],
      laborHours: 1,
      laborCostPerHour: 30,
      overheadCost: 5,
      totalMaterialCost: 0,
      totalCost: 35,
    })

    const order = await ProductionOrder.create({
      orgId: org._id,
      orderNumber: 'PO-002',
      bomId: bom._id,
      productId: product._id,
      quantity: 50,
      warehouseId: warehouse._id,
      outputWarehouseId: warehouse._id,
      status: 'in_progress',
      priority: 'high',
      plannedStartDate: new Date(),
      plannedEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      actualStartDate: new Date(),
      stages: [],
      materialsConsumed: [],
      costPerUnit: 35,
      createdBy: user._id,
    })

    const completed = await completeProduction(String(order._id), 48, 2)
    expect(completed.status).toBe('completed')
    expect(completed.quantityProduced).toBe(48)
    expect(completed.quantityDefective).toBe(2)
    expect(completed.actualEndDate).toBeDefined()

    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(48)
  })

  it('should reject starting a non-planned production order', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const bom = await BillOfMaterials.create({
      orgId: org._id,
      productId: product._id,
      name: 'BOM',
      version: '1.0',
      status: 'active',
      materials: [],
      laborHours: 1,
      laborCostPerHour: 20,
      overheadCost: 0,
      totalMaterialCost: 0,
      totalCost: 20,
    })

    const order = await ProductionOrder.create({
      orgId: org._id,
      orderNumber: 'PO-003',
      bomId: bom._id,
      productId: product._id,
      quantity: 10,
      warehouseId: warehouse._id,
      outputWarehouseId: warehouse._id,
      status: 'in_progress',
      priority: 'normal',
      plannedStartDate: new Date(),
      plannedEndDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
      stages: [],
      materialsConsumed: [],
      costPerUnit: 20,
      createdBy: user._id,
    })

    await expect(startProduction(String(order._id))).rejects.toThrow('Only planned orders can be started')
  })
})

describe('ERP Flow: POS', () => {
  it('should open and close a POS session', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const session = await openPOSSession(String(org._id), String(warehouse._id), String(user._id), 500, 'EUR')
    expect(session.status).toBe('open')
    expect(session.openingBalance).toBe(500)
    expect(session.sessionNumber).toMatch(/^POS-/)

    const closed = await closePOSSession(String(session._id), 750)
    expect(closed.status).toBe('closed')
    expect(closed.closedAt).toBeDefined()
    expect(closed.closingBalance).toBe(750)
    expect(closed.expectedBalance).toBe(500) // opening + totalCash (0 sales yet)
    expect(closed.difference).toBe(250) // 750 - 500
  })

  it('should create a POS transaction and update session totals', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id, { sellingPrice: 50 })

    const session = await openPOSSession(String(org._id), String(warehouse._id), String(user._id), 100, 'EUR')

    const txn = await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: product.name, quantity: 2, unitPrice: 50, discount: 0, taxRate: 18 },
      ],
      payments: [{ method: 'cash', amount: 118 }],
    })

    expect(txn.transactionNumber).toMatch(/^TXN-/)
    expect(txn.subtotal).toBe(100) // 2 * 50
    expect(txn.taxTotal).toBe(18) // 18% of 100
    expect(txn.total).toBe(118)
    expect(txn.changeDue).toBe(0) // exact payment

    const updatedSession = await POSSession.findById(session._id)
    expect(updatedSession!.totalSales).toBe(118)
    expect(updatedSession!.totalCash).toBe(118)
    expect(updatedSession!.transactionCount).toBe(1)
  })

  it('should reject opening a duplicate POS session for same cashier', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await openPOSSession(String(org._id), String(warehouse._id), String(user._id), 100, 'EUR')

    await expect(
      openPOSSession(String(org._id), String(warehouse._id), String(user._id), 200, 'EUR'),
    ).rejects.toThrow('Cashier already has an open session')
  })
})

describe('ERP Pagination', () => {
  it('should paginate production orders', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const bom = await createTestBOM(org._id, product._id)
    for (let i = 0; i < 15; i++) {
      await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, { orderNumber: `PO-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(ProductionOrder, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(ProductionOrder, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(ProductionOrder, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate bills of materials', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestBOM(org._id, product._id, { name: `BOM ${String(i).padStart(2, '0')}`, version: `${i + 1}.0` })
    }
    const p0 = await paginateQuery(BillOfMaterials, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(BillOfMaterials, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate construction projects', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestConstructionProject(org._id, { name: `Project ${String(i).padStart(2, '0')}`, projectNumber: `CP-${Date.now()}-${i}` })
    }
    const p0 = await paginateQuery(ConstructionProject, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(ConstructionProject, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate construction projects with sort', async () => {
    const org = await createTestOrg()
    await createTestConstructionProject(org._id, { name: 'Zeta Tower', projectNumber: 'CP-Z' })
    await createTestConstructionProject(org._id, { name: 'Alpha Complex', projectNumber: 'CP-A' })
    await createTestConstructionProject(org._id, { name: 'Metro Bridge', projectNumber: 'CP-M' })

    const sorted = await paginateQuery(ConstructionProject, { orgId: org._id }, { sortBy: 'name', sortOrder: 'asc' })
    expect(sorted.items[0].name).toBe('Alpha Complex')
    expect(sorted.items[1].name).toBe('Metro Bridge')
    expect(sorted.items[2].name).toBe('Zeta Tower')
  })

  it('should paginate POS sessions', async () => {
    const org = await createTestOrg()
    const warehouse = await createTestWarehouse(org._id)
    for (let i = 0; i < 15; i++) {
      const user = await createTestUser(org._id, { email: `pos-${Date.now()}-${i}@test.com`, username: `pos-${Date.now()}-${i}` })
      await createTestPOSSession(org._id, warehouse._id, user._id, { sessionNumber: `POS-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(POSSession, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(POSSession, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
