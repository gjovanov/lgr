import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { becomesExternal, externalScope, externalWarehouseRefusal, flagsAfterSave, holdsStockRefusal, inUseRefusal } from 'config/external-warehouse'
import { articlesHeldAt, liveUsesOf } from 'services/biz/external-warehouses'

export const warehouseController = new Elysia({ prefix: '/org/:orgId/warehouse/warehouse' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'code'], {
        lowered: { name: 'nameLower', code: 'codeLower' },
      })
      Object.assign(filter, searchFilter)
    }
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }
    // ⚠ Without `external` the list answers the warehouses that keep stock. Every picker in every app
    // lists warehouses through this route, and none of them may offer an external one: a document
    // booked there moves nothing. `external=include` answers all (the Warehouses page, the movement
    // form and the movements filter), `external=only` the external ones.
    const scope = externalScope(query.external)
    if (scope === 'own') filter.isExternal = { $ne: true }
    else if (scope === 'only') filter.isExternal = true

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

      const misfit = externalWarehouseRefusal(body)
      if (misfit) return status(422, misfit)

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
        isExternal: t.Optional(t.Boolean()),
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

      // The warehouse as it would stand after this save: either flag may be the one that changes.
      const next = flagsAfterSave(existing, body)
      const misfit = externalWarehouseRefusal(next)
      if (misfit) return status(422, misfit)
      // Becoming external is the one change that needs it empty, and named by nothing live (#779);
      // the way back is always open.
      if (becomesExternal(existing, next)) {
        const holds = holdsStockRefusal(await articlesHeldAt(orgId, id))
        if (holds) return status(422, holds)
        const inUse = inUseRefusal(await liveUsesOf(orgId, id))
        if (inUse) return status(422, inUse)
      }

      const warehouse = await r.warehouses.updateInOrg(id, orgId, body as any)

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
        isExternal: t.Optional(t.Boolean()),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.warehouses.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Warehouse not found' })

    await r.warehouses.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'warehouse', entityType: 'warehouse', entityId: id, entityName: (existing as any).name })

    return { message: 'Warehouse deactivated' }
  }, { isSignIn: true })
