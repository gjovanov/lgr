import type { RepositoryRegistry } from 'dal'
import type { IStockMovement } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

export async function confirmMovement(movementId: string, repos?: RepositoryRegistry): Promise<IStockMovement> {
  const r = repos ?? getRepos()
  const movement = await r.stockMovements.findById(movementId)
  if (!movement) throw new Error('Stock movement not found')
  if (movement.status !== 'draft') throw new Error('Only draft movements can be confirmed')

  const orgId = movement.orgId

  for (const line of movement.lines) {
    const productId = line.productId

    // Reduce stock from source warehouse
    if (movement.fromWarehouseId) {
      await adjustStock(orgId, productId, movement.fromWarehouseId, -line.quantity, line.unitCost, r)
    }

    // Add stock to destination warehouse
    if (movement.toWarehouseId) {
      await adjustStock(orgId, productId, movement.toWarehouseId, line.quantity, line.unitCost, r)
    }
  }

  const updated = await r.stockMovements.update(movementId, { status: 'completed' } as any)
  if (!updated) throw new Error('Failed to update movement status')

  logger.info({ movementId, type: movement.type }, 'Stock movement confirmed')
  return updated
}

export async function adjustStock(
  orgId: string,
  productId: string,
  warehouseId: string,
  quantity: number,
  unitCost: number,
  repos?: RepositoryRegistry,
): Promise<void> {
  const r = repos ?? getRepos()
  let stockLevel = await r.stockLevels.findOne({ orgId, productId, warehouseId })

  if (!stockLevel) {
    await r.stockLevels.create({
      orgId,
      productId,
      warehouseId,
      quantity,
      reservedQuantity: 0,
      availableQuantity: quantity,
      avgCost: unitCost,
    } as any)
    return
  }

  // Weighted average cost
  let avgCost = stockLevel.avgCost
  if (quantity > 0 && stockLevel.quantity > 0) {
    const totalCost = stockLevel.quantity * stockLevel.avgCost + quantity * unitCost
    avgCost = totalCost / (stockLevel.quantity + quantity)
  } else if (quantity > 0) {
    avgCost = unitCost
  }

  const newQuantity = stockLevel.quantity + quantity
  await r.stockLevels.update(stockLevel.id, {
    quantity: newQuantity,
    availableQuantity: newQuantity - stockLevel.reservedQuantity,
    avgCost,
  } as any)
}

export async function getStockValuation(orgId: string, repos?: RepositoryRegistry): Promise<{
  items: { productId: string; name: string; totalQty: number; avgCost: number; totalValue: number }[]
  totalValue: number
}> {
  const r = repos ?? getRepos()
  const levels = await r.stockLevels.findMany({ orgId })
  const productIds = [...new Set(levels.map(l => l.productId))]
  const products = await r.products.findMany({ orgId, id: { $in: productIds } } as any)
  const productMap = new Map(products.map(p => [p.id, p]))

  const aggregated = new Map<string, { qty: number; value: number }>()

  for (const level of levels) {
    const key = level.productId
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
