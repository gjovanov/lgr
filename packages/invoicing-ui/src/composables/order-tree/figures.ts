import type {
  AllocationInput,
  FigureInput,
  GroupFigures,
  GroupInput,
  LineInput,
  ReservationRow,
  ServerReservation,
  StagedCreate,
  TreeFigures,
} from './types'

/**
 * FR-28.37 — ONE set of figures for an order's allocations and reservations.
 *
 * Every number the supplier order shows — a row's Reserved and Free, a supplier's summary, the Totals
 * card — comes from the functions below, over the same three things: the lines and allocations as
 * edited, the reservations the server returned, and the changes staged on the form. Before this the
 * Totals card added up the server's reservations (`totalReserved`) while each allocation's Free counted
 * the staged ones as well (`allocReserved`), so the two disagreed from the first reservation staged
 * until Save.
 *
 * The rules, unchanged from the form they were taken from:
 *  - a staged reservation counts at once;
 *  - a reservation staged to be cancelled counts as what is already invoiced or dispatched (whichever
 *    is larger): cancelling cannot take that back;
 *  - a reservation the server has cancelled counts for nothing and is not a row at all (the flat
 *    Reservations card lists it, with „reserve again").
 */

const num = (v: unknown) => Number(v) || 0

/** What a reservation row holds, counted. */
export function countedQuantity(row: ReservationRow): number {
  return row.cancelled ? row.consumed : num(row.quantity)
}

export function emptyGroupFigures(): GroupFigures {
  return { lines: 0, ordered: 0, allocated: 0, reserved: 0, received: 0, invoiced: 0, dispatched: 0 }
}

export function addGroupFigures(into: GroupFigures, from: GroupFigures): GroupFigures {
  into.lines += from.lines
  into.ordered += from.ordered
  into.allocated += from.allocated
  into.reserved += from.reserved
  into.received += from.received
  into.invoiced += from.invoiced
  into.dispatched += from.dispatched
  return into
}

// ── what the customer order and the reservation page read from the server's reservations ──────────

/**
 * What a saved reservation holds: its quantity, and nothing once it is cancelled. A fulfilled one still counts: the
 * server's own `reservedQuantity` on a customer order's line adds up every reservation that is not cancelled
 * (`recomputeInternalOrder`), and this adds up the same rows.
 */
export function heldQuantity(r: { status?: string; quantity?: unknown }): number {
  return r.status === 'cancelled' ? 0 : num(r.quantity)
}

