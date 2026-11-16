import type { DalSession, RepositoryRegistry } from 'dal'
import type { ICostLayer } from 'dal/entities'
import type { CostingMethod } from 'config'
import type { ClientSession } from 'mongoose'
import { CostLayer } from 'db/models'
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

export type StockBookingRefusalCode = 'no_cost_layer' | 'insufficient_cost_layers'

/**
 * A booking the cost layers cannot carry (FR-29.6): an article on a layered method (FIFO, LIFO, FEFO)
 * leaves a warehouse whose layers hold none of it, or less than leaves.
 *
 * Thrown by `consumeCostLayers` with the ids; `confirmMovement` names the article (name, SKU) and the
 * warehouse before it answers (`nameRefusal`), so no message a person reads carries a database id.
 * Answered 422 with its `code` by the API's error handler (`spa-fallback.ts`), on every route that books.
 * It used to be a plain `Error` naming two ids, answered 500.
 */
export class StockBookingRefusedError extends Error {
  override readonly name = 'StockBookingRefusedError'
  product?: string
  sku?: string
  warehouse?: string

  constructor(
    readonly code: StockBookingRefusalCode,
    readonly productId: string,
    readonly warehouseId: string,
    readonly needed: number,
    readonly available: number,
  ) {
    super('')
    this.message = this.describe()
  }

  /** Puts the names in, and the sentence with them. */
  named(names: { product?: string; sku?: string; warehouse?: string }): this {
    this.product = names.product
    this.sku = names.sku
    this.warehouse = names.warehouse
    this.message = this.describe()
    return this
  }

  private describe(): string {
    const article = this.product ? `"${this.product}"${this.sku ? ` (SKU ${this.sku})` : ''}` : 'the article'
    const where = this.warehouse ? `in ${this.warehouse}` : 'in this warehouse'
    // The openings are the old messages' own, so what read them still finds them.
    return this.code === 'no_cost_layer'
      ? `No cost layers available for ${article} ${where}: it cannot be booked out at a cost.`
      : `Insufficient cost layers for ${article} ${where}: they hold ${this.available}, and ${this.needed} is to be booked out.`
  }

  /** The 422's body: the code and what the screens word it with (`warehouse.refusals.*`). */
  toBody() {
    return { code: this.code, message: this.message, product: this.product, sku: this.sku, warehouse: this.warehouse, needed: this.needed, available: this.available }
  }
}

/** What a booking knows of an article's costing before it moves anything (FR-29.5). */
export interface ArticleCosting {
  method: CostingMethod
  standardCost?: number
}

/**
 * The costing of every article of a booking, in two reads whatever the number of lines: the org's
 * default once, the articles' own methods and standard costs in one query. Same rule as
 * `getEffectiveCostingMethod`: the article's method, else the org's default, else WAC.
 */
export async function costingOfArticles(
  orgId: string,
  productIds: unknown[],
  repos?: RepositoryRegistry,
  opts?: { session?: DalSession },
): Promise<Map<string, ArticleCosting>> {
  const r = repos ?? getRepos()
  const ids = [...new Set(productIds.filter(Boolean).map(String))]
  // ⚠ One after the other, never `Promise.all`: operations of one transaction run serially. Two at once
  // on its session both try to start it, and the loser makes `withTransaction` run the booking again.
  const products = ids.length ? await r.products.findMany({ orgId, id: { $in: ids } } as any, undefined, { select: ['costingMethod', 'standardCost'], session: opts?.session }) : []
  const org = await r.orgs.findOne({ id: orgId } as any, { select: ['settings.inventory.defaultCostingMethod'], session: opts?.session })
  const orgDefault = ((org as any)?.settings?.inventory?.defaultCostingMethod || 'wac') as CostingMethod
  const byId = new Map(products.map(p => [String(p.id), p]))
  return new Map(ids.map(id => {
    const p: any = byId.get(id)
    return [id, { method: (p?.costingMethod || orgDefault) as CostingMethod, standardCost: p?.standardCost }]
  }))
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
  opts?: { session?: DalSession },
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
  } as any, { session: opts?.session })

  logger.info({ orgId, productId: line.productId, warehouseId, layerId: layer.id, qty: line.quantity, cost: line.unitCost }, 'Cost layer created')

  return [layer]
}

/**
 * Take `quantity` off one layer, or nothing (null) when it no longer holds that much.
 *
 * ⚠ One write, worked out by the server from the row as it stands. Writing back a remainder computed
 * from an earlier read loses a dispatch whenever two take from one layer at once: both read 10, both
 * take 3, both write 7, and the layer still holds goods that have left. A `$gte` guard in the filter
 * does not stop that on its own, because both writes pass it.
 */
function takeFromLayer(orgId: string, layerId: string, quantity: number, session?: ClientSession) {
  const remaining = { $subtract: ['$remainingQuantity', quantity] }
  return CostLayer.findOneAndUpdate(
    { _id: layerId, orgId, remainingQuantity: { $gte: quantity } } as any,
    [{ $set: { remainingQuantity: remaining, isExhausted: { $lte: [remaining, 0] } } }],
    session ? { session } : {},
  ).lean().exec()
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
  options?: { stockLevel?: { avgCost: number }; standardCost?: number; session?: DalSession },
): Promise<ConsumptionResult> {
  const r = repos ?? getRepos()
  // FR-29.3: inside a booking's transaction, every read and write of the layers carries it.
  const session = options?.session as ClientSession | undefined

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
    { session },
  )

  if (!layers.length) {
    throw new StockBookingRefusedError('no_cost_layer', String(productId), String(warehouseId), quantity, 0)
  }

  let remaining = quantity
  const allocations: CostAllocationResult[] = []
  let totalCost = 0

  for (const layer of layers) {
    if (remaining <= 0) break

    let available = layer.remainingQuantity
    while (remaining > 0 && available > 0) {
      const consume = Math.min(remaining, available)
      if (await takeFromLayer(orgId, layer.id, consume, session)) {
        const cost = consume * layer.unitCost
        allocations.push({
          costLayerId: layer.id,
          quantity: consume,
          unitCost: layer.unitCost,
          totalCost: cost,
        })
        totalCost += cost
        remaining -= consume
        break
      }
      // Another dispatch took from this layer after it was read: take what it holds now, and go on
      // to the next layer for the rest.
      const now: any = await CostLayer.findOne({ _id: layer.id, orgId } as any, { remainingQuantity: 1, isExhausted: 1 }, session ? { session } : {}).lean().exec()
      available = now && !now.isExhausted ? now.remainingQuantity : 0
    }
  }

  if (remaining > 0) {
    // All or nothing: a dispatch the layers cannot cover must not keep what it took from them. Inside a
    // transaction its abort undoes them too; restored through the session all the same, since a write
    // outside it would wait on the very layers the transaction holds.
    await restoreCostLayers(allocations, r, { session })
    throw new StockBookingRefusedError('insufficient_cost_layers', String(productId), String(warehouseId), quantity, quantity - remaining)
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
  _repos?: RepositoryRegistry,
  opts?: { session?: DalSession },
): Promise<void> {
  const session = opts?.session as ClientSession | undefined
  for (const alloc of allocations) {
    // One write, like `takeFromLayer`: adding to a remainder read a moment earlier would undo a
    // dispatch that took from the layer in between.
    await CostLayer.updateOne(
      { _id: alloc.costLayerId } as any,
      { $inc: { remainingQuantity: alloc.quantity }, $set: { isExhausted: false } },
      session ? { session } : {},
    ).exec()
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
      unit: (product as any)?.unit || 'pcs',
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
