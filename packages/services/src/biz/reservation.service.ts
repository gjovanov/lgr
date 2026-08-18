import { Order, Invoice, InternalOrder, Reservation, StockLevel, type IOrder, type IReservation } from 'db/models'
import { logger } from '../logger/logger.js'

/**
 * Reservation graph — derived-state engine.
 *
 * First-class Reservation (RES-) documents link client demand (a contact, optionally an
 * internal order ORDI line) to a supply source (free warehouse stock, or an external
 * order ORDO allocation). Everything volatile is DERIVED from the linked documents and
 * re-materialised here — there is no incremental counter to drift:
 *
 *   - allocation.receivedQuantity        = Σ received ORDO-linked bill lines targeting it
 *   - reservation.invoicedQuantity       = Σ live conversion-invoice lines referencing it
 *   - reservation.dispatchedQuantity     = Σ dispatched (sent+) conversion lines referencing it
 *   - reservation.status                 active ↔ fulfilled follows dispatch (cancelled is terminal)
 *   - internalOrder line counters/status = Σ over its reservations + conversion lines
 *   - order.status sent → partially_received → received follows the receipt totals
 *   - StockLevel.reservedQuantity/availableQuantity = Σ active holds
 *
 * Hold rules:
 *   - stock-source, active:  hold = max(0, qty − dispatched)  (validated vs availability at creation)
 *   - order-source: holds activate only once goods are physically received and release in
 *     step with dispatch:  hold = min(Σ(qty − dispatched), received − Σdispatched), and only
 *     while the parent ORDO is in a holding status.
 *
 * Only live OUTGOING invoices of type 'invoice' feed reservation consumption — bills and
 * converted proformas (status 'converted' is live!) must never count, or a proforma→invoice
 * conversion would double-book the same lines.
 */

/** Order statuses whose reservations hold stock. */
export const ORDER_HOLDING_STATUSES = ['sent', 'partially_received', 'received']

/** Bill statuses that count as physically received. */
const BILL_RECEIVED_STATUSES = ['received', 'partially_paid', 'paid', 'overdue']

/** Outgoing-invoice statuses that mean the goods left the warehouse. */
const INVOICE_DISPATCHED_STATUSES = ['sent', 'partially_paid', 'paid', 'overdue']

/** Any status that still counts as a live (non-reverted) document. */
const LIVE_STATUSES_EXCLUDED = ['voided', 'cancelled']

/** Internal-order statuses whose reservations are dead demand (never resurrect holds). */
const INTERNAL_ORDER_CLOSED_STATUSES = ['completed', 'cancelled']

export interface StockKey {
  productId: string
  warehouseId: string
}

function idStr(v: any): string {
  return v == null ? '' : String(v)
}

function dedupeKeys(keys: StockKey[]): StockKey[] {
  const seen = new Map<string, StockKey>()
  for (const k of keys) seen.set(`${k.productId}|${k.warehouseId}`, k)
  return [...seen.values()]
}

/**
 * Active (stock-holding) reserved quantity for one order allocation, given the RES
 * documents attached to it. Dispatched quantity of cancelled reservations still counts
 * against the physical term — those goods really left the shelf.
 */
export function activeReservedForAllocation(
  alloc: { receivedQuantity?: number },
  reservations: Array<{ quantity: number; dispatchedQuantity?: number; status?: string }>,
): number {
  const openHold = reservations.reduce(
    (s, r) => s + (r.status === 'cancelled' ? 0 : Math.max(0, (r.quantity || 0) - (r.dispatchedQuantity || 0))),
    0,
  )
  const dispatched = reservations.reduce((s, r) => s + (r.dispatchedQuantity || 0), 0)
  const physical = Math.max(0, (alloc.receivedQuantity || 0) - dispatched)
  return Math.min(openHold, physical)
}