/** A date as the day it names (`YYYY-MM-DD`), from the ISO string or the Date the server sent; empty where there is none. */
export function dayOf(d: string | Date | null | undefined): string {
  if (!d) return ''
  if (typeof d === 'string') return d.slice(0, 10)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/**
 * Late: the supplier order a reservation sits on is expected AFTER the day the customer asked for. Only a reservation
 * still waiting for its goods can be late; one that is fulfilled or cancelled is history, not a call to act.
 */
export function isLateReservation(r: { status?: string; expectedDate?: string | Date | null }, requestedDeliveryDate?: string | Date | null): boolean {
  if (r.status !== 'active') return false
  const expected = dayOf(r.expectedDate)
  const requested = dayOf(requestedDeliveryDate)
  return !!expected && !!requested && expected > requested
}

export interface ReservationRowContext {
  /** A screen that cannot change anything (a document that is closed, the reservation page) takes the actions away. */
  readonly: boolean
  requestedDeliveryDate?: string | Date | null
}

/**
 * A saved reservation as a row, for the screens that act on it at once (the customer order) or only read it (the
 * reservation page). Nothing is staged here: `cancelled` and `changed` are the supplier order's words for a change
 * waiting for Save, and are false.
 */
export function reservationRowFrom(r: ServerReservation, ctx: ReservationRowContext): ReservationRow {
  const id = String(r._id)
  const invoiced = num(r.invoicedQuantity)
  const dispatched = num(r.dispatchedQuantity)
  return {
    key: id,
    resId: id,
    number: r.reservationNumber,
    status: r.status,
    contactId: String(r.contactId || ''),
    quantity: num(r.quantity),
    invoiced,
    dispatched,
    consumed: Math.max(invoiced, dispatched),
    internalOrderId: r.internalOrderId ? String(r.internalOrderId) : undefined,
    cancelled: false,
    changed: false,
    editable: !ctx.readonly && r.status === 'active',
    cancellable: r.status === 'active',
    canChangeClient: false,
    source: r.source,
    warehouseId: r.warehouseId ? String(r.warehouseId) : undefined,
    orderId: r.orderId ? String(r.orderId) : undefined,
    orderLineId: r.lineId ? String(r.lineId) : undefined,
    allocationId: r.allocationId ? String(r.allocationId) : undefined,
    internalOrderLineId: r.internalOrderLineId ? String(r.internalOrderLineId) : undefined,
    expectedDate: dayOf(r.expectedDate) || undefined,
    late: isLateReservation(r, ctx.requestedDeliveryDate),
  }
}

/** A line nobody has filled in: it is a row waiting for its article, not part of the order. */
export function isBlankLine(line: LineInput): boolean {
  return !line.productId && !String(line.description || '').trim()
}

export interface LineFigures {
  figures: TreeFigures
  allocated: number
  overAllocated: boolean
}

export function createOrderFigures(input: FigureInput) {
  const readonly = input.readonly

  // The server's live reservations by the allocation they hang on.
  const saved = new Map<string, ServerReservation[]>()
  for (const r of input.reservations) {
    if (r.status === 'cancelled') continue
    const k = String(r.allocationId || '')
    if (!k) continue
    const list = saved.get(k)
    if (list) list.push(r)
    else saved.set(k, [r])
  }

  // The staged creates by the allocation they name: by its id, or by its client key while it is not saved.
  const created = new Map<string, StagedCreate[]>()
  for (const c of input.staged.creates) {
    for (const k of [c.alloc.id ? `id:${c.alloc.id}` : '', c.alloc.key ? `key:${c.alloc.key}` : '']) {
      if (!k) continue
      const list = created.get(k)
      if (list) list.push(c)
      else created.set(k, [c])
    }
  }

  const cancels = new Set(input.staged.cancels.map(String))
  const updates = input.staged.updates

  /** An allocation's reservations as the form now has them: the saved ones with their staged changes, then the new ones. */
  function rows(alloc: AllocationInput): ReservationRow[] {
    const out: ReservationRow[] = []
    if (alloc._id) {
      for (const r of saved.get(String(alloc._id)) || []) {
        const id = String(r._id)
        const u = updates[id] || {}
        const cancelled = cancels.has(id)
        const invoiced = num(r.invoicedQuantity)
        const dispatched = num(r.dispatchedQuantity)
        const consumed = Math.max(invoiced, dispatched)
        out.push({
          key: id,
          resId: id,
          number: r.reservationNumber,
          status: r.status,
          contactId: String(u.contactId ?? r.contactId),
          quantity: u.quantity ?? num(r.quantity),
          invoiced,
          dispatched,
          consumed,
          internalOrderId: r.internalOrderId ? String(r.internalOrderId) : undefined,
          cancelled,
          changed: !cancelled && (u.quantity !== undefined || u.contactId !== undefined),
          editable: !readonly && !cancelled && r.status === 'active',
          cancellable: r.status === 'active',
          canChangeClient: consumed <= 0 && !r.internalOrderId,
        })
      }
    }
    const seen = new Set<StagedCreate>()
    const keys = [alloc._id ? `id:${alloc._id}` : '', alloc._key ? `key:${alloc._key}` : '']
    for (const k of keys) {
      if (!k) continue
      for (const c of created.get(k) || []) {
        if (seen.has(c)) continue
        seen.add(c)
        out.push({
          key: c.key,
          createKey: c.key,
          contactId: c.contactId,
          quantity: c.quantity,
          invoiced: 0,
          dispatched: 0,
          consumed: 0,
          cancelled: false,
          changed: false,
          editable: !readonly,
          cancellable: true,
          canChangeClient: true,
        })
      }
    }
    return out
  }

  /** A warehouse's row: what it was given, what of it is reserved and what is still free. */
  function allocation(alloc: AllocationInput, rs: ReservationRow[] = rows(alloc)): TreeFigures {
    const quantity = num(alloc.quantity)
    let reserved = 0
    let invoiced = 0
    let dispatched = 0
    for (const r of rs) {
      reserved += countedQuantity(r)
      invoiced += r.invoiced
      dispatched += r.dispatched
    }
    return { quantity, reserved, free: Math.max(0, quantity - reserved), received: num(alloc.receivedQuantity), invoiced, dispatched }
  }

  /** A line's row: what is ordered, what of it is placed, held, and still to place. */
  function line(l: LineInput, rowsOf: (a: AllocationInput) => ReservationRow[] = rows): LineFigures {
    const quantity = num(l.quantity)
    let allocated = 0
    let reserved = 0
    let invoiced = 0
    let dispatched = 0
    for (const a of l.allocations) {
      const f = allocation(a, rowsOf(a))
      allocated += f.quantity
      reserved += f.reserved
      invoiced += f.invoiced
      dispatched += f.dispatched
    }
    return {
      allocated,
      overAllocated: allocated > quantity,
      figures: { quantity, reserved, free: Math.max(0, quantity - allocated), received: num(l.receivedQuantity), invoiced, dispatched },
    }
  }

  /** A supplier's lines added up. */
  function group(g: GroupInput): GroupFigures {
    const out = emptyGroupFigures()
    for (const l of g.lines) {
      const f = line(l)
      if (!isBlankLine(l)) out.lines++
      out.ordered += f.figures.quantity
      out.allocated += f.allocated
      out.reserved += f.figures.reserved
      out.received += f.figures.received ?? 0
      out.invoiced += f.figures.invoiced
      out.dispatched += f.figures.dispatched
    }
    return out
  }

  /** Every supplier added up: the Totals card. */
  function order(groups: GroupInput[]): GroupFigures {
    const out = emptyGroupFigures()
    for (const g of groups) addGroupFigures(out, group(g))
    return out
  }

  return { rows, allocation, line, group, order }
}

export type OrderFigures = ReturnType<typeof createOrderFigures>
