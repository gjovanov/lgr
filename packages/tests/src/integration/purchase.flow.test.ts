import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestProduct, createTestWarehouse, createTestStockLevel } from '../helpers/factories'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import {
  sendRFQ,
  requestApproval,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  confirmPurchaseOrder,
  recordReceipt,
  createBillFromPO,
  cancelPurchaseOrder,
  checkReorderRules,
} from 'services/biz/purchase.service'
import { eventBus } from 'services/events/event-bus'
import { ReorderRule } from 'db/models'
import type { Types } from 'mongoose'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
  eventBus.removeAllListeners() // Clean all event types
})

async function createTestPO(
  orgId: Types.ObjectId,
  vendorId: Types.ObjectId,
  product: { id: string; name: string },
  overrides: any = {},
) {
  const name = await getNextNumber(String(orgId), 'PO')
  return repos.purchaseOrders.create({
    orgId: String(orgId),
    name,
    state: 'draft',
    vendorId: String(vendorId),
    currency: 'EUR',
    exchangeRate: 1,
    lines: [
      {
        productId: product.id,
        name: product.name,
        quantity: 50,
        uom: 'kg',
        priceUnit: 80,
        taxRate: 20,
        taxAmount: 800,
        priceSubtotal: 4000,
        priceTotal: 4800,
        qtyReceived: 0,
        qtyBilled: 0,
      },
    ],
    amountUntaxed: 4000,
    amountTax: 800,
    amountTotal: 4800,
    receiptStatus: 'pending',
    invoiceStatus: 'nothing',
    invoiceIds: [],
    movementIds: [],
    userId: String(orgId), // placeholder
    createdBy: String(orgId), // placeholder
    ...overrides,
  } as any)
}

