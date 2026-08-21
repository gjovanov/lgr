import { mongoose } from 'db/connection'
import { Order, InternalOrder, Invoice, Reservation, StockLevel, Contact, Product, Warehouse } from 'db/models'
import { getNextNumber } from './sequence.service.js'
import { sequenceDefFor, resolveSequencePrefix } from './sequence-registry.js'
import {
  reservationReleasable,
  applyReservationCancel,
  syncReservationsByIds,
  recomputeInternalOrder,
  ORDER_HOLDING_STATUSES,
} from './reservation.service.js'

/**
 * Reservation operations — the mutating business layer behind the RES-/ORDI endpoints.
 *
 * Creation validates the supply side (free stock, or capacity on an ORDO allocation)
 * and the demand side (an internal-order line's open demand). Preemption moves the
 * open remainder of one reservation to a higher-priority internal order inside a Mongo
 * transaction (the releasable check re-runs on a session read, so concurrent preempts
 * serialize and the loser gets a clean error). All derived state is re-materialised
 * through reservation.service afterwards — nothing here increments counters in place.
 */

export class ReservationOpsError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

const num = (v: any) => Number(v) || 0
const idStr = (v: any) => (v == null ? '' : String(v))

/** ORDI statuses that may take new reservations. */
const RESERVABLE_ORDI_STATUSES = ['confirmed', 'partially_delivered']

/** Priority rank — HIGHER wins supply. No-ORDI reservations rank below everything. */
const PRIORITY_WEIGHT: Record<string, number> = { urgent: 3, high: 2, normal: 1, low: 0 }

export function priorityRank(ordi?: { priority?: string; requestedDeliveryDate?: Date; createdAt?: Date } | null): {
  weight: number
  deadline: number
  createdAt: number
} {
  if (!ordi) return { weight: -1, deadline: Number.MAX_SAFE_INTEGER, createdAt: Number.MAX_SAFE_INTEGER }
  return {
    weight: PRIORITY_WEIGHT[ordi.priority || 'normal'] ?? 1,
    deadline: ordi.requestedDeliveryDate ? new Date(ordi.requestedDeliveryDate).getTime() : Number.MAX_SAFE_INTEGER,
    createdAt: ordi.createdAt ? new Date(ordi.createdAt).getTime() : Number.MAX_SAFE_INTEGER,
  }
}

/** True when a outranks b (sooner deadline / higher priority / earlier created). */
export function outranks(a: ReturnType<typeof priorityRank>, b: ReturnType<typeof priorityRank>): boolean {
  if (a.weight !== b.weight) return a.weight > b.weight
  if (a.deadline !== b.deadline) return a.deadline < b.deadline
  return a.createdAt < b.createdAt
}

/** RES-YYYY-NNNNN with the org's configured prefix from the sequences registry. */
export async function getNextReservationNumber(orgId: string): Promise<string> {
  const year = new Date().getFullYear()
  const key = sequenceDefFor('reservation', 'issued')!.prefix
  const raw = await getNextNumber(orgId, key, 5, year)
  const seqPart = raw.split('-').pop()!
  const display = await resolveSequencePrefix(orgId, 'reservation', 'issued')
  return `${display}-${year}-${seqPart}`
}

/** Authoritative sellable quantity for one product×warehouse. */
async function availableAt(orgId: string, productId: string, warehouseId: string): Promise<number> {
  const sl: any = await StockLevel.findOne({ orgId, productId, warehouseId } as any).lean().exec()
  if (!sl) return 0
  return num(sl.quantity) - num(sl.reservedQuantity)
}

/** Σ non-cancelled reserved quantity per key over a set of RES docs. */
function sumBy(resDocs: any[], key: 'allocationId' | 'internalOrderLineId'): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of resDocs) {
    if (r.status === 'cancelled') continue
    const k = idStr(r[key])
    if (!k) continue
    m.set(k, (m.get(k) || 0) + num(r.quantity))
  }
  return m
}

export interface CreateReservationInput {
  source: 'stock' | 'order'
  productId: string
  quantity: number
  contactId?: string
  internalOrderId?: string
  internalOrderLineId?: string
  warehouseId?: string
  orderId?: string
  groupId?: string
  lineId?: string
  allocationId?: string
  notes?: string
}

