import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { RestaurantFloor } from 'db/models'

export const restaurantFloorController = new Elysia({ prefix: '/org/:orgId/erp/restaurant/floors' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name'])
      Object.assign(filter, searchFilter)
    }
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true'

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(query.size !== undefined ? Number(query.size) : 10, 1000)
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.restaurantFloors.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { floors: result.items, ...result }
  }, { access: { permission: 'erp.read' } })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      const r = getRepos()

      const floor = await r.restaurantFloors.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'restaurant_floor', entityId: floor.id, entityName: (floor as any).name })

      return { floor }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        name: t.String({ minLength: 1 }),
        tables: t.Optional(t.Array(t.Object({
          number: t.Number({ minimum: 1 }),
          name: t.String({ minLength: 1 }),
          seats: t.Number({ minimum: 1 }),
          positionX: t.Optional(t.Number()),
          positionY: t.Optional(t.Number()),
          shape: t.Optional(t.Union([
            t.Literal('square'),
            t.Literal('round'),
            t.Literal('rectangle'),
          ])),
          state: t.Optional(t.Union([
            t.Literal('available'),
            t.Literal('occupied'),
            t.Literal('reserved'),
          ])),
        }))),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const floor = await r.restaurantFloors.findOne({ id, orgId } as any)
    if (!floor) return status(404, { message: 'Floor not found' })

    return { floor }
  }, { access: { permission: 'erp.read' } })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      const r = getRepos()

      const existing = await r.restaurantFloors.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Floor not found' })

      const floor = await r.restaurantFloors.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'restaurant_floor', entityId: id, entityName: (floor as any).name, changes: diffChanges(existing as any, floor as any) })

      return { floor }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        name: t.Optional(t.String()),
        tables: t.Optional(t.Array(t.Object({
          number: t.Number({ minimum: 1 }),
          name: t.String({ minLength: 1 }),
          seats: t.Number({ minimum: 1 }),
          positionX: t.Optional(t.Number()),
          positionY: t.Optional(t.Number()),
          shape: t.Optional(t.Union([
            t.Literal('square'),
            t.Literal('round'),
            t.Literal('rectangle'),
          ])),
          state: t.Optional(t.Union([
            t.Literal('available'),
            t.Literal('occupied'),
            t.Literal('reserved'),
          ])),
        }))),
        isActive: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.restaurantFloors.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Floor not found' })

    await r.restaurantFloors.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'restaurant_floor', entityId: id, entityName: (existing as any).name })

    return { message: 'Floor deleted' }
  }, { access: { permission: 'erp.write' } })

  // Update single table state
  .put(
    '/:id/table/:tableNumber',
    async ({ params: { orgId, id, tableNumber }, body, user, status }) => {
      const tblNum = Number(tableNumber)
      const floor = await RestaurantFloor.findOneAndUpdate(
        { _id: id, orgId, 'tables.number': tblNum },
        { $set: { 'tables.$.state': body.state, ...(body.currentOrderId ? { 'tables.$.currentOrderId': body.currentOrderId } : {}) } },
        { new: true },
      ).exec()

      if (!floor) return status(404, { message: 'Floor or table not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'restaurant_floor', entityId: id, entityName: `${floor.name} / Table ${tblNum}`, changes: [{ field: 'table.state', oldValue: '', newValue: body.state }] })

      return { floor }
    },
    {
      access: { permission: 'erp.write' },
      body: t.Object({
        state: t.Union([
          t.Literal('available'),
          t.Literal('occupied'),
          t.Literal('reserved'),
        ]),
        currentOrderId: t.Optional(t.String()),
      }),
    },
  )
