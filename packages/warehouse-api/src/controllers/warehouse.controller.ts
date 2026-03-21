import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

export const warehouseController = new Elysia({ prefix: '/org/:orgId/warehouse/warehouse' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'code'])
      Object.assign(filter, searchFilter)
    }
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.warehouses.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { warehouses: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const warehouse = await r.warehouses.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'warehouse', entityId: warehouse.id, entityName: (warehouse as any).name })

      // Upsert tags
      if (body.tags?.length) {
        for (const value of body.tags) {
          const existingTag = await r.tags.findOne({ orgId, type: 'warehouse', value } as any)
          if (!existingTag) await r.tags.create({ orgId, type: 'warehouse', value } as any)
        }
      }

      return { warehouse }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        code: t.String({ minLength: 1 }),
        type: t.Union([
          t.Literal('warehouse'),
          t.Literal('store'),
          t.Literal('production'),
          t.Literal('transit'),
        ]),
        address: t.Optional(t.Union([
          t.String(),
          t.Object({
            street: t.Optional(t.String()),
            city: t.Optional(t.String()),
            state: t.Optional(t.String()),
            postalCode: t.Optional(t.String()),
            country: t.Optional(t.String()),
          }),
        ])),
        manager: t.Optional(t.String()),
        managerId: t.Optional(t.String()),
        isDefault: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
        tags: t.Optional(t.Array(t.String())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const warehouse = await r.warehouses.findOne({ id, orgId } as any)
    if (!warehouse) return status(404, { message: 'Warehouse not found' })

    return { warehouse }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.warehouses.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Warehouse not found' })

      const warehouse = await r.warehouses.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'warehouse', entityId: id, entityName: (warehouse as any).name, changes: diffChanges(existing as any, warehouse as any) })

      // Upsert tags
      if (body.tags?.length) {
        for (const value of body.tags) {
          const existingTag = await r.tags.findOne({ orgId, type: 'warehouse', value } as any)
          if (!existingTag) await r.tags.create({ orgId, type: 'warehouse', value } as any)
        }
      }

      return { warehouse }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        code: t.Optional(t.String()),
        type: t.Optional(t.Union([
          t.Literal('warehouse'),
          t.Literal('store'),
          t.Literal('production'),
          t.Literal('transit'),
        ])),
        tags: t.Optional(t.Array(t.String())),
        address: t.Optional(t.Union([
          t.String(),
          t.Object({
            street: t.Optional(t.String()),
            city: t.Optional(t.String()),
            state: t.Optional(t.String()),
            postalCode: t.Optional(t.String()),
            country: t.Optional(t.String()),
          }),
        ])),
        manager: t.Optional(t.String()),
        managerId: t.Optional(t.String()),
        isDefault: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.warehouses.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Warehouse not found' })

    await r.warehouses.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'warehouse', entityType: 'warehouse', entityId: id, entityName: (existing as any).name })

    return { message: 'Warehouse deactivated' }
  }, { isSignIn: true })