/** Validate demand-side linkage; returns the ORDI (or null for ad-hoc client reservations). */
async function validateDemand(orgId: string, input: CreateReservationInput): Promise<{ ordi: any | null; contactId: string }> {
  if (!input.internalOrderId) {
    if (!input.contactId) throw new ReservationOpsError(422, 'contactId is required (or link an internal order)')
    const contact = await Contact.findOne({ _id: input.contactId, orgId } as any, { _id: 1 }).lean().exec()
    if (!contact) throw new ReservationOpsError(404, 'Client not found')
    return { ordi: null, contactId: input.contactId }
  }
  const ordi: any = await InternalOrder.findOne({ _id: input.internalOrderId, orgId } as any).lean().exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  if (!RESERVABLE_ORDI_STATUSES.includes(ordi.status)) {
    throw new ReservationOpsError(422, `Cannot reserve for a ${ordi.status} internal order`)
  }
  if (input.contactId && String(input.contactId) !== String(ordi.contactId)) {
    throw new ReservationOpsError(422, 'contactId does not match the internal order client')
  }
  if (!input.internalOrderLineId) throw new ReservationOpsError(422, 'internalOrderLineId is required')
  const line = (ordi.lines || []).find((l: any) => String(l._id) === String(input.internalOrderLineId))
  if (!line) throw new ReservationOpsError(404, 'Internal order line not found')
  if (String(line.productId) !== String(input.productId)) {
    throw new ReservationOpsError(422, 'Product does not match the internal order line')
  }
  const existing = await Reservation.find(
    { orgId, internalOrderId: input.internalOrderId, status: { $ne: 'cancelled' } } as any,
    { internalOrderLineId: 1, quantity: 1, status: 1 },
  ).lean().exec()
  const reserved = sumBy(existing, 'internalOrderLineId').get(String(line._id)) || 0
  const open = num(line.quantity) - reserved
  if (input.quantity > open + 1e-9) {
    throw new ReservationOpsError(422, `Reservation exceeds the line's open demand (open: ${open})`)
  }
  return { ordi, contactId: String(ordi.contactId) }
}

export async function createReservation(orgId: string, userId: string, input: CreateReservationInput): Promise<any> {
  if (!(input.quantity > 0)) throw new ReservationOpsError(422, 'quantity must be > 0')
  if (!input.productId) throw new ReservationOpsError(422, 'productId is required')

  const { ordi, contactId } = await validateDemand(orgId, input)

  let supply: { warehouseId: string; orderId?: string; groupId?: string; lineId?: string; allocationId?: string; expectedDate?: Date }
  if (input.source === 'stock') {
    if (!input.warehouseId) throw new ReservationOpsError(422, 'warehouseId is required for stock reservations')
    const available = await availableAt(orgId, input.productId, input.warehouseId)
    if (input.quantity > available + 1e-9) {
      throw new ReservationOpsError(422, `Insufficient available stock (available: ${available})`)
    }
    supply = { warehouseId: input.warehouseId }
  } else {
    if (!input.orderId || !input.groupId || !input.lineId || !input.allocationId) {
      throw new ReservationOpsError(422, 'orderId/groupId/lineId/allocationId are required for order reservations')
    }
    const order: any = await Order.findOne({ _id: input.orderId, orgId } as any).lean().exec()
    if (!order) throw new ReservationOpsError(404, 'External order not found')
    if (['completed', 'cancelled'].includes(order.status)) {
      throw new ReservationOpsError(422, `Cannot reserve on a ${order.status} order`)
    }
    const group = (order.supplierGroups || []).find((g: any) => String(g._id) === String(input.groupId))
    const line = group && (group.lines || []).find((l: any) => String(l._id) === String(input.lineId))
    const alloc = line && (line.allocations || []).find((a: any) => String(a._id) === String(input.allocationId))
    if (!alloc) throw new ReservationOpsError(404, 'Order allocation not found')
    if (!line.productId) throw new ReservationOpsError(422, 'The order line has no linked product')
    if (String(line.productId) !== String(input.productId)) {
      throw new ReservationOpsError(422, 'Product does not match the order line')
    }
    const allocRes = await Reservation.find(
      { orgId, allocationId: input.allocationId, status: { $ne: 'cancelled' } } as any,
      { allocationId: 1, quantity: 1, status: 1 },
    ).lean().exec()
    const reserved = sumBy(allocRes, 'allocationId').get(String(alloc._id)) || 0
    const free = num(alloc.quantity) - reserved
    if (input.quantity > free + 1e-9) {
      throw new ReservationOpsError(422, `Reservation exceeds the allocation's free quantity (free: ${free})`)
    }
    supply = {
      warehouseId: String(alloc.warehouseId),
      orderId: input.orderId,
      groupId: input.groupId,
      lineId: input.lineId,
      allocationId: input.allocationId,
      expectedDate: order.expectedDate,
    }
  }

  const reservationNumber = await getNextReservationNumber(orgId)
  const res = await Reservation.create({
    orgId,
    reservationNumber,
    status: 'active',
    statusHistory: [{ status: 'active', changedAt: new Date(), changedBy: userId, reason: 'created' }],
    contactId,
    internalOrderId: input.internalOrderId || undefined,
    internalOrderLineId: input.internalOrderLineId || undefined,
    requestedDeliveryDate: ordi?.requestedDeliveryDate,
    source: input.source,
    productId: input.productId,
    quantity: input.quantity,
    notes: input.notes,
    createdBy: userId,
    ...supply,
  } as any)
  await syncReservationsByIds(orgId, [String(res._id)], userId)
  return Reservation.findById(res._id).exec()
}

