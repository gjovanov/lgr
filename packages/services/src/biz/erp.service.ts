import type { RepositoryRegistry } from 'dal'
import type { IProductionOrder, IPOSSession } from 'dal/entities'
import { adjustStock } from './warehouse.service.js'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

export async function startProduction(orderId: string, repos?: RepositoryRegistry): Promise<IProductionOrder> {
  const r = repos ?? getRepos()
  const order = await r.productionOrders.findById(orderId)
  if (!order) throw new Error('Production order not found')
  if (order.status !== 'planned') throw new Error('Only planned orders can be started')

  const updated = await r.productionOrders.update(order.id, {
    status: 'in_progress',
    actualStartDate: new Date(),
  } as any)
  if (!updated) throw new Error('Failed to update production order')

  logger.info({ orderId, orderNumber: order.orderNumber }, 'Production started')
  return updated
}

export async function completeProduction(
  orderId: string,
  quantityProduced: number,
  quantityDefective: number,
  repos?: RepositoryRegistry,
): Promise<IProductionOrder> {
  const r = repos ?? getRepos()
  const order = await r.productionOrders.findById(orderId)
  if (!order) throw new Error('Production order not found')
  if (order.status !== 'in_progress' && order.status !== 'quality_check') {
    throw new Error('Order must be in progress or quality check')
  }

  const orgId = order.orgId

  // Add finished goods to output warehouse
  if (quantityProduced > 0) {
    await adjustStock(orgId, order.productId, order.outputWarehouseId, quantityProduced, order.costPerUnit, r)
  }

  const updated = await r.productionOrders.update(order.id, {
    status: 'completed',
    actualEndDate: new Date(),
    quantityProduced,
    quantityDefective,
  } as any)
  if (!updated) throw new Error('Failed to update production order')

  logger.info({ orderId, quantityProduced, quantityDefective }, 'Production completed')
  return updated
}

export async function openPOSSession(
  orgId: string,
  warehouseId: string,
  cashierId: string,
  openingBalance: number,
  currency: string,
  repos?: RepositoryRegistry,
): Promise<IPOSSession> {
  const r = repos ?? getRepos()

  // Check for existing open session
  const existing = await r.posSessions.findOne({ orgId, cashierId, status: 'open' } as any)
  if (existing) throw new Error('Cashier already has an open session')

  const count = await r.posSessions.count({ orgId } as any)
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '')
  const sessionNumber = `POS-${today}-${String(count + 1).padStart(3, '0')}`

  const session = await r.posSessions.create({
    orgId,
    warehouseId,
    cashierId,
    sessionNumber,
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

  logger.info({ sessionId: session.id, sessionNumber }, 'POS session opened')
  return session
}

export async function closePOSSession(
  sessionId: string,
  closingBalance: number,
  repos?: RepositoryRegistry,
): Promise<IPOSSession> {
  const r = repos ?? getRepos()
  const session = await r.posSessions.findById(sessionId)
  if (!session) throw new Error('POS session not found')
  if (session.status !== 'open') throw new Error('Session is not open')

  const expectedBalance = session.openingBalance + session.totalCash
  const difference = closingBalance - expectedBalance

  const updated = await r.posSessions.update(session.id, {
    status: 'closed',
    closedAt: new Date(),
    closingBalance,
    expectedBalance,
    difference,
  } as any)
  if (!updated) throw new Error('Failed to update POS session')

  logger.info({ sessionId, difference }, 'POS session closed')
  return updated
}

export async function createPOSTransaction(
  sessionId: string,
  orgId: string,
  userId: string,
  data: {
    type: string
    customerId?: string
    lines: { productId: string; name: string; quantity: number; unitPrice: number; discount: number; taxRate: number }[]
    payments: { method: string; amount: number; reference?: string }[]
  },
  repos?: RepositoryRegistry,
) {
  const r = repos ?? getRepos()
  const session = await r.posSessions.findById(sessionId)
  if (!session) throw new Error('POS session not found')
  if (session.status !== 'open') throw new Error('Session is not open')

  // Calculate line totals
  const lines = data.lines.map(line => {
    const lineTotal = line.quantity * line.unitPrice * (1 - line.discount / 100)
    const taxAmount = lineTotal * line.taxRate / 100
    return { ...line, taxAmount, lineTotal }
  })

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0)
  const discountTotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice * l.discount / 100, 0)
  const taxTotal = lines.reduce((sum, l) => sum + l.taxAmount, 0)
  const total = subtotal - discountTotal + taxTotal
  const totalPaid = data.payments.reduce((sum, p) => sum + p.amount, 0)
  const changeDue = totalPaid - total

  const count = await r.posTransactions.count({ orgId, sessionId } as any)
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '')
  const transactionNumber = `TXN-${today}-${String(count + 1).padStart(3, '0')}`

  const transaction = await r.posTransactions.create({
    orgId,
    sessionId,
    transactionNumber,
    type: data.type,
    customerId: data.customerId,
    lines,
    subtotal,
    discountTotal,
    taxTotal,
    total,
    payments: data.payments,
    changeDue,
    createdBy: userId,
  } as any)

  // Update session totals
  let totalSales = session.totalSales
  let totalReturns = session.totalReturns
  if (data.type === 'sale') {
    totalSales += total
  } else if (data.type === 'return') {
    totalReturns += total
  }

  let totalCash = session.totalCash
  let totalCard = session.totalCard
  for (const payment of data.payments) {
    if (payment.method === 'cash') totalCash += payment.amount
    if (payment.method === 'card') totalCard += payment.amount
  }

  await r.posSessions.update(session.id, {
    totalSales,
    totalReturns,
    totalCash,
    totalCard,
    transactionCount: session.transactionCount + 1,
  } as any)

  return transaction
}
