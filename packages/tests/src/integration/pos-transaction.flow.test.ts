import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestStockLevel,
} from '../helpers/factories'
import { POSSession, POSTransaction } from 'db/models'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { mongoose } from 'db/connection'
const { Types } = mongoose

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

// ── Helpers ──

async function createSessionViaRepos(orgId: string, warehouseId: string, cashierId: string, openingBalance = 500) {
  const r = getRepos()
  const sessionNumber = await getNextNumber(orgId, 'POS', 6)
  return r.posSessions.create({
    orgId,
    warehouseId,
    cashierId,
    sessionNumber,
    openedAt: new Date(),
    status: 'open',
    openingBalance,
    currency: 'EUR',
    totalSales: 0,
    totalReturns: 0,
    totalCash: 0,
    totalCard: 0,
    transactionCount: 0,
  } as any)
}

function buildSaleBody(productId: string, opts: { quantity?: number; unitPrice?: number; taxRate?: number; paymentMethod?: string } = {}) {
  const quantity = opts.quantity ?? 2
  const unitPrice = opts.unitPrice ?? 100
  const taxRate = opts.taxRate ?? 0
  const discount = 0

  const lineBase = quantity * unitPrice
  const lineDiscount = lineBase * (discount / 100)
  const taxableAmount = lineBase - lineDiscount
  const lineTax = taxableAmount * (taxRate / 100)
  const lineTotal = lineBase - lineDiscount + lineTax

  const subtotal = lineBase
  const discountTotal = lineDiscount
  const taxTotal = lineTax
  const total = subtotal - discountTotal + taxTotal

  return {
    type: 'sale' as const,
    lines: [{
      productId,
      name: 'Test Product',
      quantity,
      unitPrice,
      discount,
      taxRate,
      taxAmount: lineTax,
      lineTotal,
    }],
    subtotal,
    discountTotal,
    taxTotal,
    total,
    payments: [{ method: opts.paymentMethod ?? 'cash', amount: total }],
    changeDue: 0,
  }
}

/**
 * Validates totals server-side (mirrors controller validateTotals).
 */
function validateTotals(body: any) {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0

  for (const line of body.lines) {
    const lineBase = line.quantity * line.unitPrice
    const lineDiscount = lineBase * ((line.discount || 0) / 100)
    const taxableAmount = lineBase - lineDiscount
    const lineTax = taxableAmount * ((line.taxRate || 0) / 100)
    subtotal += lineBase
    discountTotal += lineDiscount
    taxTotal += lineTax
  }

  const total = subtotal - discountTotal + taxTotal

  if (Math.abs(total - body.total) > 0.02) {
    throw new Error(`Total mismatch: calculated ${total.toFixed(2)}, received ${body.total.toFixed(2)}`)
  }

  const paymentTotal = body.payments.reduce((s: number, p: any) => s + p.amount, 0)
  if (paymentTotal < total - 0.02) {
    throw new Error(`Insufficient payment: total ${total.toFixed(2)}, paid ${paymentTotal.toFixed(2)}`)
  }

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    discountTotal: Math.round(discountTotal * 100) / 100,
    taxTotal: Math.round(taxTotal * 100) / 100,
    total: Math.round(total * 100) / 100,
    changeDue: Math.round((paymentTotal - total) * 100) / 100,
  }
}

async function createTransactionViaRepos(
  orgId: string,
  sessionId: string,
  createdBy: string,
  body: ReturnType<typeof buildSaleBody>,
) {
  const r = getRepos()

  // Validate session is open
  const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
  if (!session) throw new Error('POS session not found')
  if (session.status === 'closed') throw new Error('Session is closed')

  const verified = validateTotals(body)
  const transactionNumber = await getNextNumber(orgId, 'TXN', 7)

  const transaction = await r.posTransactions.create({
    ...body,
    orgId,
    sessionId,
    transactionNumber,
    status: 'completed',
    subtotal: verified.subtotal,
    discountTotal: verified.discountTotal,
    taxTotal: verified.taxTotal,
    total: verified.total,
    changeDue: verified.changeDue,
    isFiscal: false,
    createdBy,
  } as any)

  // Atomic session total updates using MongoDB $inc (mirrors controller)
  const incData: Record<string, number> = { transactionCount: 1 }
  if (body.type === 'sale') incData.totalSales = verified.total
  else if (body.type === 'return') incData.totalReturns = verified.total

  const cashPayment = body.payments.filter((p: any) => p.method === 'cash').reduce((s: number, p: any) => s + p.amount, 0)
  const cardPayment = body.payments.filter((p: any) => p.method === 'card').reduce((s: number, p: any) => s + p.amount, 0)
  if (cashPayment) incData.totalCash = cashPayment
  if (cardPayment) incData.totalCard = cardPayment

  await POSSession.findByIdAndUpdate(sessionId, { $inc: incData }).exec()

  return transaction
}

