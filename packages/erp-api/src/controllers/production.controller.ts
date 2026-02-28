import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { BillOfMaterials, ProductionOrder } from 'db/models'
import { productionOrderDao } from 'services/dao/erp/production-order.dao'
import { paginateQuery } from 'services/utils/pagination'

// BOM controller
export const bomController = new Elysia({ prefix: '/org/:orgId/erp/bom' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.productId) filter.productId = query.productId

    const result = await paginateQuery(BillOfMaterials, filter, query, { sortBy: 'name', sortOrder: 'asc' })
    return { boms: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const bom = await BillOfMaterials.create({ ...body, orgId })
      return { bom: bom.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        productId: t.String(),
        name: t.String({ minLength: 1 }),
        version: t.String({ minLength: 1 }),
        materials: t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unit: t.String(),
          wastagePercent: t.Optional(t.Number()),
          cost: t.Number({ minimum: 0 }),
          notes: t.Optional(t.String()),
        })),
        laborHours: t.Number({ minimum: 0 }),
        laborCostPerHour: t.Number({ minimum: 0 }),
        overheadCost: t.Optional(t.Number()),
        totalMaterialCost: t.Number(),
        totalCost: t.Number(),
        instructions: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const bom = await BillOfMaterials.findOne({ _id: id, orgId }).lean().exec()
    if (!bom) return status(404, { message: 'BOM not found' })

    return { bom }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const bom = await BillOfMaterials.findOneAndUpdate(
        { _id: id, orgId },
        body,
        { new: true },
      ).lean().exec()
      if (!bom) return status(404, { message: 'BOM not found' })

      return { bom }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        version: t.Optional(t.String()),
        status: t.Optional(t.Union([
          t.Literal('draft'),
          t.Literal('active'),
          t.Literal('obsolete'),
        ])),
        materials: t.Optional(t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unit: t.String(),
          wastagePercent: t.Optional(t.Number()),
          cost: t.Number({ minimum: 0 }),
          notes: t.Optional(t.String()),
        }))),
        laborHours: t.Optional(t.Number()),
        laborCostPerHour: t.Optional(t.Number()),
        overheadCost: t.Optional(t.Number()),
        totalMaterialCost: t.Optional(t.Number()),
        totalCost: t.Optional(t.Number()),
        instructions: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const bom = await BillOfMaterials.findOneAndDelete({ _id: id, orgId }).exec()
    if (!bom) return status(404, { message: 'BOM not found' })

    return { message: 'BOM deleted' }
  }, { isSignIn: true })

// Production Order controller
export const productionOrderController = new Elysia({ prefix: '/org/:orgId/erp/production-order' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.productId) filter.productId = query.productId

    const result = await paginateQuery(ProductionOrder, filter, query, { sortBy: 'plannedStartDate', sortOrder: 'desc' })
    return { productionOrders: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const orderNumber = body.orderNumber || await productionOrderDao.getNextOrderNumber(orgId)

      const order = await ProductionOrder.create({
        ...body,
        orgId,
        orderNumber,
        status: 'planned',
        createdBy: user.id,
      })

      return { productionOrder: order.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        orderNumber: t.Optional(t.String()),
        bomId: t.String(),
        productId: t.String(),
        quantity: t.Number({ minimum: 1 }),
        warehouseId: t.String(),
        outputWarehouseId: t.String(),
        priority: t.Optional(t.Union([
          t.Literal('low'),
          t.Literal('normal'),
          t.Literal('high'),
          t.Literal('urgent'),
        ])),
        plannedStartDate: t.String(),
        plannedEndDate: t.String(),
        stages: t.Optional(t.Array(t.Object({
          name: t.String(),
          order: t.Number(),
          plannedDuration: t.Number(),
        }))),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const order = await ProductionOrder.findOne({ _id: id, orgId })
      .populate('bomId', 'name version')
      .populate('productId', 'name sku')
      .lean()
      .exec()
    if (!order) return status(404, { message: 'Production order not found' })

    return { productionOrder: order }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const existing = await ProductionOrder.findOne({ _id: id, orgId }).exec()
      if (!existing) return status(404, { message: 'Production order not found' })
      if (['completed', 'cancelled'].includes(existing.status))
        return status(400, { message: 'Cannot edit completed or cancelled orders' })

      const updated = await ProductionOrder.findByIdAndUpdate(id, body, { new: true }).lean().exec()
      return { productionOrder: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        quantity: t.Optional(t.Number()),
        priority: t.Optional(t.Union([
          t.Literal('low'),
          t.Literal('normal'),
          t.Literal('high'),
          t.Literal('urgent'),
        ])),
        status: t.Optional(t.Union([
          t.Literal('planned'),
          t.Literal('in_progress'),
          t.Literal('quality_check'),
          t.Literal('completed'),
          t.Literal('cancelled'),
        ])),
        plannedStartDate: t.Optional(t.String()),
        plannedEndDate: t.Optional(t.String()),
        actualStartDate: t.Optional(t.String()),
        actualEndDate: t.Optional(t.String()),
        quantityProduced: t.Optional(t.Number()),
        quantityDefective: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const order = await ProductionOrder.findOne({ _id: id, orgId }).exec()
    if (!order) return status(404, { message: 'Production order not found' })
    if (order.status !== 'planned')
      return status(400, { message: 'Can only delete planned orders' })

    await ProductionOrder.findByIdAndDelete(id).exec()
    return { message: 'Production order deleted' }
  }, { isSignIn: true })