/** All (productId, warehouseId) pairs an order's allocations touch. */
export function collectOrderStockKeys(order: Pick<IOrder, 'supplierGroups'>): StockKey[] {
  const seen = new Map<string, StockKey>()
  for (const g of order.supplierGroups || []) {
    for (const line of (g as any).lines || []) {
      if (!line.productId) continue
      for (const alloc of line.allocations || []) {
        const k = `${idStr(line.productId)}|${idStr(alloc.warehouseId)}`
        seen.set(k, { productId: idStr(line.productId), warehouseId: idStr(alloc.warehouseId) })
      }
    }
  }
  return [...seen.values()]
}

/** The (productId, warehouseId) pairs a set of reservations touches. */
export function collectReservationStockKeys(
  reservations: Array<{ productId?: any; warehouseId?: any }>,
): StockKey[] {
  const seen = new Map<string, StockKey>()
  for (const r of reservations) {
    if (!r.productId || !r.warehouseId) continue
    const k = `${idStr(r.productId)}|${idStr(r.warehouseId)}`
    seen.set(k, { productId: idStr(r.productId), warehouseId: idStr(r.warehouseId) })
  }
  return [...seen.values()]
}

/**
 * Materialise StockLevel.reservedQuantity (+availableQuantity) from all reservations.
 * Pass `keys` to limit the update to the affected product×warehouse pairs; omit for a
 * full recompute (also zeroes stale holds on levels nothing references anymore).
 */
export async function syncReservedQuantities(orgId: string, keys?: StockKey[]): Promise<void> {
  const totals = new Map<string, number>()

  // Stock-source holds: unconditional while the reservation is open.
  const stockRes = await Reservation.find(
    { orgId, source: 'stock', status: { $ne: 'cancelled' } } as any,
    { productId: 1, warehouseId: 1, quantity: 1, dispatchedQuantity: 1 },
  ).lean().exec()
  for (const r of stockRes) {
    if (!(r as any).productId || !(r as any).warehouseId) continue
    const hold = Math.max(0, ((r as any).quantity || 0) - ((r as any).dispatchedQuantity || 0))
    if (hold <= 0) continue
    const k = `${idStr((r as any).productId)}|${idStr((r as any).warehouseId)}`
    totals.set(k, (totals.get(k) || 0) + hold)
  }

  // Order-source holds: only orders in a holding status, capped by physical receipt.
  const orders = await Order.find(
    { orgId, status: { $in: ORDER_HOLDING_STATUSES } } as any,
    { supplierGroups: 1 },
  ).lean().exec()
  const orderIds = orders.map((o: any) => o._id)
  const orderRes = orderIds.length
    ? await Reservation.find(
        { orgId, source: 'order', orderId: { $in: orderIds } } as any,
        { allocationId: 1, quantity: 1, dispatchedQuantity: 1, status: 1 },
      ).lean().exec()
    : []
  const byAlloc = new Map<string, any[]>()
  for (const r of orderRes) {
    const k = idStr((r as any).allocationId)
    if (!k) continue
    if (!byAlloc.has(k)) byAlloc.set(k, [])
    byAlloc.get(k)!.push(r)
  }
  for (const order of orders) {
    for (const g of (order as any).supplierGroups || []) {
      for (const line of g.lines || []) {
        if (!line.productId) continue
        for (const alloc of line.allocations || []) {
          const active = activeReservedForAllocation(alloc, byAlloc.get(idStr(alloc._id)) || [])
          if (active <= 0) continue
          const k = `${idStr(line.productId)}|${idStr(alloc.warehouseId)}`
          totals.set(k, (totals.get(k) || 0) + active)
        }
      }
    }
  }

  let pairs: StockKey[]
  if (keys?.length) {
    pairs = keys
  } else {
    const pairMap = new Map<string, StockKey>()
    for (const k of totals.keys()) {
      const [productId, warehouseId] = k.split('|')
      pairMap.set(k, { productId, warehouseId })
    }
    // Also reset levels still holding a reservation nothing backs anymore.
    const held = await StockLevel.find(
      { orgId, reservedQuantity: { $gt: 0 } } as any,
      { productId: 1, warehouseId: 1 },
    ).lean().exec()
    for (const sl of held) {
      const k = `${idStr((sl as any).productId)}|${idStr((sl as any).warehouseId)}`
      if (!pairMap.has(k)) pairMap.set(k, { productId: idStr((sl as any).productId), warehouseId: idStr((sl as any).warehouseId) })
    }
    pairs = [...pairMap.values()]
  }

  for (const { productId, warehouseId } of pairs) {
    const reserved = totals.get(`${productId}|${warehouseId}`) || 0
    const level: any = await StockLevel.findOne({ orgId, productId, warehouseId } as any).exec()
    if (!level) {
      // Order-source holds only activate after a receipt, which creates the level;
      // stock-source creation requires an existing level — nothing to do.
      continue
    }
    const available = (level.quantity || 0) - reserved
    if ((level.reservedQuantity || 0) === reserved && level.availableQuantity === available) continue
    level.reservedQuantity = reserved
    level.availableQuantity = available
    await level.save()
  }
}