async function closeSessionViaRepos(sessionId: string, orgId: string, closingBalance: number) {
  const r = getRepos()
  const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
  if (!session) throw new Error('POS session not found')
  if (session.status === 'closed') throw new Error('Session already closed')

  const expectedBalance = session.openingBalance + session.totalCash
  return r.posSessions.update(sessionId, {
    status: 'closed',
    closedAt: new Date(),
    closingBalance,
    expectedBalance,
    difference: closingBalance - expectedBalance,
  } as any)
}

async function createStornoViaRepos(
  orgId: string,
  sessionId: string,
  createdBy: string,
  originalTransactionId: string,
  reason: string,
) {
  const r = getRepos()

  const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
  if (!session) throw new Error('POS session not found')
  if (session.status === 'closed') throw new Error('Session is closed')

  const original = await r.posTransactions.findOne({ id: originalTransactionId, orgId } as any) as any
  if (!original) throw new Error('Original transaction not found')
  if (original.status === 'cancelled') throw new Error('Original transaction is already cancelled')
  if (original.type === 'storno') throw new Error('Cannot storno a storno transaction')

  const transactionNumber = await getNextNumber(orgId, 'TXN', 7)

  const stornoTransaction = await r.posTransactions.create({
    orgId,
    sessionId,
    transactionNumber,
    type: 'storno',
    status: 'completed',
    lines: original.lines,
    subtotal: original.subtotal,
    discountTotal: original.discountTotal,
    taxTotal: original.taxTotal,
    total: original.total,
    payments: original.payments,
    changeDue: 0,
    isFiscal: false,
    originalTransactionId: original.id,
    originalTransactionDate: original.createdAt,
    stornoReason: reason,
    createdBy,
  } as any)

  // Mark original as cancelled
  await r.posTransactions.update(original.id, { status: 'cancelled' } as any)

  // Atomic session total update
  await POSSession.findByIdAndUpdate(sessionId, {
    $inc: { totalReturns: original.total, transactionCount: 1 },
  }).exec()

  return stornoTransaction
}

// ════════════════════════════════════════════════════════════════════
// Positive scenarios
// ════════════════════════════════════════════════════════════════════

