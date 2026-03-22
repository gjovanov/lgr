import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import {
  sendRFQ, requestApproval, approvePurchaseOrder, rejectPurchaseOrder,
  confirmPurchaseOrder, recordReceipt, createBillFromPO, cancelPurchaseOrder,
} from 'services/biz/purchase.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'state', 'amountTotal', 'dateOrder']

export const purchaseOrderController = new Elysia({ prefix: '/org/:orgId/purchase/orders' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'notes']))
    }
    if (query.state) filter.state = query.state
    if (query.vendorId) filter.vendorId = query.vendorId
    if (query.receiptStatus) filter.receiptStatus = query.receiptStatus
    if (query.invoiceStatus) filter.invoiceStatus = query.invoiceStatus
    if (query.userId) filter.userId = query.userId
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }
    if (query.startDate || query.endDate) {
      filter.datePlanned = {}
      if (query.startDate) filter.datePlanned.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.datePlanned.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.purchaseOrders.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Batch lookup vendors
    const vendorIds = new Set<string>()
    for (const item of result.items) {
      if (item.vendorId) vendorIds.add(item.vendorId)
    }
    const vendors = vendorIds.size > 0
      ? await r.contacts.findMany({ id: { $in: [...vendorIds] } } as any)
      : []
    const vendorMap = new Map(vendors.map((v: any) => [v.id, v]))

    return {
      purchaseOrders: result.items.map((po: any) => ({
        ...po,
        vendor: vendorMap.get(po.vendorId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'purchase.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const order = await r.purchaseOrders.findOne({ id, orgId } as any)
    if (!order) return status(404, { message: 'Purchase order not found' })
    const vendor = order.vendorId ? await r.contacts.findById(order.vendorId) : null
    return { ...order, vendor }
  }, { access: { permission: 'purchase.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const name = await getNextNumber(orgId, 'PO')

    const lines = (body.lines || []).map((line: any) => {
      const priceSubtotal = line.quantity * line.priceUnit
      const taxAmount = priceSubtotal * (line.taxRate || 0) / 100
      return {
        ...line,
        priceSubtotal: Math.round(priceSubtotal * 100) / 100,
        taxAmount: Math.round(taxAmount * 100) / 100,
        priceTotal: Math.round((priceSubtotal + taxAmount) * 100) / 100,
        qtyReceived: 0,
        qtyBilled: 0,
      }
    })

    const amountUntaxed = lines.reduce((sum: number, l: any) => sum + l.priceSubtotal, 0)
    const amountTax = lines.reduce((sum: number, l: any) => sum + l.taxAmount, 0)

    const order = await r.purchaseOrders.create({
      orgId,
      name,
      state: 'draft',
      vendorId: body.vendorId,
      datePlanned: body.datePlanned ? new Date(body.datePlanned) : undefined,
      currency: body.currency || 'EUR',
      exchangeRate: body.exchangeRate || 1,
      lines,
      amountUntaxed: Math.round(amountUntaxed * 100) / 100,
      amountTax: Math.round(amountTax * 100) / 100,
      amountTotal: Math.round((amountUntaxed + amountTax) * 100) / 100,
      receiptStatus: 'pending',
      invoiceStatus: 'nothing',
      invoiceIds: [],
      movementIds: [],
      agreementId: body.agreementId,
      notes: body.notes,
      userId: user.id,
      tags: body.tags,
      createdBy: user.id,
    } as any)

    await upsertTags(orgId, 'purchase_order', body.tags)

    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'create', entityType: 'PurchaseOrder',
      entityId: order.id, entityName: name,
    }).catch(() => {})

    return order
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      vendorId: t.String(),
      datePlanned: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      exchangeRate: t.Optional(t.Number({ minimum: 0.0001 })),
      lines: t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        uom: t.String(),
        priceUnit: t.Number({ minimum: 0 }),
        taxRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        warehouseId: t.Optional(t.String()),
        scheduledDate: t.Optional(t.String()),
      })),
      agreementId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.purchaseOrders.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Purchase order not found' })
    if (!['draft', 'sent'].includes(existing.state)) {
      return status(400, { message: 'Can only edit draft or sent orders' })
    }

    const updates: any = { ...body }
    if (body.lines) {
      updates.lines = body.lines.map((line: any) => {
        const priceSubtotal = line.quantity * line.priceUnit
        const taxAmount = priceSubtotal * (line.taxRate || 0) / 100
        return {
          ...line,
          priceSubtotal: Math.round(priceSubtotal * 100) / 100,
          taxAmount: Math.round(taxAmount * 100) / 100,
          priceTotal: Math.round((priceSubtotal + taxAmount) * 100) / 100,
          qtyReceived: 0,
          qtyBilled: 0,
        }
      })
      const amountUntaxed = updates.lines.reduce((sum: number, l: any) => sum + l.priceSubtotal, 0)
      const amountTax = updates.lines.reduce((sum: number, l: any) => sum + l.taxAmount, 0)
      updates.amountUntaxed = Math.round(amountUntaxed * 100) / 100
      updates.amountTax = Math.round(amountTax * 100) / 100
      updates.amountTotal = Math.round((amountUntaxed + amountTax) * 100) / 100
    }

    if (body.datePlanned) updates.datePlanned = new Date(body.datePlanned)

    const updated = await r.purchaseOrders.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    if (body.tags) await upsertTags(orgId, 'purchase_order', body.tags)

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      vendorId: t.Optional(t.String()),
      datePlanned: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      exchangeRate: t.Optional(t.Number({ minimum: 0.0001 })),
      lines: t.Optional(t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        uom: t.String(),
        priceUnit: t.Number({ minimum: 0 }),
        taxRate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        warehouseId: t.Optional(t.String()),
        scheduledDate: t.Optional(t.String()),
      }))),
      agreementId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.purchaseOrders.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Purchase order not found' })
    if (existing.state !== 'draft') {
      return status(400, { message: 'Can only delete draft orders' })
    }

    await r.purchaseOrders.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'delete', entityType: 'PurchaseOrder',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { access: { permission: 'purchase.write' } })

  // ── ACTIONS ──

  .post('/:id/send', async ({ params: { orgId, id }, user, status }) => {
    const result = await sendRFQ(id, orgId)
    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'draft', newValue: 'sent' }],
    }).catch(() => {})
    return result
  }, { access: { permission: 'purchase.confirm' } })

  .post('/:id/request-approval', async ({ params: { orgId, id }, user, status }) => {
    const result = await requestApproval(id, orgId)
    return result
  }, { access: { permission: 'purchase.confirm' } })

  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    const result = await approvePurchaseOrder(id, orgId, user.id)
    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'to_approve', newValue: 'confirmed' }],
    }).catch(() => {})
    return result
  }, { access: { permission: 'purchase.approve' } })

  .post('/:id/reject', async ({ params: { orgId, id }, user, status }) => {
    const result = await rejectPurchaseOrder(id, orgId, user.id)
    return result
  }, { access: { permission: 'purchase.approve' } })

  .post('/:id/confirm', async ({ params: { orgId, id }, user, status }) => {
    const result = await confirmPurchaseOrder(id, orgId)
    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'draft', newValue: 'confirmed' }],
    }).catch(() => {})
    return result
  }, { access: { permission: 'purchase.confirm' } })

  .post('/:id/receive', async ({ params: { orgId, id }, body, user, status }) => {
    const result = await recordReceipt(id, orgId, body.lines)
    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'receiptStatus', oldValue: 'pending', newValue: result.receiptStatus }],
    }).catch(() => {})
    return result
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      lines: t.Array(t.Object({
        productId: t.String(),
        qtyReceived: t.Number({ minimum: 0.001 }),
      })),
    }),
  })

  .post('/:id/bill', async ({ params: { orgId, id }, user, status }) => {
    const result = await createBillFromPO(id, orgId)
    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'invoiceStatus', oldValue: 'nothing', newValue: result.invoiceStatus }],
    }).catch(() => {})
    return result
  }, { access: { permission: 'purchase.write' } })

  .post('/:id/cancel', async ({ params: { orgId, id }, user, status }) => {
    const result = await cancelPurchaseOrder(id, orgId)
    createAuditEntry({
      orgId, userId: user.id, module: 'purchase', action: 'update', entityType: 'PurchaseOrder',
      entityId: id, entityName: result.name,
      changes: [{ field: 'state', oldValue: 'draft', newValue: 'cancelled' }],
    }).catch(() => {})
    return result
  }, { access: { permission: 'purchase.write' } })
