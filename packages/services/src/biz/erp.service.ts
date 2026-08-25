/**
 * ERP POS Service — business logic for POS sessions and transactions.
 * Extracted from pos.controller.ts for testability.
 */
import { getRepos } from '../context.js'
import { getNextNumber } from './sequence.service.js'

export async function openPOSSession(
  orgId: string,
  warehouseId: string,
  cashierId: string,
  openingBalance: number,
  currency: string,
) {
  const r = getRepos()

  const existing = await r.posSessions.findOne({ orgId, cashierId, status: 'open' } as any)
  if (existing) throw new Error('Cashier already has an open session')

  const sessionNumber = await getNextNumber(orgId, 'POS', 6)

  const session = await r.posSessions.create({
    orgId,
    warehouseId,
    sessionNumber,
    cashierId,
    openedAt: new Date(),
    status: 'open',
    openingBalance,
    currency,
    totalSales: 0,
    totalReturns: 0,
    totalCash: 0,
    totalCard: 0,
    transactionCount: 0,
  } as any)

  return session
}

/**
 * @deprecated FR-09 (#18). This is the OLD bookkeeping-only close and no production code
 * path calls it — only `unit/biz/erp-pos.test.ts` does. It does not run the fiscal
 * Z-report, does not record the per-method breakdown, and does not guard against a
 * concurrent close, so using it would mark a day closed in LGR while the fiscal device
 * still has it open.
 *
 * The real close is `POST /org/:orgId/trade/pos/session/:id/close`
 * (`invoicing-api/src/controllers/pos.controller.ts`). Kept only so its existing tests keep
 * documenting the legacy arithmetic; delete both when someone is confident nothing external
 * imports it.
 */
export async function closePOSSession(sessionId: string, closingBalance: number) {
  const r = getRepos()

  const session = await r.posSessions.findById(sessionId) as any
  if (!session) throw new Error('POS session not found')
  if (session.status !== 'open') throw new Error('Session is not open')

  const expectedBalance = session.openingBalance + session.totalCash
  const updated = await r.posSessions.update(sessionId, {
    status: 'closed',
    closedAt: new Date(),
    closingBalance,
    expectedBalance,
    difference: closingBalance - expectedBalance,
  } as any)

  return updated
}

export async function createPOSTransaction(
  sessionId: string,
  orgId: string,
  userId: string,
  body: {
    type: 'sale' | 'return'
    lines: Array<{
      productId: string
      name: string
      quantity: number
      unitPrice: number
      discount: number
      taxRate: number
    }>
    payments: Array<{ method: string; amount: number }>
  },
) {
  const r = getRepos()

  const session = await r.posSessions.findById(sessionId) as any
  if (!session) throw new Error('POS session not found')
  if (session.status !== 'open') throw new Error('Session is not open')

  // Calculate totals
  let subtotal = 0
  let taxTotal = 0
  for (const line of body.lines) {
    const lineBase = line.quantity * line.unitPrice
    const lineDiscount = lineBase * ((line.discount || 0) / 100)
    const taxableAmount = lineBase - lineDiscount
    subtotal += lineBase
    taxTotal += taxableAmount * ((line.taxRate || 0) / 100)
  }
  subtotal = Math.round(subtotal * 100) / 100
  taxTotal = Math.round(taxTotal * 100) / 100
  const total = Math.round((subtotal + taxTotal) * 100) / 100

  const paymentTotal = body.payments.reduce((s, p) => s + p.amount, 0)
  const changeDue = Math.round((paymentTotal - total) * 100) / 100

  const transactionNumber = await getNextNumber(orgId, 'TXN', 7)

  const transaction = await r.posTransactions.create({
    orgId,
    sessionId,
    transactionNumber,
    type: body.type,
    status: 'completed',
    lines: body.lines.map(l => ({
      ...l,
      taxAmount: Math.round(l.quantity * l.unitPrice * ((l.taxRate || 0) / 100) * 100) / 100,
      lineTotal: l.quantity * l.unitPrice,
    })),
    subtotal,
    discountTotal: 0,
    taxTotal,
    total,
    payments: body.payments,
    changeDue,
    createdBy: userId,
  } as any)

  // Update session aggregates
  const cashAmount = body.payments.filter(p => p.method === 'cash').reduce((s, p) => s + p.amount, 0)
  const cardAmount = body.payments.filter(p => p.method === 'card').reduce((s, p) => s + p.amount, 0)

  const updates: Record<string, any> = {
    transactionCount: (session.transactionCount || 0) + 1,
  }

  if (body.type === 'sale') {
    updates.totalSales = (session.totalSales || 0) + total
    updates.totalCash = (session.totalCash || 0) + cashAmount
    updates.totalCard = (session.totalCard || 0) + cardAmount
  } else if (body.type === 'return') {
    updates.totalReturns = (session.totalReturns || 0) + total
  }

  await r.posSessions.update(sessionId, updates as any)

  return transaction
}
