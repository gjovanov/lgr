import type { RepositoryRegistry } from 'dal'
import type { IInvoice } from 'dal/entities'
import { Reservation, Product } from 'db/models'
import { getRepos } from '../context.js'
import { confirmMovement } from './warehouse.service.js'
import { loadAllocationSupply } from './reservation.service.js'
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

export interface ReservationBudgets {
  /**
   * Exempt up to `quantity` of a line dispatching against `reservationId` from the free-stock
   * check, consuming the budget. Returns the exempt part; the rest competes for free stock.
   */
  take(reservationId: string, quantity: number): number
}

/**
 * Per-reservation exemption budgets, computed once per validation call. The dispatch movement
 * runs before the reservation sync, so `dispatchedQuantity` excludes the current document —
 * which is exactly why the budget must be shared across all of the document's lines instead of
 * re-granted per line.
 *
 * A line may skip the free-stock check only for goods its reservation's hold took OUT of free
 * stock, so the budget is that hold: a stock reservation's open (undispatched, non-cancelled)
 * quantity; an order reservation's open quantity capped by what its allocation has received and
 * not dispatched, nothing while its ORDO holds nothing, one pool shared by the reservations on
 * the same allocation. Granting the open quantity whatever the supply let an invoice dispatch the
 * 10 units of a sent but unreceived ORDO: stock 404 → −10 (FR-22.5, B-7).
 */
