import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup.js'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestBOM,
  createTestProductionOrder,
  createTestPOSSession,
} from '../../helpers/factories.js'
import {
  openPOSSession,
  closePOSSession,
  createPOSTransaction,
  startProduction,
  completeProduction,
} from 'services/biz/erp.service'
import { POSSession, POSTransaction, ProductionOrder, StockLevel } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('openPOSSession', () => {
  it('should create a session with auto-generated sessionNumber in POS-YYYYMMDD-NNN format', async () => {
    const org = await createTestOrg({ slug: 'pos-open-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier1' })

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    expect(session).toBeDefined()
    expect(session.sessionNumber).toMatch(/^POS-\d{8}-\d{3}$/)
    expect(session.status).toBe('open')
    expect(session.openingBalance).toBe(500)
    expect(session.currency).toBe('EUR')
    expect(session.totalSales).toBe(0)
    expect(session.totalReturns).toBe(0)
    expect(session.totalCash).toBe(0)
    expect(session.totalCard).toBe(0)
    expect(session.transactionCount).toBe(0)
    expect(session.openedAt).toBeDefined()
  })

  it('should reject duplicate open session for the same cashier', async () => {
    const org = await createTestOrg({ slug: 'pos-dup-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-dup' })

    await openPOSSession(String(org._id), String(warehouse._id), String(user._id), 500, 'EUR')

    await expect(
      openPOSSession(String(org._id), String(warehouse._id), String(user._id), 300, 'EUR'),
    ).rejects.toThrow('Cashier already has an open session')
  })
})

describe('closePOSSession', () => {
  it('should set closedAt and status to closed', async () => {
    const org = await createTestOrg({ slug: 'pos-close-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-close' })

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    const closed = await closePOSSession(String(session._id), 500)

    expect(closed.status).toBe('closed')
    expect(closed.closedAt).toBeDefined()
  })

  it('should calculate expectedBalance as openingBalance + totalCash', async () => {
    const org = await createTestOrg({ slug: 'pos-expected-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-exp' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    // Create a cash transaction to have totalCash > 0
    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget', quantity: 2, unitPrice: 100, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'cash', amount: 200 }],
    })

    const closed = await closePOSSession(String(session._id), 700)

    expect(closed.expectedBalance).toBe(500 + 200) // openingBalance + totalCash
  })

  it('should calculate difference as closingBalance - expectedBalance', async () => {
    const org = await createTestOrg({ slug: 'pos-diff-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-diff' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget', quantity: 1, unitPrice: 100, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'cash', amount: 100 }],
    })

    // Close with 590 (expected is 600, so difference is -10)
    const closed = await closePOSSession(String(session._id), 590)

    expect(closed.expectedBalance).toBe(600)
    expect(closed.closingBalance).toBe(590)
    expect(closed.difference).toBe(-10)
  })

  it('should reject closing an already-closed session', async () => {
    const org = await createTestOrg({ slug: 'pos-reclose-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-reclose' })

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await closePOSSession(String(session._id), 500)

    await expect(closePOSSession(String(session._id), 500)).rejects.toThrow('Session is not open')
  })
})

