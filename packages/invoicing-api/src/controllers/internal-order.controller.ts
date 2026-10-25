import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { getNextNumber, getCurrentNumber } from 'services/biz/sequence.service'
import { syncInternalOrderDerivedState } from 'services/biz/reservation.service'
import {
  ReservationOpsError,
  completeInternalOrder,
  cancelInternalOrder,
  reserveAvailableForInternalOrder,
  getInternalOrderSuggestions,
  generateExternalOrder,
} from 'services/biz/reservation-ops.service'
import { InternalOrder, Reservation, Invoice, Order, Contact, Warehouse, Product } from 'db/models'
import { sequenceDefFor, resolveSequencePrefix } from 'services/biz/sequence-registry'
import { getNextOrderNumber } from './order.controller.js'
import { buildConversionInvoice, planConversion, ConversionError, type ConversionItem, type ConversionPlan } from '../lib/reservation-convert.js'

// ── numbering ─────────────────────────────────────────────────────────────────
// Internal orders: issued ORDI-YYYY-NNNNN (key INTERNAL_ORDER), drafts
// DRF-ORDI-YYYY-NNNNN (key DRAFT_ORDI); display overrides via the Sequences page.

export async function getNextInternalOrderNumber(orgId: string, draft: boolean): Promise<string> {
  const variant = draft ? 'draft' : 'issued'
  const key = sequenceDefFor('internal_order', variant)!.prefix
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveSequencePrefix(orgId, 'internal_order', variant)
  return `${display}-${year}-${seqPart}`
}

function statusEntry(toStatus: string, fromStatus?: string, userId?: string, reason?: string) {
  return { status: toStatus, fromStatus, changedAt: new Date(), changedBy: userId, reason }
}

function opsError(status: any, e: any) {
  if (e instanceof ReservationOpsError) return status(e.statusCode, { message: e.message })
  throw e
}

const num = (v: any) => Number(v) || 0

function coverageOf(ordi: any): { reservationCoverage: 'none' | 'partial' | 'full'; shortQuantity: number } {
  let ordered = 0
  let reserved = 0
  for (const line of ordi.lines || []) {
    ordered += num(line.quantity)
    reserved += Math.min(num(line.reservedQuantity), num(line.quantity))
  }
  const short = Math.max(0, ordered - reserved)
  return {
    reservationCoverage: reserved <= 0 ? 'none' : short > 0 ? 'partial' : 'full',
    shortQuantity: short,
  }
}