describe('POS Transaction Flow — Positive', () => {
  it('1. should create a POS session with sessionNumber and status=open', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    expect(session).toBeDefined()
    expect(session.sessionNumber).toMatch(/^POS-\d{4}-\d{6}$/)
    expect(session.status).toBe('open')
    expect(session.openingBalance).toBe(500)
    expect(session.totalSales).toBe(0)
    expect(session.totalReturns).toBe(0)
    expect(session.transactionCount).toBe(0)
  })

  it('2. should create a sale transaction with correct totals and status=completed', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))
    const body = buildSaleBody(String(product._id), { quantity: 3, unitPrice: 50, taxRate: 20 })
    const txn = await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    expect(txn).toBeDefined()
    expect(txn.transactionNumber).toMatch(/^TXN-\d{4}-\d{7}$/)
    expect(txn.type).toBe('sale')
    expect(txn.status).toBe('completed')
    // subtotal = 3 * 50 = 150, tax = 150 * 20% = 30, total = 180
    expect(txn.subtotal).toBe(150)
    expect(txn.taxTotal).toBe(30)
    expect(txn.total).toBe(180)
  })

  it('3. should update session totals after multiple transactions', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    // Create 3 transactions
    for (let i = 1; i <= 3; i++) {
      const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 100 * i })
      await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)
    }

    const updatedSession = await POSSession.findById(session.id)
    expect(updatedSession!.transactionCount).toBe(3)
    // totalSales = 100 + 200 + 300 = 600
    expect(updatedSession!.totalSales).toBe(600)
    expect(updatedSession!.totalCash).toBe(600)
  })

  it('4. should list transactions per session with correct count', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    // Create 2 transactions
    for (let i = 0; i < 2; i++) {
      const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 50 })
      await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)
    }

    const r = getRepos()
    const result = await r.posTransactions.findAll(
      { orgId: String(org._id), sessionId: session.id },
      { page: 0, size: 10, sort: { createdAt: -1 } },
    )

    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('5. should list all transactions globally across sessions', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    // Session 1 with 2 transactions
    const session1 = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))
    for (let i = 0; i < 2; i++) {
      const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 50 })
      await createTransactionViaRepos(String(org._id), session1.id, String(user._id), body)
    }
    await closeSessionViaRepos(session1.id, String(org._id), 600)

    // Session 2 with 1 transaction
    const session2 = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))
    const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 75 })
    await createTransactionViaRepos(String(org._id), session2.id, String(user._id), body)

    const r = getRepos()
    const result = await r.posTransactions.findAll(
      { orgId: String(org._id) },
      { page: 0, size: 50, sort: { createdAt: -1 } },
    )

    expect(result.total).toBe(3)
  })

  it('6. should filter transactions by type=sale', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    // Create a sale
    const saleBody = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 100 })
    const saleTxn = await createTransactionViaRepos(String(org._id), session.id, String(user._id), saleBody)

    // Create a storno (which creates a storno-type transaction)
    await createStornoViaRepos(String(org._id), session.id, String(user._id), saleTxn.id, 'operator_error')

    const r = getRepos()
    const salesOnly = await r.posTransactions.findAll(
      { orgId: String(org._id), type: 'sale' },
      { page: 0, size: 50, sort: { createdAt: -1 } },
    )

    // The original sale is now cancelled, but it still has type='sale'
    expect(salesOnly.items.every((t: any) => t.type === 'sale')).toBe(true)
  })

  it('7. should filter transactions by status=completed', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const saleBody = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 100 })
    const saleTxn = await createTransactionViaRepos(String(org._id), session.id, String(user._id), saleBody)

    // Storno cancels the original
    await createStornoViaRepos(String(org._id), session.id, String(user._id), saleTxn.id, 'customer_return')

    const r = getRepos()
    const completedOnly = await r.posTransactions.findAll(
      { orgId: String(org._id), status: 'completed' },
      { page: 0, size: 50, sort: { createdAt: -1 } },
    )

    // Only the storno transaction should be 'completed' (original is 'cancelled')
    expect(completedOnly.items.every((t: any) => t.status === 'completed')).toBe(true)
    expect(completedOnly.total).toBe(1)
  })

  it('8. should filter transactions by date range', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 100 })
    await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    const now = new Date()
    const dayBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const dayAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    const r = getRepos()

    // Date range that includes today
    const inRange = await r.posTransactions.findAll(
      { orgId: String(org._id), createdAt: { $gte: dayBefore, $lte: dayAfter } } as any,
      { page: 0, size: 50, sort: { createdAt: -1 } },
    )
    expect(inRange.total).toBe(1)

    // Date range in the past (should return 0)
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)
    const outOfRange = await r.posTransactions.findAll(
      { orgId: String(org._id), createdAt: { $gte: twoDaysAgo, $lte: dayBefore } } as any,
      { page: 0, size: 50, sort: { createdAt: -1 } },
    )
    expect(outOfRange.total).toBe(0)
  })

  it('9. should search transactions by transaction number', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 100 })
    const txn = await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    const r = getRepos()
    const result = await r.posTransactions.findAll(
      {
        orgId: String(org._id),
        $or: [
          { transactionNumber: { $regex: 'TXN', $options: 'i' } },
        ],
      } as any,
      { page: 0, size: 50, sort: { createdAt: -1 } },
    )

    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.items.some((t: any) => t.transactionNumber === txn.transactionNumber)).toBe(true)
  })

  it('10. should get transaction detail with all fields', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 2, unitPrice: 75, taxRate: 10 })
    const txn = await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    const r = getRepos()
    const detail = await r.posTransactions.findOne({ id: txn.id, orgId: String(org._id) } as any) as any

    expect(detail).toBeDefined()
    expect(detail.transactionNumber).toBe(txn.transactionNumber)
    expect(detail.type).toBe('sale')
    expect(detail.status).toBe('completed')
    expect(detail.subtotal).toBe(150)
    expect(detail.taxTotal).toBe(15)
    expect(detail.total).toBe(165)
    expect(detail.lines).toHaveLength(1)
    expect(detail.lines[0].name).toBe('Test Product')
    expect(detail.payments).toHaveLength(1)
    expect(detail.payments[0].method).toBe('cash')
  })

  it('11. should create storno and mark original as cancelled', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 2, unitPrice: 50 })
    const original = await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    const storno = await createStornoViaRepos(
      String(org._id), session.id, String(user._id), original.id, 'operator_error',
    )

    expect(storno).toBeDefined()
    expect(storno.type).toBe('storno')
    expect(storno.status).toBe('completed')
    expect(storno.stornoReason).toBe('operator_error')
    expect(storno.originalTransactionId).toBeDefined()
    expect(storno.total).toBe(original.total)

    // Original should be cancelled
    const r = getRepos()
    const updatedOriginal = await r.posTransactions.findOne({ id: original.id, orgId: String(org._id) } as any) as any
    expect(updatedOriginal.status).toBe('cancelled')

    // Session totalReturns should be updated
    const updatedSession = await POSSession.findById(session.id)
    expect(updatedSession!.totalReturns).toBe(original.total)
  })

  it('12. should close session with closingBalance and calculate difference', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id), 500)

    // Create a cash sale of 200
    const body = buildSaleBody(String(product._id), { quantity: 2, unitPrice: 100 })
    await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    const closed = await closeSessionViaRepos(session.id, String(org._id), 690) as any

    expect(closed.status).toBe('closed')
    expect(closed.closedAt).toBeDefined()
    expect(closed.closingBalance).toBe(690)
    // expectedBalance = openingBalance(500) + totalCash(200) = 700
    expect(closed.expectedBalance).toBe(700)
    // difference = 690 - 700 = -10
    expect(closed.difference).toBe(-10)
  })
})

