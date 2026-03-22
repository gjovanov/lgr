import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const reorderRuleController = new Elysia({ prefix: '/org/:orgId/purchase/reorder-rules' })
  .use(AppAuthService)

  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.productId) filter.productId = query.productId
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 50
    const result = await r.reorderRules.findAll(filter, { page, size, sort: { createdAt: -1 } })
    return { reorderRules: result.items, total: result.total, page: result.page, pageSize: result.size }
  }, { access: { permission: 'purchase.read' } })

  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const rule = await r.reorderRules.findOne({ id, orgId } as any)
    if (!rule) return status(404, { message: 'Reorder rule not found' })
    return rule
  }, { access: { permission: 'purchase.read' } })

  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()
    return r.reorderRules.create({ orgId, ...body, isActive: true } as any)
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      productId: t.String(),
      warehouseId: t.String(),
      minQty: t.Number({ minimum: 0 }),
      maxQty: t.Number({ minimum: 0 }),
      multipleQty: t.Optional(t.Number({ minimum: 0.001 })),
      leadTimeDays: t.Number({ minimum: 0 }),
      vendorId: t.Optional(t.String()),
    }),
  })

  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.reorderRules.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Reorder rule not found' })
    const updated = await r.reorderRules.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })
    return updated
  }, {
    access: { permission: 'purchase.write' },
    body: t.Object({
      minQty: t.Optional(t.Number({ minimum: 0 })),
      maxQty: t.Optional(t.Number({ minimum: 0 })),
      multipleQty: t.Optional(t.Number({ minimum: 0.001 })),
      leadTimeDays: t.Optional(t.Number({ minimum: 0 })),
      vendorId: t.Optional(t.String()),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.reorderRules.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Reorder rule not found' })
    await r.reorderRules.delete(id)
    return { message: 'Deleted' }
  }, { access: { permission: 'purchase.write' } })
