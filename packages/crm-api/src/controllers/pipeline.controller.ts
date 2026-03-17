import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const pipelineController = new Elysia({ prefix: '/org/:orgId/crm/pipeline' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.pipelines.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { pipelines: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'manager'].includes(user.role))
        return status(403, { message: 'Admin or manager only' })
      const r = getRepos()

      const pipeline = await r.pipelines.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'crm', entityType: 'pipeline', entityId: pipeline.id, entityName: (pipeline as any).name })

      return { pipeline }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        stages: t.Array(t.Object({
          name: t.String({ minLength: 1 }),
          order: t.Number(),
          probability: t.Number({ minimum: 0, maximum: 100 }),
          color: t.String(),
        })),
        isDefault: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const pipeline = await r.pipelines.findOne({ id, orgId } as any)
    if (!pipeline) return status(404, { message: 'Pipeline not found' })

    return { pipeline }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!['admin', 'manager'].includes(user.role))
        return status(403, { message: 'Admin or manager only' })
      const r = getRepos()

      const existing = await r.pipelines.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Pipeline not found' })

      const pipeline = await r.pipelines.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'crm', entityType: 'pipeline', entityId: id, entityName: (pipeline as any).name, changes: diffChanges(existing as any, pipeline as any) })

      return { pipeline }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        stages: t.Optional(t.Array(t.Object({
          name: t.String({ minLength: 1 }),
          order: t.Number(),
          probability: t.Number({ minimum: 0, maximum: 100 }),
          color: t.String(),
        }))),
        isDefault: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'manager'].includes(user.role))
      return status(403, { message: 'Admin or manager only' })
    const r = getRepos()

    const existing = await r.pipelines.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Pipeline not found' })

    await r.pipelines.update(id, { isActive: false } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'crm', entityType: 'pipeline', entityId: id, entityName: (existing as any).name })

    return { message: 'Pipeline deactivated' }
  }, { isSignIn: true })