/** The portion of a reservation that can still be released or preempted. */
export function reservationReleasable(res: {
  quantity: number
  invoicedQuantity?: number
  dispatchedQuantity?: number
}): number {
  const consumed = Math.max(res.invoicedQuantity || 0, res.dispatchedQuantity || 0)
  return Math.max(0, (res.quantity || 0) - consumed)
}

/**
 * Release `amount` of a reservation's open remainder (caller validates
 * amount ≤ releasable, and saves + syncs afterwards).
 *
 * A fully-open reservation released in full is cancelled outright, KEEPING its
 * quantity for the audit trail. A partially-consumed one shrinks toward the consumed
 * quantity and stays live (the sync flips it to fulfilled once dispatch catches up).
 */
export function applyReservationCancel(
  res: any,
  amount: number,
  reason: IReservation['cancelReason'],
  userId?: string,
  preemptedBy?: { internalOrderId?: any; reservationId?: any; userId?: any },
): void {
  const releasable = reservationReleasable(res)
  const consumed = Math.max(res.invoicedQuantity || 0, res.dispatchedQuantity || 0)
  const from = res.status
  if (preemptedBy) res.preemptedBy = { ...preemptedBy, at: new Date() }
  if (amount >= releasable - 1e-9 && consumed <= 0) {
    res.status = 'cancelled'
    res.cancelReason = reason
    res.statusHistory = [
      ...(res.statusHistory || []),
      { status: 'cancelled', fromStatus: from, changedAt: new Date(), changedBy: userId, reason },
    ]
  } else {
    res.quantity = Math.max(consumed, (res.quantity || 0) - amount)
    res.statusHistory = [
      ...(res.statusHistory || []),
      { status: res.status, fromStatus: from, changedAt: new Date(), changedBy: userId, reason: `${reason} (-${amount})` },
    ]
  }
}

/**
 * Recompute an order's receipt state (allocation/line receivedQuantity + status
 * transition) from its linked bills. Returns the saved order, or null if not found.
 */
