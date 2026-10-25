import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { getNextNumber, getCurrentNumber } from 'services/biz/sequence.service'
import {
  syncOrderDerivedState,
  syncReservedQuantities,
  syncReservationsByIds,
  recomputeInternalOrder,
  collectOrderStockKeys,
  reservationReleasable,
  applyReservationCancel,
  ORDER_HOLDING_STATUSES,
} from 'services/biz/reservation.service'
import { Order, Reservation, InternalOrder, Contact, Warehouse, Product, Invoice, Org } from 'db/models'
import { sequenceDefFor, resolveSequencePrefix } from 'services/biz/sequence-registry'
import {
  hasReservationChanges, saveOrderWithReservations, cancelOrderReservations, type ReservationChanges,
} from 'services/biz/order-reservations.service'
import { ReservationOpsError } from 'services/biz/reservation-ops.service'
import { buildConversionInvoice, planConversion, ConversionError, type ConversionItem, type ConversionPlan } from '../lib/reservation-convert.js'
import { canExport } from '../lib/export-access.js'
import { generateOrderSheetXLSX } from 'reporting/excel/order-sheet.excel'
import { generateOrderSheetPDF } from 'reporting/pdf/order-sheet.pdf'
import type { OrderSheetCtx } from 'reporting/order-sheet.i18n'

// ── numbering ─────────────────────────────────────────────────────────────────
// External orders get their own counters: issued ORDO-YYYY-NNNNN (key ORDER), drafts
// DRF-ORDO-YYYY-NNNNN (key DRAFT_ORD). The counter keys predate the ORD→ORDO rename —
// numbering continues across it; only the display prefix changed. Both support
// display-prefix overrides via the Sequences configuration page (keys whitelisted in
// sequence-config.controller).

export async function getNextOrderNumber(orgId: string, draft: boolean): Promise<string> {
  const variant = draft ? 'draft' : 'issued'
  const key = sequenceDefFor('order', variant)!.prefix
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveSequencePrefix(orgId, 'order', variant)
  return `${display}-${year}-${seqPart}`
}

function statusEntry(toStatus: string, fromStatus?: string, userId?: string, reason?: string) {
  return { status: toStatus, fromStatus, changedAt: new Date(), changedBy: userId, reason }
}

// ── structural validation (sums) ──────────────────────────────────────────────

function validateSupplierGroups(groups: any[]): string | null {
  if (!groups?.length) return 'At least one supplier group is required'
  for (const [gi, g] of groups.entries()) {
    if (!g.supplierId) return `Group ${gi + 1}: supplier is required`
    for (const [li, line] of (g.lines || []).entries()) {
      const label = `Group ${gi + 1}, line ${li + 1}`
      if (!(line.quantity > 0)) return `${label}: quantity must be > 0`
      const allocSum = (line.allocations || []).reduce((s: number, a: any) => s + (Number(a.quantity) || 0), 0)
      if (allocSum > line.quantity + 1e-9) {
        return `${label}: warehouse allocations (${allocSum}) exceed the ordered quantity (${line.quantity})`
      }
    }
  }
  return null
}

// ── enrichment lookups ────────────────────────────────────────────────────────

