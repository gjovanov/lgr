import type { RepositoryRegistry } from 'dal'
import type { ICostLayer } from 'dal/entities'
import type { CostingMethod } from 'config'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

export interface CostAllocationResult {
  costLayerId: string
  quantity: number
  unitCost: number
  totalCost: number
}

export interface ConsumptionResult {
  allocations: CostAllocationResult[]
  totalCost: number
  weightedUnitCost: number
  costingMethod: CostingMethod
}

/**
 * Resolve the effective costing method for a product.
 * Priority: product override > org default > 'wac'
 */
export async function getEffectiveCostingMethod(
  orgId: string,
  productId: string,
  repos?: RepositoryRegistry,
): Promise<CostingMethod> {
  const r = repos ?? getRepos()
  const product = await r.products.findById(productId)
  if (product?.costingMethod) return product.costingMethod as CostingMethod

  const org = await r.orgs.findOne({ id: orgId } as any)
  if ((org as any)?.settings?.inventory?.defaultCostingMethod) {
    return (org as any).settings.inventory.defaultCostingMethod as CostingMethod
  }

  return 'wac'
}

/**
 * Create cost layers from a receipt/return movement line.
 * Called when stock enters a warehouse (quantity > 0).
 */
export async function createCostLayers(
  orgId: string,
  warehouseId: string,
  movementId: string,
  movementNumber: string,
  movementDate: Date,
  line: { productId: string; quantity: number; unitCost: number; batchNumber?: string; expiryDate?: Date; serialNumbers?: string[] },
  repos?: RepositoryRegistry,
): Promise<ICostLayer[]> {
  const r = repos ?? getRepos()

  const layer = await r.costLayers.create({
    orgId,
    productId: line.productId,
    warehouseId,
    unitCost: line.unitCost,
    initialQuantity: line.quantity,
    remainingQuantity: line.quantity,
    batchNumber: line.batchNumber,
    expiryDate: line.expiryDate,
    serialNumbers: line.serialNumbers,
    sourceMovementId: movementId,
    sourceMovementNumber: movementNumber,
    receivedAt: movementDate,
    isExhausted: false,
  } as any)

  logger.info({ orgId, productId: line.productId, warehouseId, layerId: layer.id, qty: line.quantity, cost: line.unitCost }, 'Cost layer created')

  return [layer]
}

/**
 * Consume cost layers on dispatch according to the costing method.
 * Returns allocation details for audit trail.
 */
export async function consumeCostLayers(
  orgId: string,
  productId: string,
  warehouseId: string,
  quantity: number,
  method: CostingMethod,
  repos?: RepositoryRegistry,
  options?: { stockLevel?: { avgCost: number }; standardCost?: number },
): Promise<ConsumptionResult> {
  const r = repos ?? getRepos()

  // WAC: no layer consumption — use StockLevel.avgCost
  if (method === 'wac') {
    const avgCost = options?.stockLevel?.avgCost ?? 0
    return {
      allocations: [],
      totalCost: quantity * avgCost,
      weightedUnitCost: avgCost,
      costingMethod: 'wac',
    }
  }

  // Standard: no layer consumption — use product.standardCost
  if (method === 'standard') {
    const unitCost = options?.standardCost ?? 0
    return {
      allocations: [],
      totalCost: quantity * unitCost,
      weightedUnitCost: unitCost,
      costingMethod: 'standard',
    }
  }

  // Layer-based methods: FIFO, LIFO, FEFO
  const sortKey = method === 'fefo' ? 'expiryDate' : 'receivedAt'
  const sortOrder = method === 'lifo' ? -1 : 1

  const layers = await r.costLayers.findMany(
    { orgId, productId, warehouseId, isExhausted: false } as any,
    { [sortKey]: sortOrder },
  )

  if (!layers.length) {
    throw new Error(`No cost layers available for product ${productId} in warehouse ${warehouseId}`)
  }

  let remaining = quantity
  const allocations: CostAllocationResult[] = []
  let totalCost = 0

  for (const layer of layers) {
    if (remaining <= 0) break

    const consume = Math.min(remaining, layer.remainingQuantity)
    const cost = consume * layer.unitCost

    allocations.push({
      costLayerId: layer.id,
      quantity: consume,
      unitCost: layer.unitCost,
      totalCost: cost,
    })

    totalCost += cost
    remaining -= consume

    // Update the layer
    const newRemaining = layer.remainingQuantity - consume
    await r.costLayers.update(layer.id, {
      remainingQuantity: newRemaining,
      isExhausted: newRemaining <= 0,
    } as any)
  }

  if (remaining > 0) {
    throw new Error(`Insufficient cost layers: need ${quantity} but only ${quantity - remaining} available for product ${productId}`)
  }

  const weightedUnitCost = quantity > 0 ? totalCost / quantity : 0

  logger.info({ orgId, productId, warehouseId, method, quantity, totalCost, layers: allocations.length }, 'Cost layers consumed')

  return { allocations, totalCost, weightedUnitCost, costingMethod: method }
}

