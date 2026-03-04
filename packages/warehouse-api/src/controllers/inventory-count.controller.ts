import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { InventoryCount, StockLevel } from 'db/models'
import { inventoryCountDao } from 'services/dao/warehouse/inventory-count.dao'
import { paginateQuery } from 'services/utils/pagination'

export const inventoryCountController = new Elysia({ prefix: '/org/:orgId/warehouse/inventory-count' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    if (query.productId) filter['lines.productId'] = query.productId
    const result = await paginateQuery(InventoryCount, filter, query)
    const populated = await InventoryCount.populate(result.items, [
      { path: 'warehouseId', select: 'name' },
    ])
    const inventoryCounts = populated.map((ic: any) => ({
      ...ic,
      number: ic.countNumber,
      warehouseName: ic.warehouseId?.name || '',
      warehouseId: ic.warehouseId?._id || ic.warehouseId,
      itemCount: ic.lines?.length || 0,
      varianceCount: ic.lines?.filter((l: any) => l.variance !== 0).length || 0,
    }))
    return { inventoryCounts, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const doc = await InventoryCount.findById(params.id).lean().exec()
    if (!doc) return { inventoryCount: null }

    const populated = await InventoryCount.populate(doc, [
      { path: 'lines.productId', select: 'name sku' },
    ])
    const lines = (populated as any).lines.map((l: any) => ({
      ...l,
      productName: l.productId?.name || '',
      productSku: l.productId?.sku || '',
      productId: l.productId?._id || l.productId,
    }))

    return { inventoryCount: { ...populated, lines } }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const countNumber = await inventoryCountDao.getNextCountNumber(params.orgId)
    const item = await inventoryCountDao.create({ ...body, orgId: params.orgId, createdBy: user.id, countNumber })
    return { inventoryCount: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await inventoryCountDao.update(params.id, body)
    return { inventoryCount: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await inventoryCountDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
  .post('/:id/complete', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const doc = await InventoryCount.findOne({ _id: id, orgId }).exec()
    if (!doc) return status(404, { message: 'Inventory count not found' })
    if (doc.status === 'completed') return status(400, { message: 'Already completed' })

    // Update stock levels based on counted quantities
    for (const line of doc.lines) {
      await StockLevel.findOneAndUpdate(
        { orgId, productId: line.productId, warehouseId: doc.warehouseId },
        {
          $set: {
            quantity: line.countedQuantity,
            availableQuantity: line.countedQuantity,
            lastCountDate: new Date(),
          },
        },
        { upsert: true, new: true },
      ).exec()
    }

    doc.status = 'completed'
    doc.completedAt = new Date()
    doc.completedBy = user.id
    await doc.save()

    return { inventoryCount: doc.toJSON() }
  }, { isSignIn: true })