export async function cancelReservation(
  orgId: string,
  userId: string,
  reservationId: string,
  opts: { quantity?: number; reason?: 'manual' | 'released' } = {},
): Promise<any> {
  const res: any = await Reservation.findOne({ _id: reservationId, orgId } as any).exec()
  if (!res) throw new ReservationOpsError(404, 'Reservation not found')
  if (res.status === 'cancelled') throw new ReservationOpsError(422, 'Reservation is already cancelled')
  const releasable = reservationReleasable(res)
  const amount = opts.quantity ?? releasable
  if (!(amount > 0)) throw new ReservationOpsError(422, 'Nothing to release on this reservation')
  if (amount > releasable + 1e-9) {
    throw new ReservationOpsError(422, `Amount exceeds the releasable quantity (releasable: ${releasable})`)
  }
  applyReservationCancel(res, amount, opts.reason || 'manual', userId)
  await res.save()
  await syncReservationsByIds(orgId, [String(res._id)], userId)
  return Reservation.findById(res._id).exec()
}

export interface PreemptInput {
  internalOrderId: string
  internalOrderLineId: string
  quantity?: number
}

/**
 * Move the open remainder (or part of it) of a reservation to a higher-priority
 * internal-order line, preserving the supply source. Runs in a transaction; the
 * releasable check re-runs on the session read so concurrent preempts serialize.
 */