async function nameMaps(orgId: string, order: any, reservations: any[] = []) {
  const contactIds = new Set<string>()
  const warehouseIds = new Set<string>()
  const productIds = new Set<string>()
  const invoiceIds = new Set<string>()
  const internalOrderIds = new Set<string>()
  for (const g of order.supplierGroups || []) {
    if (g.supplierId) contactIds.add(String(g.supplierId))
    for (const line of g.lines || []) {
      if (line.productId) productIds.add(String(line.productId))
      for (const alloc of line.allocations || []) {
        if (alloc.warehouseId) warehouseIds.add(String(alloc.warehouseId))
      }
    }
  }
  for (const res of reservations) {
    if (res.contactId) contactIds.add(String(res.contactId))
    if (res.internalOrderId) internalOrderIds.add(String(res.internalOrderId))
    for (const iid of res.invoiceIds || []) invoiceIds.add(String(iid))
  }
  // A conversion invoice mixing sources may lack the doc-level orderId — match line refs too.
  const linkedInvoices = await Invoice.find(
    { orgId, $or: [{ orderId: order._id }, { 'lines.orderRef.orderId': order._id }] } as any,
    { invoiceNumber: 1, type: 1, direction: 1, status: 1, orderGroupId: 1, total: 1, contactId: 1 },
  ).lean().exec()
  for (const inv of linkedInvoices) invoiceIds.add(String((inv as any)._id))

  const [contacts, warehouses, products, internalOrders] = await Promise.all([
    contactIds.size ? Contact.find({ orgId, _id: { $in: [...contactIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : [],
    warehouseIds.size ? Warehouse.find({ orgId, _id: { $in: [...warehouseIds] } } as any, { name: 1, code: 1 }).lean().exec() : [],
    productIds.size ? Product.find({ orgId, _id: { $in: [...productIds] } } as any, { name: 1, sku: 1, unit: 1 }).lean().exec() : [],
    internalOrderIds.size ? InternalOrder.find({ orgId, _id: { $in: [...internalOrderIds] } } as any, { orderNumber: 1, status: 1 }).lean().exec() : [],
  ])

  const contactName = (c: any) => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || String(c._id)
  return {
    contacts: Object.fromEntries(contacts.map((c: any) => [String(c._id), contactName(c)])),
    warehouses: Object.fromEntries(warehouses.map((w: any) => [String(w._id), w.name])),
    products: Object.fromEntries(products.map((p: any) => [String(p._id), { name: p.name, sku: p.sku, unit: p.unit }])),
    internalOrders: Object.fromEntries(internalOrders.map((o: any) => [String(o._id), { orderNumber: o.orderNumber, status: o.status }])),
    invoices: Object.fromEntries(linkedInvoices.map((i: any) => [String(i._id), {
      invoiceNumber: i.invoiceNumber, type: i.type, direction: i.direction, status: i.status,
      orderGroupId: i.orderGroupId ? String(i.orderGroupId) : undefined, total: i.total, contactId: i.contactId ? String(i.contactId) : undefined,
    }])),
  }
}

// ── body schemas ──────────────────────────────────────────────────────────────

// Reservations are first-class RES- documents now — order bodies no longer carry them
// (a legacy client still sending an embedded `reservations` array is silently ignored).
const allocationBody = t.Object({
  _id: t.Optional(t.String()),
  // #203: names a NEW allocation so a staged reservation can point at it before it has an _id.
  clientKey: t.Optional(t.String()),
  warehouseId: t.String(),
  quantity: t.Number({ minimum: 0 }),
})

const lineBody = t.Object({
  _id: t.Optional(t.String()),
  productId: t.Optional(t.String()),
  description: t.String(),
  sku: t.Optional(t.String()),
  quantity: t.Number({ minimum: 0 }),
  unit: t.Optional(t.String()),
  expectedUnitPrice: t.Optional(t.Number()),
  taxRate: t.Optional(t.Number()),
  allocations: t.Optional(t.Array(allocationBody)),
})

const groupBody = t.Object({
  _id: t.Optional(t.String()),
  supplierId: t.String(),
  reference: t.Optional(t.String()),
  notes: t.Optional(t.String()),
  lines: t.Array(lineBody),
})

const orderBody = t.Object({
  issueDate: t.String(),
  expectedDate: t.Optional(t.String()),
  currency: t.Optional(t.String()),
  exchangeRate: t.Optional(t.Number()),
  notes: t.Optional(t.String()),
  terms: t.Optional(t.String()),
  tags: t.Optional(t.Array(t.String())),
  supplierGroups: t.Array(groupBody),
  /**
   * #203: client reservations edited in the order form, saved with it in one transaction
   * (`services/biz/order-reservations.service.ts`). Its own name: a legacy client may still send
   * an embedded `reservations` array, which stays ignored.
   */
  reservationChanges: t.Optional(t.Object({
    create: t.Optional(t.Array(t.Object({
      allocationId: t.Optional(t.String()),
      allocationKey: t.Optional(t.String()),
      contactId: t.Optional(t.String()),
      quantity: t.Number({ exclusiveMinimum: 0 }),
      internalOrderId: t.Optional(t.String()),
      internalOrderLineId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      repeatOf: t.Optional(t.String()),
    }))),
    update: t.Optional(t.Array(t.Object({
      id: t.String(),
      quantity: t.Optional(t.Number({ exclusiveMinimum: 0 })),
      contactId: t.Optional(t.String()),
    }))),
    cancel: t.Optional(t.Array(t.Object({ id: t.String() }))),
  })),
})

/** The answer to a refused reservation change, or rethrow. */
function reservationRefusal(status: any, e: any) {
  if (e instanceof ReservationOpsError) return status(e.statusCode, { message: e.message })
  throw e
}

/** Warehouse names for the planner's messages („Болт М8 @ Склад 1"). */
async function warehouseNames(orgId: string): Promise<(id: string) => string> {
  const list: any[] = await Warehouse.find({ orgId } as any, { name: 1 }).lean().exec()
  const byId = new Map(list.map(w => [String(w._id), w.name || '']))
  return (id: string) => byId.get(id) || ''
}

// Strip empty-string ids the form may send so Mongoose casts don't choke.
function sanitizeGroups(groups: any[]): any[] {
  return (groups || []).map((g) => ({
    ...(g._id ? { _id: g._id } : {}),
    supplierId: g.supplierId,
    reference: g.reference || undefined,
    notes: g.notes || undefined,
    lines: (g.lines || []).map((l: any) => ({
      ...(l._id ? { _id: l._id } : {}),
      productId: l.productId || undefined,
      description: l.description,
      sku: l.sku || undefined,
      quantity: l.quantity,
      unit: l.unit || 'pcs',
      expectedUnitPrice: l.expectedUnitPrice,
      taxRate: l.taxRate,
      allocations: (l.allocations || []).map((a: any) => ({
        ...(a._id ? { _id: a._id } : {}),
        // Only read by the reservation-changes path; Mongoose drops it on a plain save.
        ...(a.clientKey && !a._id ? { clientKey: a.clientKey } : {}),
        warehouseId: a.warehouseId,
        quantity: a.quantity,
      })),
    })),
  }))
}

export const orderController = new Elysia({ prefix: '/org/:orgId/invoicing/orders' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) {
      const list = String(query.status).split(',').map((s) => s.trim()).filter(Boolean)
      if (list.length === 1) filter.status = list[0]
      else if (list.length > 1) filter.status = { $in: list }
    }
    if (query.search) {
      const s = String(query.search)
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const contactFilter = buildSearchFilter(s, ['companyName', 'firstName', 'lastName'], {
        lowered: { companyName: 'companyNameLower', firstName: 'firstNameLower', lastName: 'lastNameLower' },
      })
      const matching = await Contact.find({ orgId, ...contactFilter } as any, { _id: 1 }).lean().exec()
      const ids = matching.map((c: any) => c._id)
      filter.$or = [
        { orderNumber: { $regex: esc, $options: 'i' } },
        ...(ids.length ? [{ 'supplierGroups.supplierId': { $in: ids } }] : []),
      ]
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    // The grid's № column is `number`, which only the rows built below carry: sort on the
    // stored number, or Mongo sorts on a field no document has and nothing moves (B-12).
    const sortBy = query.sortBy === 'number' ? 'orderNumber' : (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const [items, total] = await Promise.all([
      Order.find(filter as any).sort({ [sortBy]: sortOrder }).skip(page * size).limit(size || 10).lean().exec(),
      Order.countDocuments(filter as any).exec(),
    ])

    // Supplier names for the list chips
    const supplierIds = new Set<string>()
    for (const o of items) for (const g of (o as any).supplierGroups || []) if (g.supplierId) supplierIds.add(String(g.supplierId))
    const suppliers = supplierIds.size
      ? await Contact.find({ orgId, _id: { $in: [...supplierIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec()
      : []
    const nameOf = new Map(suppliers.map((c: any) => [String(c._id), c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')]))

    // Distinct reserving clients per order (RES- docs) for the page's orders.
    const pageOrderIds = items.map((o: any) => o._id)
    const pageRes = pageOrderIds.length
      ? await Reservation.find(
          { orgId, orderId: { $in: pageOrderIds }, status: { $ne: 'cancelled' } } as any,
          { orderId: 1, contactId: 1 },
        ).lean().exec()
      : []
    const clientsByOrder = new Map<string, Set<string>>()
    for (const r of pageRes) {
      const k = String((r as any).orderId)
      if (!clientsByOrder.has(k)) clientsByOrder.set(k, new Set())
      if ((r as any).contactId) clientsByOrder.get(k)!.add(String((r as any).contactId))
    }

    const orders = items.map((o: any) => {
      let ordered = 0
      let received = 0
      const names: string[] = []
      for (const g of o.supplierGroups || []) {
        const n = nameOf.get(String(g.supplierId))
        if (n) names.push(n)
        for (const line of g.lines || []) {
          ordered += Number(line.quantity) || 0
          received += Number(line.receivedQuantity) || 0
        }
      }
      return {
        ...o,
        number: o.orderNumber,
        supplierNames: names,
        orderedQuantity: ordered,
        receivedQuantity: received,
        reservationClientCount: clientsByOrder.get(String(o._id))?.size || 0,
      }
    })

    return { orders, total, page, size }
  }, { isSignIn: true })
  // Non-incrementing preview of the next order number (draft by default).
  .get('/peek-next', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const wantDraft = (query.status as string | undefined) !== 'issued'
    const variant = wantDraft ? 'draft' : 'issued'
    const key = sequenceDefFor('order', variant)!.prefix
    const year = new Date().getFullYear()
    const counter = await getCurrentNumber(orgId, key, year)
    const display = await resolveSequencePrefix(orgId, 'order', variant)
    return { next: `${display}-${year}-${String(counter + 1).padStart(5, '0')}`, counter, prefix: display }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const invalid = validateSupplierGroups(body.supplierGroups as any[])
      if (invalid) return status(422, { message: invalid })

      // #203: reservations staged in the form of a NEW order — saved with it, in one transaction.
      if (hasReservationChanges(body.reservationChanges as ReservationChanges)) {
        const names = await warehouseNames(orgId)
        for (let attempt = 0; attempt < 3; attempt++) {
          const orderNumber = await getNextOrderNumber(orgId, true)
          try {
            const saved = await saveOrderWithReservations({
              orgId, userId: user.id, orderNumber,
              header: {
                issueDate: new Date(body.issueDate),
                expectedDate: body.expectedDate ? new Date(body.expectedDate) : undefined,
                currency: body.currency || 'EUR',
                exchangeRate: body.exchangeRate || 1,
                notes: body.notes, terms: body.terms, tags: body.tags || [],
              },
              groups: sanitizeGroups(body.supplierGroups as any[]),
              changes: body.reservationChanges as ReservationChanges,
              warehouseName: names,
            })
            const synced = await syncOrderDerivedState(orgId, saved.orderId, user.id)
            await upsertTags(orgId, 'order', body.tags)
            createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'order', entityId: saved.orderId, entityName: orderNumber, changes: { reservations: { to: saved.reservationIds.length } } })
            return { order: synced }
          } catch (e: any) {
            if (e?.code === 11000 && /orderNumber/.test(String(e?.message || ''))) continue
            return reservationRefusal(status, e)
          }
        }
        return status(409, { message: 'Could not allocate order number' })
      }

      let order: any
      let lastErr: any
      for (let attempt = 0; attempt < 3; attempt++) {
        const orderNumber = await getNextOrderNumber(orgId, true)
        try {
          order = await Order.create({
            orgId,
            orderNumber,
            status: 'draft',
            statusHistory: [statusEntry('draft', undefined, user.id, 'created')],
            numberHistory: [{ number: orderNumber, allocatedAt: new Date(), status: 'draft' }],
            issueDate: new Date(body.issueDate),
            expectedDate: body.expectedDate ? new Date(body.expectedDate) : undefined,
            currency: body.currency || 'EUR',
            exchangeRate: body.exchangeRate || 1,
            notes: body.notes,
            terms: body.terms,
            tags: body.tags || [],
            supplierGroups: sanitizeGroups(body.supplierGroups as any[]),
            createdBy: user.id,
          } as any)
          break
        } catch (e: any) {
          lastErr = e
          if (e?.code !== 11000) throw e
        }
      }
      if (!order) return status(409, { message: `Could not allocate order number: ${lastErr?.message || 'duplicate'}` })

      await upsertTags(orgId, 'order', body.tags)
      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'order', entityId: String(order._id), entityName: order.orderNumber })

      return { order }
    },
    { isSignIn: true, body: orderBody },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const order: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
    if (!order) return status(404, { message: 'Order not found' })
    const reservations = await Reservation.find({ orgId, orderId: id } as any).sort({ createdAt: 1 }).lean().exec()
    const lookup = await nameMaps(orgId, order, reservations)
    return { order, reservations, lookup }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const existing: any = await Order.findOne({ _id: id, orgId } as any).exec()
      if (!existing) return status(404, { message: 'Order not found' })
      if (['completed', 'cancelled'].includes(existing.status)) {
        return status(400, { message: `Cannot edit a ${existing.status} order` })
      }

      const invalid = validateSupplierGroups(body.supplierGroups as any[])
      if (invalid) return status(422, { message: invalid })

      // #203: the form's reservation changes and the order, in one transaction. The rules are
      // checked on the result, so lowering an allocation together with its reservations is one save.
      if (hasReservationChanges(body.reservationChanges as ReservationChanges)) {
        const beforeKeys = collectOrderStockKeys(existing)
        const before = existing.toObject()
        try {
          await saveOrderWithReservations({
            orgId, userId: user.id, orderId: id,
            header: {
              issueDate: new Date(body.issueDate),
              expectedDate: body.expectedDate ? new Date(body.expectedDate) : undefined,
              currency: body.currency || existing.currency,
              exchangeRate: body.exchangeRate !== undefined ? body.exchangeRate : existing.exchangeRate,
              notes: body.notes, terms: body.terms, tags: body.tags || [],
            },
            groups: sanitizeGroups(body.supplierGroups as any[]),
            changes: body.reservationChanges as ReservationChanges,
            warehouseName: await warehouseNames(orgId),
          })
        } catch (e: any) {
          return reservationRefusal(status, e)
        }
        const synced = await syncOrderDerivedState(orgId, id, user.id)
        await syncReservedQuantities(orgId, beforeKeys)
        await upsertTags(orgId, 'order', body.tags)
        createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'order', entityId: id, entityName: existing.orderNumber, changes: diffChanges(before, synced?.toObject?.() || before) })
        return { order: synced }
      }

      // Allocations backing live reservations must survive the edit with enough quantity.
      const liveRes = await Reservation.find(
        { orgId, orderId: id, status: { $ne: 'cancelled' } } as any,
        { reservationNumber: 1, allocationId: 1, quantity: 1 },
      ).lean().exec()
      if (liveRes.length) {
        const reservedByAlloc = new Map<string, { qty: number; numbers: string[] }>()
        for (const r of liveRes) {
          const k = String((r as any).allocationId || '')
          if (!k) continue
          const entry = reservedByAlloc.get(k) || { qty: 0, numbers: [] }
          entry.qty += Number((r as any).quantity) || 0
          entry.numbers.push((r as any).reservationNumber)
          reservedByAlloc.set(k, entry)
        }
        const incomingAllocQty = new Map<string, number>()
        for (const g of body.supplierGroups as any[])
          for (const l of g.lines || [])
            for (const a of l.allocations || [])
              if (a._id) incomingAllocQty.set(String(a._id), Number(a.quantity) || 0)
        for (const [allocId, entry] of reservedByAlloc) {
          const incoming = incomingAllocQty.get(allocId)
          if (incoming === undefined || incoming + 1e-9 < entry.qty) {
            return status(409, {
              message: `Allocation carries active reservations (${entry.numbers.join(', ')}) totalling ${entry.qty} — cancel or preempt them before shrinking/removing it`,
            })
          }
        }
      }

      const beforeKeys = collectOrderStockKeys(existing)
      const before = existing.toObject()

      existing.issueDate = new Date(body.issueDate)
      existing.expectedDate = body.expectedDate ? new Date(body.expectedDate) : undefined
      if (body.currency) existing.currency = body.currency
      if (body.exchangeRate !== undefined) existing.exchangeRate = body.exchangeRate
      existing.notes = body.notes
      existing.terms = body.terms
      existing.tags = body.tags || []
      existing.supplierGroups = sanitizeGroups(body.supplierGroups as any[])
      await existing.save()

      // Re-derive received/invoiced counters + holds; also refresh pairs the edit removed.
      const synced = await syncOrderDerivedState(orgId, id, user.id)
      await syncReservedQuantities(orgId, beforeKeys)

      await upsertTags(orgId, 'order', body.tags)
      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'order', entityId: id, entityName: existing.orderNumber, changes: diffChanges(before, synced?.toObject?.() || existing.toObject()) })

      return { order: synced || existing }
    },
    { isSignIn: true, body: orderBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const existing: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
    if (!existing) return status(404, { message: 'Order not found' })
    if (existing.status !== 'draft') return status(400, { message: 'Can only delete draft orders' })

    // #203: a draft order takes reservations too — they go with it instead of staying active and
    // pointing at nothing (still eating their incoming-order lines' demand).
    const cancelled = await cancelOrderReservations(orgId, user.id, id)
    await Order.deleteOne({ _id: id, orgId } as any).exec()
    await syncReservationsByIds(orgId, cancelled, user.id)
    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'order', entityId: id, entityName: existing.orderNumber })
    return { message: 'Order deleted' }
  }, { isSignIn: true })
  // Issue the ORD number and mark the order as sent (ordered from the suppliers).
  .post('/:id/send', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const order: any = await Order.findOne({ _id: id, orgId } as any).exec()
    if (!order) return status(404, { message: 'Order not found' })
    if (order.status !== 'draft') return status(400, { message: 'Order is not in draft status' })

    const draftNumber = order.orderNumber
    const issuedNumber = await getNextOrderNumber(orgId, false)
    order.draftNumber = draftNumber
    order.orderNumber = issuedNumber
    order.numberHistory = [...(order.numberHistory || []), { number: issuedNumber, allocatedAt: new Date(), status: 'sent' }]
    order.statusHistory = [...(order.statusHistory || []), statusEntry('sent', 'draft', user.id)]
    order.status = 'sent'
    await order.save()

    createAuditEntry({ orgId, userId: user.id, action: 'send', module: 'invoicing', entityType: 'order', entityId: id, entityName: issuedNumber, changes: { orderNumber: { from: draftNumber, to: issuedNumber } } })
    return { order }
  }, { isSignIn: true })
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const order: any = await Order.findOne({ _id: id, orgId } as any).exec()
    if (!order) return status(404, { message: 'Order not found' })
    if (['completed', 'cancelled'].includes(order.status)) {
      return status(400, { message: `Order is already ${order.status}` })
    }
    // A mixed-source conversion invoice may lack the doc-level orderId — check line refs
    // and reservation-consuming invoices too before allowing the cancel.
    const linkedRes = await Reservation.find({ orgId, orderId: id } as any).exec()
    const liveLinked = await Invoice.countDocuments({
      orgId,
      status: { $nin: ['voided', 'cancelled'] },
      $or: [
        { orderId: id },
        { 'lines.orderRef.orderId': id },
        ...(linkedRes.length ? [{ 'lines.orderRef.reservationId': { $in: linkedRes.map((r: any) => r._id) } }] : []),
      ],
    } as any).exec()
    if (liveLinked > 0) {
      return status(409, { message: 'Order has linked invoices — void or delete them before cancelling' })
    }

    // Cascade: reservations sourced from this order lose their supply.
    const affectedOrdiIds = new Set<string>()
    for (const res of linkedRes) {
      if ((res as any).status === 'cancelled') continue
      applyReservationCancel(res, reservationReleasable(res as any), 'external_order_cancelled', user.id)
      await (res as any).save()
      if ((res as any).internalOrderId) affectedOrdiIds.add(String((res as any).internalOrderId))
    }

    order.statusHistory = [...(order.statusHistory || []), statusEntry('cancelled', order.status, user.id)]
    order.status = 'cancelled'
    await order.save()
    const affectedInternalOrders: Array<{ id: string; orderNumber: string }> = []
    for (const ordiId of affectedOrdiIds) {
      const ordi = await recomputeInternalOrder(orgId, ordiId, user.id)
      if (ordi) affectedInternalOrders.push({ id: ordiId, orderNumber: ordi.orderNumber })
    }
    await syncReservedQuantities(orgId, collectOrderStockKeys(order))

    createAuditEntry({ orgId, userId: user.id, action: 'cancel', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber })
    return { order, affectedInternalOrders }
  }, { isSignIn: true })
  // Close the order: explicitly releases the open remainder of every linked reservation.
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const order: any = await Order.findOne({ _id: id, orgId } as any).exec()
    if (!order) return status(404, { message: 'Order not found' })
    if (!ORDER_HOLDING_STATUSES.includes(order.status)) {
      return status(400, { message: 'Only sent/received orders can be completed' })
    }

    const linkedRes = await Reservation.find({ orgId, orderId: id, status: { $ne: 'cancelled' } } as any).exec()
    const releasedIds: string[] = []
    for (const res of linkedRes) {
      const releasable = reservationReleasable(res as any)
      if (releasable <= 0) continue
      applyReservationCancel(res, releasable, 'released', user.id)
      await (res as any).save()
      releasedIds.push(String((res as any)._id))
    }

    order.statusHistory = [...(order.statusHistory || []), statusEntry('completed', order.status, user.id)]
    order.status = 'completed'
    await order.save()
    if (releasedIds.length) await syncReservationsByIds(orgId, releasedIds, user.id)
    await syncReservedQuantities(orgId, collectOrderStockKeys(order))

    createAuditEntry({ orgId, userId: user.id, action: 'complete', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber })
    return { order }
  }, { isSignIn: true })
  // Legacy alias: release the open remainder of one reservation (RES- cancel-remainder).
  .post(
    '/:id/release',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const order: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
      if (!order) return status(404, { message: 'Order not found' })
      const res: any = await Reservation.findOne({ _id: body.reservationId, orgId, orderId: id } as any).exec()
      if (!res) return status(404, { message: 'Reservation not found' })

      if (res.status !== 'cancelled') {
        applyReservationCancel(res, reservationReleasable(res), 'released', user.id)
        await res.save()
        await syncReservationsByIds(orgId, [String(res._id)], user.id)
      }

      createAuditEntry({ orgId, userId: user.id, action: 'release_reservation', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber, changes: { reservationId: { to: body.reservationId } } })
      return { order, reservation: res }
    },
    { isSignIn: true, body: t.Object({ reservationId: t.String() }) },
  )
  // Convert one client's open reservations into a draft sales invoice — what this order has
  // delivered so far (planConversion); the rest stays reserved and comes back as `waiting`.
  .post(
    '/:id/convert',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const order: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
      if (!order) return status(404, { message: 'Order not found' })
      if (!ORDER_HOLDING_STATUSES.includes(order.status)) {
        return status(400, { message: 'Only sent/received orders can be converted' })
      }

      const contactId = body.contactId
      const contact: any = await Contact.findOne({ _id: contactId, orgId } as any).lean().exec()
      if (!contact) return status(404, { message: 'Client not found' })

      // This client's open reservations sourced from this order.
      const resDocs = await Reservation.find(
        { orgId, orderId: id, contactId, status: 'active' } as any,
      ).sort({ createdAt: 1, _id: 1 }).lean().exec()

      // Line metadata (description/unit/expected price) comes from the source order line.
      const lineById = new Map<string, any>()
      for (const g of order.supplierGroups || [])
        for (const line of g.lines || []) lineById.set(String(line._id), line)

      let invoice: any
      let plan: ConversionPlan
      try {
        plan = await planConversion(orgId, resDocs, 'No open reservations for this client')
        if (plan.ready.some((p) => !p.res.productId)) {
          return status(422, { message: 'Reserved lines without a linked product cannot be invoiced' })
        }
        const items: ConversionItem[] = plan.ready.map(({ res, quantity }) => {
          const line = lineById.get(String(res.lineId))
          return {
            productId: String(res.productId),
            description: line?.description || String(res.productId),
            quantity,
            unit: line?.unit || 'pcs',
            taxRate: line?.taxRate ?? undefined,
            fallbackPrice: line?.expectedUnitPrice || 0,
            warehouseId: String(res.warehouseId),
            orderRef: {
              orderId: id,
              groupId: res.groupId ? String(res.groupId) : undefined,
              lineId: res.lineId ? String(res.lineId) : undefined,
              allocationId: res.allocationId ? String(res.allocationId) : undefined,
              reservationId: String(res._id),
              internalOrderId: res.internalOrderId ? String(res.internalOrderId) : undefined,
              internalOrderLineId: res.internalOrderLineId ? String(res.internalOrderLineId) : undefined,
            },
          }
        })
        invoice = await buildConversionInvoice(orgId, user.id, contact, items, {
          currency: order.currency || 'EUR',
          exchangeRate: order.exchangeRate || 1,
          reference: order.orderNumber,
          statusReason: `converted_from_order ${order.orderNumber}`,
          orderId: id,
        })
      } catch (e: any) {
        if (e instanceof ConversionError) return status(e.statusCode as any, e.body())
        throw e
      }

      // Derive invoicedQuantity/invoiceIds from the new draft (idempotent recompute).
      await syncOrderDerivedState(orgId, id, user.id)

      createAuditEntry({ orgId, userId: user.id, action: 'convert', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber, changes: { invoice: { to: invoice.invoiceNumber } } })
      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: invoice.id || String(invoice._id), entityName: invoice.invoiceNumber })

      return { invoice, waiting: plan.waiting }
    },
    { isSignIn: true, body: t.Object({ contactId: t.String() }) },
  )
  // Per-supplier-group sheet: supplier variant (offer sheet, internal data redacted)
  // or internal variant (allocations + reservations), as XLSX or PDF.
  .get('/:id/export', async ({ params: { orgId, id }, query, user, status, set }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!canExport(user)) return status(403, { message: 'Forbidden' })

    const order: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
    if (!order) return status(404, { message: 'Order not found' })
    const group = (order.supplierGroups || []).find((g: any) => String(g._id) === String(query.groupId))
    if (!group) return status(404, { message: 'Supplier group not found' })

    const variant = query.variant === 'internal' ? 'internal' : 'supplier'
    const format = query.format === 'pdf' ? 'pdf' : 'xlsx'

    const resDocs = variant === 'internal'
      ? await Reservation.find({ orgId, orderId: id, status: { $ne: 'cancelled' } } as any).lean().exec()
      : []
    const [lookup, org, supplier] = await Promise.all([
      nameMaps(orgId, order, resDocs),
      Org.findById(orgId).lean().exec(),
      Contact.findOne({ _id: group.supplierId, orgId } as any).lean().exec(),
    ])
    const resByAlloc: Record<string, Array<{ contactId: any; quantity: number }>> = {}
    for (const r of resDocs) {
      const k = String((r as any).allocationId || '')
      if (!k) continue
      if (!resByAlloc[k]) resByAlloc[k] = []
      resByAlloc[k].push({ contactId: (r as any).contactId, quantity: (r as any).quantity })
    }

    const ctx: OrderSheetCtx = {
      order,
      group,
      org: {
        name: (org as any)?.name || 'Organization',
        taxNumber: (org as any)?.taxNumber,
        vatNumber: (org as any)?.vatNumber,
        email: (org as any)?.email,
        phone: (org as any)?.phone,
      },
      supplierName: lookup.contacts[String(group.supplierId)] || '',
      supplierTaxId: (supplier as any)?.taxNumber || (supplier as any)?.taxId,
      productInfo: lookup.products,
      warehouseNames: lookup.warehouses,
      contactNames: lookup.contacts,
      reservations: resByAlloc,
      locale: (query.locale as string) || undefined,
    }

    const filename = `${order.orderNumber}-${variant}.${format}`
    if (format === 'xlsx') {
      const buffer = await generateOrderSheetXLSX(ctx, variant)
      set.headers['content-type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      set.headers['content-disposition'] = `attachment; filename="${filename}"`
      return new Response(buffer)
    }
    try {
      const buffer = await generateOrderSheetPDF(ctx, variant)
      if (!buffer) return status(503, { message: 'PDF renderer unavailable' })
      set.headers['content-type'] = 'application/pdf'
      set.headers['content-disposition'] = `attachment; filename="${filename}"`
      return new Response(buffer)
    } catch (e: any) {
      return status(503, {
        message: 'PDF export is temporarily unavailable. Use Excel export or retry.',
        detail: e?.message?.slice(0, 300),
      })
    }
  }, { isSignIn: true })
