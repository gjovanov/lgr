import { Invoice, JournalEntry, Account, StockMovement, type IInvoice } from 'db/models'
import { stockMovementDao } from '../dao/warehouse/stock-movement.dao.js'
import { confirmMovement } from './warehouse.service.js'
import { logger } from '../logger/logger.js'

export async function recordPayment(
  invoiceId: string,
  payment: {
    date: Date
    amount: number
    method: string
    reference?: string
    bankAccountId?: string
  },
): Promise<IInvoice> {
  const invoice = await Invoice.findById(invoiceId)
  if (!invoice) throw new Error('Invoice not found')
  if (['paid', 'voided', 'cancelled'].includes(invoice.status)) {
    throw new Error(`Cannot record payment on ${invoice.status} invoice`)
  }

  if (payment.amount > invoice.amountDue) {
    throw new Error('Payment amount exceeds amount due')
  }

  invoice.payments.push(payment as any)
  invoice.amountPaid += payment.amount
  invoice.amountDue = invoice.total - invoice.amountPaid

  if (invoice.amountDue <= 0.01) {
    invoice.status = 'paid'
    invoice.paidAt = new Date()
  } else {
    invoice.status = 'partially_paid'
  }

  await invoice.save()
  logger.info({ invoiceId, amount: payment.amount }, 'Payment recorded')
  return invoice
}

export async function sendInvoice(invoiceId: string): Promise<IInvoice> {
  const invoice = await Invoice.findById(invoiceId)
  if (!invoice) throw new Error('Invoice not found')
  if (invoice.status !== 'draft') throw new Error('Only draft invoices can be sent')

  invoice.status = 'sent'
  invoice.sentAt = new Date()
  await invoice.save()

  logger.info({ invoiceId, invoiceNumber: invoice.invoiceNumber }, 'Invoice sent')
  return invoice
}

export async function checkOverdueInvoices(orgId: string): Promise<number> {
  const result = await Invoice.updateMany(
    {
      orgId,
      status: { $in: ['sent', 'partially_paid'] },
      dueDate: { $lt: new Date() },
    },
    { status: 'overdue' },
  )
  return result.modifiedCount
}

export function calculateInvoiceTotals(
  lines: { quantity: number; unitPrice: number; discount: number; taxRate: number }[],
): { subtotal: number; discountTotal: number; taxTotal: number; total: number } {
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0

  for (const line of lines) {
    const lineTotal = line.quantity * line.unitPrice
    const lineDiscount = lineTotal * (line.discount / 100)
    const taxableAmount = lineTotal - lineDiscount
    const lineTax = taxableAmount * (line.taxRate / 100)

    subtotal += lineTotal
    discountTotal += lineDiscount
    taxTotal += lineTax
  }

  return {
    subtotal,
    discountTotal,
    taxTotal,
    total: subtotal - discountTotal + taxTotal,
  }
}

export async function createInvoiceStockMovement(invoice: IInvoice, userId: string): Promise<void> {
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) return

  const orgId = String(invoice.orgId)

  // Group lines by warehouseId
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = String(line.warehouseId)
    if (!byWarehouse.has(whId)) byWarehouse.set(whId, [])
    byWarehouse.get(whId)!.push(line)
  }

  // Determine movement type based on invoice type and direction
  let movementType: string
  if (invoice.type === 'credit_note') {
    movementType = 'return'
  } else if (invoice.direction === 'outgoing') {
    movementType = 'dispatch'
  } else {
    movementType = 'receipt'
  }

  for (const [warehouseId, lines] of byWarehouse) {
    const movementNumber = await stockMovementDao.getNextMovementNumber(orgId)
    const movementLines = lines.map(l => ({
      productId: l.productId!,
      quantity: l.quantity,
      unitCost: l.unitPrice,
      totalCost: l.quantity * l.unitPrice,
    }))
    const totalAmount = movementLines.reduce((s, l) => s + l.totalCost, 0)

    const movement = await StockMovement.create({
      orgId,
      movementNumber,
      type: movementType,
      status: 'draft',
      date: new Date(),
      fromWarehouseId: movementType === 'dispatch' ? warehouseId : undefined,
      toWarehouseId: movementType !== 'dispatch' ? warehouseId : undefined,
      invoiceId: invoice._id,
      lines: movementLines,
      totalAmount,
      createdBy: userId,
    })

    await confirmMovement(String(movement._id))
  }

  logger.info({ invoiceId: String(invoice._id), movementType }, 'Invoice stock movement created')
}

export async function reverseInvoiceStockMovement(invoice: IInvoice, userId: string): Promise<void> {
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) return

  const orgId = String(invoice.orgId)

  // Group lines by warehouseId
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = String(line.warehouseId)
    if (!byWarehouse.has(whId)) byWarehouse.set(whId, [])
    byWarehouse.get(whId)!.push(line)
  }

  // Reverse: dispatch→receipt, receipt→dispatch, return→dispatch
  let reverseType: string
  if (invoice.type === 'credit_note') {
    reverseType = 'dispatch'
  } else if (invoice.direction === 'outgoing') {
    reverseType = 'receipt'
  } else {
    reverseType = 'dispatch'
  }

  for (const [warehouseId, lines] of byWarehouse) {
    const movementNumber = await stockMovementDao.getNextMovementNumber(orgId)
    const movementLines = lines.map(l => ({
      productId: l.productId!,
      quantity: l.quantity,
      unitCost: l.unitPrice,
      totalCost: l.quantity * l.unitPrice,
    }))
    const totalAmount = movementLines.reduce((s, l) => s + l.totalCost, 0)

    const movement = await StockMovement.create({
      orgId,
      movementNumber,
      type: reverseType,
      status: 'draft',
      date: new Date(),
      fromWarehouseId: reverseType === 'dispatch' ? warehouseId : undefined,
      toWarehouseId: reverseType !== 'dispatch' ? warehouseId : undefined,
      invoiceId: invoice._id,
      lines: movementLines,
      totalAmount,
      notes: `Reversal for voided invoice ${invoice.invoiceNumber}`,
      createdBy: userId,
    })

    await confirmMovement(String(movement._id))
  }

  logger.info({ invoiceId: String(invoice._id), reverseType }, 'Invoice stock movement reversed')
}
