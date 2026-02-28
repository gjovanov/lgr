import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { Warehouse } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const warehouseController = new Elysia({ prefix: '/org/:orgId/warehouse/warehouse' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(Warehouse, filter, query, { sortBy: 'name', sortOrder: 'asc' })
    return { warehouses: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const warehouse = await Warehouse.create({ ...body, orgId })
      return { warehouse: warehouse.toJSON() }
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
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const warehouse = await Warehouse.findOne({ _id: id, orgId }).lean().exec()
    if (!warehouse) return status(404, { message: 'Warehouse not found' })

    return { warehouse }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const warehouse = await Warehouse.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!warehouse) return status(404, { message: 'Warehouse not found' })

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

    const warehouse = await Warehouse.findOneAndUpdate(
      { _id: id, orgId },
      { isActive: false },
      { new: true },
    ).exec()
    if (!warehouse) return status(404, { message: 'Warehouse not found' })

    return { message: 'Warehouse deactivated' }
  }, { isSignIn: true })