export async function preemptReservation(
  orgId: string,
  userId: string,
  reservationId: string,
  input: PreemptInput,
): Promise<{ source: any; created: any }> {
  const ordi: any = await InternalOrder.findOne({ _id: input.internalOrderId, orgId } as any).lean().exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  if (!RESERVABLE_ORDI_STATUSES.includes(ordi.status)) {
    throw new ReservationOpsError(422, `Cannot reserve for a ${ordi.status} internal order`)
  }
  const line = (ordi.lines || []).find((l: any) => String(l._id) === String(input.internalOrderLineId))
  if (!line) throw new ReservationOpsError(404, 'Internal order line not found')

  const reservationNumber = await getNextReservationNumber(orgId)
  const session = await mongoose.startSession()
  let createdId: string | null = null
  try {
    await session.withTransaction(async () => {
      const source: any = await Reservation.findOne({ _id: reservationId, orgId } as any).session(session).exec()
      if (!source) throw new ReservationOpsError(404, 'Reservation not found')
      if (source.status !== 'active') throw new ReservationOpsError(422, `Cannot preempt a ${source.status} reservation`)
      if (String(source.productId) !== String(line.productId)) {
        throw new ReservationOpsError(422, 'Product does not match the internal order line')
      }
      if (source.internalOrderId && String(source.internalOrderId) === String(input.internalOrderId)) {
        throw new ReservationOpsError(422, 'Reservation already serves this internal order')
      }
      const releasable = reservationReleasable(source)
      const beneficiaryRes = await Reservation.find(
        { orgId, internalOrderId: input.internalOrderId, status: { $ne: 'cancelled' } } as any,
        { internalOrderLineId: 1, quantity: 1, status: 1 },
      ).session(session).lean().exec()
      const reserved = sumBy(beneficiaryRes, 'internalOrderLineId').get(String(line._id)) || 0
      const openDemand = num(line.quantity) - reserved
      const amount = input.quantity ?? Math.min(releasable, openDemand)
      if (!(amount > 0)) throw new ReservationOpsError(422, 'Nothing to preempt')
      if (amount > releasable + 1e-9) {
        throw new ReservationOpsError(422, `Amount exceeds the releasable quantity (releasable: ${releasable})`)
      }
      if (amount > openDemand + 1e-9) {
        throw new ReservationOpsError(422, `Amount exceeds the line's open demand (open: ${openDemand})`)
      }

      applyReservationCancel(source, amount, 'preempted', userId, {
        internalOrderId: input.internalOrderId,
        userId,
      })
      await source.save({ session })

      const created = new Reservation({
        orgId,
        reservationNumber,
        status: 'active',
        statusHistory: [
          { status: 'active', changedAt: new Date(), changedBy: userId, reason: `preempted from ${source.reservationNumber}` },
        ],
        contactId: ordi.contactId,
        internalOrderId: input.internalOrderId,
        internalOrderLineId: input.internalOrderLineId,
        requestedDeliveryDate: ordi.requestedDeliveryDate,
        source: source.source,
        warehouseId: source.warehouseId,
        orderId: source.orderId,
        groupId: source.groupId,
        lineId: source.lineId,
        allocationId: source.allocationId,
        expectedDate: source.expectedDate,
        productId: source.productId,
        quantity: amount,
        createdBy: userId,
        preemptedBy: { reservationId: source._id, userId, at: new Date() },
      })
      await created.save({ session })
      createdId = String(created._id)
    })
  } finally {
    await session.endSession()
  }

  await syncReservationsByIds(orgId, [reservationId, createdId!], userId)
  const [source, created] = await Promise.all([
    Reservation.findById(reservationId).exec(),
    Reservation.findById(createdId!).exec(),
  ])
  return { source, created }
}

/** One-click stock cover: create stock-source reservations for a confirmed ORDI's open demand. */
export async function reserveAvailableForInternalOrder(
  orgId: string,
  userId: string,
  internalOrderId: string,
  lineIds?: string[],
): Promise<{ created: any[]; short: Array<{ lineId: string; productId: string; missing: number }> }> {
  const ordi: any = await InternalOrder.findOne({ _id: internalOrderId, orgId } as any).lean().exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  if (!RESERVABLE_ORDI_STATUSES.includes(ordi.status)) {
    throw new ReservationOpsError(422, `Cannot reserve for a ${ordi.status} internal order`)
  }
  const wanted = new Set((lineIds || []).map(String))
  const existing = await Reservation.find(
    { orgId, internalOrderId, status: { $ne: 'cancelled' } } as any,
    { internalOrderLineId: 1, quantity: 1, status: 1 },
  ).lean().exec()
  const reservedByLine = sumBy(existing, 'internalOrderLineId')

  const created: any[] = []
  const short: Array<{ lineId: string; productId: string; missing: number }> = []
  for (const line of ordi.lines || []) {
    if (wanted.size && !wanted.has(String(line._id))) continue
    let open = num(line.quantity) - (reservedByLine.get(String(line._id)) || 0)
    if (open <= 0) continue

    // Preferred warehouse first, then the rest by available desc.
    const levels: any[] = await StockLevel.find({ orgId, productId: line.productId } as any).lean().exec()
    const ranked = levels
      .map((sl) => ({ warehouseId: String(sl.warehouseId), available: num(sl.quantity) - num(sl.reservedQuantity) }))
      .filter((x) => x.available > 0)
      .sort((a, b) => {
        const prefA = ordi.warehouseId && a.warehouseId === String(ordi.warehouseId) ? 1 : 0
        const prefB = ordi.warehouseId && b.warehouseId === String(ordi.warehouseId) ? 1 : 0
        if (prefA !== prefB) return prefB - prefA
        return b.available - a.available
      })

    for (const slot of ranked) {
      if (open <= 0) break
      const qty = Math.min(open, slot.available)
      const res = await createReservation(orgId, userId, {
        source: 'stock',
        productId: String(line.productId),
        quantity: qty,
        internalOrderId,
        internalOrderLineId: String(line._id),
        warehouseId: slot.warehouseId,
      })
      created.push(res)
      open -= qty
    }
    if (open > 0) short.push({ lineId: String(line._id), productId: String(line.productId), missing: open })
  }
  return { created, short }
}

