import { mongoose } from 'db/connection'
import { Order, InternalOrder, Reservation, Contact } from 'db/models'
import { applyReservationCancel, reservationReleasable } from './reservation.service.js'
import { ReservationOpsError, getNextReservationNumber } from './reservation-ops.service.js'

const { Types } = mongoose

/**
 * Client reservations edited INSIDE the outgoing-order form (#203), saved with the order.
 *
 * Before this, a reservation was its own request: it needed a saved allocation (so a new order
 * could reserve nothing), it reloaded the whole form afterwards (throwing away unsaved edits), and
 * an allocation could not be lowered together with its reservations — the order's PUT refused with
 * 409 until the reservations were cut first, in another request.
 *
 * Now the form sends `reservationChanges: { create, update, cancel }` with the order (not
 * `reservations`: that name is the deprecated embedded array, still ignored). One transaction
 * applies the order and every reservation change, and the rules are checked on the RESULT:
 *   - every allocation carries at most its quantity in live reservations;
 *   - a removed allocation carries none;
 *   - nothing goes below what is already invoiced or dispatched;
 *   - an incoming-order line is never reserved beyond its demand.
 * New allocations are named by the form's `clientKey`; their `_id`s are assigned here, before the
 * save, so a create can point at an allocation that did not exist a moment ago.
 *
 * Without `reservationChanges` the order controller keeps its old path, byte for byte.
 */

const num = (v: any) => Number(v) || 0
const idStr = (v: any) => (v == null ? '' : String(v))
const EPS = 1e-9
const RESERVABLE_ORDI_STATUSES = ['confirmed', 'partially_delivered']

export interface ReservationChanges {
  create?: Array<{
    allocationId?: string
    /** A new allocation, by the `clientKey` the form gave it. */
    allocationKey?: string
    contactId?: string
    quantity: number
    internalOrderId?: string
    internalOrderLineId?: string
    notes?: string
    /** „Резервирай отново" of a cancelled reservation, staged in the form. */
    repeatOf?: string
  }>
  update?: Array<{ id: string; quantity?: number; contactId?: string }>
  cancel?: Array<{ id: string }>
}

export function hasReservationChanges(c?: ReservationChanges | null): boolean {
  return !!c && ((c.create?.length || 0) + (c.update?.length || 0) + (c.cancel?.length || 0)) > 0
}

/** One allocation of the order as it will be saved. */
export interface PlannedAllocation {
  id: string
  key?: string
  groupId: string
  lineId: string
  productId: string | null
  warehouseId: string
  quantity: number
  /** For messages: „Болт М8 @ Склад 1". */
  label: string
}

/** A reservation of the order as it stands before the request. */
export interface LiveReservation {
  id: string
  number: string
  allocationId: string
  quantity: number
  invoiced: number
  dispatched: number
  contactId: string
  internalOrderId: string | null
  internalOrderLineId: string | null
  status: string
}

export interface PlanResult {
  error?: { status: number; message: string }
  /** id → what to do with a live reservation. */
  updates: Map<string, { quantity?: number; contactId?: string; cancel?: boolean }>
  creates: Array<ReservationChanges['create'] extends Array<infer T> | undefined ? T & { allocation: PlannedAllocation } : never>
  /** Final live quantity per allocation id, and per incoming-order line touched by this order. */
  perAllocation: Map<string, number>
}

/**
 * Give every new group, line and allocation its `_id` now, and say which allocation each
 * `clientKey` became. Mutates `groups` (the sanitized ones about to be saved).
 */
