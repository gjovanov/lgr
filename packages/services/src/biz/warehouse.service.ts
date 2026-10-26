import type { RepositoryRegistry } from 'dal'
import type { IStockMovement } from 'dal/entities'
import { StockLevel } from 'db/models'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { getEffectiveCostingMethod, createCostLayers, consumeCostLayers, type ConsumptionResult } from './costing.service.js'
import { eventBus } from '../events/event-bus.js'

export interface ConfirmMovementOptions {
  /**
   * `<productId>|<warehouseId>` pairs whose cost layers the caller already restored (a void's
   * reversal restores the layers its dispatch consumed). Incoming stock there creates no layer of
   * its own: a second one would hold the same goods twice (#276).
   */
  layersRestored?: Set<string>
}

export async function confirmMovement(movementId: string, repos?: RepositoryRegistry, opts?: ConfirmMovementOptions): Promise<IStockMovement> {
  const r = repos ?? getRepos()
  const movement = await r.stockMovements.findById(movementId)
  if (!movement) throw new Error('Stock movement not found')
  if (movement.status !== 'draft') throw new Error('Only draft movements can be confirmed')

  const orgId = movement.orgId
  const movementDate = movement.date || new Date()
  const updatedLines: any[] = []

  for (const line of movement.lines) {
    const productId = line.productId
    let consumptionResult: ConsumptionResult | undefined

    // Reduce stock from source warehouse
    if (movement.fromWarehouseId) {
      consumptionResult = await adjustStock(orgId, productId, movement.fromWarehouseId, -line.quantity, line.unitCost, r)
    }

    // Add stock to destination warehouse
    if (movement.toWarehouseId) {
      await adjustStock(orgId, productId, movement.toWarehouseId, line.quantity, line.unitCost, r)

      // For layer-based methods, create cost layers on incoming stock
      const method = await getEffectiveCostingMethod(orgId, productId, r)
      const restored = opts?.layersRestored?.has(`${String(productId)}|${String(movement.toWarehouseId)}`)
      if (method !== 'wac' && method !== 'standard' && !restored) {
        // For transfers, use the consumed cost; for receipts, use the line cost
        const layerCost = consumptionResult?.weightedUnitCost ?? line.unitCost
        await createCostLayers(orgId, movement.toWarehouseId, movementId, movement.movementNumber, movementDate, {
          productId,
          quantity: line.quantity,
          unitCost: layerCost,
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          serialNumbers: line.serialNumbers,
        }, r)
      }
    }

    // Store cost allocation data on the line
    updatedLines.push({
      ...line,
      costAllocations: consumptionResult?.allocations,
      resolvedUnitCost: consumptionResult?.weightedUnitCost ?? line.unitCost,
      costingMethod: consumptionResult?.costingMethod,
    })
  }

  const updated = await r.stockMovements.update(movementId, {
    status: 'completed',
    lines: updatedLines,
  } as any)
  if (!updated) throw new Error('Failed to update movement status')

  // Emit event for cross-module journal entry creation (replaces inline createMovementJournalEntry)
  eventBus.emit('stock.movement.confirmed', {
    movementId,
    orgId,
    type: movement.type,
    lines: updatedLines.map((l: any) => ({ productId: l.productId, quantity: l.quantity })),
  })

  logger.info({ movementId, type: movement.type }, 'Stock movement confirmed')
  return updated
}

/**
 * Adjust stock level for a product in a warehouse.
 * Returns cost consumption result for outgoing stock (layer-based methods).
 */
export async function adjustStock(
  orgId: string,
  productId: string,
  warehouseId: string,
  quantity: number,
  unitCost: number,
  repos?: RepositoryRegistry,
): Promise<ConsumptionResult | undefined> {
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

    // Create cost layer for new incoming stock (layer-based methods)
    if (quantity > 0) {
      const method = await getEffectiveCostingMethod(orgId, productId, r)
      if (method !== 'wac' && method !== 'standard') {
        // Layers are created by confirmMovement, not here
        // This function only handles stock level updates
      }
    }
    return undefined
  }

  // Weighted average cost (maintained for WAC and as fallback)
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

  // For outgoing stock, consume cost layers if using layer-based method
  if (quantity < 0) {
    const method = await getEffectiveCostingMethod(orgId, productId, r)
    if (method !== 'wac' && method !== 'standard') {
      const product = await r.products.findById(productId)
      return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
        stockLevel: { avgCost: stockLevel.avgCost },
        standardCost: product?.standardCost,
      })
    }
    // WAC/Standard: return result without layer consumption
    if (method === 'standard') {
      const product = await r.products.findById(productId)
      return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
        standardCost: product?.standardCost,
      })
    }
    return consumeCostLayers(orgId, productId, warehouseId, Math.abs(quantity), method, r, {
      stockLevel: { avgCost: stockLevel.avgCost },
    })
  }

  return undefined
}

/**
 * Cheap header numbers for dashboards: Σ(quantity × avgCost) + row count in one
 * aggregation. getStockValuation below materialises every item (23k docs + a 23k-id
 * $in on regal — ~1.6s); this stays ~25ms. (Aggregate does NOT auto-cast orgId.)
 */
export async function getStockValuationTotals(orgId: string): Promise<{ totalValue: number; itemCount: number }> {
  const [res] = await StockLevel.aggregate([
    { $match: { orgId: new StockLevel.base.Types.ObjectId(orgId) } },
    { $group: { _id: null, totalValue: { $sum: { $multiply: ['$quantity', '$avgCost'] } }, itemCount: { $sum: 1 } } },
  ]).exec()
  return { totalValue: +(res?.totalValue || 0).toFixed(2), itemCount: res?.itemCount || 0 }
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