/** Suggestion caps — enough to act on, small enough to render. */
const SUGGESTION_CAP = 20

export interface LineSuggestions {
  lineId: string
  productId: string
  quantity: number
  reservedQuantity: number
  openQuantity: number
  freeStock: Array<{ warehouseId: string; available: number }>
  incoming: Array<{
    orderId: string
    orderNumber: string
    orderStatus: string
    groupId: string
    lineId: string
    allocationId: string
    warehouseId: string
    unreserved: number
    expectedDate?: Date
    late: boolean
  }>
  incomingTotal: number
  preemptable: Array<{
    reservationId: string
    reservationNumber: string
    contactId: string
    internalOrderId?: string
    internalOrderNumber?: string
    requestedDeliveryDate?: Date
    priority?: string
    source: string
    warehouseId: string
    orderNumber?: string
    releasable: number
  }>
  preemptableTotal: number
  supplierHint?: { supplierId: string; orderNumber: string }
}

/** Cover suggestions for every short line: free stock → unreserved incoming → preemptable RES. */
export async function getInternalOrderSuggestions(orgId: string, internalOrderId: string): Promise<LineSuggestions[]> {
  const ordi: any = await InternalOrder.findOne({ _id: internalOrderId, orgId } as any).lean().exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  const myRank = priorityRank(ordi)

  const existing = await Reservation.find(
    { orgId, internalOrderId, status: { $ne: 'cancelled' } } as any,
    { internalOrderLineId: 1, quantity: 1, status: 1 },
  ).lean().exec()
  const reservedByLine = sumBy(existing, 'internalOrderLineId')

  const out: LineSuggestions[] = []
  for (const line of ordi.lines || []) {
    const reserved = reservedByLine.get(String(line._id)) || 0
    const open = num(line.quantity) - reserved
    if (open <= 0) continue
    const productId = String(line.productId)

    // 1. Free stock per warehouse.
    const levels: any[] = await StockLevel.find({ orgId, productId } as any).lean().exec()
    const freeStock = levels
      .map((sl) => ({ warehouseId: String(sl.warehouseId), available: num(sl.quantity) - num(sl.reservedQuantity) }))
      .filter((x) => x.available > 0)
      .sort((a, b) => b.available - a.available)

    // 2. Unreserved incoming on open external orders carrying this product.
    const orders: any[] = await Order.find(
      { orgId, status: { $in: ['draft', ...ORDER_HOLDING_STATUSES] }, 'supplierGroups.lines.productId': productId } as any,
      { orderNumber: 1, status: 1, expectedDate: 1, supplierGroups: 1, createdAt: 1 },
    ).sort({ createdAt: -1 }).lean().exec()
    const allocIds: string[] = []
    for (const o of orders)
      for (const g of o.supplierGroups || [])
        for (const l of g.lines || [])
          if (String(l.productId) === productId)
            for (const a of l.allocations || []) allocIds.push(String(a._id))
    const allocRes = allocIds.length
      ? await Reservation.find(
          { orgId, allocationId: { $in: allocIds }, status: { $ne: 'cancelled' } } as any,
          { allocationId: 1, quantity: 1, status: 1 },
        ).lean().exec()
      : []
    const reservedByAlloc = sumBy(allocRes, 'allocationId')
    const incoming: LineSuggestions['incoming'] = []
    for (const o of orders) {
      for (const g of o.supplierGroups || []) {
        for (const l of g.lines || []) {
          if (String(l.productId) !== productId) continue
          for (const a of l.allocations || []) {
            const unreserved = num(a.quantity) - (reservedByAlloc.get(String(a._id)) || 0)
            if (unreserved <= 0) continue
            incoming.push({
              orderId: String(o._id),
              orderNumber: o.orderNumber,
              orderStatus: o.status,
              groupId: String(g._id),
              lineId: String(l._id),
              allocationId: String(a._id),
              warehouseId: String(a.warehouseId),
              unreserved,
              expectedDate: o.expectedDate,
              late: !!(o.expectedDate && ordi.requestedDeliveryDate && new Date(o.expectedDate) > new Date(ordi.requestedDeliveryDate)),
            })
          }
        }
      }
    }

    // 3. Preemptable reservations of lower-priority demand (most deferrable first).
    const candidates: any[] = await Reservation.find(
      { orgId, productId, status: 'active', internalOrderId: { $ne: ordi._id } } as any,
    ).lean().exec()
    const candOrdiIds = [...new Set(candidates.map((c) => idStr(c.internalOrderId)).filter(Boolean))]
    const candOrdis = candOrdiIds.length
      ? await InternalOrder.find({ orgId, _id: { $in: candOrdiIds } } as any, { orderNumber: 1, priority: 1, requestedDeliveryDate: 1, createdAt: 1 }).lean().exec()
      : []
    const candOrders = await Order.find(
      { orgId, _id: { $in: [...new Set(candidates.map((c) => idStr(c.orderId)).filter(Boolean))] } } as any,
      { orderNumber: 1 },
    ).lean().exec()
    const ordiById = new Map(candOrdis.map((o: any) => [String(o._id), o]))
    const orderNoById = new Map(candOrders.map((o: any) => [String(o._id), o.orderNumber]))
    const preemptable = candidates
      .map((c) => {
        const candOrdi = c.internalOrderId ? ordiById.get(String(c.internalOrderId)) : null
        return { c, candOrdi, rank: priorityRank(candOrdi as any), releasable: reservationReleasable(c) }
      })
      .filter((x) => x.releasable > 0 && outranks(myRank, x.rank))
      .sort((a, b) => {
        // Most deferrable first: lowest weight, then latest deadline, then newest.
        if (a.rank.weight !== b.rank.weight) return a.rank.weight - b.rank.weight
        if (a.rank.deadline !== b.rank.deadline) return b.rank.deadline - a.rank.deadline
        return b.rank.createdAt - a.rank.createdAt
      })
      .map(({ c, candOrdi, releasable }) => ({
        reservationId: String(c._id),
        reservationNumber: c.reservationNumber,
        contactId: String(c.contactId),
        internalOrderId: c.internalOrderId ? String(c.internalOrderId) : undefined,
        internalOrderNumber: (candOrdi as any)?.orderNumber,
        requestedDeliveryDate: c.requestedDeliveryDate,
        priority: (candOrdi as any)?.priority,
        source: c.source,
        warehouseId: String(c.warehouseId),
        orderNumber: c.orderId ? orderNoById.get(String(c.orderId)) : undefined,
        releasable,
      }))

    // Supplier hint: the most recent external order carrying this product.
    let supplierHint: LineSuggestions['supplierHint']
    const lastOrder: any = await Order.findOne(
      { orgId, 'supplierGroups.lines.productId': productId } as any,
      { orderNumber: 1, supplierGroups: 1 },
    ).sort({ createdAt: -1 }).lean().exec()
    if (lastOrder) {
      const g = (lastOrder.supplierGroups || []).find((gr: any) =>
        (gr.lines || []).some((l: any) => String(l.productId) === productId))
      if (g) supplierHint = { supplierId: String(g.supplierId), orderNumber: lastOrder.orderNumber }
    }

    out.push({
      lineId: String(line._id),
      productId,
      quantity: num(line.quantity),
      reservedQuantity: reserved,
      openQuantity: open,
      freeStock: freeStock.slice(0, SUGGESTION_CAP),
      incoming: incoming.slice(0, SUGGESTION_CAP),
      incomingTotal: incoming.length,
      preemptable: preemptable.slice(0, SUGGESTION_CAP),
      preemptableTotal: preemptable.length,
      supplierHint,
    })
  }
  return out
}