export function assignSubdocIds(groups: any[], warehouseName: (id: string) => string = () => ''): { allocations: PlannedAllocation[]; byKey: Map<string, string> } {
  const allocations: PlannedAllocation[] = []
  const byKey = new Map<string, string>()
  for (const g of groups) {
    if (!g._id) g._id = new Types.ObjectId()
    for (const l of g.lines || []) {
      if (!l._id) l._id = new Types.ObjectId()
      for (const a of l.allocations || []) {
        if (!a._id) a._id = new Types.ObjectId()
        if (a.clientKey) byKey.set(String(a.clientKey), idStr(a._id))
        allocations.push({
          id: idStr(a._id),
          key: a.clientKey,
          groupId: idStr(g._id),
          lineId: idStr(l._id),
          productId: l.productId ? idStr(l.productId) : null,
          warehouseId: idStr(a.warehouseId),
          quantity: num(a.quantity),
          label: [l.description || '', warehouseName(idStr(a.warehouseId))].filter(Boolean).join(' @ '),
        })
        delete a.clientKey
      }
    }
  }
  return { allocations, byKey }
}

/**
 * The pure part: what the reservations of the order become, and the first thing wrong with it.
 * Contacts and incoming-order demand need the database and are checked by the caller.
 */
export function planOrderReservations(input: {
  allocations: PlannedAllocation[]
  byKey: Map<string, string>
  live: LiveReservation[]
  changes: ReservationChanges
}): PlanResult {
  const { allocations, byKey, live, changes } = input
  const allocById = new Map(allocations.map(a => [a.id, a]))
  const liveById = new Map(live.filter(r => r.status !== 'cancelled').map(r => [r.id, r]))
  const updates: PlanResult['updates'] = new Map()
  const creates: PlanResult['creates'] = []
  const fail = (status: number, message: string): PlanResult => ({ error: { status, message }, updates, creates, perAllocation: new Map() })
  const consumedOf = (r: LiveReservation) => Math.max(r.invoiced, r.dispatched)

  // A fulfilled reservation is a closed record of goods delivered: nothing in it is open to change.
  const closed = (r: LiveReservation) => fail(422, `Reservation ${r.number} is ${r.status} — it can no longer be changed`)
  for (const c of changes.cancel || []) {
    const r = liveById.get(String(c.id))
    if (!r) return fail(404, `Reservation ${c.id} is not a live reservation of this order`)
    if (r.status !== 'active') return closed(r)
    updates.set(r.id, { cancel: true })
  }
  for (const u of changes.update || []) {
    const r = liveById.get(String(u.id))
    if (!r) return fail(404, `Reservation ${u.id} is not a live reservation of this order`)
    if (r.status !== 'active') return closed(r)
    if (updates.get(r.id)?.cancel) return fail(422, `Reservation ${r.number} cannot be both cancelled and changed`)
    const next: { quantity?: number; contactId?: string } = {}
    if (u.quantity !== undefined && Math.abs(num(u.quantity) - r.quantity) > EPS) {
      const q = num(u.quantity)
      if (!(q > 0)) return fail(422, `Reservation ${r.number}: the quantity must be greater than 0 — cancel it instead`)
      if (q + EPS < consumedOf(r)) return fail(422, `Reservation ${r.number}: cannot go below the invoiced or dispatched quantity (${consumedOf(r)})`)
      next.quantity = q
    }
    if (u.contactId !== undefined && idStr(u.contactId) !== r.contactId) {
      if (r.internalOrderId) return fail(422, `Reservation ${r.number} serves an incoming order: its client is that order's client`)
      if (consumedOf(r) > 0) return fail(422, `Reservation ${r.number}: ${consumedOf(r)} is already invoiced or dispatched — cancel the rest and reserve it for the other client`)
      next.contactId = idStr(u.contactId)
    }
    if (next.quantity !== undefined || next.contactId !== undefined) updates.set(r.id, next)
  }
  for (const c of changes.create || []) {
    const allocId = c.allocationId ? String(c.allocationId) : c.allocationKey ? byKey.get(String(c.allocationKey)) : undefined
    const allocation = allocId ? allocById.get(allocId) : undefined
    if (!allocation) return fail(422, 'A reservation must point at an allocation of this order')
    if (!allocation.productId) return fail(422, `${allocation.label || 'The order line'}: link a product before reserving it for a client`)
    if (!(num(c.quantity) > 0)) return fail(422, `${allocation.label}: the reserved quantity must be greater than 0`)
    if (!c.contactId && !c.internalOrderId) return fail(422, `${allocation.label}: choose the client`)
    creates.push({ ...c, quantity: num(c.quantity), allocation } as any)
  }

  // The result, per allocation.
  const perAllocation = new Map<string, number>()
  const add = (allocationId: string, q: number) => perAllocation.set(allocationId, (perAllocation.get(allocationId) || 0) + q)
  const numbersOn = new Map<string, string[]>()
  for (const r of liveById.values()) {
    const u = updates.get(r.id)
    // A cancel keeps what was consumed (applyReservationCancel); a fully open one holds nothing.
    const q = u?.cancel ? consumedOf(r) : u?.quantity ?? r.quantity
    if (q <= EPS) continue
    add(r.allocationId, q)
    if (!numbersOn.has(r.allocationId)) numbersOn.set(r.allocationId, [])
    numbersOn.get(r.allocationId)!.push(r.number)
  }
  for (const c of creates) add(c.allocation.id, c.quantity)

  const touched = new Set<string>([
    ...creates.map(c => c.allocation.id),
    ...[...updates.entries()].filter(([, u]) => u.quantity !== undefined).map(([id]) => liveById.get(id)!.allocationId),
  ])
  for (const [allocationId, q] of perAllocation) {
    const allocation = allocById.get(allocationId)
    const legacy = () => fail(409, `Allocation carries active reservations (${(numbersOn.get(allocationId) || []).join(', ')}) totalling ${q} — cancel or preempt them before shrinking/removing it`)
    if (!allocation) return legacy()
    if (q > allocation.quantity + EPS) {
      return touched.has(allocationId)
        ? fail(422, `${allocation.label}: reservations of ${q} exceed the allocated ${allocation.quantity}`)
        : legacy()
    }
  }
  return { updates, creates, perAllocation }
}