export async function recomputeOrderReceipts(orgId: string, orderId: string, userId?: string): Promise<IOrder | null> {
  const order: any = await Order.findOne({ _id: orderId, orgId } as any).exec()
  if (!order) return null

  const bills = await Invoice.find(
    { orgId, orderId, direction: 'incoming', status: { $nin: LIVE_STATUSES_EXCLUDED } } as any,
    { status: 1, lines: 1 },
  ).lean().exec()

  const receivedByAlloc = new Map<string, number>()
  const receivedByLine = new Map<string, number>()
  for (const inv of bills) {
    if (!BILL_RECEIVED_STATUSES.includes((inv as any).status)) continue
    for (const line of (inv as any).lines || []) {
      const ref = line.orderRef
      if (!ref) continue
      const qty = Number(line.quantity) || 0
      if (ref.allocationId) {
        const k = idStr(ref.allocationId)
        receivedByAlloc.set(k, (receivedByAlloc.get(k) || 0) + qty)
      }
      const lk = idStr(ref.lineId)
      if (lk) receivedByLine.set(lk, (receivedByLine.get(lk) || 0) + qty)
    }
  }

  let totalOrdered = 0
  let totalReceived = 0
  let anyLine = false
  for (const g of order.supplierGroups || []) {
    for (const line of g.lines || []) {
      anyLine = true
      totalOrdered += Number(line.quantity) || 0
      for (const alloc of line.allocations || []) {
        alloc.receivedQuantity = receivedByAlloc.get(idStr(alloc._id)) || 0
      }
      line.receivedQuantity = receivedByLine.get(idStr(line._id)) || 0
      totalReceived += line.receivedQuantity
    }
  }

  // Receipt-status transition (only within the post-send lifecycle).
  if (ORDER_HOLDING_STATUSES.includes(order.status) && anyLine) {
    const fullyReceived = totalOrdered > 0 && (order.supplierGroups || []).every((g: any) =>
      (g.lines || []).every((l: any) => (l.receivedQuantity || 0) >= (l.quantity || 0)),
    )
    const next = fullyReceived ? 'received' : totalReceived > 0 ? 'partially_received' : 'sent'
    if (next !== order.status) {
      order.statusHistory = [
        ...(order.statusHistory || []),
        { status: next, fromStatus: order.status, changedAt: new Date(), changedBy: userId, reason: 'receipt sync' },
      ]
      order.status = next
    }
  }

  await order.save()
  return order
}

export interface ReservationRecomputeResult {
  stockKeys: StockKey[]
  orderIds: string[]
  internalOrderIds: string[]
}

/**
 * Recompute reservation consumption (invoiced/dispatched/invoiceIds), refresh the
 * denormalised supply/demand fields, and run the active↔fulfilled status machine.
 * Seed with explicit ids, an orderId, or an internalOrderId.
 */
