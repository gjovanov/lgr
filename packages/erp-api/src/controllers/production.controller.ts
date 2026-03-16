import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

// BOM controller
export const bomController = new Elysia({ prefix: '/org/:orgId/erp/bom' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.productId) filter.productId = query.productId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.billOfMaterials.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { boms: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const bom = await r.billOfMaterials.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'bom', entityId: bom.id, entityName: (bom as any).name })

      return { bom }
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
    const r = getRepos()

    const bom = await r.billOfMaterials.findOne({ id, orgId } as any)
    if (!bom) return status(404, { message: 'BOM not found' })

    return { bom }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.billOfMaterials.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'BOM not found' })

      const bom = await r.billOfMaterials.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'bom', entityId: id, entityName: (bom as any).name, changes: diffChanges(existing as any, bom as any) })

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
    const r = getRepos()

    const existing = await r.billOfMaterials.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'BOM not found' })

    await r.billOfMaterials.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'bom', entityId: id, entityName: (existing as any).name })

    return { message: 'BOM deleted' }
  }, { isSignIn: true })

// Production Order controller
export const productionOrderController = new Elysia({ prefix: '/org/:orgId/erp/production-order' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.productId) filter.productId = query.productId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'plannedStartDate'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.productionOrders.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { productionOrders: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Generate next order number if not provided
      let orderNumber = body.orderNumber
      if (!orderNumber) {
        const year = new Date().getFullYear()
        const prefix = `PRD-${year}-`
        const latest = await r.productionOrders.findAll(
          { orgId, orderNumber: { $regex: `^${prefix}` } } as any,
          { page: 0, size: 1, sort: { orderNumber: -1 } },
        )
        if (latest.items.length === 0) {
          orderNumber = `${prefix}00001`
        } else {
          const currentNum = parseInt((latest.items[0] as any).orderNumber.replace(prefix, ''), 10)
          orderNumber = `${prefix}${String(currentNum + 1).padStart(5, '0')}`
        }
      }

      const order = await r.productionOrders.create({
        ...body,
        orgId,
        orderNumber,
        status: 'planned',
        createdBy: user.id,
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'erp', entityType: 'production_order', entityId: order.id, entityName: orderNumber })

      return { productionOrder: order }
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
    const r = getRepos()

    const order = await r.productionOrders.findOne({ id, orgId } as any)
    if (!order) return status(404, { message: 'Production order not found' })

    // Manual batch lookup for bom and product
    if ((order as any).bomId) {
      const bom = await r.billOfMaterials.findById((order as any).bomId)
      if (bom) {
        ;(order as any).bomId = {
          _id: bom.id,
          id: bom.id,
          name: (bom as any).name,
          version: (bom as any).version,
        }
      }
    }
    if ((order as any).productId) {
      const product = await r.products.findById((order as any).productId)
      if (product) {
        ;(order as any).productId = {
          _id: product.id,
          id: product.id,
          name: (product as any).name,
          sku: (product as any).sku,
        }
      }
    }

    return { productionOrder: order }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.productionOrders.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Production order not found' })
      if (['completed', 'cancelled'].includes(existing.status))
        return status(400, { message: 'Cannot edit completed or cancelled orders' })

      const updated = await r.productionOrders.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'erp', entityType: 'production_order', entityId: id, entityName: (existing as any).orderNumber, changes: diffChanges(existing as any, updated as any) })

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
    const r = getRepos()

    const order = await r.productionOrders.findOne({ id, orgId } as any)
    if (!order) return status(404, { message: 'Production order not found' })
    if (order.status !== 'planned')
      return status(400, { message: 'Can only delete planned orders' })

    await r.productionOrders.delete(id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'erp', entityType: 'production_order', entityId: id, entityName: (order as any).orderNumber })

    return { message: 'Production order deleted' }
  }, { isSignIn: true })