/**
 * Restore cost layers when a dispatch movement is reversed/voided.
 */
export async function restoreCostLayers(
  allocations: CostAllocationResult[],
  repos?: RepositoryRegistry,
): Promise<void> {
  const r = repos ?? getRepos()

  for (const alloc of allocations) {
    const layer = await r.costLayers.findById(alloc.costLayerId)
    if (!layer) continue

    await r.costLayers.update(alloc.costLayerId, {
      remainingQuantity: layer.remainingQuantity + alloc.quantity,
      isExhausted: false,
    } as any)
  }
}

/**
 * Get inventory valuation respecting each product's costing method.
 */
export async function getInventoryValuation(
  orgId: string,
  warehouseId?: string,
  productId?: string,
  repos?: RepositoryRegistry,
): Promise<{
  items: { productId: string; name: string; costingMethod: string; totalQty: number; avgCost: number; totalValue: number }[]
  totalValue: number
}> {
  const r = repos ?? getRepos()

  // Get stock levels
  const levelFilter: any = { orgId }
  if (warehouseId) levelFilter.warehouseId = warehouseId
  if (productId) levelFilter.productId = productId

  const levels = await r.stockLevels.findMany(levelFilter)
  const productIds = [...new Set(levels.map(l => l.productId))]
  const products = await r.products.findMany({ orgId, id: { $in: productIds } } as any)
  const productMap = new Map(products.map(p => [p.id, p]))

  // Get non-exhausted cost layers for layer-based products
  const layerFilter: any = { orgId, isExhausted: false }
  if (warehouseId) layerFilter.warehouseId = warehouseId
  if (productId) layerFilter.productId = productId
  const layers = await r.costLayers.findMany(layerFilter)

  // Group layers by productId
  const layersByProduct = new Map<string, ICostLayer[]>()
  for (const layer of layers) {
    const key = layer.productId
    if (!layersByProduct.has(key)) layersByProduct.set(key, [])
    layersByProduct.get(key)!.push(layer)
  }

  // Aggregate stock levels by product
  const aggregated = new Map<string, { qty: number; value: number }>()
  for (const level of levels) {
    const product = productMap.get(level.productId)
    const method = (product?.costingMethod || 'wac') as CostingMethod

    const current = aggregated.get(level.productId) || { qty: 0, value: 0 }
    current.qty += level.quantity

    if (method === 'standard' && product?.standardCost) {
      current.value += level.quantity * product.standardCost
    } else if (method === 'wac') {
      current.value += level.quantity * level.avgCost
    }
    // For layer-based methods, value comes from layers (computed below)

    aggregated.set(level.productId, current)
  }

  // For layer-based products, override value from actual layers
  for (const [pid, productLayers] of layersByProduct) {
    const product = productMap.get(pid)
    const method = (product?.costingMethod || 'wac') as CostingMethod
    if (method !== 'wac' && method !== 'standard') {
      const current = aggregated.get(pid) || { qty: 0, value: 0 }
      current.value = productLayers.reduce((sum, l) => sum + l.remainingQuantity * l.unitCost, 0)
      aggregated.set(pid, current)
    }
  }

  const items = [...aggregated.entries()].map(([pid, data]) => {
    const product = productMap.get(pid)
    return {
      productId: pid,
      name: product?.name || 'Unknown',
      costingMethod: (product?.costingMethod || 'wac') as string,
      totalQty: data.qty,
      avgCost: data.qty > 0 ? data.value / data.qty : 0,
      totalValue: data.value,
    }
  })

  const totalValue = items.reduce((sum, i) => sum + i.totalValue, 0)
  return { items, totalValue }
}

/**
 * Initialize cost layers for a product switching from WAC to a layer-based method.
 * Creates a single opening-balance layer from current StockLevel data.
 */
export async function initializeCostLayers(
  orgId: string,
  productId: string,
  repos?: RepositoryRegistry,
): Promise<number> {
  const r = repos ?? getRepos()
  const levels = await r.stockLevels.findMany({ orgId, productId } as any)

  let created = 0
  for (const level of levels) {
    if (level.quantity <= 0) continue

    await r.costLayers.create({
      orgId,
      productId,
      warehouseId: level.warehouseId,
      unitCost: level.avgCost,
      initialQuantity: level.quantity,
      remainingQuantity: level.quantity,
      sourceMovementId: '000000000000000000000000',
      sourceMovementNumber: 'INIT',
      receivedAt: new Date(),
      isExhausted: false,
    } as any)
    created++
  }

  logger.info({ orgId, productId, layersCreated: created }, 'Cost layers initialized from WAC')
  return created
}
