/**
 * The rules the reservation dialogs share (FR-22.37), kept free of Vue so they are unit-tested:
 * which sources a new reservation is offered, which one it starts on, what a source puts in the
 * request, and what releasing part of a reservation leaves.
 *
 * The figures come from `GET /invoicing/reservations/sources`, which applies the checks the create
 * applies; nothing here second-guesses them.
 */

export interface StockSource {
  warehouseId: string
  warehouseName: string
  isDefault: boolean
  onHand: number
  reserved: number
  free: number
}

export interface AllocationSource {
  orderId: string
  orderNumber: string
  orderStatus: string
  expectedDate: string | null
  supplierId: string
  supplierName: string
  groupId: string
  lineId: string
  allocationId: string
  warehouseId: string
  warehouseName: string
  quantity: number
  received: number
  reserved: number
  free: number
}

export interface DemandLine {
  internalOrderId: string
  internalOrderNumber: string
  status: string
  priority: string
  requestedDeliveryDate: string | null
  lineId: string
  description: string
  unit: string
  quantity: number
  reserved: number
  open: number
}

export interface ReservationSources {
  stock: StockSource[]
  allocations: AllocationSource[]
  demand: DemandLine[]
}

export type SourceOption =
  | { key: string; kind: 'stock'; free: number; stock: StockSource }
  | { key: string; kind: 'order'; free: number; allocation: AllocationSource }

export const stockKey = (warehouseId: string) => `stock:${warehouseId}`
export const allocationKey = (allocationId: string) => `order:${allocationId}`
export const demandKey = (internalOrderId: string, lineId: string) => `${internalOrderId}:${lineId}`

/** A reservation's own source, as a key: where a repeat starts. */
export function keyOfReservation(r: { source?: string; warehouseId?: unknown; allocationId?: unknown } | null | undefined): string | null {
  if (!r) return null
  if (r.source === 'order' && r.allocationId) return allocationKey(String(r.allocationId))
  if (r.source === 'stock' && r.warehouseId) return stockKey(String(r.warehouseId))
  return null
}

/** Stock first (the shelf is here now), then what supplier orders bring, in the API's order. */
export function sourceOptions(s: ReservationSources | null | undefined): SourceOption[] {
  if (!s) return []
  return [
    ...s.stock.map((stock) => ({ key: stockKey(stock.warehouseId), kind: 'stock' as const, free: stock.free, stock })),
    ...s.allocations.map((allocation) => ({ key: allocationKey(allocation.allocationId), kind: 'order' as const, free: allocation.free, allocation })),
  ]
}

/**
 * The source a reservation starts on. The one asked for (the user's pick, or the source of the
 * reservation being repeated) while it is still offered; otherwise the first that holds the whole
 * quantity — stock before supplier orders, the default warehouse first, as the API orders them;
 * otherwise the first there is, so the shortage shows against a source rather than against none.
 */
export function defaultSourceKey(options: SourceOption[], quantity: number, preferred?: string | null): string | null {
  if (preferred && options.some((o) => o.key === preferred)) return preferred
  const q = Number(quantity) || 0
  return (options.find((o) => o.free + 1e-9 >= q) ?? options[0])?.key ?? null
}

/** The fields a source puts in `POST /reservations` (or a repeat). */
export function sourceBody(o: SourceOption): Record<string, string> {
  if (o.kind === 'stock') return { source: 'stock', warehouseId: o.stock.warehouseId }
  const a = o.allocation
  return { source: 'order', orderId: a.orderId, groupId: a.groupId, lineId: a.lineId, allocationId: a.allocationId }
}

export interface ReleaseOutcome {
  /** quantity − max(invoiced, dispatched): what a release may free. */
  releasable: number
  /** What is already invoiced or dispatched: it stays reserved whatever is released. */
  consumed: number
  /** Releasing `amount` cancels the reservation (everything, and nothing consumed). */
  cancels: boolean
  /** What stays reserved afterwards. */
  remaining: number
  /** `amount` is more than nothing and no more than is releasable. */
  valid: boolean
}

/** What releasing `amount` of a reservation does — the server's `applyReservationCancel` rule. */
export function releaseOutcome(
  r: { quantity?: number; invoicedQuantity?: number; dispatchedQuantity?: number },
  amount: number,
): ReleaseOutcome {
  const quantity = Number(r.quantity) || 0
  const consumed = Math.max(Number(r.invoicedQuantity) || 0, Number(r.dispatchedQuantity) || 0)
  const releasable = Math.max(0, quantity - consumed)
  const a = Number(amount) || 0
  const valid = a > 0 && a <= releasable + 1e-9
  const all = a >= releasable - 1e-9
  const cancels = valid && all && consumed <= 0
  return { releasable, consumed, cancels, remaining: valid ? (cancels ? 0 : Math.max(consumed, quantity - a)) : quantity, valid }
}
