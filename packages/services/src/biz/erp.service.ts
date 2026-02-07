import {
  ProductionOrder, StockMovement, StockLevel, POSSession, POSTransaction,
  type IProductionOrder, type IPOSSession,
} from 'db/models'
import { adjustStock } from './warehouse.service.js'
import { logger } from '../logger/logger.js'

export async function startProduction(orderId: string): Promise<IProductionOrder> {
  const order = await ProductionOrder.findById(orderId)
  if (!order) throw new Error('Production order not found')
  if (order.status !== 'planned') throw new Error('Only planned orders can be started')

  order.status = 'in_progress'
  order.actualStartDate = new Date()
  await order.save()

  logger.info({ orderId, orderNumber: order.orderNumber }, 'Production started')
  return order
}

export async function completeProduction(
  orderId: string,
  quantityProduced: number,
  quantityDefective: number,
): Promise<IProductionOrder> {
  const order = await ProductionOrder.findById(orderId)
  if (!order) throw new Error('Production order not found')
  if (order.status !== 'in_progress' && order.status !== 'quality_check') {
    throw new Error('Order must be in progress or quality check')
  }

  const orgId = String(order.orgId)

  // Add finished goods to output warehouse
  if (quantityProduced > 0) {
    await adjustStock(orgId, String(order.productId), String(order.outputWarehouseId), quantityProduced, order.costPerUnit)
  }

  order.status = 'completed'
  order.actualEndDate = new Date()
  order.quantityProduced = quantityProduced
  order.quantityDefective = quantityDefective
  await order.save()

  logger.info({ orderId, quantityProduced, quantityDefective }, 'Production completed')
  return order
}

export async function openPOSSession(
  orgId: string,
  warehouseId: string,
  cashierId: string,
  openingBalance: number,
  currency: string,
): Promise<IPOSSession> {
  // Check for existing open session
  const existing = await POSSession.findOne({ orgId, cashierId, status: 'open' })
  if (existing) throw new Error('Cashier already has an open session')

  const count = await POSSession.countDocuments({ orgId })
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '')
  const sessionNumber = `POS-${today}-${String(count + 1).padStart(3, '0')}`

  const session = await POSSession.create({
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
  })

  logger.info({ sessionId: session._id, sessionNumber }, 'POS session opened')
  return session
}

export async function closePOSSession(
  sessionId: string,
  closingBalance: number,
): Promise<IPOSSession> {
  const session = await POSSession.findById(sessionId)
  if (!session) throw new Error('POS session not found')
  if (session.status !== 'open') throw new Error('Session is not open')

  session.status = 'closed'
  session.closedAt = new Date()
  session.closingBalance = closingBalance
  session.expectedBalance = session.openingBalance + session.totalCash
  session.difference = closingBalance - session.expectedBalance
  await session.save()

  logger.info({ sessionId, difference: session.difference }, 'POS session closed')
  return session
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
) {
  const session = await POSSession.findById(sessionId)
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

  const count = await POSTransaction.countDocuments({ orgId, sessionId })
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '')
  const transactionNumber = `TXN-${today}-${String(count + 1).padStart(3, '0')}`

  const transaction = await POSTransaction.create({
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
  })

  // Update session totals
  if (data.type === 'sale') {
    session.totalSales += total
  } else if (data.type === 'return') {
    session.totalReturns += total
  }

  for (const payment of data.payments) {
    if (payment.method === 'cash') session.totalCash += payment.amount
    if (payment.method === 'card') session.totalCard += payment.amount
  }
  session.transactionCount += 1
  await session.save()

  return transaction
}
