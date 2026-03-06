import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { InventoryCount, StockLevel, StockMovement } from 'db/models'
import { inventoryCountDao } from 'services/dao/warehouse/inventory-count.dao'
import { stockMovementDao } from 'services/dao/warehouse/stock-movement.dao'
import { confirmMovement } from 'services/biz/warehouse.service'
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

    // Build adjustment lines for products with non-zero variance
    const adjustmentLines = doc.lines
      .filter(line => line.variance !== 0)
      .map(line => {
        // Get current avg cost for the unit cost
        const absCost = line.varianceCost !== 0 && line.variance !== 0
          ? Math.abs(line.varianceCost / line.variance)
          : 0
        return {
          productId: line.productId,
          quantity: Math.abs(line.variance),
          unitCost: absCost,
          totalCost: Math.abs(line.varianceCost),
        }
      })

    if (adjustmentLines.length > 0) {
      // Create an adjustment stock movement
      const movementNumber = await stockMovementDao.getNextMovementNumber(orgId)
      const totalAmount = adjustmentLines.reduce((s, l) => s + l.totalCost, 0)

      // Determine direction: if net variance is positive (more counted than system), it's a receipt-like adjustment
      // We use 'adjustment' type which adjustStock handles based on fromWarehouseId/toWarehouseId
      const netVariance = doc.lines.reduce((s, l) => s + l.variance, 0)

      const movement = await StockMovement.create({
        orgId,
        movementNumber,
        type: 'adjustment',
        status: 'draft',
        date: new Date(),
        // For adjustments: toWarehouseId means stock goes in, fromWarehouseId means stock goes out
        // We handle each line individually via separate movements if needed
        // Simple approach: create per-line adjustments as positive/negative
        toWarehouseId: doc.warehouseId,
        lines: doc.lines
          .filter(l => l.variance !== 0)
          .map(l => {
            const absCost = l.varianceCost !== 0 && l.variance !== 0
              ? Math.abs(l.varianceCost / l.variance)
              : 0
            return {
              productId: l.productId,
              quantity: l.variance, // signed: positive = surplus, negative = shortage
              unitCost: absCost,
              totalCost: Math.abs(l.varianceCost),
            }
          }),
        totalAmount,
        notes: `Inventory count adjustment for ${doc.countNumber}`,
        createdBy: user.id,
      })

      // Confirm the movement to update stock levels
      await confirmMovement(String(movement._id))

      doc.adjustmentMovementId = movement._id
    } else {
      // No variance — just update lastCountDate
      for (const line of doc.lines) {
        await StockLevel.findOneAndUpdate(
          { orgId, productId: line.productId, warehouseId: doc.warehouseId },
          { $set: { lastCountDate: new Date() } },
          { upsert: false },
        ).exec()
      }
    }

    doc.status = 'completed'
    doc.completedAt = new Date()
    doc.completedBy = user.id
    await doc.save()

    return { inventoryCount: doc.toJSON() }
  }, { isSignIn: true })