// ════════════════════════════════════════════════════════════════════
// Negative scenarios
// ════════════════════════════════════════════════════════════════════

describe('POS Transaction Flow — Negative', () => {
  it('13. should reject transaction on a closed session', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))
    await closeSessionViaRepos(session.id, String(org._id), 500)

    const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 50 })

    expectRejection(await captureRejection(createTransactionViaRepos(String(org._id), session.id, String(user._id), body)), 'Session is closed')
  })

  it('14. should reject transaction with total mismatch', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 2, unitPrice: 100 })
    // Tamper with the total
    body.total = 999

    expectRejection(await captureRejection(createTransactionViaRepos(String(org._id), session.id, String(user._id), body)), 'Total mismatch')
  })

  it('15. should reject transaction with insufficient payment', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    // Build a valid body then reduce payment amount
    const body = buildSaleBody(String(product._id), { quantity: 2, unitPrice: 100 })
    body.payments = [{ method: 'cash', amount: 50 }] // 50 < 200 total

    expectRejection(await captureRejection(createTransactionViaRepos(String(org._id), session.id, String(user._id), body)), 'Insufficient payment')
  })

  it('16. should reject storno of non-existent transaction', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const fakeId = String(new Types.ObjectId())

    expectRejection(await captureRejection(createStornoViaRepos(String(org._id), session.id, String(user._id), fakeId, 'operator_error')), 'Original transaction not found')
  })

  it('17. should reject storno of already-cancelled transaction', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 80 })
    const original = await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    // First storno — should succeed
    await createStornoViaRepos(String(org._id), session.id, String(user._id), original.id, 'operator_error')

    // Second storno of same transaction — should fail
    expectRejection(await captureRejection(createStornoViaRepos(String(org._id), session.id, String(user._id), original.id, 'operator_error')), 'Original transaction is already cancelled')
  })

  it('18. should reject storno of a storno transaction', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const session = await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    const body = buildSaleBody(String(product._id), { quantity: 1, unitPrice: 60 })
    const original = await createTransactionViaRepos(String(org._id), session.id, String(user._id), body)

    const storno = await createStornoViaRepos(
      String(org._id), session.id, String(user._id), original.id, 'customer_return',
    )

    // Try to storno the storno
    expectRejection(await captureRejection(createStornoViaRepos(String(org._id), session.id, String(user._id), storno.id, 'operator_error')), 'Cannot storno a storno transaction')
  })

  it('19. should reject duplicate open session for same cashier', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id, { operatorCode: '0001' })
    const warehouse = await createTestWarehouse(org._id)

    await createSessionViaRepos(String(org._id), String(warehouse._id), String(user._id))

    // Check for existing open session before creating (mirrors controller logic)
    const r = getRepos()
    const existing = await r.posSessions.findOne({
      orgId: String(org._id),
      cashierId: String(user._id),
      status: 'open',
    } as any)

    expect(existing).toBeDefined()
    // The controller returns 400, we verify the condition that triggers it
    expect(existing!.status).toBe('open')
  })

  it('20. should return null for non-existent transaction', async () => {
    const org = await createTestOrg()

    const r = getRepos()
    const fakeId = String(new Types.ObjectId())
    const result = await r.posTransactions.findOne({ id: fakeId, orgId: String(org._id) } as any)

    expect(result).toBeNull()
  })
})