export async function recomputeReservations(
  orgId: string,
  seed: { ids?: string[]; orderId?: string; internalOrderId?: string },
  userId?: string,
): Promise<ReservationRecomputeResult> {
  let resDocs: any[] = []
  if (seed.ids?.length) {
    resDocs = await Reservation.find({ orgId, _id: { $in: seed.ids } } as any).exec()
  } else if (seed.orderId) {
    resDocs = await Reservation.find({ orgId, orderId: seed.orderId } as any).exec()
  } else if (seed.internalOrderId) {
    resDocs = await Reservation.find({ orgId, internalOrderId: seed.internalOrderId } as any).exec()
  }
  if (!resDocs.length) return { stockKeys: [], orderIds: [], internalOrderIds: [] }

  const resIds = resDocs.map((r) => r._id)
  // Only live outgoing sales invoices consume reservations — never bills, and never
  // proformas (a converted proforma stays live in status 'converted' and would
  // double-count the lines its conversion copied).
  const invoices = await Invoice.find(
    {
      orgId,
      direction: 'outgoing',
      type: 'invoice',
      status: { $nin: LIVE_STATUSES_EXCLUDED },
      'lines.orderRef.reservationId': { $in: resIds },
    } as any,
    { status: 1, lines: 1 },
  ).lean().exec()

  const invoicedByRes = new Map<string, number>()
  const dispatchedByRes = new Map<string, number>()
  const invoiceIdsByRes = new Map<string, Set<string>>()
  for (const inv of invoices) {
    const isDispatched = INVOICE_DISPATCHED_STATUSES.includes((inv as any).status)
    for (const line of (inv as any).lines || []) {
      const rk = idStr(line.orderRef?.reservationId)
      if (!rk) continue
      const qty = Number(line.quantity) || 0
      invoicedByRes.set(rk, (invoicedByRes.get(rk) || 0) + qty)
      if (isDispatched) dispatchedByRes.set(rk, (dispatchedByRes.get(rk) || 0) + qty)
      if (!invoiceIdsByRes.has(rk)) invoiceIdsByRes.set(rk, new Set())
      invoiceIdsByRes.get(rk)!.add(idStr((inv as any)._id))
    }
  }

  // Parent lookups for denorm refresh + the reopen rule.
  const ordiIds = [...new Set(resDocs.map((r) => idStr(r.internalOrderId)).filter(Boolean))]
  const orderIds = [...new Set(resDocs.map((r) => idStr(r.orderId)).filter(Boolean))]
  const [ordis, orders] = await Promise.all([
    ordiIds.length
      ? InternalOrder.find({ orgId, _id: { $in: ordiIds } } as any, { status: 1, requestedDeliveryDate: 1 }).lean().exec()
      : [],
    orderIds.length
      ? Order.find({ orgId, _id: { $in: orderIds } } as any, { supplierGroups: 1, expectedDate: 1 }).lean().exec()
      : [],
  ])
  const ordiById = new Map((ordis as any[]).map((o) => [idStr(o._id), o]))
  const allocInfo = new Map<string, { productId?: any; warehouseId?: any; expectedDate?: Date }>()
  for (const order of orders as any[]) {
    for (const g of order.supplierGroups || []) {
      for (const line of g.lines || []) {
        for (const alloc of line.allocations || []) {
          allocInfo.set(idStr(alloc._id), {
            productId: line.productId,
            warehouseId: alloc.warehouseId,
            expectedDate: order.expectedDate,
          })
        }
      }
    }
  }

  for (const res of resDocs) {
    const rk = idStr(res._id)
    res.invoicedQuantity = invoicedByRes.get(rk) || 0
    res.dispatchedQuantity = dispatchedByRes.get(rk) || 0
    res.invoiceIds = [...(invoiceIdsByRes.get(rk) || [])]

    // Refresh denorms (self-healing: e.g. a product linked to the ORDO line later).
    if (res.source === 'order') {
      const info = allocInfo.get(idStr(res.allocationId))
      if (info) {
        if (info.productId) res.productId = info.productId
        if (info.warehouseId) res.warehouseId = info.warehouseId
        res.expectedDate = info.expectedDate
      }
    }
    const ordi = res.internalOrderId ? ordiById.get(idStr(res.internalOrderId)) : undefined
    if (ordi) res.requestedDeliveryDate = (ordi as any).requestedDeliveryDate

    // Status machine — cancelled is terminal.
    if (res.status !== 'cancelled') {
      let target = res.status
      if (res.dispatchedQuantity >= res.quantity && res.quantity > 0) {
        target = 'fulfilled'
      } else if (res.status === 'fulfilled') {
        // Dispatch dropped below quantity (an invoice was voided). Reactivate only when
        // the demand is still live — a completed/cancelled ORDI must never resurrect a
        // stock hold; shrink the reservation to what was actually consumed instead.
        const demandClosed = ordi && INTERNAL_ORDER_CLOSED_STATUSES.includes((ordi as any).status)
        if (demandClosed) {
          res.quantity = Math.max(res.invoicedQuantity, res.dispatchedQuantity)
          if (res.quantity === 0) {
            target = 'cancelled'
            res.cancelReason = 'released'
          } else {
            target = res.dispatchedQuantity >= res.quantity ? 'fulfilled' : 'active'
          }
        } else {
          target = 'active'
        }
      }
      if (target !== res.status) {
        res.statusHistory = [
          ...(res.statusHistory || []),
          { status: target, fromStatus: res.status, changedAt: new Date(), changedBy: userId, reason: 'sync' },
        ]
        res.status = target
      }
    }

    if (res.isModified()) await res.save()
  }

  return {
    stockKeys: collectReservationStockKeys(resDocs),
    orderIds,
    internalOrderIds: ordiIds,
  }
}

