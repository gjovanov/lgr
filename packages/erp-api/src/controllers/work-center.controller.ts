import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const workCenterController = new Elysia({ prefix: '/org/:orgId/erp/work-centers' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'code'])
      Object.assign(filter, searchFilter)
    }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.workCenters.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { workCenters: result.items, ...result }
  }, { access: { permission: 'erp.read' } })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      const r = getRepos()

      const workCenter = await r.workCenters.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'work_center', entityId: workCenter.id, entityName: (workCenter as any).name })

      return { workCenter }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        name: t.String({ minLength: 1 }),
        code: t.String({ minLength: 1 }),
        capacity: t.Optional(t.Number({ minimum: 0 })),
        costPerHour: t.Optional(t.Number({ minimum: 0 })),
        setupTime: t.Optional(t.Number({ minimum: 0 })),
        cleanupTime: t.Optional(t.Number({ minimum: 0 })),
        isActive: t.Optional(t.Boolean()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const workCenter = await r.workCenters.findOne({ id, orgId } as any)
    if (!workCenter) return status(404, { message: 'Work center not found' })

    return { workCenter }
  }, { access: { permission: 'erp.read' } })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      const r = getRepos()

      const existing = await r.workCenters.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Work center not found' })

      const workCenter = await r.workCenters.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'work_center', entityId: id, entityName: (workCenter as any).name, changes: diffChanges(existing as any, workCenter as any) })

      return { workCenter }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        name: t.Optional(t.String()),
        code: t.Optional(t.String()),
        capacity: t.Optional(t.Number({ minimum: 0 })),
        costPerHour: t.Optional(t.Number({ minimum: 0 })),
        setupTime: t.Optional(t.Number({ minimum: 0 })),
        cleanupTime: t.Optional(t.Number({ minimum: 0 })),
        isActive: t.Optional(t.Boolean()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.workCenters.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Work center not found' })

    await r.workCenters.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'work_center', entityId: id, entityName: (existing as any).name })

    return { message: 'Work center deleted' }
  }, { access: { permission: 'erp.write' } })