export async function loadReservationBudgets(orgId: string, reservationIds: string[]): Promise<ReservationBudgets> {
  const open = new Map<string, number>()
  const allocationOf = new Map<string, string>()
  const pool = new Map<string, number>()
  if (reservationIds.length) {
    const resDocs: any[] = await Reservation.find(
      { orgId, _id: { $in: reservationIds } } as any,
      { quantity: 1, dispatchedQuantity: 1, status: 1, source: 1, orderId: 1, allocationId: 1 },
    ).lean().exec()
    const live = resDocs.filter(r => r.status !== 'cancelled')
    const supply = await loadAllocationSupply(orgId, live.filter(r => r.source === 'order'))
    for (const res of live) {
      const id = String(res._id)
      open.set(id, Math.max(0, (res.quantity || 0) - (res.dispatchedQuantity || 0)))
      if (res.source !== 'order') continue
      const alloc = res.allocationId ? String(res.allocationId) : ''
      allocationOf.set(id, alloc)
      if (!pool.has(alloc)) pool.set(alloc, supply.get(alloc)?.physical ?? 0)
    }
  }
  return {
    take(reservationId, quantity) {
      const id = String(reservationId)
      const alloc = allocationOf.get(id)
      const own = open.get(id) || 0
      const exempt = Math.max(0, Math.min(quantity, own, alloc === undefined ? own : pool.get(alloc) || 0))
      open.set(id, own - exempt)
      if (alloc !== undefined) pool.set(alloc, (pool.get(alloc) || 0) - exempt)
      return exempt
    },
  }
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
  // exemption is capped at what that hold holds (loadReservationBudgets); any excess
  // competes for free stock like everyone else. Missing/cancelled reservations grant none.
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
    if (rid) required -= budgets.take(rid, required)
    // Tolerance as elsewhere in the reservation code: fractional units (kg, l) can leave a
    // subtraction residue that must not read as a shortfall.
    if (required > 1e-9) {
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

/**
 * Which of these lines' products actually hold stock.
 *
 * A service is invoiced like anything else — regal bills „Комисионна по диларски договор" every
 * month — but it has no stock to move, and it must not trip the no-warehouse guard below either.
 * Inventory tracking is a property of the product, so ask the catalog rather than guess from the line.
 */
async function stockTrackedIds(orgId: string, lines: Array<{ productId?: string | null }>): Promise<Set<string>> {
  const ids = Array.from(new Set(lines.filter(l => l.productId).map(l => String(l.productId))))
  if (!ids.length) return new Set()
  const rows: any[] = await Product.find({ orgId, _id: { $in: ids } } as any).select('trackInventory').lean()
  return new Set(rows.filter(p => p.trackInventory !== false).map(p => String(p._id)))
}

/**
 * An invoice converted from a складова разписка moves no stock, in either direction.
 *
 * The goods left on the разписка; the invoice is the paperwork that follows it. Booking its
 * dispatch takes them out twice, and reversing it on a void puts back goods that never left on
 * this document. The guard lives here rather than at each call site so it holds for the import,
 * the Issue button and the Void button alike — see `doc-import/conversion.ts`.
 */
function movesNoStock(invoice: IInvoice, direction: 'book' | 'reverse'): boolean {
  const src = (invoice as any).stockSource
  if (!src?.marker) return false
  logger.info({ invoiceId: invoice.id, marker: src.marker, direction }, 'Invoice carries a stock source — no stock movement')
  return true
}

export async function createInvoiceStockMovement(invoice: IInvoice, userId: string, repos?: RepositoryRegistry, opts?: { allowNegative?: boolean }): Promise<void> {
  const r = repos ?? getRepos()
  if (movesNoStock(invoice, 'book')) return

  /**
   * A line that claims a quantity but names no PRODUCT moves nothing, while its money still
   * counts toward the document's total. That is the same failure as the warehouseId case below —
   * the document is issued, the stock is not — and it is silent, which is what makes it worse.
   *
   * It has happened ten times across the two regal orgs for **3,413 units**: regal-pz
   * INV-3000101246 alone invoiced 3,000 × „ГАЙКА М6 - DIN 985 - A2-Gleitmo" that never left,
   * and regal-sf did 400 on 2026-10-06 and 4 more on 10-07.
   *
   * ⚠ But a product-less line is NOT always a mistake, and the test
   * "should skip stock movement for lines without productId or warehouseId" says so: a
   * service-only invoice — 10 hrs of „Consulting Service", no product at all — must book nothing
   * and must not fail. So this cannot simply refuse every product-less line.
   *
   * What separates the two is **`sourceText`**: it is written only by the import mappers
   * (`map-invoice`, `map-cash-sale`) to record the text a document actually carried, and the
   * invoice form merely round-trips it. So a line with `sourceText` and no productId means "we
   * read this off paper and could not resolve it to an article", which has no benign reading —
   * the goods are named on a customer's invoice and nothing leaves the warehouse. A hand-typed
   * line has no `sourceText` and keeps its existing behaviour exactly.
   *
   * All ten historical cases carry `sourceText`, so this catches every one of them and nothing
   * else. (A service, for the record, is a product with `trackInventory: false` — the `tracked`
   * set below is what exempts it — so a service line normally keeps its productId anyway.)
   *
   * ⚠ Sales invoices only, and a CASH SALE is deliberately exempt. A till export is a whole
   * day's takings aggregated by article name, so one unrecognised name among a hundred would
   * block the entire day's revenue; `mapCashSaleExport` warns there instead ("N item(s) have no
   * catalog match — they import as free-text and will not move stock") and the operator creates
   * the article and re-imports. An invoice is one named customer document, so the same silence is
   * not a trade-off worth making. All ten real cases were `type: 'invoice'`.
   *
   * Quantity-0 lines are exempt: they are notes and headers and claim no goods.
   *
   * ⚠ Only on the BOOK path. `reverseInvoiceStockMovement` deliberately has no equivalent, so
   * the ten documents already carrying such a line can still be voided and corrected.
   */
  const unresolved = invoice.type === 'invoice'
    ? invoice.lines.filter(l => !l.productId && Number(l.quantity || 0) !== 0 && !!(l as any).sourceText)
    : []
  if (unresolved.length) {
    const shown = unresolved.slice(0, 3).map(l => `${l.quantity} × ${JSON.stringify(String(l.description ?? '').slice(0, 40))}`).join('; ')
    throw new Error(
      `Refusing to book stock for ${invoice.invoiceNumber || invoice.id}: ${unresolved.length} line(s) carry a quantity but no product, `
      + `so they would be invoiced and never dispatched — ${shown}${unresolved.length > 3 ? ` (+${unresolved.length - 3} more)` : ''}. `
      + `Create the article, or point the line at an existing one, then book it again.`,
    )
  }

  const tracked = await stockTrackedIds(invoice.orgId, invoice.lines as any)
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId && tracked.has(String(l.productId)))
  if (!productLines.length) {
    // Loud by design: a document WITH product lines but none carrying a warehouseId used
    // to no-op here — the document got issued while the stock never moved (Files-pipeline
    // passed no warehouse). Silence made that invisible; fail so the caller can fix it.
    // Service lines are exempt: they legitimately move nothing.
    const stockLines = invoice.lines.filter(l => l.productId && tracked.has(String(l.productId)))
    if (stockLines.length) throw new Error(`Refusing to book stock for ${invoice.invoiceNumber || invoice.id}: ${stockLines.length} product line(s) carry no warehouseId`)
    return
  }

  const orgId = invoice.orgId

  // Group lines by warehouseId. `String()` is load-bearing: a caller handing over a raw/lean
  // invoice carries ObjectId warehouseIds, and a Map keys those by REFERENCE — so one 50-line
  // invoice silently became 50 single-line movements instead of one.
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = String(line.warehouseId!)
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
  if (movesNoStock(invoice, 'reverse')) return
  // Symmetric with the booking above: what never moved must not be restocked on a void.
  const tracked = await stockTrackedIds(invoice.orgId, invoice.lines as any)
  const productLines = invoice.lines.filter(l => l.productId && l.warehouseId && tracked.has(String(l.productId)))
  if (!productLines.length) {
    if (invoice.lines.some(l => l.productId && tracked.has(String(l.productId)))) logger.warn({ invoiceId: invoice.id }, 'reverseInvoiceStockMovement: product lines carry no warehouseId — nothing reversed')
    return
  }

  const orgId = invoice.orgId

  // Group lines by warehouseId — see the note on the same grouping in the booking above.
  const byWarehouse = new Map<string, typeof productLines>()
  for (const line of productLines) {
    const whId = String(line.warehouseId!)
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
