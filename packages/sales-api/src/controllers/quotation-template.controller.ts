import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { buildSearchFilter } from 'services/biz/search.utils'

export const quotationTemplateController = new Elysia({ prefix: '/org/:orgId/sales/templates' })
  .use(AppAuthService)

  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.read')) {
      return status(403, { message: 'Forbidden: sales.read permission required' })
    }
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) Object.assign(filter, buildSearchFilter(query.search as string, ['name']))
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 50
    const result = await r.quotationTemplates.findAll(filter, { page, size, sort: { name: 1 } })
    return { templates: result.items, total: result.total, page: result.page, pageSize: result.size }
  }, { isSignIn: true })

  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.read')) {
      return status(403, { message: 'Forbidden: sales.read permission required' })
    }
    const r = getRepos()
    const template = await r.quotationTemplates.findOne({ id, orgId } as any)
    if (!template) return status(404, { message: 'Template not found' })
    return template
  }, { isSignIn: true })

  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const r = getRepos()
    return r.quotationTemplates.create({ orgId, ...body } as any)
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.String(),
      lines: t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        discount: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
      })),
      optionalProductIds: t.Optional(t.Array(t.String())),
      notes: t.Optional(t.String()),
      termsAndConditions: t.Optional(t.String()),
      validityDays: t.Optional(t.Number({ minimum: 0 })),
    }),
  })

  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const r = getRepos()
    const existing = await r.quotationTemplates.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Template not found' })
    const updated = await r.quotationTemplates.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })
    return updated
  }, {
    isSignIn: true,
    body: t.Object({
      name: t.Optional(t.String()),
      lines: t.Optional(t.Array(t.Object({
        productId: t.Optional(t.String()),
        name: t.String(),
        quantity: t.Number({ minimum: 0.001 }),
        discount: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
      }))),
      optionalProductIds: t.Optional(t.Array(t.String())),
      notes: t.Optional(t.String()),
      termsAndConditions: t.Optional(t.String()),
      validityDays: t.Optional(t.Number({ minimum: 0 })),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('sales.write')) {
      return status(403, { message: 'Forbidden: sales.write permission required' })
    }
    const r = getRepos()
    const existing = await r.quotationTemplates.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Template not found' })
    await r.quotationTemplates.delete(id)
    return { message: 'Deleted' }
  }, { isSignIn: true })
