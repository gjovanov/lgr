import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { eventBus } from 'services/events/event-bus'
import { registerEventHandlers, resetEventHandlers } from 'services/events/handlers'
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
  eventBus.removeAllListeners()
  resetEventHandlers()
  registerEventHandlers()
})

// Helper: wait for async event handlers to complete
const flush = () => new Promise((r) => setTimeout(r, 200))

async function createSO(orgId: string, userId: string, partnerId: string, product: any, qty: number, price: number) {
  const name = await getNextNumber(orgId, 'SO')
  const sub = qty * price
  const tax = Math.round(sub * 0.2 * 100) / 100
  return repos.salesOrders.create({
    orgId, name, state: 'confirmed', partnerId, currency: 'EUR', exchangeRate: 1,
    userId, createdBy: userId, dateOrder: new Date(), movementIds: [],
    lines: [{ productId: product.id ?? String(product._id), name: product.name, quantity: qty, uom: 'pcs', priceUnit: price, discount: 0, taxRate: 20, taxAmount: tax, priceSubtotal: sub, priceTotal: sub + tax, qtyDelivered: 0, qtyInvoiced: 0 }],
    amountUntaxed: sub, amountTax: tax, amountTotal: sub + tax,
  } as any)
}

async function createPO(orgId: string, userId: string, vendorId: string, product: any, qty: number, price: number) {
  const name = await getNextNumber(orgId, 'PO')
  const sub = qty * price
  const tax = Math.round(sub * 0.2 * 100) / 100
  return repos.purchaseOrders.create({
    orgId, name, state: 'confirmed', vendorId, currency: 'EUR', exchangeRate: 1,
    userId, createdBy: userId, dateOrder: new Date(), movementIds: [],
    lines: [{ productId: product.id ?? String(product._id), name: product.name, quantity: qty, uom: 'pcs', priceUnit: price, discount: 0, taxRate: 20, taxAmount: tax, priceSubtotal: sub, priceTotal: sub + tax, qtyReceived: 0, qtyBilled: 0 }],
    amountUntaxed: sub, amountTax: tax, amountTotal: sub + tax,
  } as any)
}

describe('Event Handlers: sales.order.confirmed → dispatch movement', () => {
  it('creates a draft dispatch stock movement from confirmed SO', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const so = await createSO(orgId, String(user._id), String(contact._id), product, 5, 100)

    // Emit event
    eventBus.emit('sales.order.confirmed', {
      salesOrderId: so.id,
      orgId,
      lines: [{ productId: String(product._id), quantity: 5, warehouseId: String(warehouse._id), unitPrice: 100 }],
      contactId: String(contact._id),
      userId: String(org.ownerId),
    })

    await flush()

    // Verify dispatch movement was created
    const movements = await repos.stockMovements.findMany({ orgId, reference: `SO:${so.id}` } as any)
    expect(movements.length).toBe(1)
    expect(movements[0].type).toBe('dispatch')
    expect(movements[0].status).toBe('draft')
    expect(movements[0].lines.length).toBe(1)
    expect(movements[0].lines[0].quantity).toBe(5)

    // Verify SO was updated with movementId
    const updatedSO = await repos.salesOrders.findById(so.id)
    expect(updatedSO!.movementIds.length).toBe(1)
  })

  it('is idempotent — does not create duplicate movements', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const so = await createSO(orgId, String(user._id), String(contact._id), product, 3, 50)

    const payload = {
      salesOrderId: so.id,
      orgId,
      lines: [{ productId: String(product._id), quantity: 3, warehouseId: String(warehouse._id), unitPrice: 50 }],
      contactId: String(contact._id),
      userId: String(user._id),
    }

    // Emit twice
    eventBus.emit('sales.order.confirmed', payload)
    await flush()
    eventBus.emit('sales.order.confirmed', payload)
    await flush()

    const movements = await repos.stockMovements.findMany({ orgId, reference: `SO:${so.id}` } as any)
    expect(movements.length).toBe(1)
  })

  it('skips when lines have no productId', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)

    eventBus.emit('sales.order.confirmed', {
      salesOrderId: '000000000000000000000099',
      orgId,
      lines: [{ productId: '', quantity: 1, unitPrice: 10 }],
      contactId: '000000000000000000000001',
      userId: '000000000000000000000002',
    })

    await flush()

    const movements = await repos.stockMovements.findMany({ orgId } as any)
    expect(movements.length).toBe(0)
  })
})

describe('Event Handlers: purchase.order.confirmed → receipt movement', () => {
  it('creates a draft receipt stock movement from confirmed PO', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const po = await createPO(orgId, String(user._id), String(contact._id), product, 20, 50)

    eventBus.emit('purchase.order.confirmed', {
      purchaseOrderId: po.id,
      orgId,
      lines: [{ productId: String(product._id), quantity: 20, warehouseId: String(warehouse._id), unitCost: 50 }],
      vendorId: String(contact._id),
      userId: String(user._id),
    })

    await flush()

    const movements = await repos.stockMovements.findMany({ orgId, reference: `PO:${po.id}` } as any)
    expect(movements.length).toBe(1)
    expect(movements[0].type).toBe('receipt')
    expect(movements[0].status).toBe('draft')
    expect(movements[0].lines.length).toBe(1)
    expect(movements[0].lines[0].quantity).toBe(20)

    // Verify PO was updated with movementId
    const updatedPO = await repos.purchaseOrders.findById(po.id)
    expect(updatedPO!.movementIds.length).toBe(1)
  })

  it('is idempotent — does not create duplicate receipt movements', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const po = await createPO(orgId, String(user._id), String(contact._id), product, 10, 30)

    const payload = {
      purchaseOrderId: po.id,
      orgId,
      lines: [{ productId: String(product._id), quantity: 10, warehouseId: String(warehouse._id), unitCost: 30 }],
      vendorId: String(contact._id),
      userId: String(user._id),
    }

    eventBus.emit('purchase.order.confirmed', payload)
    await flush()
    eventBus.emit('purchase.order.confirmed', payload)
    await flush()

    const movements = await repos.stockMovements.findMany({ orgId, reference: `PO:${po.id}` } as any)
    expect(movements.length).toBe(1)
  })

  it('uses default warehouse when no warehouseId in lines', async () => {
    const org = await createTestOrg()
    const orgId = String(org._id)
    const contact = await createTestContact(org._id, { type: 'supplier' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const poName = await getNextNumber(orgId, 'PO')
    const po = await repos.purchaseOrders.create({
      orgId,
      name: poName,
      state: 'confirmed',
      vendorId: String(contact._id),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{
        productId: String(product._id),
        name: product.name,
        quantity: 5,
        uom: 'pcs',
        priceUnit: 25,
        discount: 0,
        taxRate: 20,
        taxAmount: 25,
        priceSubtotal: 125,
        priceTotal: 150,
        qtyReceived: 0,
        qtyBilled: 0,
      }],
      amountUntaxed: 125,
      amountTax: 25,
      amountTotal: 150,
      dateOrder: new Date(),
      movementIds: [],
    } as any)

    // Emit without warehouseId — handler should pick default warehouse
    eventBus.emit('purchase.order.confirmed', {
      purchaseOrderId: po.id,
      orgId,
      lines: [{ productId: String(product._id), quantity: 5, unitCost: 25 }],
      vendorId: String(contact._id),
      userId: String(org.ownerId),
    })

    await flush()

    const movements = await repos.stockMovements.findMany({ orgId, reference: `PO:${po.id}` } as any)
    expect(movements.length).toBe(1)
    expect(movements[0].toWarehouseId?.toString()).toBe(warehouse._id.toString())
  })
})
