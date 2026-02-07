import { StockLevel, StockMovement, Product, type IStockMovement } from 'db/models'
import { logger } from '../logger/logger.js'

export async function confirmMovement(movementId: string): Promise<IStockMovement> {
  const movement = await StockMovement.findById(movementId)
  if (!movement) throw new Error('Stock movement not found')
  if (movement.status !== 'draft') throw new Error('Only draft movements can be confirmed')

  const orgId = String(movement.orgId)

  for (const line of movement.lines) {
    const productId = String(line.productId)

    // Reduce stock from source warehouse
    if (movement.fromWarehouseId) {
      await adjustStock(
        orgId,
        productId,
        String(movement.fromWarehouseId),
        -line.quantity,
        line.unitCost,
      )
    }

    // Add stock to destination warehouse
    if (movement.toWarehouseId) {
      await adjustStock(
        orgId,
        productId,
        String(movement.toWarehouseId),
        line.quantity,
        line.unitCost,
      )
    }
  }

  movement.status = 'completed'
  await movement.save()

  logger.info({ movementId, type: movement.type }, 'Stock movement confirmed')
  return movement
}

export async function adjustStock(
  orgId: string,
  productId: string,
  warehouseId: string,
  quantity: number,
  unitCost: number,
): Promise<void> {
  let stockLevel = await StockLevel.findOne({ orgId, productId, warehouseId })

  if (!stockLevel) {
    stockLevel = await StockLevel.create({
      orgId,
      productId,
      warehouseId,
      quantity: 0,
      reservedQuantity: 0,
      availableQuantity: 0,
      avgCost: unitCost,
    })
  }

  // Weighted average cost
  if (quantity > 0 && stockLevel.quantity > 0) {
    const totalCost = stockLevel.quantity * stockLevel.avgCost + quantity * unitCost
    stockLevel.avgCost = totalCost / (stockLevel.quantity + quantity)
  } else if (quantity > 0) {
    stockLevel.avgCost = unitCost
  }

  stockLevel.quantity += quantity
  stockLevel.availableQuantity = stockLevel.quantity - stockLevel.reservedQuantity
  await stockLevel.save()
}

export async function getStockValuation(orgId: string): Promise<{
  items: { productId: string; name: string; totalQty: number; avgCost: number; totalValue: number }[]
  totalValue: number
}> {
  const levels = await StockLevel.find({ orgId }).exec()
  const productIds = [...new Set(levels.map(l => String(l.productId)))]
  const products = await Product.find({ _id: { $in: productIds } }).exec()
  const productMap = new Map(products.map(p => [String(p._id), p]))

  const aggregated = new Map<string, { qty: number; value: number }>()

  for (const level of levels) {
    const key = String(level.productId)
    const current = aggregated.get(key) || { qty: 0, value: 0 }
    current.qty += level.quantity
    current.value += level.quantity * level.avgCost
    aggregated.set(key, current)
  }

  const items = [...aggregated.entries()].map(([productId, data]) => ({
    productId,
    name: productMap.get(productId)?.name || 'Unknown',
    totalQty: data.qty,
    avgCost: data.qty > 0 ? data.value / data.qty : 0,
    totalValue: data.value,
  }))

  const totalValue = items.reduce((sum, i) => sum + i.totalValue, 0)
  return { items, totalValue }
}
