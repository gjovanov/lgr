import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { getNextNumber, getCurrentNumber } from 'services/biz/sequence.service'
import { resolvePrice } from 'services/biz/pricing.service'
import {
  syncOrderDerivedState,
  syncReservedQuantities,
  collectOrderStockKeys,
  ORDER_HOLDING_STATUSES,
} from 'services/biz/reservation.service'
import { Order, Contact, Warehouse, Product, Invoice, Org } from 'db/models'
import { getNextDraftInvoiceNumber, resolveDisplayPrefix } from './invoice.controller.js'
import { generateOrderSheetXLSX } from 'reporting/excel/order-sheet.excel'
import { generateOrderSheetPDF } from 'reporting/pdf/order-sheet.pdf'
import type { OrderSheetCtx } from 'reporting/order-sheet.i18n'

// ── numbering ─────────────────────────────────────────────────────────────────
// Orders get their own counters: issued ORD-YYYY-NNNNN (key ORDER), drafts
// DRF-ORD-YYYY-NNNNN (key DRAFT_ORD). Both support display-prefix overrides via
// the Sequences configuration page (keys whitelisted in sequence-config.controller).

export async function getNextOrderNumber(orgId: string, draft: boolean): Promise<string> {
  const key = draft ? 'DRAFT_ORD' : 'ORDER'
  const basePrefix = draft ? 'DRF-ORD' : 'ORD'
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveDisplayPrefix(orgId, basePrefix, key)
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
      for (const alloc of line.allocations || []) {
        const resSum = (alloc.reservations || []).reduce((s: number, r: any) => s + (Number(r.quantity) || 0), 0)
        if (resSum > (Number(alloc.quantity) || 0) + 1e-9) {
          return `${label}: reservations (${resSum}) exceed the allocation quantity (${alloc.quantity})`
        }
        for (const res of alloc.reservations || []) {
          if (!res.contactId) return `${label}: reservation client is required`
          if (!(res.quantity > 0)) return `${label}: reservation quantity must be > 0`
        }
      }
    }
  }
  return null
}

// ── enrichment lookups ────────────────────────────────────────────────────────

async function nameMaps(orgId: string, order: any) {
  const contactIds = new Set<string>()
  const warehouseIds = new Set<string>()
  const productIds = new Set<string>()
  const invoiceIds = new Set<string>()
  for (const g of order.supplierGroups || []) {
    if (g.supplierId) contactIds.add(String(g.supplierId))
    for (const line of g.lines || []) {
      if (line.productId) productIds.add(String(line.productId))
      for (const alloc of line.allocations || []) {
        if (alloc.warehouseId) warehouseIds.add(String(alloc.warehouseId))
        for (const res of alloc.reservations || []) {
          if (res.contactId) contactIds.add(String(res.contactId))
          for (const iid of res.invoiceIds || []) invoiceIds.add(String(iid))
        }
      }
    }
  }
  const linkedInvoices = await Invoice.find({ orgId, orderId: order._id } as any, { invoiceNumber: 1, type: 1, direction: 1, status: 1, orderGroupId: 1, total: 1, contactId: 1 }).lean().exec()
  for (const inv of linkedInvoices) invoiceIds.add(String((inv as any)._id))

  const [contacts, warehouses, products] = await Promise.all([
    contactIds.size ? Contact.find({ orgId, _id: { $in: [...contactIds] } } as any, { companyName: 1, firstName: 1, lastName: 1 }).lean().exec() : [],
    warehouseIds.size ? Warehouse.find({ orgId, _id: { $in: [...warehouseIds] } } as any, { name: 1, code: 1 }).lean().exec() : [],
    productIds.size ? Product.find({ orgId, _id: { $in: [...productIds] } } as any, { name: 1, sku: 1, unit: 1 }).lean().exec() : [],
  ])

  const contactName = (c: any) => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || String(c._id)
  return {
    contacts: Object.fromEntries(contacts.map((c: any) => [String(c._id), contactName(c)])),
    warehouses: Object.fromEntries(warehouses.map((w: any) => [String(w._id), w.name])),
    products: Object.fromEntries(products.map((p: any) => [String(p._id), { name: p.name, sku: p.sku, unit: p.unit }])),
    invoices: Object.fromEntries(linkedInvoices.map((i: any) => [String(i._id), {
      invoiceNumber: i.invoiceNumber, type: i.type, direction: i.direction, status: i.status,
      orderGroupId: i.orderGroupId ? String(i.orderGroupId) : undefined, total: i.total, contactId: i.contactId ? String(i.contactId) : undefined,
    }])),
  }
}

