import type { RepositoryRegistry } from 'dal'
import type { IInvoice } from 'dal/entities'
import { Reservation } from 'db/models'
import { getRepos } from '../context.js'
import { confirmMovement } from './warehouse.service.js'
import { restoreCostLayers } from './costing.service.js'
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

/**
 * Per-reservation exemption budgets: each reservation exempts at most its OPEN
 * (undispatched, non-cancelled) quantity, computed once per validation call. The
 * dispatch movement runs before the reservation sync, so `dispatchedQuantity` excludes
 * the current document — which is exactly why the budget must be shared across all of
 * the document's lines instead of re-granted per line.
 */
export async function loadReservationBudgets(orgId: string, reservationIds: string[]): Promise<Map<string, number>> {
  const budgets = new Map<string, number>()
  if (!reservationIds.length) return budgets
  const resDocs = await Reservation.find(
    { orgId, _id: { $in: reservationIds } } as any,
    { quantity: 1, dispatchedQuantity: 1, status: 1 },
  ).lean().exec()
  for (const res of resDocs) {
    if ((res as any).status === 'cancelled') continue
    budgets.set(String((res as any)._id), Math.max(0, ((res as any).quantity || 0) - ((res as any).dispatchedQuantity || 0)))
  }
  return budgets
}

export async function validateStockAvailability(
  orgId: string,
  lines: { productId?: string; warehouseId?: string; quantity: number; description?: string }[],
  repos?: RepositoryRegistry,
): Promise<void> {
  const r = repos ?? getRepos()
  const withProduct = lines.filter(l => l.productId && l.warehouseId)
  if (!withProduct.length) return

  // Lines dispatching against a reservation consume their own hold — the reserved stock
  // is excluded from the sellable quantity precisely so it stays theirs to take. The
  // exemption is capped at the reservation's open quantity; any excess competes for
  // free stock like everyone else. Missing/cancelled reservations grant no exemption.
  const resIds = [...new Set(withProduct
    .map(l => (l as any).orderRef?.reservationId)
    .filter(Boolean)
    .map(String))]
  const budgets = await loadReservationBudgets(orgId, resIds)

  // Build plain objects — the input may be Mongoose subdocuments, whose schema fields
  // do not survive an object spread.
  const productLines: { productId?: string; warehouseId?: string; quantity: number; description?: string }[] = []
  for (const line of withProduct) {
    const rid = (line as any).orderRef?.reservationId ? String((line as any).orderRef.reservationId) : ''
    let required = line.quantity
    if (rid) {
      const budget = budgets.get(rid) || 0
      const exempt = Math.min(required, budget)
      budgets.set(rid, budget - exempt)
      required -= exempt
    }
    if (required > 0) {
      productLines.push({
        productId: String(line.productId),
        warehouseId: String(line.warehouseId),
        quantity: required,
        description: (line as any).description,
      })
    }
  }
  if (!productLines.length) return

  // Batch load all stock levels for the relevant product+warehouse combinations
  const productIds = [...new Set(productLines.map(l => l.productId!))]
  const warehouseIds = [...new Set(productLines.map(l => l.warehouseId!))]
  const allStockLevels = await r.stockLevels.findMany(
    { orgId, productId: { $in: productIds }, warehouseId: { $in: warehouseIds } } as any,
  )

  // Index stock levels by productId+warehouseId for O(1) lookup.
  // Sellable stock = quantity − reservedQuantity, computed from the authoritative
  // fields (the denormalised availableQuantity can be stale on legacy/seeded rows).
  const stockMap = new Map<string, number>()
  for (const sl of allStockLevels) {
    const available = (sl.quantity || 0) - ((sl as any).reservedQuantity || 0)
    stockMap.set(`${sl.productId}:${sl.warehouseId}`, available)
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

export async function createInvoiceStockMovement(invoice: IInvoice, userId: string, repos?: RepositoryRegistry, opts?: { allowNegative?: boolean }): Promise<void> {
  const r = repos ?? getRepos()
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) {
    // Loud by design: a document WITH product lines but none carrying a warehouseId used
    // to no-op here — the document got issued while the stock never moved (Files-pipeline
    // passed no warehouse). Silence made that invisible; fail so the caller can fix it.
    const stockLines = invoice.lines.filter(l => l.productId)
    if (stockLines.length) throw new Error(`Refusing to book stock for ${invoice.invoiceNumber || invoice.id}: ${stockLines.length} product line(s) carry no warehouseId`)
    return
  }

  const orgId = invoice.orgId

  // Group lines by warehouseId
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = line.warehouseId!
    if (!byWarehouse.has(whId)) byWarehouse.set(whId, [])
    byWarehouse.get(whId)!.push(line)
  }

  // Determine movement type + direction based on invoice type and direction.
  // Credit notes are returns on both sides: an outgoing CN restocks (customer returns the
  // goods), an incoming CN de-stocks (we return the goods to the supplier).
  let movementType: string
  let stockSide: 'from' | 'to'
  if (invoice.type === 'credit_note') {
    movementType = 'return'
    stockSide = invoice.direction === 'incoming' ? 'from' : 'to'
  } else if (invoice.direction === 'outgoing') {
    movementType = 'dispatch'
    stockSide = 'from'
  } else {
    movementType = 'receipt'
    stockSide = 'to'
  }

  // Validate stock availability for dispatch movements (outgoing).
  // Migration imports pass allowNegative to permit dispatching items not yet in stock.
  // Incoming credit notes reduce stock too but deliberately skip validation — returning
  // more than is on hand is an operational reality the correction itself documents.
  if (movementType === 'dispatch' && !opts?.allowNegative) {
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
      fromWarehouseId: stockSide === 'from' ? warehouseId : undefined,
      toWarehouseId: stockSide === 'to' ? warehouseId : undefined,
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

export async function reverseInvoiceStockMovement(invoice: IInvoice, userId: string, repos?: RepositoryRegistry, opts?: { allowNegative?: boolean }): Promise<void> {
  const r = repos ?? getRepos()
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId)
  if (!productLines.length) {
    if (invoice.lines.some(l => l.productId)) logger.warn({ invoiceId: invoice.id }, 'reverseInvoiceStockMovement: product lines carry no warehouseId — nothing reversed')
    return
  }

  const orgId = invoice.orgId

  // Group lines by warehouseId
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = line.warehouseId!
    if (!byWarehouse.has(whId)) byWarehouse.set(whId, [])
    byWarehouse.get(whId)!.push(line)
  }

  // Restore cost layers from original dispatch movements
  const originalMovements = await r.stockMovements.findMany({ orgId, invoiceId: invoice.id } as any)
  for (const mov of originalMovements) {
    if (mov.status !== 'completed') continue
    for (const line of mov.lines) {
      if ((line as any).costAllocations?.length) {
        await restoreCostLayers((line as any).costAllocations, r)
      }
    }
  }

  // Reverse: dispatch→receipt, receipt→dispatch, return→its opposite side.
  // Voiding an outgoing CN dispatches the returned goods back out; voiding an incoming CN
  // receives the goods we had returned to the supplier back in.
  let reverseType: string
  if (invoice.type === 'credit_note') {
    reverseType = invoice.direction === 'incoming' ? 'receipt' : 'dispatch'
  } else if (invoice.direction === 'outgoing') {
    reverseType = 'receipt'
  } else {
    reverseType = 'dispatch'
  }

  // Validate stock availability for reverse dispatch movements. ORD-linked bill voids
  // pass allowNegative: the goods being dispatched back out are the very stock whose
  // receipt created the reservation holds — the next order sync re-balances the holds.
  if (reverseType === 'dispatch' && !opts?.allowNegative) {
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