/**
 * Recompute an internal order's derived line counters (reserved/invoiced/delivered)
 * and its delivery-status transition. Returns the saved ORDI, or null if not found.
 */
export async function recomputeInternalOrder(orgId: string, internalOrderId: string, userId?: string): Promise<any | null> {
  const ordi: any = await InternalOrder.findOne({ _id: internalOrderId, orgId } as any).exec()
  if (!ordi) return null

  const resDocs = await Reservation.find(
    { orgId, internalOrderId } as any,
    { internalOrderLineId: 1, quantity: 1, status: 1 },
  ).lean().exec()
  const reservedByLine = new Map<string, number>()
  for (const r of resDocs) {
    if ((r as any).status === 'cancelled') continue
    const lk = idStr((r as any).internalOrderLineId)
    if (!lk) continue
    reservedByLine.set(lk, (reservedByLine.get(lk) || 0) + ((r as any).quantity || 0))
  }

  const lineIds = new Set((ordi.lines || []).map((l: any) => idStr(l._id)))
  const invoices = await Invoice.find(
    {
      orgId,
      direction: 'outgoing',
      type: 'invoice',
      status: { $nin: LIVE_STATUSES_EXCLUDED },
      $or: [{ internalOrderId }, { 'lines.orderRef.internalOrderId': internalOrderId }],
    } as any,
    { status: 1, lines: 1 },
  ).lean().exec()
  const invoicedByLine = new Map<string, number>()
  const deliveredByLine = new Map<string, number>()
  for (const inv of invoices) {
    const isDispatched = INVOICE_DISPATCHED_STATUSES.includes((inv as any).status)
    for (const line of (inv as any).lines || []) {
      const lk = idStr(line.orderRef?.internalOrderLineId)
      if (!lk || !lineIds.has(lk)) continue
      const qty = Number(line.quantity) || 0
      invoicedByLine.set(lk, (invoicedByLine.get(lk) || 0) + qty)
      if (isDispatched) deliveredByLine.set(lk, (deliveredByLine.get(lk) || 0) + qty)
    }
  }

  let totalOrdered = 0
  let totalDelivered = 0
  for (const line of ordi.lines || []) {
    const lk = idStr(line._id)
    line.reservedQuantity = reservedByLine.get(lk) || 0
    line.invoicedQuantity = invoicedByLine.get(lk) || 0
    line.deliveredQuantity = deliveredByLine.get(lk) || 0
    totalOrdered += Number(line.quantity) || 0
    totalDelivered += line.deliveredQuantity
  }

  // Delivery-status transition (only within the post-confirm lifecycle).
  if (['confirmed', 'partially_delivered', 'delivered'].includes(ordi.status) && (ordi.lines || []).length) {
    const fullyDelivered = totalOrdered > 0 && (ordi.lines || []).every(
      (l: any) => (l.deliveredQuantity || 0) >= (l.quantity || 0),
    )
    const next = fullyDelivered ? 'delivered' : totalDelivered > 0 ? 'partially_delivered' : 'confirmed'
    if (next !== ordi.status) {
      ordi.statusHistory = [
        ...(ordi.statusHistory || []),
        { status: next, fromStatus: ordi.status, changedAt: new Date(), changedBy: userId, reason: 'delivery sync' },
      ]
      ordi.status = next
    }
  }

  await ordi.save()
  return ordi
}

/**
 * Recompute an order's full derived state (receipts + its reservations + affected
 * internal orders), persist, and re-materialise the stock holds. Idempotent — call
 * after ANY mutation of the order or of an invoice carrying its refs.
 */