// ── body schemas ──────────────────────────────────────────────────────────────

const reservationBody = t.Object({
  _id: t.Optional(t.String()),
  contactId: t.String(),
  quantity: t.Number({ minimum: 0 }),
})

const allocationBody = t.Object({
  _id: t.Optional(t.String()),
  warehouseId: t.String(),
  quantity: t.Number({ minimum: 0 }),
  reservations: t.Optional(t.Array(reservationBody)),
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
})

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
        warehouseId: a.warehouseId,
        quantity: a.quantity,
        reservations: (a.reservations || []).map((res: any) => ({
          ...(res._id ? { _id: res._id } : {}),
          contactId: res.contactId,
          quantity: res.quantity,
        })),
      })),
    })),
  }))
}

const round2 = (n: number) => Math.round(n * 100) / 100

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
    const sortBy = (query.sortBy as string) || 'createdAt'
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

    const orders = items.map((o: any) => {
      let ordered = 0
      let received = 0
      let reservedClients = new Set<string>()
      const names: string[] = []
      for (const g of o.supplierGroups || []) {
        const n = nameOf.get(String(g.supplierId))
        if (n) names.push(n)
        for (const line of g.lines || []) {
          ordered += Number(line.quantity) || 0
          received += Number(line.receivedQuantity) || 0
          for (const alloc of line.allocations || [])
            for (const res of alloc.reservations || [])
              if (res.contactId) reservedClients.add(String(res.contactId))
        }
      }
      return {
        ...o,
        number: o.orderNumber,
        supplierNames: names,
        orderedQuantity: ordered,
        receivedQuantity: received,
        reservationClientCount: reservedClients.size,
      }
    })

    return { orders, total, page, size }
  }, { isSignIn: true })
  // Non-incrementing preview of the next order number (draft by default).
  .get('/peek-next', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const wantDraft = (query.status as string | undefined) !== 'issued'
    const key = wantDraft ? 'DRAFT_ORD' : 'ORDER'
    const basePrefix = wantDraft ? 'DRF-ORD' : 'ORD'
    const year = new Date().getFullYear()
    const counter = await getCurrentNumber(orgId, key, year)
    const display = await resolveDisplayPrefix(orgId, basePrefix, key)
    return { next: `${display}-${year}-${String(counter + 1).padStart(5, '0')}`, counter, prefix: display }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const invalid = validateSupplierGroups(body.supplierGroups as any[])
      if (invalid) return status(422, { message: invalid })

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
    const lookup = await nameMaps(orgId, order)
    return { order, lookup }
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

      // Reservations already carried onto invoices must not silently disappear.
      const incomingResIds = new Set<string>()
      for (const g of body.supplierGroups as any[])
        for (const l of g.lines || [])
          for (const a of l.allocations || [])
            for (const res of a.reservations || [])
              if (res._id) incomingResIds.add(String(res._id))
      for (const g of existing.supplierGroups || [])
        for (const l of g.lines || [])
          for (const a of l.allocations || [])
            for (const res of a.reservations || []) {
              if ((res.invoicedQuantity || 0) > 0 && !incomingResIds.has(String(res._id))) {
                return status(409, { message: 'Cannot remove a reservation that already has linked invoices — void/delete those first' })
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

    await Order.deleteOne({ _id: id, orgId } as any).exec()
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
    const liveLinked = await Invoice.countDocuments({ orgId, orderId: id, status: { $nin: ['voided', 'cancelled'] } } as any).exec()
    if (liveLinked > 0) {
      return status(409, { message: 'Order has linked invoices — void or delete them before cancelling' })
    }

    order.statusHistory = [...(order.statusHistory || []), statusEntry('cancelled', order.status, user.id)]
    order.status = 'cancelled'
    await order.save()
    await syncReservedQuantities(orgId, collectOrderStockKeys(order))

    createAuditEntry({ orgId, userId: user.id, action: 'cancel', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber })
    return { order }
  }, { isSignIn: true })
  // Close the order: releases any remaining (un-invoiced) reservation holds.
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const order: any = await Order.findOne({ _id: id, orgId } as any).exec()
    if (!order) return status(404, { message: 'Order not found' })
    if (!ORDER_HOLDING_STATUSES.includes(order.status)) {
      return status(400, { message: 'Only sent/received orders can be completed' })
    }

    order.statusHistory = [...(order.statusHistory || []), statusEntry('completed', order.status, user.id)]
    order.status = 'completed'
    await order.save()
    await syncReservedQuantities(orgId, collectOrderStockKeys(order))

    createAuditEntry({ orgId, userId: user.id, action: 'complete', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber })
    return { order }
  }, { isSignIn: true })
  // Release the un-invoiced remainder of one reservation (shrinks it to what was already invoiced).
  .post(
    '/:id/release',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const order: any = await Order.findOne({ _id: id, orgId } as any).exec()
      if (!order) return status(404, { message: 'Order not found' })

      let found = false
      for (const g of order.supplierGroups || [])
        for (const line of g.lines || [])
          for (const alloc of line.allocations || [])
            for (const res of alloc.reservations || []) {
              if (String(res._id) === body.reservationId) {
                res.quantity = res.invoicedQuantity || 0
                found = true
              }
            }
      if (!found) return status(404, { message: 'Reservation not found' })

      await order.save()
      await syncReservedQuantities(orgId, collectOrderStockKeys(order))

      createAuditEntry({ orgId, userId: user.id, action: 'release_reservation', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber, changes: { reservationId: { to: body.reservationId } } })
      return { order }
    },
    { isSignIn: true, body: t.Object({ reservationId: t.String() }) },
  )
  // Convert one client's open reservations into a draft sales invoice.
  .post(
    '/:id/convert',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const order: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
      if (!order) return status(404, { message: 'Order not found' })
      if (!ORDER_HOLDING_STATUSES.includes(order.status)) {
        return status(400, { message: 'Only sent/received orders can be converted' })
      }

      const contactId = body.contactId
      const contact: any = await Contact.findOne({ _id: contactId, orgId } as any).lean().exec()
      if (!contact) return status(404, { message: 'Client not found' })

      const org: any = await Org.findById(orgId).lean().exec()
      const defaultVat = org?.settings?.taxConfig?.defaultVatRate ?? 20

      // Gather this client's open reservations across all groups/lines/allocations.
      const pending: Array<{ group: any; line: any; alloc: any; res: any; qty: number }> = []
      for (const g of order.supplierGroups || [])
        for (const line of g.lines || [])
          for (const alloc of line.allocations || [])
            for (const res of alloc.reservations || []) {
              if (String(res.contactId) !== String(contactId)) continue
              const open = (Number(res.quantity) || 0) - (Number(res.invoicedQuantity) || 0)
              if (open > 0) pending.push({ group: g, line, alloc, res, qty: open })
            }
      if (!pending.length) return status(400, { message: 'No open reservations for this client' })
      const unmatched = pending.filter((p) => !p.line.productId)
      if (unmatched.length) return status(422, { message: 'Reserved lines without a linked product cannot be invoiced' })

      // Build invoice lines: one per reservation, priced through the resolution chain.
      let subtotal = 0
      let taxTotal = 0
      const lines: any[] = []
      for (const p of pending) {
        let unitPrice = p.line.expectedUnitPrice || 0
        let priceExplanation: any[] | undefined
        try {
          const resolution = await resolvePrice(orgId, String(p.line.productId), String(contactId), p.qty)
          unitPrice = resolution.finalPrice
          priceExplanation = resolution.steps
        } catch {
          /* product gone — keep expected price */
        }
        const taxRate = p.line.taxRate ?? defaultVat
        const net = p.qty * unitPrice
        const taxAmount = net * (taxRate / 100)
        subtotal += net
        taxTotal += taxAmount
        lines.push({
          productId: String(p.line.productId),
          description: p.line.description,
          quantity: p.qty,
          unit: p.line.unit || 'pcs',
          unitPrice,
          discount: 0,
          taxRate,
          taxAmount: round2(taxAmount),
          lineTotal: round2(net + taxAmount),
          warehouseId: String(p.alloc.warehouseId),
          priceExplanation,
          orderRef: {
            groupId: p.group._id,
            lineId: p.line._id,
            allocationId: p.alloc._id,
            reservationId: p.res._id,
          },
        })
      }
      // Components-first rounding (Bulgarian fiscal style): total = round2(sub) + round2(tax).
      const total = round2(round2(subtotal) + round2(taxTotal))

      const billing = (contact.addresses || []).find((a: any) => a.isDefault) || (contact.addresses || [])[0]
      const dueDate = new Date()
      dueDate.setMonth(dueDate.getMonth() + 1)

      let invoice: any
      let lastErr: any
      for (let attempt = 0; attempt < 3; attempt++) {
        const invoiceNumber = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'invoice')
        try {
          invoice = await r.invoices.create({
            orgId,
            type: 'invoice',
            direction: 'outgoing',
            status: 'draft',
            statusHistory: [statusEntry('draft', undefined, user.id, `converted_from_order ${order.orderNumber}`)],
            invoiceNumber,
            numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: 'draft' }],
            contactId,
            issueDate: new Date(),
            dueDate,
            currency: order.currency || 'EUR',
            exchangeRate: order.exchangeRate || 1,
            reference: order.orderNumber,
            lines,
            subtotal: round2(subtotal),
            discountTotal: 0,
            taxTotal: round2(taxTotal),
            total,
            totalBase: round2(total * (order.exchangeRate || 1)),
            amountPaid: 0,
            amountDue: total,
            billingAddress: billing
              ? { street: billing.street || '-', city: billing.city || '-', state: billing.state, postalCode: billing.postalCode || '-', country: billing.country || '-' }
              : { street: '-', city: '-', postalCode: '-', country: '-' },
            orderId: id,
            createdBy: user.id,
          } as any)
          break
        } catch (e: any) {
          lastErr = e
          if (e?.code !== 'DUPLICATE' && e?.code !== 11000) throw e
        }
      }
      if (!invoice) return status(409, { message: `Could not allocate invoice number: ${lastErr?.message || 'duplicate'}` })

      // Derive invoicedQuantity/invoiceIds from the new draft (idempotent recompute).
      await syncOrderDerivedState(orgId, id, user.id)

      createAuditEntry({ orgId, userId: user.id, action: 'convert', module: 'invoicing', entityType: 'order', entityId: id, entityName: order.orderNumber, changes: { invoice: { to: invoice.invoiceNumber } } })
      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: invoice.id || String(invoice._id), entityName: invoice.invoiceNumber })

      return { invoice }
    },
    { isSignIn: true, body: t.Object({ contactId: t.String() }) },
  )
  // Per-supplier-group sheet: supplier variant (offer sheet, internal data redacted)
  // or internal variant (allocations + reservations), as XLSX or PDF.
  .get('/:id/export', async ({ params: { orgId, id }, query, user, status, set }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const perms: string[] = (user as any)?.permissions || []
    if (!(perms.includes('trade.read') || perms.includes('trade.write') || user.role === 'admin')) {
      return status(403, { message: 'Forbidden' })
    }

    const order: any = await Order.findOne({ _id: id, orgId } as any).lean().exec()
    if (!order) return status(404, { message: 'Order not found' })
    const group = (order.supplierGroups || []).find((g: any) => String(g._id) === String(query.groupId))
    if (!group) return status(404, { message: 'Supplier group not found' })

    const variant = query.variant === 'internal' ? 'internal' : 'supplier'
    const format = query.format === 'pdf' ? 'pdf' : 'xlsx'

    const [lookup, org, supplier] = await Promise.all([
      nameMaps(orgId, order),
      Org.findById(orgId).lean().exec(),
      Contact.findOne({ _id: group.supplierId, orgId } as any).lean().exec(),
    ])

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
