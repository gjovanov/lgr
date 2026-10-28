/**
 * What cancelling or completing an order releases (FR-22.41), for the confirmation that asks
 * first. Pure, unit-tested.
 *
 * The server's cascades: a supplier order's Cancel and Complete release what is left of every live
 * reservation on it; a client order's Complete releases what is left of its reservations and its
 * Cancel cancels them. „What is left" is quantity − max(invoiced, dispatched) — a reservation with
 * nothing left loses nothing and is not counted.
 *
 * The other side of the orders: a supplier order's reservations serve client orders (named, as
 * FR-22.41 asks) or clients directly; a client order's reservations sit on stock or on supplier
 * orders, whose room the release gives back.
 */

export interface CascadeSummary {
  /** The reservations it releases. */
  count: number
  /** What they release in all. */
  quantity: number
  /** The orders on the other side, by number: client orders for a supplier order, supplier orders for a client order. */
  orders: Array<{ id: string; number: string }>
  /** A supplier order's: how many clients lose a reservation. */
  clients: number
  /** A supplier order's: reservations of clients with no client order behind them. */
  withoutOrder: number
  /** A client order's: reservations held on stock. */
  fromStock: number
}

interface ReservationLike {
  status?: string
  source?: string
  quantity?: number
  invoicedQuantity?: number
  dispatchedQuantity?: number
  contactId?: unknown
  orderId?: unknown
  internalOrderId?: unknown
}

const left = (r: ReservationLike) =>
  Math.max(0, (Number(r.quantity) || 0) - Math.max(Number(r.invoicedQuantity) || 0, Number(r.dispatchedQuantity) || 0))

/**
 * `side` is the order being closed: `supplier` (ORDO) or `client` (ORDI). `numbers` names the
 * orders on the other side by id (what the order's GET returns in its lookup).
 */
export function cascadeSummary(
  reservations: ReservationLike[] | null | undefined,
  side: 'supplier' | 'client',
  numbers: Record<string, string> = {},
): CascadeSummary {
  const released = (reservations || []).filter((r) => r.status !== 'cancelled' && left(r) > 1e-9)
  const otherIds = new Set<string>()
  for (const r of released) {
    const id = side === 'supplier' ? r.internalOrderId : r.source === 'order' ? r.orderId : null
    if (id) otherIds.add(String(id))
  }
  return {
    count: released.length,
    quantity: released.reduce((s, r) => s + left(r), 0),
    orders: [...otherIds].map((id) => ({ id, number: numbers[id] || '…' })).sort((a, b) => a.number.localeCompare(b.number)),
    clients: new Set(released.map((r) => String(r.contactId ?? ''))).size,
    withoutOrder: side === 'supplier' ? released.filter((r) => !r.internalOrderId).length : 0,
    fromStock: side === 'client' ? released.filter((r) => r.source === 'stock').length : 0,
  }
}