describe('Purchase Order Lifecycle', () => {
  it('should create a purchase order', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier', companyName: 'Test Supplier Co' })
    const product = await createTestProduct(org._id, { name: 'Raw Material A', sku: `RM-${Date.now()}` })
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    expect(po.name).toMatch(/^PO-\d{4}-\d{5}$/)
    expect(po.state).toBe('draft')
    expect(po.amountTotal).toBe(4800)
    expect(po.receiptStatus).toBe('pending')
    expect(po.lines).toHaveLength(1)
  })

  it('should send RFQ (draft -> sent)', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    const sent = await sendRFQ(po.id, String(org._id), repos)
    expect(sent.state).toBe('sent')
    expect(sent.sentAt).toBeTruthy()
  })

  it('should confirm PO directly (draft -> confirmed)', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    const confirmed = await confirmPurchaseOrder(po.id, String(org._id), repos)
    expect(confirmed.state).toBe('confirmed')
    expect(confirmed.confirmedAt).toBeTruthy()
  })

  it('should emit purchase.order.confirmed event', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    let emittedEvent: any = null
    eventBus.on('purchase.order.confirmed', async (payload) => {
      emittedEvent = payload
    })

    await confirmPurchaseOrder(po.id, String(org._id), repos)

    expect(emittedEvent).not.toBeNull()
    expect(emittedEvent.purchaseOrderId).toBe(po.id)
    expect(emittedEvent.vendorId).toBe(String(vendor._id))
    expect(emittedEvent.lines).toHaveLength(1)
  })

  it('should handle approval workflow: request -> approve', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    // Request approval
    const pending = await requestApproval(po.id, String(org._id), repos)
    expect(pending.state).toBe('to_approve')
    expect(pending.approvalStatus).toBe('pending')

    // Approve
    const approverId = '000000000000000000000088'
    const approved = await approvePurchaseOrder(po.id, String(org._id), approverId, repos)
    expect(approved.state).toBe('confirmed')
    expect(approved.approvalStatus).toBe('approved')
    expect(approved.approvedBy).toBe(approverId)
    expect(approved.dateApproved).toBeTruthy()
  })

  it('should handle approval workflow: request -> reject', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    await requestApproval(po.id, String(org._id), repos)

    const rejected = await rejectPurchaseOrder(po.id, String(org._id), '000000000000000000000088', repos)
    expect(rejected.state).toBe('draft')
    expect(rejected.approvalStatus).toBe('rejected')
  })

  it('should record partial receipt', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)

    const received = await recordReceipt(
      po.id,
      String(org._id),
      [{ productId: String(product._id), qtyReceived: 30 }],
      repos,
    )

    expect(received.lines[0].qtyReceived).toBe(30)
    expect(received.receiptStatus).toBe('partial')
    expect(received.state).toBe('confirmed') // Still confirmed, not fully received
  })

  it('should record full receipt', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)

    const received = await recordReceipt(
      po.id,
      String(org._id),
      [{ productId: String(product._id), qtyReceived: 50 }],
      repos,
    )

    expect(received.lines[0].qtyReceived).toBe(50)
    expect(received.receiptStatus).toBe('full')
    expect(received.state).toBe('received')
  })

  it('should create vendor bill from received PO', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier', companyName: 'Vendor Inc' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)
    await recordReceipt(po.id, String(org._id), [{ productId: String(product._id), qtyReceived: 50 }], repos)

    const billed = await createBillFromPO(po.id, String(org._id), repos)
    expect(billed.invoiceIds).toHaveLength(1)
    expect(billed.invoiceStatus).toBe('billed')

    // Verify the vendor bill was created
    const bill = await repos.invoices.findById(billed.invoiceIds[0])
    expect(bill).toBeTruthy()
    expect(bill!.direction).toBe('incoming')
    expect(bill!.type).toBe('invoice')
    expect(bill!.contactId).toBe(String(vendor._id))
    expect(bill!.reference).toBe(po.name)
    expect(bill!.lines).toHaveLength(1)
    expect(bill!.lines[0].quantity).toBe(50)
  })

  it('should cancel a draft PO', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    const cancelled = await cancelPurchaseOrder(po.id, String(org._id), repos)
    expect(cancelled.state).toBe('cancelled')
  })

  it('should reject cancel on received PO', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)
    await recordReceipt(po.id, String(org._id), [{ productId: String(product._id), qtyReceived: 50 }], repos)

    await expect(cancelPurchaseOrder(po.id, String(org._id), repos)).rejects.toThrow(/Cannot/)
  })

  it('should complete the full lifecycle: draft -> sent -> confirmed -> received -> billed', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    const sent = await sendRFQ(po.id, String(org._id), repos)
    expect(sent.state).toBe('sent')

    const confirmed = await confirmPurchaseOrder(po.id, String(org._id), repos)
    expect(confirmed.state).toBe('confirmed')

    const received = await recordReceipt(
      po.id,
      String(org._id),
      [{ productId: String(product._id), qtyReceived: 50 }],
      repos,
    )
    expect(received.state).toBe('received')

    const billed = await createBillFromPO(po.id, String(org._id), repos)
    expect(billed.invoiceIds).toHaveLength(1)
    expect(billed.invoiceStatus).toBe('billed')
  })

  it('cancels a confirmed PO', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)

    const cancelled = await cancelPurchaseOrder(po.id, String(org._id), repos)
    expect(cancelled.state).toBe('cancelled')
  })

  it('caps received quantity at ordered quantity', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)

    const received = await recordReceipt(po.id, String(org._id), [
      { productId: String(product._id), qtyReceived: 999 }
    ], repos)
    expect(received.lines[0].qtyReceived).toBe(50) // capped at ordered qty
    expect(received.receiptStatus).toBe('full')
  })

  it('creates bill with correct financial totals', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)
    await recordReceipt(po.id, String(org._id), [{ productId: String(product._id), qtyReceived: 50 }], repos)
    const billed = await createBillFromPO(po.id, String(org._id), repos)

    const bill = await repos.invoices.findById(billed.invoiceIds[0])
    expect(bill).toBeTruthy()
    // 50 qty × 80 price = 4000 subtotal, 20% tax = 800, total = 4800
    expect(bill!.subtotal).toBe(4000)
    expect(bill!.taxTotal).toBe(800)
    expect(bill!.total).toBe(4800)
    expect(bill!.amountDue).toBe(4800)
  })

  it('throws for non-existent order', async () => {
    expect(confirmPurchaseOrder('000000000000000000000099', '000000000000000000000001', repos)).rejects.toThrow(/not found/)
  })
})

