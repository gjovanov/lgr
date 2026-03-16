import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { checkCrossWarehouseAvailability, createTransferMovements, confirmTransferMovements } from 'services/biz/stock-transfer.service'
import { createInvoiceStockMovement } from 'services/biz/invoicing.service'
import { StockLevel, StockMovement, Invoice } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Cash Sale with Cross-Warehouse Transfer', () => {
  it('should allow cash sale when stock is sufficient at target warehouse', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Widget A' })
    const wh = await createTestWarehouse(org._id, { name: 'Main', code: 'MAIN' })

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: wh._id, quantity: 100, reservedQuantity: 0, availableQuantity: 100, avgCost: 5 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(wh._id), quantity: 10 },
    ])

    expect(result.sufficient).toBe(true)
  })

  it('should propose transfer for cash sale when target warehouse has insufficient stock', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Widget B' })
    const whMain = await createTestWarehouse(org._id, { name: 'POS Store', code: 'POS' })
    const whBackup = await createTestWarehouse(org._id, { name: 'Backup Warehouse', code: 'BK' })

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whMain._id, quantity: 5, reservedQuantity: 0, availableQuantity: 5, avgCost: 10 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whBackup._id, quantity: 50, reservedQuantity: 0, availableQuantity: 50, avgCost: 10 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(whMain._id), quantity: 20 },
    ])

    expect(result.sufficient).toBe(false)
    expect(result.allResolvable).toBe(true)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].sources[0].fromWarehouseId).toBe(String(whBackup._id))
    expect(result.proposals[0].sources[0].transferQuantity).toBe(15)
  })

  it('should create and confirm transfers, then allow dispatch for cash sale', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id, { name: 'Widget C', sellingPrice: 25 })
    const whStore = await createTestWarehouse(org._id, { name: 'Store', code: 'ST' })
    const whDepot = await createTestWarehouse(org._id, { name: 'Depot', code: 'DP' })

    // Store has 3, Depot has 20
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whStore._id, quantity: 3, reservedQuantity: 0, availableQuantity: 3, avgCost: 10 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whDepot._id, quantity: 20, reservedQuantity: 0, availableQuantity: 20, avgCost: 10 })

    // Step 1: Check availability (need 10, have 3 → deficit 7)
    const checkResult = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(whStore._id), quantity: 10 },
    ])
    expect(checkResult.allResolvable).toBe(true)

    // Step 2: Create transfer movements
    const transferIds = await createTransferMovements(String(org._id), checkResult.proposals, String(user._id))
    expect(transferIds).toHaveLength(1)

    // Step 3: Confirm transfers (stock moves from Depot to Store)
    await confirmTransferMovements(transferIds)

    // Verify stock levels after transfer
    const storeLevel = await StockLevel.findOne({ productId: product._id, warehouseId: whStore._id }).lean()
    expect(storeLevel!.quantity).toBe(10) // 3 + 7 transferred

    const depotLevel = await StockLevel.findOne({ productId: product._id, warehouseId: whDepot._id }).lean()
    expect(depotLevel!.quantity).toBe(13) // 20 - 7 transferred

    // Step 4: Create cash sale invoice
    const invoice = await Invoice.create({
      orgId: org._id,
      invoiceNumber: `CS-TEST-${Date.now()}`,
      type: 'cash_sale',
      direction: 'outgoing',
      status: 'paid',
      issueDate: new Date(),
      dueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{
        productId: product._id,
        description: 'Widget C',
        quantity: 10,
        unit: 'pcs',
        unitPrice: 25,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineTotal: 250,
        warehouseId: whStore._id,
      }],
      subtotal: 250,
      discountTotal: 0,
      taxTotal: 0,
      total: 250,
      totalBase: 250,
      amountPaid: 250,
      amountDue: 0,
      paidAt: new Date(),
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      createdBy: user._id,
      pendingTransferIds: transferIds.map(id => id),
    })

    // Step 5: Create dispatch movement (should succeed now)
    await createInvoiceStockMovement(invoice as any, String(user._id))

    // Verify final stock: Store had 10 after transfer, dispatched 10 → 0
    const finalStore = await StockLevel.findOne({ productId: product._id, warehouseId: whStore._id }).lean()
    expect(finalStore!.quantity).toBe(0)
  })

  it('should aggregate demand from multiple lines for same product+warehouse', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Multi-line Product' })
    const wh = await createTestWarehouse(org._id, { name: 'Store', code: 'S' })

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: wh._id, quantity: 5, reservedQuantity: 0, availableQuantity: 5, avgCost: 10 })

    // Two lines for same product+warehouse, total 15
    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(wh._id), quantity: 8 },
      { productId: String(product._id), warehouseId: String(wh._id), quantity: 7 },
    ])

    expect(result.sufficient).toBe(false)
    expect(result.shortfalls).toHaveLength(1)
    expect(result.shortfalls[0].requested).toBe(15)
    expect(result.shortfalls[0].deficit).toBe(10)
  })

  it('should handle cash sale with no warehouse on lines (no stock check needed)', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Service' })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: '', quantity: 5 },
    ])

    expect(result.sufficient).toBe(true)
  })
})