async function nameMaps(orgId: string, ordi: any, reservations: any[]) {
  const contactIds = new Set<string>([String(ordi.contactId)])
  const warehouseIds = new Set<string>()
  const productIds = new Set<string>()
  const invoiceIds = new Set<string>()
  if (ordi.warehouseId) warehouseIds.add(String(ordi.warehouseId))
  for (const line of ordi.lines || []) if (line.productId) productIds.add(String(line.productId))
  for (const res of reservations) {
    if (res.contactId) contactIds.add(String(res.contactId))
    if (res.warehouseId) warehouseIds.add(String(res.warehouseId))
    for (const iid of res.invoiceIds || []) invoiceIds.add(String(iid))
  }
  const linkedInvoices = await Invoice.find(
    { orgId, $or: [{ internalOrderId: ordi._id }, { 'lines.orderRef.internalOrderId': ordi._id }] } as any,
    { invoiceNumber: 1, type: 1, direction: 1, status: 1, total: 1, contactId: 1 },
  ).lean().exec()
  for (const inv of linkedInvoices) invoiceIds.add(String((inv as any)._id))
  const orderIds = [...new Set(reservations.map((r: any) => (r.orderId ? String(r.orderId) : '')).filter(Boolean))]

  const [contacts, warehouses, products, orders] = await Promise.all([
    Contact.find({ orgId, _id: { $in: [...contactIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec(),
    warehouseIds.size ? Warehouse.find({ orgId, _id: { $in: [...warehouseIds] } } as any, { name: 1 }).lean().exec() : [],
    productIds.size ? Product.find({ orgId, _id: { $in: [...productIds] } } as any, { name: 1, sku: 1, unit: 1 }).lean().exec() : [],
    orderIds.length ? Order.find({ orgId, _id: { $in: orderIds } } as any, { orderNumber: 1, status: 1, expectedDate: 1 }).lean().exec() : [],
  ])
  const contactName = (c: any) => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || String(c._id)
  return {
    contacts: Object.fromEntries(contacts.map((c: any) => [String(c._id), contactName(c)])),
    warehouses: Object.fromEntries(warehouses.map((w: any) => [String(w._id), w.name])),
    products: Object.fromEntries(products.map((p: any) => [String(p._id), { name: p.name, sku: p.sku, unit: p.unit }])),
    orders: Object.fromEntries(orders.map((o: any) => [String(o._id), { orderNumber: o.orderNumber, status: o.status, expectedDate: o.expectedDate }])),
    invoices: Object.fromEntries(linkedInvoices.map((i: any) => [String(i._id), {
      invoiceNumber: i.invoiceNumber, type: i.type, direction: i.direction, status: i.status,
      total: i.total, contactId: i.contactId ? String(i.contactId) : undefined,
    }])),
  }
}

// ── body schemas ──────────────────────────────────────────────────────────────

const lineBody = t.Object({
  _id: t.Optional(t.String()),
  productId: t.String(),
  description: t.String(),
  sku: t.Optional(t.String()),
  quantity: t.Number({ exclusiveMinimum: 0 }),
  unit: t.Optional(t.String()),
  expectedUnitPrice: t.Optional(t.Number()),
  taxRate: t.Optional(t.Number()),
  notes: t.Optional(t.String()),
})

const orderBody = t.Object({
  contactId: t.String(),
  issueDate: t.String(),
  requestedDeliveryDate: t.String(),
  priority: t.Optional(t.Union([t.Literal('low'), t.Literal('normal'), t.Literal('high'), t.Literal('urgent')])),
  warehouseId: t.Optional(t.String()),
  currency: t.Optional(t.String()),
  exchangeRate: t.Optional(t.Number()),
  notes: t.Optional(t.String()),
  terms: t.Optional(t.String()),
  tags: t.Optional(t.Array(t.String())),
  lines: t.Array(lineBody, { minItems: 1 }),
})

function sanitizeLines(lines: any[]): any[] {
  return (lines || []).map((l) => ({
    ...(l._id ? { _id: l._id } : {}),
    productId: l.productId,
    description: l.description,
    sku: l.sku || undefined,
    quantity: l.quantity,
    unit: l.unit || 'pcs',
    expectedUnitPrice: l.expectedUnitPrice,
    taxRate: l.taxRate,
    notes: l.notes || undefined,
  }))
}

export const internalOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/internal-orders' })
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
        ...(ids.length ? [{ contactId: { $in: ids } }] : []),
      ]
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const [items, total] = await Promise.all([
      InternalOrder.find(filter as any).sort({ [sortBy]: sortOrder }).skip(page * size).limit(size || 10).lean().exec(),
      InternalOrder.countDocuments(filter as any).exec(),
    ])

    const contactIds = [...new Set(items.map((o: any) => String(o.contactId)))]
    const contacts = contactIds.length
      ? await Contact.find({ orgId, _id: { $in: contactIds } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec()
      : []
    const nameOf = new Map(contacts.map((c: any) => [String(c._id), c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ')]))

    const internalOrders = items.map((o: any) => {
      let ordered = 0
      let delivered = 0
      for (const line of o.lines || []) {
        ordered += num(line.quantity)
        delivered += num(line.deliveredQuantity)
      }
      const cov = coverageOf(o)
      return {
        ...o,
        number: o.orderNumber,
        contactName: nameOf.get(String(o.contactId)) || '',
        orderedQuantity: ordered,
        deliveredQuantity: delivered,
        ...cov,
        late: !!(o.requestedDeliveryDate
          && new Date(o.requestedDeliveryDate) < new Date()
          && !['delivered', 'completed', 'cancelled'].includes(o.status)),
      }
    })

    return { internalOrders, total, page, size }
  }, { isSignIn: true })
  .get('/peek-next', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const wantDraft = (query.status as string | undefined) !== 'issued'
    const variant = wantDraft ? 'draft' : 'issued'
    const key = sequenceDefFor('internal_order', variant)!.prefix
    const year = new Date().getFullYear()
    const counter = await getCurrentNumber(orgId, key, year)
    const display = await resolveSequencePrefix(orgId, 'internal_order', variant)
    return { next: `${display}-${year}-${String(counter + 1).padStart(5, '0')}`, counter, prefix: display }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      let ordi: any
      let lastErr: any
      for (let attempt = 0; attempt < 3; attempt++) {
        const orderNumber = await getNextInternalOrderNumber(orgId, true)
        try {
          ordi = await InternalOrder.create({
            orgId,
            orderNumber,
            status: 'draft',
            statusHistory: [statusEntry('draft', undefined, user.id, 'created')],
            numberHistory: [{ number: orderNumber, allocatedAt: new Date(), status: 'draft' }],
            contactId: body.contactId,
            issueDate: new Date(body.issueDate),
            requestedDeliveryDate: new Date(body.requestedDeliveryDate),
            priority: body.priority || 'normal',
            warehouseId: body.warehouseId || undefined,
            currency: body.currency || 'EUR',
            exchangeRate: body.exchangeRate || 1,
            lines: sanitizeLines(body.lines as any[]),
            notes: body.notes,
            terms: body.terms,
            tags: body.tags || [],
            createdBy: user.id,
          } as any)
          break
        } catch (e: any) {
          lastErr = e
          if (e?.code !== 11000) throw e
        }
      }
      if (!ordi) return status(409, { message: `Could not allocate order number: ${lastErr?.message || 'duplicate'}` })

      await upsertTags(orgId, 'internal_order', body.tags)
      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'internal_order', entityId: String(ordi._id), entityName: ordi.orderNumber })
      return { internalOrder: ordi }
    },
    { isSignIn: true, body: orderBody },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const ordi: any = await InternalOrder.findOne({ _id: id, orgId } as any).lean().exec()
    if (!ordi) return status(404, { message: 'Internal order not found' })
    const reservations = await Reservation.find({ orgId, internalOrderId: id } as any).sort({ createdAt: 1 }).lean().exec()
    const lookup = await nameMaps(orgId, ordi, reservations)
    return { internalOrder: { ...ordi, ...coverageOf(ordi) }, reservations, lookup }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const existing: any = await InternalOrder.findOne({ _id: id, orgId } as any).exec()
      if (!existing) return status(404, { message: 'Internal order not found' })
      if (!['draft', 'confirmed'].includes(existing.status)) {
        return status(400, { message: `Cannot edit a ${existing.status} internal order` })
      }

      // Lines carrying reservations or deliveries must survive with enough quantity.
      const liveRes = await Reservation.find(
        { orgId, internalOrderId: id, status: { $ne: 'cancelled' } } as any,
        { internalOrderLineId: 1, quantity: 1, reservationNumber: 1 },
      ).lean().exec()
      const reservedByLine = new Map<string, number>()
      for (const r of liveRes) {
        const k = String((r as any).internalOrderLineId || '')
        if (!k) continue
        reservedByLine.set(k, (reservedByLine.get(k) || 0) + num((r as any).quantity))
      }
      const incomingByLine = new Map<string, number>()
      for (const l of body.lines as any[]) if (l._id) incomingByLine.set(String(l._id), num(l.quantity))
      for (const line of existing.lines || []) {
        const floor = Math.max(reservedByLine.get(String(line._id)) || 0, num(line.deliveredQuantity))
        if (floor <= 0) continue
        const incoming = incomingByLine.get(String(line._id))
        if (incoming === undefined || incoming + 1e-9 < floor) {
          return status(409, {
            message: `Line "${line.description}" carries reservations/deliveries totalling ${floor} — cancel them before shrinking/removing it`,
          })
        }
      }

      const before = existing.toObject()
      existing.contactId = body.contactId
      existing.issueDate = new Date(body.issueDate)
      existing.requestedDeliveryDate = new Date(body.requestedDeliveryDate)
      existing.priority = body.priority || existing.priority || 'normal'
      existing.warehouseId = body.warehouseId || undefined
      if (body.currency) existing.currency = body.currency
      if (body.exchangeRate !== undefined) existing.exchangeRate = body.exchangeRate
      existing.notes = body.notes
      existing.terms = body.terms
      existing.tags = body.tags || []
      existing.lines = sanitizeLines(body.lines as any[])
      await existing.save()

      const synced = await syncInternalOrderDerivedState(orgId, id, user.id)
      await upsertTags(orgId, 'internal_order', body.tags)
      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: existing.orderNumber, changes: diffChanges(before, synced?.toObject?.() || existing.toObject()) })
      return { internalOrder: synced || existing }
    },
    { isSignIn: true, body: orderBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const existing: any = await InternalOrder.findOne({ _id: id, orgId } as any).lean().exec()
    if (!existing) return status(404, { message: 'Internal order not found' })
    if (existing.status !== 'draft') return status(400, { message: 'Can only delete draft internal orders' })
    await InternalOrder.deleteOne({ _id: id, orgId } as any).exec()
    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: existing.orderNumber })
    return { message: 'Internal order deleted' }
  }, { isSignIn: true })
  // Issue the ORDI number: the client's order is confirmed and reservable.
  .post('/:id/confirm', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const ordi: any = await InternalOrder.findOne({ _id: id, orgId } as any).exec()
    if (!ordi) return status(404, { message: 'Internal order not found' })
    if (ordi.status !== 'draft') return status(400, { message: 'Internal order is not in draft status' })

    const draftNumber = ordi.orderNumber
    const issuedNumber = await getNextInternalOrderNumber(orgId, false)
    ordi.draftNumber = draftNumber
    ordi.orderNumber = issuedNumber
    ordi.numberHistory = [...(ordi.numberHistory || []), { number: issuedNumber, allocatedAt: new Date(), status: 'confirmed' }]
    ordi.statusHistory = [...(ordi.statusHistory || []), statusEntry('confirmed', 'draft', user.id)]
    ordi.status = 'confirmed'
    await ordi.save()

    createAuditEntry({ orgId, userId: user.id, action: 'confirm', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: issuedNumber, changes: { orderNumber: { from: draftNumber, to: issuedNumber } } })
    return { internalOrder: ordi }
  }, { isSignIn: true })
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      const ordi = await completeInternalOrder(orgId, user.id, id)
      createAuditEntry({ orgId, userId: user.id, action: 'complete', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: ordi.orderNumber })
      return { internalOrder: ordi }
    } catch (e: any) {
      return opsError(status, e)
    }
  }, { isSignIn: true })
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      const ordi = await cancelInternalOrder(orgId, user.id, id)
      createAuditEntry({ orgId, userId: user.id, action: 'cancel', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: ordi.orderNumber })
      return { internalOrder: ordi }
    } catch (e: any) {
      return opsError(status, e)
    }
  }, { isSignIn: true })
  // One-click stock cover: reserve open demand from free stock.
  .post(
    '/:id/reserve-available',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const result = await reserveAvailableForInternalOrder(orgId, user.id, id, body?.lineIds)
        for (const res of result.created) {
          createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'reservation', entityId: String(res._id), entityName: res.reservationNumber })
        }
        return result
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    { isSignIn: true, body: t.Object({ lineIds: t.Optional(t.Array(t.String())) }) },
  )
  // Cover suggestions per short line: free stock → unreserved incoming → preemptable RES.
  .get('/:id/suggestions', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      const lines = await getInternalOrderSuggestions(orgId, id)
      // Names for rendering: warehouses, clients, suppliers, products.
      const warehouseIds = new Set<string>()
      const contactIds = new Set<string>()
      const productIds = new Set<string>()
      for (const l of lines) {
        productIds.add(l.productId)
        for (const f of l.freeStock) warehouseIds.add(f.warehouseId)
        for (const i of l.incoming) warehouseIds.add(i.warehouseId)
        for (const p of l.preemptable) {
          warehouseIds.add(p.warehouseId)
          contactIds.add(p.contactId)
        }
        if (l.supplierHint) contactIds.add(l.supplierHint.supplierId)
      }
      const [warehouses, contacts, products] = await Promise.all([
        warehouseIds.size ? Warehouse.find({ orgId, _id: { $in: [...warehouseIds] } } as any, { name: 1 }).lean().exec() : [],
        contactIds.size ? Contact.find({ orgId, _id: { $in: [...contactIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : [],
        productIds.size ? Product.find({ orgId, _id: { $in: [...productIds] } } as any, { name: 1, sku: 1 }).lean().exec() : [],
      ])
      const contactName = (c: any) => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || String(c._id)
      return {
        lines,
        lookup: {
          warehouses: Object.fromEntries(warehouses.map((w: any) => [String(w._id), w.name])),
          contacts: Object.fromEntries(contacts.map((c: any) => [String(c._id), contactName(c)])),
          products: Object.fromEntries(products.map((p: any) => [String(p._id), { name: p.name, sku: p.sku }])),
        },
      }
    } catch (e: any) {
      return opsError(status, e)
    }
  }, { isSignIn: true })
  // Cover the shortfall with a (new or existing draft) external order + linked reservations.
  .post(
    '/:id/generate-external',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        const draftOrderNumber = body.orderId ? undefined : await getNextOrderNumber(orgId, true)
        const result = await generateExternalOrder(orgId, user.id, id, {
          orderId: body.orderId,
          draftOrderNumber,
          lines: body.lines,
        })
        createAuditEntry({ orgId, userId: user.id, action: 'generate_external', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: result.order.orderNumber, changes: { order: { to: result.order.orderNumber } } })
        for (const res of result.reservations) {
          createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'reservation', entityId: String(res._id), entityName: res.reservationNumber })
        }
        return result
      } catch (e: any) {
        return opsError(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        orderId: t.Optional(t.String()),
        lines: t.Array(
          t.Object({
            internalOrderLineId: t.String(),
            quantity: t.Number({ exclusiveMinimum: 0 }),
            supplierId: t.String(),
            warehouseId: t.Optional(t.String()),
          }),
          { minItems: 1 },
        ),
      }),
    },
  )
  // Convert this internal order's open reservations into ONE draft sales invoice — what can be
  // dispatched now (planConversion); what still waits on a supplier order stays reserved and
  // comes back as `waiting`.
  .post('/:id/convert', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const ordi: any = await InternalOrder.findOne({ _id: id, orgId } as any).lean().exec()
    if (!ordi) return status(404, { message: 'Internal order not found' })
    if (!['confirmed', 'partially_delivered', 'delivered'].includes(ordi.status)) {
      return status(400, { message: 'Only confirmed internal orders can be converted' })
    }
    const contact: any = await Contact.findOne({ _id: ordi.contactId, orgId } as any).lean().exec()
    if (!contact) return status(404, { message: 'Client not found' })

    const resDocs = await Reservation.find({ orgId, internalOrderId: id, status: 'active' } as any)
      .sort({ createdAt: 1, _id: 1 }).lean().exec()
    const lineById = new Map((ordi.lines || []).map((l: any) => [String(l._id), l]))

    let invoice: any
    let plan: ConversionPlan
    try {
      plan = await planConversion(orgId, resDocs, 'No open reservations on this internal order')
      const orderIds = [...new Set(plan.ready.map((p) => (p.res.orderId ? String(p.res.orderId) : '')).filter(Boolean))]
      const items: ConversionItem[] = plan.ready.map(({ res, quantity }) => {
        const line: any = res.internalOrderLineId ? lineById.get(String(res.internalOrderLineId)) : undefined
        return {
          productId: String(res.productId),
          description: line?.description || String(res.productId),
          quantity,
          unit: line?.unit || 'pcs',
          taxRate: line?.taxRate ?? undefined,
          fallbackPrice: line?.expectedUnitPrice || 0,
          warehouseId: String(res.warehouseId),
          orderRef: {
            orderId: res.orderId ? String(res.orderId) : undefined,
            groupId: res.groupId ? String(res.groupId) : undefined,
            lineId: res.lineId ? String(res.lineId) : undefined,
            allocationId: res.allocationId ? String(res.allocationId) : undefined,
            reservationId: String(res._id),
            internalOrderId: id,
            internalOrderLineId: res.internalOrderLineId ? String(res.internalOrderLineId) : undefined,
          },
        }
      })
      invoice = await buildConversionInvoice(orgId, user.id, contact, items, {
        currency: ordi.currency || 'EUR',
        exchangeRate: ordi.exchangeRate || 1,
        reference: ordi.orderNumber,
        statusReason: `converted_from_internal_order ${ordi.orderNumber}`,
        internalOrderId: id,
        orderId: orderIds.length === 1 ? orderIds[0] : undefined,
      })
    } catch (e: any) {
      if (e instanceof ConversionError) return status(e.statusCode as any, e.body())
      throw e
    }

    await syncInternalOrderDerivedState(orgId, id, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'convert', module: 'invoicing', entityType: 'internal_order', entityId: id, entityName: ordi.orderNumber, changes: { invoice: { to: invoice.invoiceNumber } } })
    createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: invoice.id || String(invoice._id), entityName: invoice.invoiceNumber })
    return { invoice, waiting: plan.waiting }
  }, { isSignIn: true })