export interface SaveOrderInput {
  orgId: string
  userId: string
  /** PUT: the order to update. POST: absent, and `orderNumber` is the draft number to take. */
  orderId?: string
  orderNumber?: string
  header: { issueDate: Date; expectedDate?: Date; currency: string; exchangeRate: number; notes?: string; terms?: string; tags: string[] }
  /** Sanitized groups; new allocations may carry `clientKey`. */
  groups: any[]
  changes: ReservationChanges
  warehouseName?: (id: string) => string
}

/**
 * Save an order and its reservation changes in one transaction (see the file head). Returns the
 * order id and the reservations it touched; the caller re-derives state afterwards.
 */
export async function saveOrderWithReservations(input: SaveOrderInput): Promise<{ orderId: string; reservationIds: string[] }> {
  const { orgId, userId, changes } = input
  const { allocations, byKey } = assignSubdocIds(input.groups, input.warehouseName)

  // Numbers before the transaction, as `generateExternalOrder` does: a retried closure must not
  // draw again, and a number a refused request drew is a gap nobody reads.
  const resNumbers: string[] = []
  for (let i = 0; i < (changes.create?.length || 0); i++) resNumbers.push(await getNextReservationNumber(orgId))
  const baseGroups = JSON.parse(JSON.stringify(input.groups))

  const session = await mongoose.startSession()
  let orderId = input.orderId || ''
  const touched: string[] = []
  try {
    await session.withTransaction(async () => {
      touched.length = 0
      let order: any
      if (input.orderId) {
        order = await Order.findOne({ _id: input.orderId, orgId } as any).session(session).exec()
        if (!order) throw new ReservationOpsError(404, 'Order not found')
        if (['completed', 'cancelled'].includes(order.status)) throw new ReservationOpsError(400, `Cannot edit a ${order.status} order`)
      }
      const liveDocs: any[] = input.orderId
        ? await Reservation.find({ orgId, orderId: input.orderId, status: { $ne: 'cancelled' } } as any).session(session).exec()
        : []
      const live: LiveReservation[] = liveDocs.map(r => ({
        id: idStr(r._id), number: r.reservationNumber, allocationId: idStr(r.allocationId), quantity: num(r.quantity),
        invoiced: num(r.invoicedQuantity), dispatched: num(r.dispatchedQuantity), contactId: idStr(r.contactId),
        internalOrderId: r.internalOrderId ? idStr(r.internalOrderId) : null,
        internalOrderLineId: r.internalOrderLineId ? idStr(r.internalOrderLineId) : null,
        status: r.status,
      }))
      const plan = planOrderReservations({ allocations, byKey, live, changes })
      if (plan.error) throw new ReservationOpsError(plan.error.status, plan.error.message)

      // Clients: every create's and every changed client must exist in this org.
      const contactIds = new Set<string>()
      for (const c of plan.creates) if (c.contactId) contactIds.add(String(c.contactId))
      for (const u of plan.updates.values()) if (u.contactId) contactIds.add(u.contactId)
      if (contactIds.size) {
        const found = await Contact.countDocuments({ orgId, _id: { $in: [...contactIds] } } as any).session(session).exec()
        if (found !== contactIds.size) throw new ReservationOpsError(404, 'Client not found')
      }

      // Incoming-order demand, for creates and raises that serve one.
      const ordiIds = new Set<string>()
      for (const c of plan.creates) if (c.internalOrderId) ordiIds.add(String(c.internalOrderId))
      for (const [id, u] of plan.updates) {
        const r = live.find(x => x.id === id)!
        if (u.quantity !== undefined && u.quantity > r.quantity && r.internalOrderId) ordiIds.add(r.internalOrderId)
      }
      const ordiById = new Map<string, any>()
      for (const id of ordiIds) {
        const ordi: any = await InternalOrder.findOne({ _id: id, orgId } as any).session(session).lean().exec()
        if (!ordi) throw new ReservationOpsError(404, 'Incoming order not found')
        if (!RESERVABLE_ORDI_STATUSES.includes(ordi.status)) throw new ReservationOpsError(422, `Cannot reserve for a ${ordi.status} incoming order (${ordi.orderNumber})`)
        ordiById.set(id, ordi)
        // Demand per line: other orders' live reservations + this order's after the change.
        const others: any[] = await Reservation.find(
          { orgId, internalOrderId: id, status: { $ne: 'cancelled' }, ...(input.orderId ? { orderId: { $ne: input.orderId } } : {}) } as any,
          { internalOrderLineId: 1, quantity: 1 },
        ).session(session).lean().exec()
        const perLine = new Map<string, number>()
        const addLine = (lineId: string, q: number) => perLine.set(lineId, (perLine.get(lineId) || 0) + q)
        for (const r of others) addLine(idStr(r.internalOrderLineId), num(r.quantity))
        for (const r of live) {
          if (r.internalOrderId !== id) continue
          const u = plan.updates.get(r.id)
          addLine(r.internalOrderLineId || '', u?.cancel ? Math.max(r.invoiced, r.dispatched) : u?.quantity ?? r.quantity)
        }
        for (const c of plan.creates) {
          if (String(c.internalOrderId) !== id) continue
          const line = (ordi.lines || []).find((l: any) => idStr(l._id) === String(c.internalOrderLineId))
          if (!line) throw new ReservationOpsError(404, 'Incoming order line not found')
          if (idStr(line.productId) !== c.allocation.productId) throw new ReservationOpsError(422, `${c.allocation.label}: the incoming order line is for another product`)
          if (c.contactId && String(c.contactId) !== idStr(ordi.contactId)) throw new ReservationOpsError(422, 'The client does not match the incoming order\'s client')
          addLine(idStr(line._id), c.quantity)
        }
        for (const line of ordi.lines || []) {
          const q = perLine.get(idStr(line._id)) || 0
          if (q > num(line.quantity) + EPS) {
            throw new ReservationOpsError(422, `${ordi.orderNumber}: reservations of ${q} exceed the line's demand of ${num(line.quantity)}`)
          }
        }
      }

      // The order.
      const groups = JSON.parse(JSON.stringify(baseGroups))
      if (order) {
        order.issueDate = input.header.issueDate
        order.expectedDate = input.header.expectedDate
        order.currency = input.header.currency
        order.exchangeRate = input.header.exchangeRate
        order.notes = input.header.notes
        order.terms = input.header.terms
        order.tags = input.header.tags
        order.supplierGroups = groups
      } else {
        order = new Order({
          orgId,
          orderNumber: input.orderNumber,
          status: 'draft',
          statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: 'created' }],
          numberHistory: [{ number: input.orderNumber, allocatedAt: new Date(), status: 'draft' }],
          ...input.header,
          supplierGroups: groups,
          createdBy: userId,
        })
      }
      await order.save({ session })
      orderId = idStr(order._id)

      // The reservations it already had.
      for (const doc of liveDocs) {
        const u = plan.updates.get(idStr(doc._id))
        if (!u) continue
        if (u.cancel) {
          applyReservationCancel(doc, reservationReleasable(doc), 'manual', userId)
        } else {
          const what: string[] = []
          if (u.quantity !== undefined) { what.push(`quantity ${doc.quantity} → ${u.quantity}`); doc.quantity = u.quantity }
          if (u.contactId !== undefined) { what.push('client'); doc.contactId = u.contactId }
          doc.statusHistory = [
            ...(doc.statusHistory || []),
            { status: doc.status, fromStatus: doc.status, changedAt: new Date(), changedBy: userId, reason: `updated with the order: ${what.join(', ')}` },
          ]
        }
        await doc.save({ session })
        touched.push(idStr(doc._id))
      }

      // The new ones.
      for (const [i, c] of plan.creates.entries()) {
        const ordi = c.internalOrderId ? ordiById.get(String(c.internalOrderId)) : null
        const res = new Reservation({
          orgId,
          reservationNumber: resNumbers[i],
          status: 'active',
          statusHistory: [{ status: 'active', changedAt: new Date(), changedBy: userId, reason: c.repeatOf ? 'reserved again with the order' : 'created with the order' }],
          contactId: ordi ? ordi.contactId : c.contactId,
          ...(ordi ? { internalOrderId: ordi._id, internalOrderLineId: c.internalOrderLineId, requestedDeliveryDate: ordi.requestedDeliveryDate } : {}),
          source: 'order',
          warehouseId: c.allocation.warehouseId,
          orderId: order._id,
          groupId: c.allocation.groupId,
          lineId: c.allocation.lineId,
          allocationId: c.allocation.id,
          expectedDate: order.expectedDate,
          productId: c.allocation.productId,
          quantity: c.quantity,
          notes: c.notes,
          ...(c.repeatOf ? { repeatOf: c.repeatOf } : {}),
          createdBy: userId,
        })
        await res.save({ session })
        touched.push(idStr(res._id))
      }
    })
  } catch (e: any) {
    if (e?.code === 11000 && /repeatOf/.test(String(e?.message || ''))) {
      throw new ReservationOpsError(409, 'That cancelled reservation was already reserved again')
    }
    throw e
  } finally {
    await session.endSession()
  }
  return { orderId, reservationIds: touched }
}

/**
 * The live reservations of an order, cancelled — a draft order being deleted (#203). Before, the
 * delete removed the order and left its reservations active, pointing at nothing, and still
 * eating their incoming-order lines' demand.
 */
export async function cancelOrderReservations(orgId: string, userId: string, orderId: string): Promise<string[]> {
  const live: any[] = await Reservation.find({ orgId, orderId, status: { $ne: 'cancelled' } } as any).exec()
  for (const res of live) {
    applyReservationCancel(res, reservationReleasable(res), 'external_order_cancelled', userId)
    await res.save()
  }
  return live.map(r => idStr(r._id))
}
