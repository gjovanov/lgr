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
} from 'services/biz/reservation-ops.service'
import { Reservation, Order, InternalOrder, Contact, Warehouse, Product, StockLevel } from 'db/models'

function opsError(status: any, e: any) {
  if (e instanceof ReservationOpsError) return status(e.statusCode, { message: e.message })
  throw e
}

const num = (v: any) => Number(v) || 0

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
  const contactName = (c: any) => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || String(c._id)
  const contactMap = new Map(contacts.map((c: any) => [String(c._id), contactName(c)]))
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
      orderNumber: (order as any)?.orderNumber,
      internalOrderNumber: (ordi as any)?.orderNumber,
      priority: (ordi as any)?.priority,
      late: !!(r.expectedDate && r.requestedDeliveryDate && new Date(r.expectedDate) > new Date(r.requestedDeliveryDate)),
      shortage: !!(level && num(level.quantity) - num(level.reservedQuantity) < 0),
    }
  })
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
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const res: any = await Reservation.findOne({ _id: id, orgId } as any).lean().exec()
    if (!res) return status(404, { message: 'Reservation not found' })
    const [enriched] = await enrich(orgId, [res])
    return { reservation: enriched }
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
  // #203: „Резервирай отново" — make a cancelled reservation again (once).
  .post(
    '/:id/repeat',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const { reservation, created } = await repeatReservation(orgId, user.id, id, { quantity: body?.quantity })
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
      body: t.Optional(t.Object({ quantity: t.Optional(t.Number({ exclusiveMinimum: 0 })) })),
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