/** Release open reservation remainders and close the internal order. */
export async function completeInternalOrder(orgId: string, userId: string, internalOrderId: string): Promise<any> {
  const ordi: any = await InternalOrder.findOne({ _id: internalOrderId, orgId } as any).exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  if (!['confirmed', 'partially_delivered', 'delivered'].includes(ordi.status)) {
    throw new ReservationOpsError(400, 'Only confirmed/delivered internal orders can be completed')
  }
  const linked = await Reservation.find({ orgId, internalOrderId, status: { $ne: 'cancelled' } } as any).exec()
  const releasedIds: string[] = []
  for (const res of linked) {
    const releasable = reservationReleasable(res as any)
    if (releasable <= 0) continue
    applyReservationCancel(res, releasable, 'released', userId)
    await (res as any).save()
    releasedIds.push(String((res as any)._id))
  }
  ordi.statusHistory = [
    ...(ordi.statusHistory || []),
    { status: 'completed', fromStatus: ordi.status, changedAt: new Date(), changedBy: userId },
  ]
  ordi.status = 'completed'
  await ordi.save()
  if (releasedIds.length) await syncReservationsByIds(orgId, releasedIds, userId)
  return ordi
}

/** Cancel a draft/confirmed internal order (no live invoices), cascading its reservations. */
export async function cancelInternalOrder(orgId: string, userId: string, internalOrderId: string): Promise<any> {
  const ordi: any = await InternalOrder.findOne({ _id: internalOrderId, orgId } as any).exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  if (!['draft', 'confirmed'].includes(ordi.status)) {
    throw new ReservationOpsError(400, `Cannot cancel a ${ordi.status} internal order — use complete instead`)
  }
  const liveLinked = await Invoice.countDocuments({
    orgId,
    status: { $nin: ['voided', 'cancelled'] },
    $or: [{ internalOrderId }, { 'lines.orderRef.internalOrderId': internalOrderId }],
  } as any).exec()
  if (liveLinked > 0) {
    throw new ReservationOpsError(409, 'Internal order has linked invoices — void or delete them before cancelling')
  }

  const linked = await Reservation.find({ orgId, internalOrderId, status: { $ne: 'cancelled' } } as any).exec()
  const cancelledIds: string[] = []
  for (const res of linked) {
    applyReservationCancel(res, reservationReleasable(res as any), 'internal_order_cancelled', userId)
    await (res as any).save()
    cancelledIds.push(String((res as any)._id))
  }
  ordi.statusHistory = [
    ...(ordi.statusHistory || []),
    { status: 'cancelled', fromStatus: ordi.status, changedAt: new Date(), changedBy: userId },
  ]
  ordi.status = 'cancelled'
  await ordi.save()
  if (cancelledIds.length) await syncReservationsByIds(orgId, cancelledIds, userId)
  else await recomputeInternalOrder(orgId, internalOrderId, userId)
  return ordi
}

