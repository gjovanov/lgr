import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'

export const blanketOrderController = new Elysia({ prefix: '/org/:orgId/purchase/agreements' })
  .use(AppAuthService)

  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.state) filter.state = query.state
    if (query.vendorId) filter.vendorId = query.vendorId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const result = await r.blanketOrders.findAll(filter, { page, size, sort: { createdAt: -1 } })

    const vendorIds = new Set<string>()
    for (const item of result.items) {
      if (item.vendorId) vendorIds.add(item.vendorId)
    }
    const vendors = vendorIds.size > 0
      ? await r.contacts.findMany({ id: { $in: [...vendorIds] } } as any)
      : []
    const vendorMap = new Map(vendors.map((v: any) => [v.id, v]))

    return {
      blanketOrders: result.items.map((bo: any) => ({
        ...bo,
        vendor: vendorMap.get(bo.vendorId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'purchase.read' } })

  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const order = await r.blanketOrders.findOne({ id, orgId } as any)
    if (!order) return status(404, { message: 'Blanket order not found' })
    const vendor = order.vendorId ? await r.contacts.findById(order.vendorId) : null
    return { ...order, vendor }
  }, { access: { permission: 'purchase.read' } })

  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()
    const name = await getNextNumber(orgId, 'BA')
    return r.blanketOrders.create({
      orgId,
      name,
      state: 'draft',
      vendorId: body.vendorId,
      dateStart: new Date(body.dateStart),
      dateEnd: new Date(body.dateEnd),
      currency: body.currency || 'EUR',
      lines: (body.lines || []).map((l: any) => ({ ...l, qtyOrdered: 0 })),
      purchaseOrderIds: [],
      notes: body.notes,
      createdBy: user.id,
    } as any)
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      vendorId: t.String(),
      dateStart: t.String(),
      dateEnd: t.String(),
      currency: t.Optional(t.String()),
      lines: t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        priceUnit: t.Number({ minimum: 0 }),
      })),
      notes: t.Optional(t.String()),
    }),
  })

  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.blanketOrders.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Blanket order not found' })
    const updates: any = { ...body }
    if (body.dateStart) updates.dateStart = new Date(body.dateStart)
    if (body.dateEnd) updates.dateEnd = new Date(body.dateEnd)
    const updated = await r.blanketOrders.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })
    return updated
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      vendorId: t.Optional(t.String()),
      dateStart: t.Optional(t.String()),
      dateEnd: t.Optional(t.String()),
      currency: t.Optional(t.String()),
      state: t.Optional(t.String()),
      lines: t.Optional(t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        priceUnit: t.Number({ minimum: 0 }),
      }))),
      notes: t.Optional(t.String()),
    }),
  })

  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.blanketOrders.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Not found' })
    if (existing.state !== 'draft') return status(400, { message: 'Can only delete draft agreements' })
    await r.blanketOrders.delete(id)
    return { message: 'Deleted' }
  }, { access: { permission: 'purchase.write' } })
