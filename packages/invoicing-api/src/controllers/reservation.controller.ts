import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import {
  ReservationOpsError,
  createReservation,
  cancelReservation,
  preemptReservation,
  updateReservation,
  repeatReservation,
  getReservationSources,
} from 'services/biz/reservation-ops.service'
import { reservationReleasable } from 'services/biz/reservation.service'
import { Reservation, Order, InternalOrder, Contact, Warehouse, Product, StockLevel, Invoice, User } from 'db/models'
import { mongoose } from 'db/connection'

/** The refusal's message, and its code and figure for the UI to say it in the user's language. */
function opsError(status: any, e: any) {
  if (e instanceof ReservationOpsError) return status(e.statusCode, { message: e.message, ...(e.details || {}) })
  throw e
}

const num = (v: any) => Number(v) || 0
const idStr = (v: any) => (v == null ? '' : String(v))
const isId = (v: unknown) => typeof v === 'string' && mongoose.Types.ObjectId.isValid(v)
const contactName = (c: any) => c?.companyName || [c?.firstName, c?.lastName].filter(Boolean).join(' ') || ''

/** Enrich a page of RES docs with names + computed late/shortage flags. */
async function enrich(orgId: string, items: any[]) {
  const contactIds = new Set<string>()
  const warehouseIds = new Set<string>()
  const productIds = new Set<string>()
  const orderIds = new Set<string>()
  const ordiIds = new Set<string>()
  for (const r of items) {
    if (r.contactId) contactIds.add(String(r.contactId))
    if (r.warehouseId) warehouseIds.add(String(r.warehouseId))
    if (r.productId) productIds.add(String(r.productId))
    if (r.orderId) orderIds.add(String(r.orderId))
    if (r.internalOrderId) ordiIds.add(String(r.internalOrderId))
  }
  const stockKeys = items
    .filter((r) => r.source === 'stock' && r.status === 'active' && r.productId && r.warehouseId)
    .map((r) => ({ productId: r.productId, warehouseId: r.warehouseId }))
  const [contacts, warehouses, products, orders, ordis, levels] = await Promise.all([
    contactIds.size ? Contact.find({ orgId, _id: { $in: [...contactIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : [],
    warehouseIds.size ? Warehouse.find({ orgId, _id: { $in: [...warehouseIds] } } as any, { name: 1 }).lean().exec() : [],
    productIds.size ? Product.find({ orgId, _id: { $in: [...productIds] } } as any, { name: 1, sku: 1, unit: 1 }).lean().exec() : [],
    orderIds.size ? Order.find({ orgId, _id: { $in: [...orderIds] } } as any, { orderNumber: 1, status: 1, expectedDate: 1 }).lean().exec() : [],
    ordiIds.size ? InternalOrder.find({ orgId, _id: { $in: [...ordiIds] } } as any, { orderNumber: 1, status: 1, requestedDeliveryDate: 1, priority: 1 }).lean().exec() : [],
    stockKeys.length
      ? StockLevel.find({ orgId, $or: stockKeys.map((k) => ({ productId: k.productId, warehouseId: k.warehouseId })) } as any, { productId: 1, warehouseId: 1, quantity: 1, reservedQuantity: 1 }).lean().exec()
      : [],
  ])
  const contactMap = new Map(contacts.map((c: any) => [String(c._id), contactName(c) || String(c._id)]))
  const warehouseMap = new Map(warehouses.map((w: any) => [String(w._id), w.name]))
  const productMap = new Map(products.map((p: any) => [String(p._id), p]))
  const orderMap = new Map(orders.map((o: any) => [String(o._id), o]))
  const ordiMap = new Map(ordis.map((o: any) => [String(o._id), o]))
  const levelMap = new Map(levels.map((sl: any) => [`${sl.productId}|${sl.warehouseId}`, sl]))

  return items.map((r: any) => {
    const order = r.orderId ? orderMap.get(String(r.orderId)) : undefined
    const ordi = r.internalOrderId ? ordiMap.get(String(r.internalOrderId)) : undefined
    const product: any = r.productId ? productMap.get(String(r.productId)) : undefined
    const level: any = r.source === 'stock' ? levelMap.get(`${r.productId}|${r.warehouseId}`) : undefined
    return {
      ...r,
      number: r.reservationNumber,
      contactName: contactMap.get(String(r.contactId)) || '',
      warehouseName: warehouseMap.get(String(r.warehouseId)) || '',
      productName: product?.name,
      productSku: product?.sku,
      productUnit: product?.unit,
      /** What a release can still free: quantity − max(invoiced, dispatched). */
      releasable: r.status === 'cancelled' ? 0 : reservationReleasable(r),
      orderNumber: (order as any)?.orderNumber,
      internalOrderNumber: (ordi as any)?.orderNumber,
      priority: (ordi as any)?.priority,
      late: !!(r.expectedDate && r.requestedDeliveryDate && new Date(r.expectedDate) > new Date(r.requestedDeliveryDate)),
      shortage: !!(level && num(level.quantity) - num(level.reservedQuantity) < 0),
    }
  })
}

/**
 * What a reservation's page shows and links to (FR-22.37): its supplier order and allocation, its
 * incoming order and line, every invoice that names it (any status — a voided one is history
 * too), the reservation it repeats and the one that repeats it, what a preemption took it from
 * or gave away, and the names of the people in its history.
 */
async function reservationDetail(orgId: string, res: any) {
  const [order, invoices, repeatOf, repeatedAs, preemptedFrom, preemptedTo] = await Promise.all([
    res.orderId
      ? Order.findOne({ _id: res.orderId, orgId } as any, { orderNumber: 1, status: 1, expectedDate: 1, supplierGroups: 1 }).lean().exec()
      : null,
    Invoice.find(
      { orgId, 'lines.orderRef.reservationId': res._id } as any,
      { invoiceNumber: 1, status: 1, type: 1, direction: 1, issueDate: 1, currency: 1, total: 1, 'lines.quantity': 1, 'lines.orderRef.reservationId': 1 },
    ).sort({ issueDate: 1, createdAt: 1 }).lean().exec(),
    res.repeatOf
      ? Reservation.findOne({ _id: res.repeatOf, orgId } as any, { reservationNumber: 1, status: 1, quantity: 1 }).lean().exec()
      : null,
    Reservation.findOne({ orgId, repeatOf: res._id } as any, { reservationNumber: 1, status: 1, quantity: 1 }).lean().exec(),
    res.preemptedBy?.reservationId
      ? Reservation.findOne({ _id: res.preemptedBy.reservationId, orgId } as any, { reservationNumber: 1, status: 1 }).lean().exec()
      : null,
    Reservation.find(
      { orgId, 'preemptedBy.reservationId': res._id } as any,
      { reservationNumber: 1, status: 1, quantity: 1, internalOrderId: 1, createdAt: 1 },
    ).sort({ createdAt: 1 }).lean().exec(),
  ])

  // The allocation, where the order still has it.
  let group: any = null
  let line: any = null
  let alloc: any = null
  for (const g of (order as any)?.supplierGroups || []) {
    for (const l of g.lines || []) {
      for (const a of l.allocations || []) {
        if (idStr(a._id) === idStr(res.allocationId)) { group = g; line = l; alloc = a }
      }
    }
  }

  const ordiIds = new Set<string>([idStr(res.internalOrderId), ...(preemptedTo as any[]).map((r) => idStr(r.internalOrderId))].filter(Boolean))
  const userIds = new Set<string>([
    idStr(res.createdBy),
    idStr(res.preemptedBy?.userId),
    ...(res.statusHistory || []).map((h: any) => idStr(h.changedBy)),
  ].filter(isId))
  const [ordis, users, allocWarehouse, supplier] = await Promise.all([
    ordiIds.size
      ? InternalOrder.find({ orgId, _id: { $in: [...ordiIds] } } as any, { orderNumber: 1, status: 1, priority: 1, requestedDeliveryDate: 1, lines: 1 }).lean().exec()
      : [],
    userIds.size ? User.find({ orgId, _id: { $in: [...userIds] } } as any, { firstName: 1, lastName: 1, username: 1 }).lean().exec() : [],
    alloc?.warehouseId ? Warehouse.findOne({ _id: alloc.warehouseId, orgId } as any, { name: 1 }).lean().exec() : null,
    group?.supplierId ? Contact.findOne({ _id: group.supplierId, orgId } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : null,
  ])
  const ordiById = new Map((ordis as any[]).map((o) => [idStr(o._id), o]))
  const ordi: any = res.internalOrderId ? ordiById.get(idStr(res.internalOrderId)) : null
  const ordiLine: any = ordi ? (ordi.lines || []).find((l: any) => idStr(l._id) === idStr(res.internalOrderLineId)) : null
  const ref = (r: any) => (r ? { _id: idStr(r._id), reservationNumber: r.reservationNumber, status: r.status, quantity: r.quantity } : null)

  return {
    order: order
      ? {
          _id: idStr((order as any)._id),
          orderNumber: (order as any).orderNumber,
          status: (order as any).status,
          expectedDate: (order as any).expectedDate || null,
          supplierId: group ? idStr(group.supplierId) : null,
          supplierName: supplier ? contactName(supplier) : '',
        }
      : null,
    allocation: alloc
      ? {
          _id: idStr(alloc._id),
          warehouseId: idStr(alloc.warehouseId),
          warehouseName: (allocWarehouse as any)?.name || '',
          quantity: num(alloc.quantity),
          receivedQuantity: num(alloc.receivedQuantity),
          lineDescription: line?.description || '',
          lineQuantity: num(line?.quantity),
        }
      : null,
    internalOrder: ordi
      ? { _id: idStr(ordi._id), orderNumber: ordi.orderNumber, status: ordi.status, priority: ordi.priority || 'normal', requestedDeliveryDate: ordi.requestedDeliveryDate || null }
      : null,
    internalOrderLine: ordiLine
      ? {
          _id: idStr(ordiLine._id),
          description: ordiLine.description || '',
          unit: ordiLine.unit || '',
          quantity: num(ordiLine.quantity),
          reservedQuantity: num(ordiLine.reservedQuantity),
          invoicedQuantity: num(ordiLine.invoicedQuantity),
          deliveredQuantity: num(ordiLine.deliveredQuantity),
        }
      : null,
    invoices: (invoices as any[]).map((inv) => ({
      _id: idStr(inv._id),
      invoiceNumber: inv.invoiceNumber,
      status: inv.status,
      type: inv.type,
      direction: inv.direction,
      issueDate: inv.issueDate || null,
      currency: inv.currency,
      total: num(inv.total),
      /** How much of this reservation the invoice takes: its lines that name it. */
      quantity: (inv.lines || [])
        .filter((l: any) => idStr(l.orderRef?.reservationId) === idStr(res._id))
        .reduce((s: number, l: any) => s + num(l.quantity), 0),
    })),
    repeatOf: ref(repeatOf),
    repeatedAs: ref(repeatedAs),
    preemptedFrom: ref(preemptedFrom),
    preemptedTo: (preemptedTo as any[]).map((r) => ({
      ...ref(r)!,
      internalOrderId: r.internalOrderId ? idStr(r.internalOrderId) : null,
      internalOrderNumber: r.internalOrderId ? ordiById.get(idStr(r.internalOrderId))?.orderNumber || null : null,
      createdAt: r.createdAt,
    })),
    users: Object.fromEntries((users as any[]).map((u) => [idStr(u._id), [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || ''])),
  }
}

export const reservationController = new Elysia({ prefix: '/org/:orgId/invoicing/reservations' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) {
      const list = String(query.status).split(',').map((s) => s.trim()).filter(Boolean)
      if (list.length === 1) filter.status = list[0]
      else if (list.length > 1) filter.status = { $in: list }
    }
    if (query.productId) filter.productId = query.productId
    if (query.orderId) filter.orderId = query.orderId
    if (query.internalOrderId) filter.internalOrderId = query.internalOrderId
    if (query.contactId) filter.contactId = query.contactId
    if (query.source) filter.source = query.source
    if (query.search) {
      const s = String(query.search)
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const contactFilter = buildSearchFilter(s, ['companyName', 'firstName', 'lastName'], {
        lowered: { companyName: 'companyNameLower', firstName: 'firstNameLower', lastName: 'lastNameLower' },
      })
      const matching = await Contact.find({ orgId, ...contactFilter } as any, { _id: 1 }).lean().exec()
      const ids = matching.map((c: any) => c._id)
      filter.$or = [
        { reservationNumber: { $regex: esc, $options: 'i' } },
        ...(ids.length ? [{ contactId: { $in: ids } }] : []),
      ]
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    // The grid's № column is `number`, which only enrich() adds: sort on the stored number,
    // or Mongo sorts on a field no document has and nothing moves (B-12).
    const sortBy = query.sortBy === 'number' ? 'reservationNumber' : (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const [items, total] = await Promise.all([
      Reservation.find(filter as any).sort({ [sortBy]: sortOrder }).skip(page * size).limit(size || 10).lean().exec(),
      Reservation.countDocuments(filter as any).exec(),
    ])

    return { reservations: await enrich(orgId, items), total, page, size }
  }, { isSignIn: true })
  // FR-22.37: what a new reservation of a product can take — free stock per warehouse, room on
  // supplier orders out to the supplier, and the client's open incoming-order lines.
  .get('/sources', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!isId(query.productId)) return status(422, { message: 'productId is required' })
    if (query.contactId !== undefined && query.contactId !== '' && !isId(query.contactId)) {
      return status(422, { message: 'contactId is not an id' })
    }
    return getReservationSources(orgId, query.productId as string, { contactId: (query.contactId as string) || undefined })
  }, {
    isSignIn: true,
    query: t.Object({ productId: t.Optional(t.String()), contactId: t.Optional(t.String()) }),
  })
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!isId(id)) return status(404, { message: 'Reservation not found' })
    const res: any = await Reservation.findOne({ _id: id, orgId } as any).lean().exec()
    if (!res) return status(404, { message: 'Reservation not found' })
    const [enriched, detail] = await Promise.all([enrich(orgId, [res]).then((r) => r[0]), reservationDetail(orgId, res)])
    return { reservation: enriched, detail }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const res: any = await createReservation(orgId, user.id, body as any)
        createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'reservation', entityId: String(res._id), entityName: res.reservationNumber })
        return { reservation: res }
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        source: t.Union([t.Literal('stock'), t.Literal('order')]),
        productId: t.String(),
        quantity: t.Number({ exclusiveMinimum: 0 }),
        contactId: t.Optional(t.String()),
        internalOrderId: t.Optional(t.String()),
        internalOrderLineId: t.Optional(t.String()),
        warehouseId: t.Optional(t.String()),
        orderId: t.Optional(t.String()),
        groupId: t.Optional(t.String()),
        lineId: t.Optional(t.String()),
        allocationId: t.Optional(t.String()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  // Release the open remainder (or `quantity` of it). Fully-open + full amount ⇒ cancelled.
  .post(
    '/:id/cancel',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const res: any = await cancelReservation(orgId, user.id, id, {
          quantity: body?.quantity,
          reason: body?.reason,
        })
        createAuditEntry({ orgId, userId: user.id, action: 'cancel', module: 'invoicing', entityType: 'reservation', entityId: id, entityName: res.reservationNumber, changes: { quantity: { to: res.quantity }, status: { to: res.status } } })
        return { reservation: res }
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        quantity: t.Optional(t.Number({ exclusiveMinimum: 0 })),
        reason: t.Optional(t.Union([t.Literal('manual'), t.Literal('released')])),
      }),
    },
  )
  // #203: change a live reservation's quantity or client in place (the checks of a create).
  .post(
    '/:id/update',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const before: any = await Reservation.findOne({ _id: id, orgId } as any, { quantity: 1, contactId: 1 }).lean().exec()
        const res: any = await updateReservation(orgId, user.id, id, { quantity: body.quantity, contactId: body.contactId })
        createAuditEntry({
          orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'reservation', entityId: id, entityName: res.reservationNumber,
          changes: { quantity: { from: before?.quantity, to: res.quantity }, contactId: { from: String(before?.contactId || ''), to: String(res.contactId) } },
        })
        return { reservation: res }
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        quantity: t.Optional(t.Number({ exclusiveMinimum: 0 })),
        contactId: t.Optional(t.String()),
      }),
    },
  )
  // #203: „Резервирай отново" — make a cancelled reservation again (once). An empty body copies it;
  // a body naming a source, a client or an incoming order changes those (D-4, FR-22 §5.7).
  .post(
    '/:id/repeat',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const { reservation, created } = await repeatReservation(orgId, user.id, id, body || {})
        if (created) {
          createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'reservation', entityId: String(reservation._id), entityName: reservation.reservationNumber, changes: { repeatOf: { to: id } } })
        }
        return { reservation, created }
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Optional(t.Object({
        quantity: t.Optional(t.Number({ exclusiveMinimum: 0 })),
        source: t.Optional(t.Union([t.Literal('stock'), t.Literal('order')])),
        warehouseId: t.Optional(t.String()),
        orderId: t.Optional(t.String()),
        groupId: t.Optional(t.String()),
        lineId: t.Optional(t.String()),
        allocationId: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        internalOrderId: t.Optional(t.String()),
        internalOrderLineId: t.Optional(t.String()),
      })),
    },
  )
  // Move the open remainder to a higher-priority internal-order line (same supply source).
  .post(
    '/:id/preempt',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const { source, created } = await preemptReservation(orgId, user.id, id, {
          internalOrderId: body.internalOrderId,
          internalOrderLineId: body.internalOrderLineId,
          quantity: body.quantity,
        })
        createAuditEntry({ orgId, userId: user.id, action: 'preempt', module: 'invoicing', entityType: 'reservation', entityId: id, entityName: source.reservationNumber, changes: { preemptedBy: { to: created.reservationNumber }, internalOrderId: { to: body.internalOrderId } } })
        createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'reservation', entityId: String(created._id), entityName: created.reservationNumber, changes: { preemptedFrom: { to: source.reservationNumber } } })
        return { source, created }
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        internalOrderId: t.String(),
        internalOrderLineId: t.String(),
        quantity: t.Optional(t.Number({ exclusiveMinimum: 0 })),
      }),
    },
  )