describe('createPOSTransaction', () => {
  it('should create a transaction and update session totalSales', async () => {
    const org = await createTestOrg({ slug: 'pos-txn-sales-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-txn' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    const txn = await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget', quantity: 2, unitPrice: 50, discount: 0, taxRate: 10 },
      ],
      payments: [{ method: 'cash', amount: 110 }],
    })

    expect(txn).toBeDefined()
    expect(txn.transactionNumber).toMatch(/^TXN-\d{8}-\d{3}$/)
    expect(txn.type).toBe('sale')

    // subtotal = 2 * 50 = 100, discount = 0, tax = 100 * 10/100 = 10, total = 110
    expect(txn.subtotal).toBe(100)
    expect(txn.taxTotal).toBe(10)
    expect(txn.total).toBe(110)

    const updatedSession = await POSSession.findById(session._id)
    expect(updatedSession!.totalSales).toBe(110)
  })

  it('should update session totalCash for cash payments', async () => {
    const org = await createTestOrg({ slug: 'pos-cash-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-cash' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget', quantity: 1, unitPrice: 80, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'cash', amount: 80 }],
    })

    const updatedSession = await POSSession.findById(session._id)
    expect(updatedSession!.totalCash).toBe(80)
    expect(updatedSession!.totalCard).toBe(0)
  })

  it('should update session totalCard for card payments', async () => {
    const org = await createTestOrg({ slug: 'pos-card-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-card' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget', quantity: 1, unitPrice: 120, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'card', amount: 120 }],
    })

    const updatedSession = await POSSession.findById(session._id)
    expect(updatedSession!.totalCard).toBe(120)
    expect(updatedSession!.totalCash).toBe(0)
  })

  it('should increment session transactionCount', async () => {
    const org = await createTestOrg({ slug: 'pos-count-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-count' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget A', quantity: 1, unitPrice: 50, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'cash', amount: 50 }],
    })

    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'sale',
      lines: [
        { productId: String(product._id), name: 'Widget B', quantity: 1, unitPrice: 30, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'cash', amount: 30 }],
    })

    const updatedSession = await POSSession.findById(session._id)
    expect(updatedSession!.transactionCount).toBe(2)
  })

  it('should handle returns by updating totalReturns', async () => {
    const org = await createTestOrg({ slug: 'pos-return-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-return' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await createPOSTransaction(String(session._id), String(org._id), String(user._id), {
      type: 'return',
      lines: [
        { productId: String(product._id), name: 'Widget', quantity: 1, unitPrice: 60, discount: 0, taxRate: 0 },
      ],
      payments: [{ method: 'cash', amount: 60 }],
    })

    const updatedSession = await POSSession.findById(session._id)
    expect(updatedSession!.totalReturns).toBe(60)
    expect(updatedSession!.totalSales).toBe(0)
  })

  it('should reject transaction on a closed session', async () => {
    const org = await createTestOrg({ slug: 'pos-closed-txn-org' })
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id, { username: 'cashier-closed-txn' })
    const product = await createTestProduct(org._id)

    const session = await openPOSSession(
      String(org._id),
      String(warehouse._id),
      String(user._id),
      500,
      'EUR',
    )

    await closePOSSession(String(session._id), 500)

    await expect(
      createPOSTransaction(String(session._id), String(org._id), String(user._id), {
        type: 'sale',
        lines: [
          { productId: String(product._id), name: 'Widget', quantity: 1, unitPrice: 50, discount: 0, taxRate: 0 },
        ],
        payments: [{ method: 'cash', amount: 50 }],
      }),
    ).rejects.toThrow('Session is not open')
  })
})

describe('startProduction', () => {
  it('should change status from planned to in_progress and set actualStartDate', async () => {
    const org = await createTestOrg({ slug: 'prod-start-org' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id)

    expect(order.status).toBe('planned')
    expect(order.actualStartDate).toBeUndefined()

    const started = await startProduction(String(order._id))

    expect(started.status).toBe('in_progress')
    expect(started.actualStartDate).toBeDefined()
    expect(started.actualStartDate).toBeInstanceOf(Date)
  })

  it('should reject if status is not planned', async () => {
    const org = await createTestOrg({ slug: 'prod-start-reject-org' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      status: 'in_progress',
    })

    await expect(startProduction(String(order._id))).rejects.toThrow(
      'Only planned orders can be started',
    )
  })
})

describe('completeProduction', () => {
  it('should change status to completed and add finished goods to output warehouse via adjustStock', async () => {
    const org = await createTestOrg({ slug: 'prod-complete-org' })
    const warehouse = await createTestWarehouse(org._id)
    const outputWarehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      status: 'in_progress',
      outputWarehouseId: outputWarehouse._id,
      costPerUnit: 25,
    })

    const completed = await completeProduction(String(order._id), 95, 5)

    expect(completed.status).toBe('completed')
    expect(completed.actualEndDate).toBeDefined()

    // adjustStock should have created a StockLevel entry for the output warehouse
    const stockLevel = await StockLevel.findOne({
      orgId: String(org._id),
      productId: String(product._id),
      warehouseId: String(outputWarehouse._id),
    })
    expect(stockLevel).toBeDefined()
    expect(stockLevel!.quantity).toBe(95)
  })

  it('should set quantityProduced and quantityDefective on the order', async () => {
    const org = await createTestOrg({ slug: 'prod-qty-org' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)
    const bom = await createTestBOM(org._id, product._id)
    const order = await createTestProductionOrder(org._id, bom._id, product._id, warehouse._id, {
      status: 'in_progress',
      costPerUnit: 10,
    })

    const completed = await completeProduction(String(order._id), 80, 3)

    expect(completed.quantityProduced).toBe(80)
    expect(completed.quantityDefective).toBe(3)
  })
})
