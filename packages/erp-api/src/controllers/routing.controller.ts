import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const routingController = new Elysia({ prefix: '/org/:orgId/erp/routings' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name'])
      Object.assign(filter, searchFilter)
    }
    if (query.productId) filter.productId = query.productId
    if (query.bomId) filter.bomId = query.bomId
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.routings.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { routings: result.items, ...result }
  }, { access: { permission: 'erp.read' } })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      const r = getRepos()

      // Validate that each step's workCenterId exists
      for (const step of body.steps) {
        const wc = await r.workCenters.findOne({ id: step.workCenterId, orgId } as any)
        if (!wc) return status(400, { message: `Work center ${step.workCenterId} not found` })
      }

      const routing = await r.routings.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'routing', entityId: routing.id, entityName: (routing as any).name })

      return { routing }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        name: t.String({ minLength: 1 }),
        productId: t.Optional(t.String()),
        bomId: t.Optional(t.String()),
        steps: t.Array(t.Object({
          sequence: t.Number({ minimum: 1 }),
          name: t.String({ minLength: 1 }),
          workCenterId: t.String(),
          durationMinutes: t.Number({ minimum: 0 }),
          description: t.Optional(t.String()),
        })),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const routing = await r.routings.findOne({ id, orgId } as any)
    if (!routing) return status(404, { message: 'Routing not found' })

    return { routing }
  }, { access: { permission: 'erp.read' } })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      const r = getRepos()

      const existing = await r.routings.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Routing not found' })

      // Validate work centers if steps are being updated
      if (body.steps) {
        for (const step of body.steps) {
          const wc = await r.workCenters.findOne({ id: step.workCenterId, orgId } as any)
          if (!wc) return status(400, { message: `Work center ${step.workCenterId} not found` })
        }
      }

      const routing = await r.routings.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'routing', entityId: id, entityName: (routing as any).name, changes: diffChanges(existing as any, routing as any) })

      return { routing }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        name: t.Optional(t.String()),
        productId: t.Optional(t.String()),
        bomId: t.Optional(t.String()),
        steps: t.Optional(t.Array(t.Object({
          sequence: t.Number({ minimum: 1 }),
          name: t.String({ minLength: 1 }),
          workCenterId: t.String(),
          durationMinutes: t.Number({ minimum: 0 }),
          description: t.Optional(t.String()),
        }))),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.routings.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Routing not found' })

    await r.routings.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'routing', entityId: id, entityName: (existing as any).name })

    return { message: 'Routing deleted' }
  }, { access: { permission: 'erp.write' } })