describe('Reorder Rules', () => {
  it('should create a reorder rule', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const vendor = await createTestContact(org._id, { type: 'supplier' })

    const rule = await repos.reorderRules.create({
      orgId: String(org._id),
      productId: String(product._id),
      warehouseId: String(warehouse._id),
      minQty: 10,
      maxQty: 100,
      leadTimeDays: 5,
      vendorId: String(vendor._id),
      isActive: true,
    } as any)

    expect(rule.minQty).toBe(10)
    expect(rule.maxQty).toBe(100)
  })

  it('should auto-create PO when stock is below minimum', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, {
      name: 'Low Stock Item',
      sku: `LSI-${Date.now()}`,
      costPrice: 80,
      unitOfMeasure: 'kg',
    })
    const warehouse = await createTestWarehouse(org._id)
    const vendor = await createTestContact(org._id, { type: 'supplier', companyName: 'Reorder Vendor' })

    // Create reorder rule
    await repos.reorderRules.create({
      orgId: String(org._id),
      productId: String(product._id),
      warehouseId: String(warehouse._id),
      minQty: 10,
      maxQty: 100,
      leadTimeDays: 5,
      vendorId: String(vendor._id),
      isActive: true,
    } as any)

    // Create stock level below minimum
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 5, // Below minQty of 10
      availableQuantity: 5,
    })

    const created = await checkReorderRules(String(org._id), repos)
    expect(created).toBe(1)

    // Verify PO was created
    const pos = await repos.purchaseOrders.findMany({ orgId: String(org._id) } as any)
    expect(pos).toHaveLength(1)
    expect(pos[0].vendorId).toBe(String(vendor._id))
    expect(pos[0].lines[0].productId).toBe(String(product._id))
    expect(pos[0].lines[0].quantity).toBe(95) // maxQty(100) - currentQty(5)
  })

  it('should skip reorder when stock is sufficient', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, {
      name: 'Sufficient Stock Item',
      sku: `SSI-${Date.now()}`,
    })
    const warehouse = await createTestWarehouse(org._id)
    const vendor = await createTestContact(org._id, { type: 'supplier' })

    await repos.reorderRules.create({
      orgId: String(org._id),
      productId: String(product._id),
      warehouseId: String(warehouse._id),
      minQty: 10,
      maxQty: 100,
      leadTimeDays: 5,
      vendorId: String(vendor._id),
      isActive: true,
    } as any)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 50, // Above minQty of 10
      availableQuantity: 50,
    })

    const created = await checkReorderRules(String(org._id), repos)
    expect(created).toBe(0)
  })

  it('should not create PO for inactive reorder rule', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { sku: `INACT-${Date.now()}` })
    const warehouse = await createTestWarehouse(org._id)
    const vendor = await createTestContact(org._id, { type: 'supplier' })

    await repos.reorderRules.create({
      orgId: String(org._id),
      productId: String(product._id),
      warehouseId: String(warehouse._id),
      minQty: 10,
      maxQty: 100,
      leadTimeDays: 5,
      vendorId: String(vendor._id),
      isActive: false,
    } as any)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 5,
      availableQuantity: 5,
    })

    const created = await checkReorderRules(String(org._id), repos)
    expect(created).toBe(0)
  })
})

describe('Purchase Order State Machine Guards', () => {
  it('should reject confirm on PO with no lines', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const name = await getNextNumber(String(org._id), 'PO')
    const po = await repos.purchaseOrders.create({
      orgId: String(org._id),
      name,
      state: 'draft',
      vendorId: String(vendor._id),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [],
      amountUntaxed: 0,
      amountTax: 0,
      amountTotal: 0,
      receiptStatus: 'pending',
      invoiceStatus: 'nothing',
      invoiceIds: [],
      movementIds: [],
      userId: String(org._id),
      createdBy: String(org._id),
    } as any)

    await expect(confirmPurchaseOrder(po.id, String(org._id), repos)).rejects.toThrow(/Guard rejected/)
  })

  it('should reject receipt on draft PO', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })

    await expect(
      recordReceipt(po.id, String(org._id), [{ productId: String(product._id), qtyReceived: 10 }], repos),
    ).rejects.toThrow(/Can only record receipt/)
  })

  it('should reject double confirm', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const po = await createTestPO(org._id, vendor._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmPurchaseOrder(po.id, String(org._id), repos)

    await expect(confirmPurchaseOrder(po.id, String(org._id), repos)).rejects.toThrow(/Cannot/)
  })

  it('should reject approval request on PO with no lines', async () => {
    const org = await createTestOrg()
    const vendor = await createTestContact(org._id, { type: 'supplier' })
    const name = await getNextNumber(String(org._id), 'PO')
    const po = await repos.purchaseOrders.create({
      orgId: String(org._id),
      name,
      state: 'draft',
      vendorId: String(vendor._id),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [],
      amountUntaxed: 0,
      amountTax: 0,
      amountTotal: 0,
      receiptStatus: 'pending',
      invoiceStatus: 'nothing',
      invoiceIds: [],
      movementIds: [],
      userId: String(org._id),
      createdBy: String(org._id),
    } as any)

    await expect(requestApproval(po.id, String(org._id), repos)).rejects.toThrow(/Guard rejected/)
  })
})