export interface GenerateExternalInput {
  orderId?: string
  draftOrderNumber?: string
  lines: Array<{ internalOrderLineId: string; quantity: number; supplierId: string; warehouseId?: string }>
}

/**
 * Create (or append to) a DRAFT external order covering an internal order's shortfall,
 * plus an order-source reservation per line back to the ORDI. Transactional.
 */
export async function generateExternalOrder(
  orgId: string,
  userId: string,
  internalOrderId: string,
  input: GenerateExternalInput,
): Promise<{ order: any; reservations: any[] }> {
  const ordi: any = await InternalOrder.findOne({ _id: internalOrderId, orgId } as any).lean().exec()
  if (!ordi) throw new ReservationOpsError(404, 'Internal order not found')
  if (!RESERVABLE_ORDI_STATUSES.includes(ordi.status)) {
    throw new ReservationOpsError(422, `Cannot generate an external order for a ${ordi.status} internal order`)
  }
  if (!input.lines?.length) throw new ReservationOpsError(422, 'At least one line is required')

  const lineById = new Map((ordi.lines || []).map((l: any) => [String(l._id), l]))
  const productIds = new Set<string>()
  for (const l of input.lines) {
    const line = lineById.get(String(l.internalOrderLineId))
    if (!line) throw new ReservationOpsError(404, `Internal order line not found: ${l.internalOrderLineId}`)
    if (!(l.quantity > 0)) throw new ReservationOpsError(422, 'quantity must be > 0')
    productIds.add(String((line as any).productId))
  }
  const products = await Product.find({ orgId, _id: { $in: [...productIds] } } as any).lean().exec()
  const productById = new Map(products.map((p: any) => [String(p._id), p]))

  // Resolve the target warehouse: explicit → ORDI preference → org default.
  let defaultWhId: string | undefined = ordi.warehouseId ? String(ordi.warehouseId) : undefined
  if (!defaultWhId) {
    const wh: any = await Warehouse.findOne({ orgId, isDefault: true } as any, { _id: 1 }).lean().exec()
    defaultWhId = wh ? String(wh._id) : undefined
  }

  let order: any
  if (input.orderId) {
    order = await Order.findOne({ _id: input.orderId, orgId } as any).exec()
    if (!order) throw new ReservationOpsError(404, 'External order not found')
    if (order.status !== 'draft') throw new ReservationOpsError(422, 'Can only append to a draft external order')
  } else {
    if (!input.draftOrderNumber) throw new ReservationOpsError(422, 'draftOrderNumber is required when creating a new order')
    order = new Order({
      orgId,
      orderNumber: input.draftOrderNumber,
      status: 'draft',
      statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: `generated_from_internal_order ${ordi.orderNumber}` }],
      numberHistory: [{ number: input.draftOrderNumber, allocatedAt: new Date(), status: 'draft' }],
      issueDate: new Date(),
      expectedDate: ordi.requestedDeliveryDate,
      currency: ordi.currency || 'EUR',
      exchangeRate: ordi.exchangeRate || 1,
      supplierGroups: [],
      createdBy: userId,
    })
  }

  const resNumbers: string[] = []
  for (let i = 0; i < input.lines.length; i++) resNumbers.push(await getNextReservationNumber(orgId))

  // withTransaction may retry the closure on transient errors — the order-document
  // mutations must not accumulate across attempts, so rebuild from this snapshot.
  const baseGroups = JSON.parse(JSON.stringify(order.toObject().supplierGroups || []))

  const session = await mongoose.startSession()
  const createdResIds: string[] = []
  try {
    await session.withTransaction(async () => {
      createdResIds.length = 0
      order.supplierGroups = JSON.parse(JSON.stringify(baseGroups))
      const pendingRes: any[] = []
      for (const [i, l] of input.lines.entries()) {
        const ordiLine: any = lineById.get(String(l.internalOrderLineId))
        const product: any = productById.get(String(ordiLine.productId))
        const whId = l.warehouseId || defaultWhId
        if (!whId) throw new ReservationOpsError(422, 'No target warehouse (set one on the line, the internal order, or mark a default warehouse)')

        let group = (order.supplierGroups as any[]).find((g: any) => String(g.supplierId) === String(l.supplierId))
        if (!group) {
          order.supplierGroups.push({ supplierId: l.supplierId, lines: [] })
          group = order.supplierGroups[order.supplierGroups.length - 1]
        }
        group.lines.push({
          productId: ordiLine.productId,
          description: ordiLine.description || product?.name || '',
          sku: ordiLine.sku || product?.sku,
          quantity: l.quantity,
          unit: ordiLine.unit || product?.unit || 'pcs',
          expectedUnitPrice: product?.purchasePrice,
          allocations: [{ warehouseId: whId, quantity: l.quantity }],
        })
        const newLine = group.lines[group.lines.length - 1]
        const newAlloc = newLine.allocations[0]

        pendingRes.push({
          orgId,
          reservationNumber: resNumbers[i],
          status: 'active',
          statusHistory: [
            { status: 'active', changedAt: new Date(), changedBy: userId, reason: `generated for ${ordi.orderNumber}` },
          ],
          contactId: ordi.contactId,
          internalOrderId,
          internalOrderLineId: ordiLine._id,
          requestedDeliveryDate: ordi.requestedDeliveryDate,
          source: 'order',
          warehouseId: whId,
          orderId: order._id,
          groupId: group._id,
          lineId: newLine._id,
          allocationId: newAlloc._id,
          expectedDate: order.expectedDate,
          productId: ordiLine.productId,
          quantity: l.quantity,
          createdBy: userId,
        })
      }
      await order.save({ session })
      for (const fields of pendingRes) {
        const res = new Reservation(fields)
        await res.save({ session })
        createdResIds.push(String(res._id))
      }
    })
  } finally {
    await session.endSession()
  }

  await syncReservationsByIds(orgId, createdResIds, userId)
  const reservations = await Reservation.find({ _id: { $in: createdResIds } } as any).exec()
  return { order: await Order.findById(order._id).exec(), reservations }
}
