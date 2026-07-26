import { Order, Invoice, StockLevel, type IOrder } from 'db/models'
import { logger } from '../logger/logger.js'

/**
 * Order reservations — derived-state engine.
 *
 * Everything volatile on an Order (received quantities, reservation consumption,
 * stock holds) is DERIVED from the linked invoices and re-materialised by
 * `syncOrderDerivedState`. Hooks in the invoice/order controllers only ever call
 * that one function after a mutation — there is no incremental counter to drift:
 *
 *   - allocation.receivedQuantity  = Σ received ORD-linked bill lines targeting it
 *   - reservation.invoicedQuantity = Σ live conversion-invoice lines referencing it
 *   - reservation.dispatchedQuantity = Σ dispatched (sent+) conversion lines referencing it
 *   - order.status sent → partially_received → received follows the receipt totals
 *   - StockLevel.reservedQuantity/availableQuantity = Σ active holds across open orders
 *
 * A reservation holds stock only once goods are physically received, and releases
 * the hold in step with dispatch:  hold = min(Σ(qty − dispatched), received − Σdispatched).
 */

/** Order statuses whose reservations hold stock. */
export const ORDER_HOLDING_STATUSES = ['sent', 'partially_received', 'received']

/** Bill statuses that count as physically received. */
const BILL_RECEIVED_STATUSES = ['received', 'partially_paid', 'paid', 'overdue']

/** Outgoing-invoice statuses that mean the goods left the warehouse. */
const INVOICE_DISPATCHED_STATUSES = ['sent', 'partially_paid', 'paid', 'overdue']

/** Any status that still counts as a live (non-reverted) document. */
const LIVE_STATUSES_EXCLUDED = ['voided', 'cancelled']

function idStr(v: any): string {
  return v == null ? '' : String(v)
}

/** Active (stock-holding) reserved quantity for one allocation. */
export function activeReservedForAllocation(alloc: {
  receivedQuantity?: number
  reservations?: Array<{ quantity: number; dispatchedQuantity?: number }>
}): number {
  const reservations = alloc.reservations || []
  const openHold = reservations.reduce(
    (s, r) => s + Math.max(0, (r.quantity || 0) - (r.dispatchedQuantity || 0)),
    0,
  )
  const dispatched = reservations.reduce((s, r) => s + (r.dispatchedQuantity || 0), 0)
  const physical = Math.max(0, (alloc.receivedQuantity || 0) - dispatched)
  return Math.min(openHold, physical)
}

/** All (productId, warehouseId) pairs an order's allocations touch. */
export function collectOrderStockKeys(order: Pick<IOrder, 'supplierGroups'>): Array<{ productId: string; warehouseId: string }> {
  const seen = new Map<string, { productId: string; warehouseId: string }>()
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

/**
 * Materialise StockLevel.reservedQuantity (+availableQuantity) from all open orders.
 * Pass `keys` to limit the update to the affected product×warehouse pairs; omit for a
 * full recompute (also zeroes stale holds on levels no open order references anymore).
 */
export async function syncReservedQuantities(
  orgId: string,
  keys?: Array<{ productId: string; warehouseId: string }>,
): Promise<void> {
  const orders = await Order.find(
    { orgId, status: { $in: ORDER_HOLDING_STATUSES } } as any,
    { supplierGroups: 1 },
  ).lean().exec()

  const totals = new Map<string, number>()
  for (const order of orders) {
    for (const g of (order as any).supplierGroups || []) {
      for (const line of g.lines || []) {
        if (!line.productId) continue
        for (const alloc of line.allocations || []) {
          const active = activeReservedForAllocation(alloc)
          if (active <= 0) continue
          const k = `${idStr(line.productId)}|${idStr(alloc.warehouseId)}`
          totals.set(k, (totals.get(k) || 0) + active)
        }
      }
    }
  }

  let pairs: Array<{ productId: string; warehouseId: string }>
  if (keys?.length) {
    pairs = keys
  } else {
    const pairMap = new Map<string, { productId: string; warehouseId: string }>()
    for (const k of totals.keys()) {
      const [productId, warehouseId] = k.split('|')
      pairMap.set(k, { productId, warehouseId })
    }
    // Also reset levels still holding a reservation that no open order backs anymore.
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
      // Holds only activate after a receipt, which creates the level — nothing to do.
      continue
    }
    const available = (level.quantity || 0) - reserved
    if ((level.reservedQuantity || 0) === reserved && level.availableQuantity === available) continue
    level.reservedQuantity = reserved
    level.availableQuantity = available
    await level.save()
  }
}