export async function syncOrderDerivedState(orgId: string, orderId: string, userId?: string): Promise<IOrder | null> {
  const order = await recomputeOrderReceipts(orgId, orderId, userId)
  if (!order) return null
  const r = await recomputeReservations(orgId, { orderId }, userId)
  for (const ordiId of r.internalOrderIds) {
    await recomputeInternalOrder(orgId, ordiId, userId)
  }
  await syncReservedQuantities(orgId, dedupeKeys([...collectOrderStockKeys(order), ...r.stockKeys]))
  logger.info({ orderId, status: (order as any).status }, 'Order derived state synced')
  return order
}

/**
 * Recompute an internal order's full derived state (its reservations + line counters +
 * delivery status) and re-materialise the affected stock holds.
 */
export async function syncInternalOrderDerivedState(orgId: string, internalOrderId: string, userId?: string): Promise<any | null> {
  const r = await recomputeReservations(orgId, { internalOrderId }, userId)
  const ordi = await recomputeInternalOrder(orgId, internalOrderId, userId)
  if (r.stockKeys.length) await syncReservedQuantities(orgId, r.stockKeys)
  logger.info({ internalOrderId, status: ordi?.status }, 'Internal order derived state synced')
  return ordi
}

/**
 * Recompute a specific set of reservations (+ their internal orders) and the affected
 * holds. Use after direct reservation mutations (create/cancel/preempt).
 */
export async function syncReservationsByIds(orgId: string, ids: string[], userId?: string): Promise<void> {
  if (!ids.length) return
  const r = await recomputeReservations(orgId, { ids }, userId)
  for (const ordiId of r.internalOrderIds) {
    await recomputeInternalOrder(orgId, ordiId, userId)
  }
  if (r.stockKeys.length) await syncReservedQuantities(orgId, r.stockKeys)
}

/**
 * Convenience hook for invoice-controller mutations: walks every order/internal-order/
 * reservation reference the invoice carries (doc-level and line-level) and re-derives
 * the affected subgraph. No-op when nothing is linked; never throws.
 */
export async function syncOrderForInvoice(orgId: string, invoice: any, userId?: string): Promise<void> {
  const orderIds = new Set<string>()
  const ordiIds = new Set<string>()
  const resIds = new Set<string>()
  if (invoice?.orderId) orderIds.add(idStr(invoice.orderId))
  if (invoice?.internalOrderId) ordiIds.add(idStr(invoice.internalOrderId))
  for (const line of invoice?.lines || []) {
    const ref = line?.orderRef
    if (!ref) continue
    if (ref.orderId) orderIds.add(idStr(ref.orderId))
    if (ref.internalOrderId) ordiIds.add(idStr(ref.internalOrderId))
    if (ref.reservationId) resIds.add(idStr(ref.reservationId))
  }
  if (!orderIds.size && !ordiIds.size && !resIds.size) return

  try {
    const keys: StockKey[] = []
    for (const oid of orderIds) {
      const order = await recomputeOrderReceipts(orgId, oid, userId)
      if (order) keys.push(...collectOrderStockKeys(order))
      const r = await recomputeReservations(orgId, { orderId: oid }, userId)
      keys.push(...r.stockKeys)
      r.internalOrderIds.forEach((id) => ordiIds.add(id))
    }
    if (resIds.size) {
      const r = await recomputeReservations(orgId, { ids: [...resIds] }, userId)
      keys.push(...r.stockKeys)
      r.internalOrderIds.forEach((id) => ordiIds.add(id))
    }
    for (const ordiId of ordiIds) {
      await recomputeInternalOrder(orgId, ordiId, userId)
    }
    await syncReservedQuantities(orgId, keys.length ? dedupeKeys(keys) : undefined)
  } catch (e: any) {
    // The invoice mutation must not fail because of a sync problem — log and continue;
    // the next sync (any subsequent mutation, or a manual one) self-heals.
    logger.error({ err: e?.message }, 'Reservation graph sync failed for invoice mutation')
  }
}
