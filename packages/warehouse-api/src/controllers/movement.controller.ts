import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { StockMovement, StockLevel, Warehouse } from 'db/models'
import { stockMovementDao } from 'services/dao/warehouse/stock-movement.dao'
import { paginateQuery } from 'services/utils/pagination'

export const movementController = new Elysia({ prefix: '/org/:orgId/warehouse/movement' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.type) filter.type = query.type
    if (query.status) filter.status = query.status
    if (query.warehouseId) {
      filter.$or = [
        { fromWarehouseId: query.warehouseId },
        { toWarehouseId: query.warehouseId },
      ]
    }
    if (query.productId) {
      const ids = (query.productId as string).split(',').map(id => id.trim()).filter(Boolean)
      filter['lines.productId'] = ids.length === 1 ? ids[0] : { $in: ids }
    }
    if (query.dateFrom || query.dateTo) {
      filter.date = {}
      if (query.dateFrom) filter.date.$gte = new Date(query.dateFrom as string)
      if (query.dateTo) filter.date.$lte = new Date(query.dateTo as string)
    }

    const result = await paginateQuery(StockMovement, filter, query, { sortBy: 'date', sortOrder: 'desc' })
    const populated = await StockMovement.populate(result.items, [
      { path: 'fromWarehouseId', select: 'name' },
      { path: 'toWarehouseId', select: 'name' },
      { path: 'contactId', select: 'companyName firstName lastName' },
    ])
    const stockMovements = populated.map((m: any) => {
      const contact = m.contactId
      let contactName = ''
      if (contact && typeof contact === 'object') {
        contactName = contact.companyName || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || ''
      }
      return {
        ...m,
        number: m.movementNumber,
        total: m.totalAmount,
        fromWarehouseName: m.fromWarehouseId?.name || '',
        toWarehouseName: m.toWarehouseId?.name || '',
        contactName,
        fromWarehouseId: m.fromWarehouseId?._id || m.fromWarehouseId,
        toWarehouseId: m.toWarehouseId?._id || m.toWarehouseId,
        contactId: contact?._id || m.contactId,
      }
    })
    return { stockMovements, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const movementNumber = body.movementNumber || await stockMovementDao.getNextMovementNumber(orgId)

      const movement = await StockMovement.create({
        ...body,
        orgId,
        movementNumber,
        status: 'draft',
        createdBy: user.id,
      })

      return { stockMovement: movement.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        movementNumber: t.Optional(t.String()),
        type: t.Union([
          t.Literal('receipt'),
          t.Literal('dispatch'),
          t.Literal('transfer'),
          t.Literal('adjustment'),
          t.Literal('return'),
          t.Literal('production_in'),
          t.Literal('production_out'),
        ]),
        date: t.String(),
        fromWarehouseId: t.Optional(t.String()),
        toWarehouseId: t.Optional(t.String()),
        contactId: t.Optional(t.String()),
        invoiceId: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unitCost: t.Number({ minimum: 0 }),
          totalCost: t.Number({ minimum: 0 }),
          batchNumber: t.Optional(t.String()),
          serialNumbers: t.Optional(t.Array(t.String())),
        })),
        totalAmount: t.Number(),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const movement = await StockMovement.findOne({ _id: id, orgId }).lean().exec()
    if (!movement) return status(404, { message: 'Stock movement not found' })

    const populated = await StockMovement.populate(movement, [
      { path: 'lines.productId', select: 'name sku' },
    ])
    const lines = (populated as any).lines.map((l: any) => ({
      ...l,
      productName: l.productId?.name || '',
      productSku: l.productId?.sku || '',
      productId: l.productId?._id || l.productId,
    }))

    return { stockMovement: { ...populated, lines } }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const existing = await StockMovement.findOne({ _id: id, orgId }).exec()
      if (!existing) return status(404, { message: 'Stock movement not found' })
      if (existing.status !== 'draft') return status(400, { message: 'Can only edit draft movements' })

      const updated = await StockMovement.findByIdAndUpdate(id, body, { new: true }).lean().exec()
      return { stockMovement: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        date: t.Optional(t.String()),
        fromWarehouseId: t.Optional(t.String()),
        toWarehouseId: t.Optional(t.String()),
        lines: t.Optional(t.Array(t.Object({
          productId: t.String(),
          quantity: t.Number({ minimum: 0 }),
          unitCost: t.Number({ minimum: 0 }),
          totalCost: t.Number({ minimum: 0 }),
          batchNumber: t.Optional(t.String()),
          serialNumbers: t.Optional(t.Array(t.String())),
        }))),
        totalAmount: t.Optional(t.Number()),
        notes: t.Optional(t.String()),
      }),
    },
  )
  .post('/:id/confirm', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const movement = await StockMovement.findOne({ _id: id, orgId }).exec()
    if (!movement) return status(404, { message: 'Stock movement not found' })
    if (movement.status !== 'draft') return status(400, { message: 'Movement is not in draft status' })

    // Update stock levels
    for (const line of movement.lines) {
      // Decrease from source warehouse
      if (movement.fromWarehouseId) {
        await StockLevel.findOneAndUpdate(
          { orgId, productId: line.productId, warehouseId: movement.fromWarehouseId },
          { $inc: { quantity: -line.quantity, availableQuantity: -line.quantity } },
          { upsert: true, new: true },
        ).exec()
      }

      // Increase in destination warehouse
      if (movement.toWarehouseId) {
        await StockLevel.findOneAndUpdate(
          { orgId, productId: line.productId, warehouseId: movement.toWarehouseId },
          { $inc: { quantity: line.quantity, availableQuantity: line.quantity } },
          { upsert: true, new: true },
        ).exec()
      }
    }

    movement.status = 'confirmed'
    await movement.save()

    return { stockMovement: movement.toJSON() }
  }, { isSignIn: true })