/**
 * Recompute an order's derived state from its linked invoices, transition its
 * receipt status, persist, and re-materialise the stock holds. Idempotent —
 * call after ANY mutation of the order or of an invoice carrying its orderId.
 */
export async function syncOrderDerivedState(orgId: string, orderId: string, userId?: string): Promise<IOrder | null> {
  const order: any = await Order.findOne({ _id: orderId, orgId } as any).exec()
  if (!order) return null

  const linked = await Invoice.find(
    { orgId, orderId, status: { $nin: LIVE_STATUSES_EXCLUDED } } as any,
    { direction: 1, status: 1, lines: 1 },
  ).lean().exec()

  // Aggregate per allocation / reservation.
  const receivedByAlloc = new Map<string, number>()
  const receivedByLine = new Map<string, number>()
  const invoicedByRes = new Map<string, number>()
  const dispatchedByRes = new Map<string, number>()
  const invoiceIdsByRes = new Map<string, Set<string>>()

  for (const inv of linked) {
    const isBill = (inv as any).direction === 'incoming'
    const isReceivedBill = isBill && BILL_RECEIVED_STATUSES.includes((inv as any).status)
    const isDispatched = !isBill && INVOICE_DISPATCHED_STATUSES.includes((inv as any).status)
    for (const line of (inv as any).lines || []) {
      const ref = line.orderRef
      if (!ref) continue
      const qty = Number(line.quantity) || 0
      if (isBill) {
        if (!isReceivedBill) continue
        if (ref.allocationId) {
          const k = idStr(ref.allocationId)
          receivedByAlloc.set(k, (receivedByAlloc.get(k) || 0) + qty)
        }
        const lk = idStr(ref.lineId)
        receivedByLine.set(lk, (receivedByLine.get(lk) || 0) + qty)
      } else if (ref.reservationId) {
        const rk = idStr(ref.reservationId)
        invoicedByRes.set(rk, (invoicedByRes.get(rk) || 0) + qty)
        if (isDispatched) dispatchedByRes.set(rk, (dispatchedByRes.get(rk) || 0) + qty)
        if (!invoiceIdsByRes.has(rk)) invoiceIdsByRes.set(rk, new Set())
        invoiceIdsByRes.get(rk)!.add(idStr((inv as any)._id))
      }
    }
  }

  // Write the derived values back onto the order document.
  let totalOrdered = 0
  let totalReceived = 0
  let anyLine = false
  for (const g of order.supplierGroups || []) {
    for (const line of g.lines || []) {
      anyLine = true
      totalOrdered += Number(line.quantity) || 0
      for (const alloc of line.allocations || []) {
        alloc.receivedQuantity = receivedByAlloc.get(idStr(alloc._id)) || 0
        for (const res of alloc.reservations || []) {
          const rk = idStr(res._id)
          res.invoicedQuantity = invoicedByRes.get(rk) || 0
          res.dispatchedQuantity = dispatchedByRes.get(rk) || 0
          res.invoiceIds = [...(invoiceIdsByRes.get(rk) || [])]
        }
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
  await syncReservedQuantities(orgId, collectOrderStockKeys(order))
  logger.info({ orderId, status: order.status }, 'Order derived state synced')
  return order
}

/** Convenience hook for invoice-controller mutations: no-op unless the invoice is ORD-linked. */
export async function syncOrderForInvoice(orgId: string, invoice: any, userId?: string): Promise<void> {
  const orderId = invoice?.orderId
  if (!orderId) return
  try {
    await syncOrderDerivedState(orgId, idStr(orderId), userId)
  } catch (e: any) {
    // The invoice mutation must not fail because of a sync problem — log and continue;
    // the next sync (any subsequent mutation, or a manual one) self-heals.
    logger.error({ orderId: idStr(orderId), err: e?.message }, 'Order derived-state sync failed')
  }
}
