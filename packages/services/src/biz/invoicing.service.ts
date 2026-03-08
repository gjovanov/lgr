import type { RepositoryRegistry } from 'dal'
import type { IInvoice } from 'dal/entities'
import { getRepos } from '../context.js'
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
  repos?: RepositoryRegistry,
): Promise<IInvoice> {
  const r = repos ?? getRepos()
  const invoice = await r.invoices.findById(invoiceId)
  if (!invoice) throw new Error('Invoice not found')
  if (['paid', 'voided', 'cancelled'].includes(invoice.status)) {
    throw new Error(`Cannot record payment on ${invoice.status} invoice`)
  }

  if (payment.amount > invoice.amountDue) {
    throw new Error('Payment amount exceeds amount due')
  }

  const newPayments = [...invoice.payments, payment]
  const newAmountPaid = invoice.amountPaid + payment.amount
  const newAmountDue = invoice.total - newAmountPaid

  let newStatus = invoice.status
  if (newAmountDue <= 0.01) {
    newStatus = 'paid'
  } else {
    newStatus = 'partially_paid'
  }

  const updated = await r.invoices.update(invoiceId, {
    payments: newPayments,
    amountPaid: newAmountPaid,
    amountDue: newAmountDue,
    status: newStatus,
    ...(newStatus === 'paid' ? { paidAt: new Date() } : {}),
  } as any)
  if (!updated) throw new Error('Failed to update invoice')

  logger.info({ invoiceId, amount: payment.amount }, 'Payment recorded')
  return updated
}

export async function sendInvoice(invoiceId: string, repos?: RepositoryRegistry): Promise<IInvoice> {
  const r = repos ?? getRepos()
  const invoice = await r.invoices.findById(invoiceId)
  if (!invoice) throw new Error('Invoice not found')
  if (invoice.status !== 'draft') throw new Error('Only draft invoices can be sent')

  const updated = await r.invoices.update(invoiceId, {
    status: 'sent',
    sentAt: new Date(),
  } as any)
  if (!updated) throw new Error('Failed to update invoice')

  logger.info({ invoiceId, invoiceNumber: invoice.invoiceNumber }, 'Invoice sent')
  return updated
}

export async function checkOverdueInvoices(orgId: string, repos?: RepositoryRegistry): Promise<number> {
  const r = repos ?? getRepos()
  return r.invoices.updateMany(
    {
      orgId,
      status: { $in: ['sent', 'partially_paid'] },
      dueDate: { $lt: new Date() },
    } as any,
    { status: 'overdue' } as any,
  )
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

async function getNextMovementNumber(orgId: string, repos: RepositoryRegistry): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `SM-${year}-`
  const movements = await repos.stockMovements.findMany(
    { orgId, movementNumber: { $regex: `^${prefix}` } } as any,
    { movementNumber: -1 },
  )
  if (!movements.length) {
    return `${prefix}00001`
  }
  const currentNum = parseInt(movements[0].movementNumber.replace(prefix, ''), 10)
  return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
}

export async function validateStockAvailability(
  orgId: string,
  lines: { productId?: string; warehouseId?: string; quantity: number; description?: string }[],
  repos?: RepositoryRegistry,
): Promise<void> {
  const r = repos ?? getRepos()
  const productLines = lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) return

  const insufficient: string[] = []

  for (const line of productLines) {
    const stockLevel = await r.stockLevels.findOne({
      orgId,
      productId: line.productId!,
      warehouseId: line.warehouseId!,
    })

    const available = stockLevel?.quantity ?? 0
    if (available < line.quantity) {
      // Look up product and warehouse names for a user-friendly message
      const [product, warehouse] = await Promise.all([
        r.products.findById(line.productId!),
        r.warehouses.findById(line.warehouseId!),
      ])
      const productName = (product as any)?.name || line.description || line.productId
      const warehouseName = (warehouse as any)?.name || line.warehouseId
      insufficient.push(`${productName} @ ${warehouseName}: available ${available}, requested ${line.quantity}`)
    }
  }

  if (insufficient.length > 0) {
    throw new Error(`Insufficient stock:\n${insufficient.join('\n')}`)
  }
}

export async function createInvoiceStockMovement(invoice: IInvoice, userId: string, repos?: RepositoryRegistry): Promise<void> {
  const r = repos ?? getRepos()
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) return

  const orgId = invoice.orgId

  // Group lines by warehouseId
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = line.warehouseId!
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

  // Validate stock availability for dispatch movements (outgoing)
  if (movementType === 'dispatch') {
    await validateStockAvailability(orgId, productLines, r)
  }

  for (const [warehouseId, lines] of byWarehouse) {
    const movementNumber = await getNextMovementNumber(orgId, r)
    const movementLines = lines.map(l => ({
      productId: l.productId!,
      quantity: l.quantity,
      unitCost: l.unitPrice,
      totalCost: l.quantity * l.unitPrice,
    }))
    const totalAmount = movementLines.reduce((s, l) => s + l.totalCost, 0)

    const movement = await r.stockMovements.create({
      orgId,
      movementNumber,
      type: movementType,
      status: 'draft',
      date: new Date(),
      fromWarehouseId: movementType === 'dispatch' ? warehouseId : undefined,
      toWarehouseId: movementType !== 'dispatch' ? warehouseId : undefined,
      invoiceId: invoice.id,
      lines: movementLines,
      totalAmount,
      createdBy: userId,
    } as any)

    await confirmMovement(movement.id, r)
  }

  logger.info({ invoiceId: invoice.id, movementType }, 'Invoice stock movement created')
}

export async function reverseInvoiceStockMovement(invoice: IInvoice, userId: string, repos?: RepositoryRegistry): Promise<void> {
  const r = repos ?? getRepos()
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) return

  const orgId = invoice.orgId

  // Group lines by warehouseId
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = line.warehouseId!
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

  // Validate stock availability for reverse dispatch movements
  if (reverseType === 'dispatch') {
    await validateStockAvailability(orgId, productLines, r)
  }

  for (const [warehouseId, lines] of byWarehouse) {
    const movementNumber = await getNextMovementNumber(orgId, r)
    const movementLines = lines.map(l => ({
      productId: l.productId!,
      quantity: l.quantity,
      unitCost: l.unitPrice,
      totalCost: l.quantity * l.unitPrice,
    }))
    const totalAmount = movementLines.reduce((s, l) => s + l.totalCost, 0)

    const movement = await r.stockMovements.create({
      orgId,
      movementNumber,
      type: reverseType,
      status: 'draft',
      date: new Date(),
      fromWarehouseId: reverseType === 'dispatch' ? warehouseId : undefined,
      toWarehouseId: reverseType !== 'dispatch' ? warehouseId : undefined,
      invoiceId: invoice.id,
      lines: movementLines,
      totalAmount,
      notes: `Reversal for voided invoice ${invoice.invoiceNumber}`,
      createdBy: userId,
    } as any)

    await confirmMovement(movement.id, r)
  }

  logger.info({ invoiceId: invoice.id, reverseType }, 'Invoice stock movement reversed')
}
