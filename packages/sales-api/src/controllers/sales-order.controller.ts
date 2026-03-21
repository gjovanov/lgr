import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { sendQuotation, confirmSalesOrder, createInvoiceFromSO, cancelSalesOrder, markSalesOrderDone } from 'services/biz/sales.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'amountTotal', 'dateOrder']

async function upsertTags(orgId: string, tags?: string[]) {
  if (!tags?.length) return
  const r = getRepos()
  // Batch check which tags already exist
  const existing = await r.tags.findMany({ orgId, type: 'sales_order', value: { $in: tags } } as any)
  const existingValues = new Set(existing.map((t: any) => t.value))
  // Only create missing tags
  const newTags = tags.filter(v => !existingValues.has(v))
  for (const value of newTags) {
    await r.tags.create({ orgId, type: 'sales_order', value } as any)
  }
}

export const salesOrderController = new Elysia({ prefix: '/org/:orgId/sales/orders' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.read')) {
      return status(403, { message: 'Forbidden: sales.read permission required' })
    }
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'notes']))
    }
    if (query.state) filter.state = query.state
    if (query.partnerId) filter.partnerId = query.partnerId
    if (query.invoiceStatus) filter.invoiceStatus = query.invoiceStatus
    if (query.deliveryStatus) filter.deliveryStatus = query.deliveryStatus
    if (query.userId) filter.userId = query.userId
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }
    if (query.startDate || query.endDate) {
      filter.dateOrder = {}
      if (query.startDate) filter.dateOrder.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.dateOrder.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.salesOrders.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Batch lookup contacts
    const contactIds = new Set<string>()
    for (const item of result.items) {
      if (item.partnerId) contactIds.add(item.partnerId)
    }
    const contacts = contactIds.size > 0
      ? await r.contacts.findMany({ id: { $in: [...contactIds] } } as any)
      : []
    const contactMap = new Map(contacts.map((c: any) => [c.id, c]))

    return {
      salesOrders: result.items.map((so: any) => ({
        ...so,
        partner: contactMap.get(so.partnerId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { isSignIn: true })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.read')) {
      return status(403, { message: 'Forbidden: sales.read permission required' })
    }
    const r = getRepos()
    const order = await r.salesOrders.findOne({ id, orgId } as any)
    if (!order) return status(404, { message: 'Sales order not found' })

    // Lookup contact
    const partner = order.partnerId ? await r.contacts.findById(order.partnerId) : null

    return { ...order, partner }
  }, { isSignIn: true })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const r = getRepos()

    const name = await getNextNumber(orgId, 'SO')

    // Compute line totals
    const lines = (body.lines || []).map((line: any) => {
      const priceSubtotal = line.quantity * line.priceUnit * (1 - (line.discount || 0) / 100)
      const taxAmount = priceSubtotal * (line.taxRate || 0) / 100
      return {
        ...line,
        priceSubtotal: Math.round(priceSubtotal * 100) / 100,
        taxAmount: Math.round(taxAmount * 100) / 100,
        priceTotal: Math.round((priceSubtotal + taxAmount) * 100) / 100,
        qtyDelivered: 0,
        qtyInvoiced: 0,
      }
    })

    const amountUntaxed = lines.reduce((sum: number, l: any) => sum + l.priceSubtotal, 0)
    const amountTax = lines.reduce((sum: number, l: any) => sum + l.taxAmount, 0)

    const order = await r.salesOrders.create({
      orgId,
      name,
      state: 'draft',
      partnerId: body.partnerId,
      partnerShippingId: body.partnerShippingId,
      partnerInvoiceId: body.partnerInvoiceId,
      validityDate: body.validityDate ? new Date(body.validityDate) : undefined,
      commitmentDate: body.commitmentDate ? new Date(body.commitmentDate) : undefined,
      pricelistId: body.pricelistId,
      currency: body.currency || 'EUR',
      exchangeRate: body.exchangeRate || 1,
      lines,
      amountUntaxed: Math.round(amountUntaxed * 100) / 100,
      amountTax: Math.round(amountTax * 100) / 100,
      amountTotal: Math.round((amountUntaxed + amountTax) * 100) / 100,
      invoiceStatus: 'nothing',
      deliveryStatus: 'pending',
      invoiceIds: [],
      movementIds: [],
      templateId: body.templateId,
      notes: body.notes,
      termsAndConditions: body.termsAndConditions,
      requireSignature: body.requireSignature || false,
      requirePayment: body.requirePayment || false,
      userId: user.id,
      tags: body.tags,
      createdBy: user.id,
    } as any)

    await upsertTags(orgId, body.tags)

    // Audit
    createAuditEntry(r, {
      orgId, userId: user.id, action: 'create', entityType: 'SalesOrder',
      entityId: order.id, entityName: name, newValues: order,
    }).catch(() => {})

    return order
  }, {
    isSignIn: true,
    body: t.Object({
      partnerId: t.String(),
      partnerShippingId: t.Optional(t.String()),
      partnerInvoiceId: t.Optional(t.String()),
      validityDate: t.Optional(t.String()),
      commitmentDate: t.Optional(t.String()),
      pricelistId: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      exchangeRate: t.Optional(t.Number({ minimum: 0.0001 })),
      lines: t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        uom: t.String(),
        priceUnit: t.Number({ minimum: 0 }),
        discount: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        taxRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        warehouseId: t.Optional(t.String()),
        scheduledDate: t.Optional(t.String()),
      })),
      templateId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      termsAndConditions: t.Optional(t.String()),
      requireSignature: t.Optional(t.Boolean()),
      requirePayment: t.Optional(t.Boolean()),
      tags: t.Optional(t.Array(t.String())),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const r = getRepos()

    const existing = await r.salesOrders.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Sales order not found' })
    if (existing.state !== 'draft' && existing.state !== 'sent') {
      return status(400, { message: 'Can only edit draft or sent orders' })
    }

    // Recompute lines if provided
    const updates: any = { ...body }
    if (body.lines) {
      updates.lines = body.lines.map((line: any) => {
        const priceSubtotal = line.quantity * line.priceUnit * (1 - (line.discount || 0) / 100)
        const taxAmount = priceSubtotal * (line.taxRate || 0) / 100
        return {
          ...line,
          priceSubtotal: Math.round(priceSubtotal * 100) / 100,
          taxAmount: Math.round(taxAmount * 100) / 100,
          priceTotal: Math.round((priceSubtotal + taxAmount) * 100) / 100,
          qtyDelivered: 0,
          qtyInvoiced: 0,
        }
      })
      const amountUntaxed = updates.lines.reduce((sum: number, l: any) => sum + l.priceSubtotal, 0)
      const amountTax = updates.lines.reduce((sum: number, l: any) => sum + l.taxAmount, 0)
      updates.amountUntaxed = Math.round(amountUntaxed * 100) / 100
      updates.amountTax = Math.round(amountTax * 100) / 100
      updates.amountTotal = Math.round((amountUntaxed + amountTax) * 100) / 100
    }

    if (body.validityDate) updates.validityDate = new Date(body.validityDate)
    if (body.commitmentDate) updates.commitmentDate = new Date(body.commitmentDate)

    const updated = await r.salesOrders.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    if (body.tags) await upsertTags(orgId, body.tags)

    // Audit
    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry(r, {
        orgId, userId: user.id, action: 'update', entityType: 'SalesOrder',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      partnerId: t.Optional(t.String()),
      partnerShippingId: t.Optional(t.String()),
      partnerInvoiceId: t.Optional(t.String()),
      validityDate: t.Optional(t.String()),
      commitmentDate: t.Optional(t.String()),
      pricelistId: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      exchangeRate: t.Optional(t.Number({ minimum: 0.0001 })),
      lines: t.Optional(t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        uom: t.String(),
        priceUnit: t.Number({ minimum: 0 }),
        discount: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        taxRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        warehouseId: t.Optional(t.String()),
        scheduledDate: t.Optional(t.String()),
      }))),
      templateId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      termsAndConditions: t.Optional(t.String()),
      requireSignature: t.Optional(t.Boolean()),
      requirePayment: t.Optional(t.Boolean()),
      tags: t.Optional(t.Array(t.String())),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const r = getRepos()
    const existing = await r.salesOrders.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Sales order not found' })
    if (existing.state !== 'draft') {
      return status(400, { message: 'Can only delete draft orders' })
    }

    await r.salesOrders.delete(id)

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'delete', entityType: 'SalesOrder',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { isSignIn: true })

  // ── ACTIONS ──

  // Send quotation
  .post('/:id/send', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.confirm')) {
      return status(403, { message: 'Forbidden: sales.confirm permission required' })
    }
    const result = await sendQuotation(id, orgId)

    const r = getRepos()
    createAuditEntry(r, {
      orgId, userId: user.id, action: 'update', entityType: 'SalesOrder',
      entityId: id, entityName: result.name, changes: [{ field: 'state', oldValue: 'draft', newValue: 'sent' }],
    }).catch(() => {})

    return result
  }, { isSignIn: true })

  // Confirm order
  .post('/:id/confirm', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.confirm')) {
      return status(403, { message: 'Forbidden: sales.confirm permission required' })
    }
    const r = getRepos()
    const existing = await r.salesOrders.findOne({ id, orgId } as any)
    const result = await confirmSalesOrder(id, orgId)

    createAuditEntry(r, {
      orgId, userId: user.id, action: 'update', entityType: 'SalesOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: existing?.state, newValue: 'confirmed' }],
    }).catch(() => {})

    return result
  }, { isSignIn: true })

  // Create invoice
  .post('/:id/invoice', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.invoice')) {
      return status(403, { message: 'Forbidden: sales.invoice permission required' })
    }
    const result = await createInvoiceFromSO(id, orgId)

    const r = getRepos()
    createAuditEntry(r, {
      orgId, userId: user.id, action: 'update', entityType: 'SalesOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'invoiceStatus', oldValue: 'to_invoice', newValue: result.invoiceStatus }],
    }).catch(() => {})

    return result
  }, { isSignIn: true })

  // Cancel order
  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const result = await cancelSalesOrder(id, orgId)

    const r = getRepos()
    createAuditEntry(r, {
      orgId, userId: user.id, action: 'update', entityType: 'SalesOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'draft', newValue: 'cancelled' }],
    }).catch(() => {})

    return result
  }, { isSignIn: true })

  // Mark done
  .post('/:id/done', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const result = await markSalesOrderDone(id, orgId)
    return result
  }, { isSignIn: true })
