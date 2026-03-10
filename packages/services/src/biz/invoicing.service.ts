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

  // Batch load all stock levels for the relevant product+warehouse combinations
  const productIds = [...new Set(productLines.map(l => l.productId!))]
  const warehouseIds = [...new Set(productLines.map(l => l.warehouseId!))]
  const allStockLevels = await r.stockLevels.findMany(
    { orgId, productId: { $in: productIds }, warehouseId: { $in: warehouseIds } } as any,
  )

  // Index stock levels by productId+warehouseId for O(1) lookup
  const stockMap = new Map<string, number>()
  for (const sl of allStockLevels) {
    stockMap.set(`${sl.productId}:${sl.warehouseId}`, sl.quantity)
  }

  const insufficient: string[] = []
  const missingProductIds: string[] = []
  const missingWarehouseIds: string[] = []

  for (const line of productLines) {
    const available = stockMap.get(`${line.productId}:${line.warehouseId}`) ?? 0
    if (available < line.quantity) {
      missingProductIds.push(line.productId!)
      missingWarehouseIds.push(line.warehouseId!)
    }
  }

  if (missingProductIds.length > 0) {
    // Batch load product and warehouse names only for insufficient lines
    const uniqueProductIds = [...new Set(missingProductIds)]
    const uniqueWarehouseIds = [...new Set(missingWarehouseIds)]
    const [products, warehouses] = await Promise.all([
      Promise.all(uniqueProductIds.map(id => r.products.findById(id))),
      Promise.all(uniqueWarehouseIds.map(id => r.warehouses.findById(id))),
    ])
    const productMap = new Map(products.filter(Boolean).map(p => [(p as any).id ?? (p as any)._id?.toString(), p]))
    const warehouseMap = new Map(warehouses.filter(Boolean).map(w => [(w as any).id ?? (w as any)._id?.toString(), w]))

    for (const line of productLines) {
      const available = stockMap.get(`${line.productId}:${line.warehouseId}`) ?? 0
      if (available < line.quantity) {
        const product = productMap.get(line.productId!)
        const warehouse = warehouseMap.get(line.warehouseId!)
        const productName = (product as any)?.name || line.description || line.productId
        const warehouseName = (warehouse as any)?.name || line.warehouseId
        insufficient.push(`${productName} @ ${warehouseName}: available ${available}, requested ${line.quantity}`)
      }
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
      contactId: invoice.contactId || undefined,
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
      contactId: invoice.contactId || undefined,
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
